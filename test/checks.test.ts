import { test } from "node:test";
import assert from "node:assert/strict";
import { checkChain } from "../src/checks/chain.ts";
import { checkAnchors, parseMemo } from "../src/checks/anchors.ts";
import { checkRules } from "../src/checks/rules.ts";
import { planAlerts } from "../src/alerts.ts";
import { anchorMemoOf, readChainAnchors } from "../src/solana.ts";
import { signReport, verifyReport } from "../src/report.ts";
import { generateKeyPairSync } from "node:crypto";
import { NOW, SECRET, anchorAt, config, rawRows, seal, snapshot } from "./helpers.ts";
import type { SealedRow } from "../src/types.ts";

function run(sealed: SealedRow[], built: ReturnType<typeof anchorAt>, secret: string | null = SECRET) {
  const snap = snapshot(sealed, built.db);
  const chain = checkChain(snap, config.unsealedGraceMinutes);
  const anchors = checkAnchors({
    config,
    sealed,
    trusted: chain.trusted,
    chainAnchors: built.chain,
    dbAnchors: built.db,
    dbNow: NOW,
    saltSecret: secret ?? undefined,
  });
  return { chain, anchors, all: [...chain.findings, ...anchors.findings] };
}

test("a clean, anchored ledger passes", () => {
  const sealed = seal(rawRows(9));
  const r = run(sealed, anchorAt(sealed, [3, 6, 9]));
  assert.deepEqual(r.all, []);
  assert.equal(r.anchors.verified, 3);
  assert.equal(r.anchors.latest?.seq, "3");
});

test("editing a sealed row's amount is caught at that row and fails every later anchor", () => {
  const sealed = seal(rawRows(9));
  const built = anchorAt(sealed, [3, 6, 9]);
  sealed[4] = { ...sealed[4], reward_point: "999.0000" };
  const r = run(sealed, built);
  const breaks = r.chain.findings.filter((f) => f.severity === "critical");
  assert.equal(breaks.length, 1);
  assert.match(breaks[0].key, /^chain-break:5$/);
  assert.equal(r.anchors.verified, 1); // only the anchor at 3 still verifies
  assert.ok(r.anchors.findings.some((f) => f.key === "anchor-beyond:sig2"));
  assert.ok(r.anchors.findings.some((f) => f.key === "anchor-beyond:sig3"));
});

test("rewriting a row AND its seal hashes is caught by the anchors", () => {
  const raw = rawRows(9);
  const built = anchorAt(seal(raw), [3, 6, 9]);
  raw[4] = { ...raw[4], user_id: raw[0].user_id };
  const resealed = seal(raw); // an insider recomputes the whole chain
  const r = run(resealed, built);
  assert.deepEqual(r.chain.findings, []);
  assert.ok(r.anchors.findings.some((f) => f.key === "anchor-mismatch:sig2" && f.severity === "critical"));
  assert.ok(r.anchors.findings.some((f) => f.key === "anchor-mismatch:sig3"));
});

test("deleting the newest anchored rows is caught", () => {
  const sealed = seal(rawRows(9));
  const built = anchorAt(sealed, [3, 9]);
  const r = run(sealed.slice(0, 7), built);
  assert.ok(r.anchors.findings.some((f) => f.key === "anchor-beyond:sig2"));
});

test("without the salt secret, totals and account counts are still checked", () => {
  const sealed = seal(rawRows(6));
  const r = run(sealed, anchorAt(sealed, [6]), null);
  assert.deepEqual(r.all, []);
  assert.equal(r.anchors.bal_root_checked, false);
});

test("an anchor on Solana the app never recorded, and one the app records that isn't on Solana", () => {
  const sealed = seal(rawRows(6));
  const built = anchorAt(sealed, [3, 6]);
  const db = [built.db[0], { ...built.db[1], tx_sig: "sigMissing" }];
  const r = checkAnchors({ config, sealed, trusted: sealed.map((s) => s.row_hash), chainAnchors: built.chain, dbAnchors: db, dbNow: NOW });
  assert.ok(r.findings.some((f) => f.key === "chain-anchor-unrecorded:sig2"));
  assert.ok(r.findings.some((f) => f.key === "db-anchor-missing:2"));
});

test("unsealed rows past the grace period warn", () => {
  const raw = rawRows(4);
  const sealed = seal(raw.slice(0, 3));
  const r = checkChain(snapshot(sealed, [], [raw[3]]), config.unsealedGraceMinutes);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, "warning");
});

test("memo parsing rejects anything that isn't a BTR1 anchor", () => {
  assert.equal(parseMemo("hello"), null);
  assert.equal(parseMemo("BTR1|mainnet|1|2|zz|" + "0".repeat(64) + "|" + "0".repeat(64) + "|1|1|1"), null);
  const sealed = seal(rawRows(3));
  assert.ok(parseMemo(anchorAt(sealed, [3]).chain[0].memo));
});

test("business rules: unknown type, repeated one-time reward, daily cap, admin write, negative balance", () => {
  const base = { user_id: "aaaaaaaa-0000-4000-8000-000000000001", source_id: null as string | null, sign: 1 };
  const at = (h: number) => new Date(Date.UTC(2026, 9, 10, h));
  const rows = [
    { ...base, reward_id: "r1", reward_type: "MADE_UP", reward_point: "1", created_at: at(1) },
    { ...base, reward_id: "r2", reward_type: "TX_PASSWORD_SET", reward_point: "1", created_at: at(2) },
    { ...base, reward_id: "r3", reward_type: "TX_PASSWORD_SET", reward_point: "1", created_at: at(3) },
    // 13:00 and 23:00 fall in the same 12:00 UTC window; 12:00 the next day opens a new one.
    { ...base, reward_id: "r4", reward_type: "DAILY_CHECKIN", reward_point: "0.1", created_at: at(13) },
    { ...base, reward_id: "r5", reward_type: "DAILY_CHECKIN", reward_point: "0.1", created_at: at(23) },
    { ...base, reward_id: "r6", reward_type: "DAILY_CHECKIN", reward_point: "0.1", created_at: new Date(Date.UTC(2026, 9, 11, 12)) },
    { ...base, reward_id: "r7", reward_type: "EARLY_ADOPTER_RESET", reward_point: "50", sign: -1, created_at: at(22), source_id: "early_adopter_arm:1" },
  ];
  const f = checkRules(rows, config, NOW);
  const rules = f.map((x) => (x.detail?.rule as string) ?? x.key.split(":")[0]).sort();
  assert.deepEqual(rules, ["admin-write", "daily-cap", "negative-balance", "one-time-repeated", "unknown-type"]);
  const cap = f.find((x) => x.detail?.rule === "daily-cap")!;
  assert.equal(cap.detail?.count, 1); // only r5; r6 opens a new window
});

test("alerts: new findings alert once, criticals repeat, resolved goes out when all clear", () => {
  const crit = { check: "chain", severity: "critical" as const, key: "k1", message: "m" };
  const warn = { check: "rules", severity: "warning" as const, key: "k2", message: "m" };
  const t0 = new Date("2026-10-11T00:00:00Z");
  const p1 = planAlerts([crit, warn], { alerted: {} }, t0, 6);
  assert.equal(p1.send.length, 2);
  const p2 = planAlerts([crit, warn], p1.state, new Date(t0.getTime() + 3_600_000), 6);
  assert.equal(p2.send.length, 0);
  const p3 = planAlerts([crit, warn], p2.state, new Date(t0.getTime() + 7 * 3_600_000), 6);
  assert.deepEqual(p3.send.map((f) => f.key), ["k1"]);
  const p4 = planAlerts([], p3.state, new Date(t0.getTime() + 8 * 3_600_000), 6);
  assert.equal(p4.resolved.length, 2);
});

test("only the anchoring wallet's own signed memos count", () => {
  const tx = (payer: string, signer: boolean) => ({
    slot: 1,
    blockTime: 1,
    meta: { err: null },
    transaction: {
      message: {
        accountKeys: [{ pubkey: payer, signer }],
        instructions: [{ programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: "BTR1|x" }],
      },
    },
  });
  assert.equal(anchorMemoOf(tx(config.anchorAddress, true), config.anchorAddress), "BTR1|x");
  assert.equal(anchorMemoOf(tx("SomeoneElse111111111111111111111111111111111", true), config.anchorAddress), null);
  assert.equal(anchorMemoOf(tx(config.anchorAddress, false), config.anchorAddress), null);
});

test("a v1 transaction to the wallet (dust spam) is read and skipped, not a failure", async () => {
  const addr = config.anchorAddress;
  const txs: Record<string, unknown> = {
    spam: {
      slot: 2, blockTime: 2, version: 1, meta: { err: null },
      transaction: { message: {
        accountKeys: [{ pubkey: "Spammer1111111111111111111111111111111111111", signer: true }, { pubkey: addr, signer: false }],
        instructions: [{ programId: "11111111111111111111111111111111", parsed: { type: "transfer" } }],
      } },
    },
    anchor: {
      slot: 1, blockTime: 1, version: "legacy", meta: { err: null },
      transaction: { message: {
        accountKeys: [{ pubkey: addr, signer: true }],
        instructions: [{ programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: "BTR1|x" }],
      } },
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body);
    if (method === "getSignaturesForAddress") {
      return new Response(JSON.stringify({ result: [
        { signature: "spam", slot: 2, err: null, blockTime: 2 },
        { signature: "anchor", slot: 1, err: null, blockTime: 1 },
      ] }));
    }
    // Mirrors the RPC: refuses a v1 transaction unless the caller accepts v1.
    const tx = txs[params[0]] as { version: number | string };
    if (tx.version === 1 && !(params[1].maxSupportedTransactionVersion >= 1)) {
      return new Response(JSON.stringify({ error: { message: "Transaction version (1) is not supported" } }));
    }
    return new Response(JSON.stringify({ result: tx }));
  }) as typeof fetch;
  try {
    const out = await readChainAnchors("http://rpc", addr, { newest_sig: null, anchors: [] });
    assert.deepEqual(out.anchors.map((a) => a.tx_sig), ["anchor"]);
    assert.equal(out.newest_sig, "spam");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a one-time reward reversed and granted again is not a repeat", () => {
  const base = { user_id: "aaaaaaaa-0000-4000-8000-000000000002", source_id: null as string | null };
  const at = (h: number) => new Date(Date.UTC(2026, 9, 15, h));
  const rows = [
    { ...base, reward_id: "g1", reward_type: "EARLY_ADOPTER_BONUS", reward_point: "100", sign: 1, created_at: at(1) },
    { ...base, reward_id: "g2", reward_type: "EARLY_ADOPTER_BONUS", reward_point: "100", sign: -1, created_at: at(2) },
    { ...base, reward_id: "g3", reward_type: "EARLY_ADOPTER_BONUS", reward_point: "100", sign: 1, created_at: at(3) },
  ];
  assert.equal(checkRules(rows, config, NOW).length, 0);
  // Without the reversal it is still a repeat.
  assert.equal(checkRules([rows[0], rows[2]], config, NOW)[0]?.detail?.rule, "one-time-repeated");
  // A partial take-back (1 of 100) cancels nothing: still a repeat.
  const partial = [rows[0], { ...rows[1], reward_point: "1" }, rows[2]];
  assert.equal(checkRules(partial, config, NOW)[0]?.detail?.rule, "one-time-repeated");
});

test("signed reports verify, and a changed report does not", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = signReport({ ok: true }, privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  assert.equal(verifyReport(signed, pub), true);
  assert.equal(verifyReport({ ...signed, report: JSON.stringify({ ok: false }) }, pub), false);
});

// ── Gold Nº reconciliation (2026-10-24) ─────────────────────────────────
import { reconcileGold, type PaymentIntent } from "../src/checks/stripe.ts";
import { USERS } from "./helpers.ts";
import type { UnsealedRow } from "../src/types.ts";

const goldPi = (id: string, over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id,
  status: "succeeded",
  amount_received: 49999,
  created: Math.floor(NOW.getTime() / 1000) - 7200,
  metadata: { purpose: "gold_membership", user_id: USERS[0] },
  latest_charge: { refunded: false, amount_refunded: 0, disputed: false },
  ...over,
});
const goldRow = (pi: string, over: Partial<UnsealedRow> = {}): UnsealedRow => ({
  reward_id: `r-${pi}`,
  user_id: USERS[0],
  reward_type: "GOLD_MEMBERSHIP_REBATE",
  reward_point: "4999.9000",
  sign: 1,
  source_id: `stripe_gold:${pi}`,
  created_at: NOW,
  ...over,
});
const gold = (rows: UnsealedRow[], intents: PaymentIntent[]) =>
  reconcileGold({
    rows,
    byId: new Map(intents.map((p) => [p.id, p])),
    verified: new Set(),
    nowSec: Math.floor(NOW.getTime() / 1000),
    graceSec: 15 * 60,
  });

test("a Gold payment with its one matching rebate passes", () => {
  assert.deepEqual(gold([goldRow("pi_g1")], [goldPi("pi_g1")]).findings, []);
});

test("a Gold rebate that doesn't match the amount paid is critical", () => {
  const r = gold([goldRow("pi_g2", { reward_point: "5999.9000" })], [goldPi("pi_g2")]);
  assert.equal(r.findings[0]?.severity, "critical");
  assert.match(r.findings[0]?.key ?? "", /^gold-mismatch:/);
});

test("a Gold rebate for another account's payment is critical", () => {
  const r = gold([goldRow("pi_g3", { user_id: USERS[1] })], [goldPi("pi_g3")]);
  assert.match(r.findings[0]?.key ?? "", /^gold-mismatch:/);
});

test("a paid Gold payment without a rebate is flagged, unless refunded in full", () => {
  assert.match(gold([], [goldPi("pi_g4")]).findings[0]?.key ?? "", /^gold-paid-not-credited:/);
  const refunded = goldPi("pi_g5", { latest_charge: { refunded: true, amount_refunded: 49999, disputed: false } });
  assert.deepEqual(gold([], [refunded]).findings, []);
});

test("a Gold rebate credited twice is critical", () => {
  const r = gold([goldRow("pi_g6"), goldRow("pi_g6", { reward_id: "r-dup" })], [goldPi("pi_g6")]);
  assert.ok(r.findings.some((f) => f.key.startsWith("gold-credited-twice:")));
});

test("a disputed Gold payment stays open until its rebate is reversed", () => {
  const disputed = goldPi("pi_g7", { latest_charge: { refunded: false, amount_refunded: 0, disputed: true } });
  const open = gold([goldRow("pi_g7")], [disputed]);
  assert.equal(open.open, 1);
  const reversal: UnsealedRow = { ...goldRow("pi_g7"), reward_id: "r-rev", reward_type: "CARD_REBATE_REVERSAL", sign: -1 };
  assert.equal(gold([goldRow("pi_g7"), reversal], [disputed]).open, 0);
});
