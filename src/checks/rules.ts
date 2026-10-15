import { amountUnits } from "../vendor/canonical.ts";
import { LEDGER_REWARD_TYPES } from "../vendor/ledgerRewardTypes.ts";
import type { Config, Finding, UnsealedRow } from "../types.ts";

// Stage E3 "Business rules", over every row (sealed or not). These are the
// rules the app enforces in code; the verifier catches a bug or a bypass
// that let a row through anyway. Limits live in config.json, next to the
// app file that sets each one.

type Row = UnsealedRow;

const DAY_MS = 86_400_000;
const KNOWN_TYPES = new Set<string>(LEDGER_REWARD_TYPES);

/** "12.5" BTR as 10^-4 units, for config values. */
const btrUnits = (btr: string) => amountUnits(btr);

export function checkRules(rows: Row[], config: Config, dbNow: Date): Finding[] {
  const r = config.rules;
  const hits = new Map<string, { severity: Finding["severity"]; message: string; rows: Row[] }>();
  const hit = (rule: string, severity: Finding["severity"], message: string, row: Row) => {
    const h = hits.get(rule) ?? { severity, message, rows: [] };
    h.rows.push(row);
    hits.set(rule, h);
  };

  const balances = new Map<string, bigint>();
  const oneTime = new Set(r.oneTimePerUser);
  // Outstanding (not reversed) credits per account and one-time type, by amount.
  const oneTimeSeen = new Map<string, bigint[]>();
  const daily = new Map<string, number>();
  const windowOffset = r.dailyWindowStartHourUtc * 3_600_000;
  const adminTypes = new Set(r.adminRewardTypes);
  const adminSince = dbNow.getTime() - r.adminAlertHours * 3_600_000;

  for (const row of rows) {
    if (!KNOWN_TYPES.has(row.reward_type)) {
      hit("unknown-type", "warning", "reward_type is not in LEDGER_REWARD_TYPES", row);
    }
    if (row.sign !== 1 && row.sign !== -1) {
      hit("bad-sign", "critical", "sign is not +1 or -1", row);
      continue;
    }
    let units: bigint;
    try {
      units = amountUnits(row.reward_point);
    } catch {
      hit("bad-amount", "warning", "amount is not a non-negative number with at most 4 decimals", row);
      continue;
    }
    balances.set(row.user_id, (balances.get(row.user_id) ?? 0n) + units * BigInt(row.sign));

    if (row.sign === 1) {
      const max = btrUnits(r.maxCreditBtrByType[row.reward_type] ?? r.maxCreditBtr);
      if (units > max) hit("credit-too-large", "warning", "a single credit is larger than the configured maximum", row);

      if (oneTime.has(row.reward_type)) {
        const k = `${row.user_id}|${row.reward_type}`;
        const credits = oneTimeSeen.get(k) ?? [];
        credits.push(units);
        oneTimeSeen.set(k, credits);
        if (credits.length > 1) hit("one-time-repeated", "warning", "a one-time reward was credited more than once to the same account", row);
      }

      const cap = r.dailyCaps[row.reward_type];
      if (cap !== undefined) {
        const window = Math.floor((row.created_at.getTime() - windowOffset) / DAY_MS);
        const k = `${row.user_id}|${row.reward_type}|${window}`;
        const n = (daily.get(k) ?? 0) + 1;
        daily.set(k, n);
        if (n > cap) hit("daily-cap", "warning", "a reward was credited more times in one daily window than its cap allows", row);
      }
    }

    // A one-time reward that was reversed IN FULL (a sign -1 correction of
    // the same type and the same amount as an earlier credit) and granted
    // again later is not a repeat (2026-10-15: an early adopter removed by
    // mistake and restored). A partial take-back cancels nothing.
    if (row.sign === -1 && oneTime.has(row.reward_type)) {
      const credits = oneTimeSeen.get(`${row.user_id}|${row.reward_type}`);
      const i = credits ? credits.indexOf(units) : -1;
      if (credits && i >= 0) credits.splice(i, 1);
    }

    const admin = adminTypes.has(row.reward_type) || r.adminSourcePrefixes.some((p) => row.source_id?.startsWith(p));
    if (admin && row.created_at.getTime() >= adminSince) {
      hit("admin-write", "warning", `an admin-path row was written in the last ${r.adminAlertHours} hours`, row);
    }
  }

  const findings: Finding[] = [];
  for (const [rule, h] of hits) {
    const newest = h.rows[h.rows.length - 1];
    findings.push({
      check: "rules",
      severity: h.severity,
      // Re-alerts when a new offending row appears, not on every run.
      key: `${rule}:${h.rows.length}:${newest.reward_id}`,
      message: `${h.rows.length} row(s): ${h.message}`,
      detail: {
        rule,
        count: h.rows.length,
        sample: h.rows.slice(-10).map((x) => ({
          reward_id: x.reward_id,
          user_id: x.user_id,
          reward_type: x.reward_type,
          reward_point: x.reward_point,
          sign: x.sign,
          source_id: x.source_id,
          created_at: x.created_at.toISOString(),
        })),
      },
    });
  }

  const negative = [...balances].filter(([, units]) => units < 0n);
  if (negative.length) {
    findings.push({
      check: "rules",
      severity: "critical",
      key: `negative-balance:${negative.map(([u]) => u).sort().join(",")}`,
      message: `${negative.length} account(s) have a negative $BTR balance`,
      detail: { accounts: negative.map(([user_id, units]) => ({ user_id, units: units.toString() })) },
    });
  }
  return findings;
}
