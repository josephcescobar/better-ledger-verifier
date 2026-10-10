import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planAlerts, deliver, type AlertState } from "./alerts.ts";
import { checkAnchors } from "./checks/anchors.ts";
import { checkChain } from "./checks/chain.ts";
import { checkRules } from "./checks/rules.ts";
import { checkStripe, type StripeState } from "./checks/stripe.ts";
import { readSnapshot } from "./db.ts";
import { signReport } from "./report.ts";
import { readChainAnchors, type AnchorCache } from "./solana.ts";
import { loadConfig, type Config, type Finding } from "./types.ts";

// One verifier run (Stage E3). Reads the ledger, checks it, writes a signed
// report and the run state to STATE_DIR, sends alerts, and exits non-zero
// if anything needs attention, so the GitHub Actions run fails visibly too.
//
// Env:
//   DATABASE_URL          ledger_verifier role (sql/readonly-role.sql), required
//   DATABASE_CA_CERT      Supabase CA certificate (PEM); without it TLS is not verified
//   SOLANA_RPC_URL        second provider (not Helius), required
//   LEDGER_SALT_SECRET    same value as the app; without it the balance root is skipped
//   STRIPE_READ_KEY       restricted key, PaymentIntents + Charges read; without it Stripe is skipped
//   VERIFIER_SIGNING_KEY  from `npm run keygen`; without it the report is unsigned
//   REPORT_URL            optional: POST the signed report here (the app, Stage E4)
//   STATE_DIR             default ./state
//   RUN_URL               link to this run, put in alerts (set by the workflow)
// Alert channels: see src/alerts.ts.
// Flags: --full re-reads every anchor from Solana; --no-alerts skips alerts;
// --test-alert only sends a test message through every configured channel.

type State = { anchors: AnchorCache; alerts: AlertState; stripe: StripeState };

const EMPTY_STATE: State = {
  anchors: { newest_sig: null, anchors: [] },
  alerts: { alerted: {} },
  stripe: { verified_purchase_rows: [] },
};

function readState(dir: string): State {
  try {
    return { ...structuredClone(EMPTY_STATE), ...JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) };
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

/** Runs every check it can. A check that can't run becomes a warning, never a silent pass. */
async function runChecks(env: NodeJS.ProcessEnv, config: Config, state: State) {
  const findings: Finding[] = [];
  const sections: Record<string, unknown> = {};
  const opError = (check: string, err: unknown) =>
    findings.push({
      check,
      severity: "warning",
      key: `verifier-error:${check}`,
      message: `The verifier could not run the ${check} check: ${(err as Error).message}`,
    });

  let snap;
  try {
    snap = await readSnapshot(env.DATABASE_URL!, env.DATABASE_CA_CERT);
  } catch (err) {
    opError("database", err);
    return { findings, sections };
  }
  if (!snap.sealed.length && snap.anchors.length) {
    // An empty read with anchors present usually means the role can't see
    // the rows (row level security), not an empty ledger.
    findings.push({
      check: "chain",
      severity: "critical",
      key: "empty-read",
      message: "The verifier read zero sealed rows but anchors exist; check the ledger_verifier role's access",
    });
  }

  const chain = checkChain(snap, config.unsealedGraceMinutes);
  findings.push(...chain.findings);
  sections.ledger = {
    sealed_rows: snap.sealed.length,
    verified_rows: chain.trusted.length,
    unsealed_rows: snap.unsealed.length,
    head_seq: chain.head_seq.toString(),
    head_hash: chain.trusted.length ? chain.trusted[chain.trusted.length - 1].toString("hex") : null,
  };

  try {
    state.anchors = await readChainAnchors(env.SOLANA_RPC_URL!, config.anchorAddress, state.anchors);
    const a = checkAnchors({
      config,
      sealed: snap.sealed,
      trusted: chain.trusted,
      chainAnchors: state.anchors.anchors,
      dbAnchors: snap.anchors,
      dbNow: snap.db_now,
      saltSecret: env.LEDGER_SALT_SECRET,
    });
    findings.push(...a.findings);
    sections.anchors = {
      on_chain: state.anchors.anchors.length,
      verified: a.verified,
      latest_verified: a.latest,
      bal_root_checked: a.bal_root_checked,
    };
  } catch (err) {
    opError("anchors", err);
  }

  const allRows = [...snap.sealed, ...snap.unsealed];
  findings.push(...checkRules(allRows, config, snap.db_now));

  sections.stripe = { checked: false };
  if (env.STRIPE_READ_KEY) {
    try {
      const s = await checkStripe({ key: env.STRIPE_READ_KEY, rows: allRows, config, dbNow: snap.db_now, state: state.stripe });
      findings.push(...s.findings);
      state.stripe = s.state;
      sections.stripe = { checked: true, open_refunds_disputes: s.open_refunds_disputes };
    } catch (err) {
      opError("stripe", err);
    }
  }
  return { findings, sections };
}

async function main() {
  const env = process.env;
  const args = new Set(process.argv.slice(2));
  if (args.has("--test-alert")) {
    // Sends one message through every configured channel and stops; no
    // checks run and the alert history is left alone.
    const test: Finding = {
      check: "test",
      severity: "warning",
      key: "test-alert",
      message: "Test alert from the ledger verifier. If you can read this, alerts reach you.",
    };
    const errors = await deliver({ send: [test], resolved: [], state: { alerted: {} } }, env);
    const channels = [env.RESEND_API_KEY && env.ALERT_EMAIL_FROM && env.ALERT_EMAIL_TO, env.ALERT_WEBHOOK_URL, env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID].filter(Boolean).length;
    if (!channels) errors.push("no alert channel is configured");
    for (const e of errors) console.error(`Test alert failed: ${e}`);
    console.log(errors.length ? "Test alert: FAILED" : `Test alert sent to ${channels} channel(s)`);
    if (errors.length) process.exitCode = 1;
    return;
  }
  for (const name of ["DATABASE_URL", "SOLANA_RPC_URL"]) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  const config = loadConfig();
  const stateDir = env.STATE_DIR ?? "state";
  mkdirSync(stateDir, { recursive: true });
  const state = readState(stateDir);
  if (args.has("--full")) state.anchors = structuredClone(EMPTY_STATE.anchors);

  const started = Date.now();
  const { findings, sections } = await runChecks(env, config, state);

  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const report = {
    version: 1,
    run_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    network: config.network,
    ok: counts.critical === 0 && counts.warning === 0,
    counts,
    ...sections,
    findings,
  };

  // The repo (and so the state branch) is public: the committed report
  // leaves out finding details (account ids, amounts, Stripe ids). The
  // full report only goes to the app.
  const plain = JSON.parse(json(report));
  const pub = { ...plain, findings: findings.map(({ detail: _detail, ...f }) => f) };
  const signed = env.VERIFIER_SIGNING_KEY ? signReport(plain, env.VERIFIER_SIGNING_KEY) : null;
  const signedPub = env.VERIFIER_SIGNING_KEY ? signReport(pub, env.VERIFIER_SIGNING_KEY) : null;
  writeFileSync(join(stateDir, "latest.json"), json(signedPub ?? pub));

  if (env.REPORT_URL && signed) {
    try {
      const res = await fetch(env.REPORT_URL, { method: "POST", headers: { "content-type": "application/json" }, body: json(signed) });
      if (!res.ok) console.error(`Posting the report failed: HTTP ${res.status}`);
    } catch (err) {
      console.error("Posting the report failed:", (err as Error).message);
    }
  }

  if (!args.has("--no-alerts")) {
    const plan = planAlerts(findings, state.alerts, new Date(), config.alerts.repeatHours);
    for (const e of await deliver(plan, env)) console.error(`Alert delivery failed: ${e}`);
    state.alerts = plan.state;
  }
  writeFileSync(join(stateDir, "state.json"), json(state));

  const ledger = sections.ledger as { verified_rows: number; sealed_rows: number } | undefined;
  const anchors = sections.anchors as { verified: number; on_chain: number; bal_root_checked: boolean } | undefined;
  console.log(
    `${report.ok ? "OK" : "PROBLEMS"}: ` +
      `${ledger ? `${ledger.verified_rows}/${ledger.sealed_rows}` : "?"} rows verified, ` +
      `${anchors ? `${anchors.verified}/${anchors.on_chain}` : "?"} anchors verified` +
      `${anchors && !anchors.bal_root_checked ? " (balance root skipped: no LEDGER_SALT_SECRET)" : ""}, ` +
      `Stripe ${(sections.stripe as { checked: boolean } | undefined)?.checked ? "checked" : "skipped"}, ` +
      `${counts.critical} critical, ${counts.warning} warning(s)`,
  );
  for (const f of findings) console.log(`- ${f.severity.toUpperCase()} [${f.check}] ${f.message}`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 2;
});
