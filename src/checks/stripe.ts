import { amountUnits } from "../vendor/canonical.ts";
import type { Config, Finding, UnsealedRow } from "../types.ts";

// Stage E3 "Stripe reconciliation", with a restricted read-only key
// (PaymentIntents + Charges: read). Both directions:
//   - every BTR_PURCHASE row is backed by a succeeded PaymentIntent for the
//     same account and the same amount at the $0.10 peg;
//   - every succeeded $BTR PaymentIntent in the window was credited exactly once.
// Refunds and disputes are listed until an admin resolves them (Stage F3);
// the verifier never treats them as a ledger error on its own.
//
// Gold Nº bought by card (2026-10-24), the same two directions:
//   - every GOLD_MEMBERSHIP_REBATE row (source stripe_gold:<pi>) is backed by
//     a succeeded "gold_membership" PaymentIntent for the same account, and
//     credits exactly the amount paid at the $0.10 peg ($499.99 = 4,999.9);
//   - every succeeded Gold PaymentIntent was credited exactly once, except a
//     payment refunded in full because no seat was left (no rebate at all).

// $0.10 per $BTR: one cent buys 0.1 $BTR = 1,000 units of 10^-4 $BTR.
const UNITS_PER_CENT = 1000n;

type Charge = { refunded: boolean; amount_refunded: number; disputed: boolean };
export type PaymentIntent = {
  id: string;
  status: string;
  amount_received: number;
  created: number;
  metadata: Record<string, string>;
  latest_charge: Charge | string | null;
};

async function stripeGet<T>(key: string, path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1/${path}?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (res.status === 404) return null as T;
  if (!res.ok) throw new Error(`Stripe ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function listIntents(key: string, sinceSec: number): Promise<PaymentIntent[]> {
  const out: PaymentIntent[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await stripeGet<{ data: PaymentIntent[]; has_more: boolean }>(key, "payment_intents", {
      limit: "100",
      "created[gte]": String(sinceSec),
      "expand[]": "data.latest_charge",
      ...(after ? { starting_after: after } : {}),
    });
    out.push(...page.data);
    if (!page.has_more || !page.data.length) return out;
    after = page.data[page.data.length - 1].id;
  }
}

export type StripeState = { verified_purchase_rows: string[] };

export const GOLD_REBATE_TYPE = "GOLD_MEMBERSHIP_REBATE";
// The app locks every card rebate for 120 days (lib/btrBalance REBATE_LOCK_DAYS).
const GOLD_LOCK_DAYS = 120;
const GOLD_SOURCE_PREFIX = "stripe_gold:";

/**
 * Gold Nº reconciliation, pure (the caller fetched the PaymentIntents):
 * `byId` holds every Gold PaymentIntent in the window plus any older one an
 * unverified rebate row points at. Adds rows that check out to `verified`.
 */
export function reconcileGold(input: {
  rows: UnsealedRow[];
  byId: Map<string, PaymentIntent>;
  verified: Set<string>;
  nowSec: number;
  graceSec: number;
}): { findings: Finding[]; open: number } {
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], k: string, message: string, detail?: Record<string, unknown>) =>
    findings.push({ check: "stripe", severity, key: k, message, detail });

  const rebates = input.rows.filter((r) => r.reward_type === GOLD_REBATE_TYPE);
  const bySource = new Map<string, UnsealedRow[]>();
  for (const r of rebates) {
    const list = bySource.get(r.source_id ?? "") ?? [];
    list.push(r);
    bySource.set(r.source_id ?? "", list);
  }
  // Net $BTR taken back per Gold payment (CARD_REBATE_REVERSAL, same source).
  const reversedUnits = new Map<string, bigint>();
  for (const r of input.rows) {
    if (r.reward_type !== "CARD_REBATE_REVERSAL" || !r.source_id?.startsWith(GOLD_SOURCE_PREFIX)) continue;
    let u: bigint;
    try {
      u = amountUnits(r.reward_point);
    } catch {
      continue;
    }
    reversedUnits.set(r.source_id, (reversedUnits.get(r.source_id) ?? 0n) - u * BigInt(r.sign));
  }

  // Ledger -> Stripe.
  for (const row of rebates) {
    if (input.verified.has(row.reward_id)) continue;
    const at = { reward_id: row.reward_id, source_id: row.source_id, user_id: row.user_id };
    const piId = row.source_id?.startsWith(GOLD_SOURCE_PREFIX) ? row.source_id.slice(GOLD_SOURCE_PREFIX.length) : null;
    if (!piId?.startsWith("pi_")) {
      add("critical", `gold-no-intent:${row.reward_id}`, "A GOLD_MEMBERSHIP_REBATE row has no Gold PaymentIntent id", at);
      continue;
    }
    const pi = input.byId.get(piId);
    const problems: string[] = [];
    if (!pi) problems.push("PaymentIntent not found");
    else {
      if (pi.status !== "succeeded") problems.push(`PaymentIntent status is ${pi.status}`);
      if (pi.metadata?.purpose !== "gold_membership") problems.push("PaymentIntent is not a Gold Nº payment");
      if (pi.metadata?.user_id !== row.user_id) problems.push("PaymentIntent belongs to a different account");
      if (row.sign !== 1) problems.push("row is a debit");
      try {
        const units = amountUnits(row.reward_point);
        if (units !== BigInt(pi.amount_received) * UNITS_PER_CENT) {
          problems.push(`credited ${row.reward_point} $BTR for ${pi.amount_received} cents paid (peg $0.10)`);
        }
      } catch {
        problems.push("row amount is malformed");
      }
    }
    if (problems.length) {
      add("critical", `gold-mismatch:${row.reward_id}`, `GOLD_MEMBERSHIP_REBATE ${row.reward_id}: ${problems.join("; ")}`, { ...at, problems });
    } else {
      input.verified.add(row.reward_id);
    }
  }

  // Stripe -> ledger.
  let open = 0;
  for (const pi of input.byId.values()) {
    if (pi.metadata?.purpose !== "gold_membership" || pi.status !== "succeeded") continue;
    const source = `${GOLD_SOURCE_PREFIX}${pi.id}`;
    const credited = bySource.get(source) ?? [];
    const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
    const fullyRefunded = !!charge && charge.amount_refunded >= pi.amount_received && !charge.disputed;
    if (credited.length === 0 && !fullyRefunded && input.nowSec - pi.created > input.graceSec) {
      add("warning", `gold-paid-not-credited:${pi.id}`, `Gold Nº payment ${pi.id} succeeded but no rebate was credited`, {
        payment_intent: pi.id,
        user_id: pi.metadata?.user_id,
        amount_received: pi.amount_received,
      });
    }
    if (credited.length > 1) {
      add("critical", `gold-credited-twice:${pi.id}`, `Gold Nº payment ${pi.id} was credited ${credited.length} times`, {
        payment_intent: pi.id,
        reward_ids: credited.map((r) => r.reward_id),
      });
    }
    // A refund or dispute is settled once the rebate it covers is taken back
    // (or there was none: the no-seat full refund).
    if (charge && (charge.amount_refunded > 0 || charge.disputed)) {
      let creditedUnits = 0n;
      for (const r of credited) {
        try {
          creditedUnits += amountUnits(r.reward_point);
        } catch {
          /* flagged above */
        }
      }
      const owed = charge.disputed
        ? creditedUnits
        : pi.amount_received > 0
          ? (creditedUnits * BigInt(charge.amount_refunded)) / BigInt(pi.amount_received)
          : 0n;
      const settled = owed === 0n || (reversedUnits.get(source) ?? 0n) >= owed;
      if (!settled) {
        open++;
        add("warning", `gold-refund-or-dispute:${pi.id}:${charge.amount_refunded}:${charge.disputed}`, `Gold Nº payment ${pi.id} was ${charge.disputed ? "disputed" : "refunded"}; resolve it on the admin ledger page`, {
          payment_intent: pi.id,
          user_id: pi.metadata?.user_id,
          amount_refunded: charge.amount_refunded,
          disputed: charge.disputed,
        });
      }
    }
  }
  return { findings, open };
}

export async function checkStripe(input: {
  key: string;
  rows: UnsealedRow[];
  config: Config;
  dbNow: Date;
  state: StripeState;
}): Promise<{ findings: Finding[]; state: StripeState; open_refunds_disputes: number }> {
  const { key, config, dbNow } = input;
  const findings: Finding[] = [];
  const add = (severity: Finding["severity"], k: string, message: string, detail?: Record<string, unknown>) =>
    findings.push({ check: "stripe", severity, key: k, message, detail });

  const since = Math.floor(dbNow.getTime() / 1000) - config.stripeWindowDays * 86_400;
  const allIntents = await listIntents(key, since);
  const intents = allIntents.filter((pi) => pi.metadata?.purpose === "btr_purchase");
  const byId = new Map(intents.map((pi) => [pi.id, pi]));

  const purchases = input.rows.filter((r) => r.reward_type === "BTR_PURCHASE");
  // Net $BTR taken back per PaymentIntent (BTR_PURCHASE_REVERSAL rows: -1
  // takes back, +1 gives back when a refund failed), in 10^-4 units.
  const reversedUnits = new Map<string, bigint>();
  for (const r of input.rows) {
    if (r.reward_type !== "BTR_PURCHASE_REVERSAL" || !r.source_id) continue;
    let u: bigint;
    try {
      u = amountUnits(r.reward_point);
    } catch {
      continue;
    }
    reversedUnits.set(r.source_id, (reversedUnits.get(r.source_id) ?? 0n) - u * BigInt(r.sign));
  }
  const bySource = new Map<string, UnsealedRow[]>();
  for (const r of purchases) {
    const list = bySource.get(r.source_id ?? "") ?? [];
    list.push(r);
    bySource.set(r.source_id ?? "", list);
  }

  // Ledger -> Stripe. Rows already verified in an earlier run are skipped:
  // their PaymentIntent can't change amount or owner after it succeeded.
  const verified = new Set(input.state.verified_purchase_rows);
  // Purchases made against the Stripe sandbox while the app used test keys
  // (config.json knownSandboxPayments): a live key can't see them. Each was
  // offset in the ledger by a BTR_PURCHASE_REVERSAL.
  const sandbox = new Set(config.knownSandboxPayments.map((s) => s.payment_intent));
  for (const row of purchases) {
    if (verified.has(row.reward_id) || sandbox.has(row.source_id ?? "")) continue;
    const at = { reward_id: row.reward_id, source_id: row.source_id, user_id: row.user_id };
    if (!row.source_id?.startsWith("pi_")) {
      add("critical", `purchase-no-intent:${row.reward_id}`, "A BTR_PURCHASE row has no PaymentIntent id", at);
      continue;
    }
    const pi = byId.get(row.source_id) ?? (await stripeGet<PaymentIntent | null>(key, `payment_intents/${row.source_id}`, {}));
    const problems: string[] = [];
    if (!pi) problems.push("PaymentIntent not found");
    else {
      if (pi.status !== "succeeded") problems.push(`PaymentIntent status is ${pi.status}`);
      if (pi.metadata?.purpose !== "btr_purchase") problems.push("PaymentIntent is not a $BTR purchase");
      if (pi.metadata?.user_id !== row.user_id) problems.push("PaymentIntent belongs to a different account");
      if (row.sign !== 1) problems.push("row is a debit");
      let units: bigint | null = null;
      try {
        units = amountUnits(row.reward_point);
      } catch {
        problems.push("row amount is malformed");
      }
      // Since 2026-10-11 the buyer also pays Stripe's card fee, recorded on
      // the intent as metadata fee_cents; only the rest buys $BTR. A fee can
      // only lower what's credited, never raise it above the peg.
      const feeRaw = pi.metadata?.fee_cents ?? "0";
      const fee = /^[0-9]+$/.test(feeRaw) ? BigInt(feeRaw) : null;
      const priceCents = fee === null ? null : BigInt(pi.amount_received) - fee;
      if (priceCents === null || priceCents <= 0n) {
        problems.push(`processing fee ${feeRaw} is malformed for ${pi.amount_received} cents`);
      } else if (units !== null && units !== priceCents * UNITS_PER_CENT) {
        problems.push(`credited ${row.reward_point} $BTR for ${priceCents} cents of price (${pi.amount_received} paid, ${fee} fee; peg $0.10)`);
      }
    }
    if (problems.length) {
      add("critical", `purchase-mismatch:${row.reward_id}`, `BTR_PURCHASE ${row.reward_id}: ${problems.join("; ")}`, { ...at, problems });
    } else {
      verified.add(row.reward_id);
    }
  }

  // Stripe -> ledger: each succeeded intent credited exactly once.
  const grace = config.stripeWebhookGraceMinutes * 60;
  const nowSec = Math.floor(dbNow.getTime() / 1000);
  let open = 0;
  for (const pi of intents) {
    if (pi.status !== "succeeded") continue;
    const credited = bySource.get(pi.id) ?? [];
    if (credited.length === 0 && nowSec - pi.created > grace) {
      add("warning", `paid-not-credited:${pi.id}`, `PaymentIntent ${pi.id} succeeded but no $BTR was credited`, {
        payment_intent: pi.id,
        user_id: pi.metadata?.user_id,
        amount_received: pi.amount_received,
      });
    }
    if (credited.length > 1) {
      add("critical", `credited-twice:${pi.id}`, `PaymentIntent ${pi.id} was credited ${credited.length} times`, {
        payment_intent: pi.id,
        reward_ids: credited.map((r) => r.reward_id),
      });
    }
    const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
    // A refund whose $BTR is already taken back in the ledger (the admin
    // Refund button does that first) is resolved: nothing to flag. The
    // refunded cents convert at the purchase's own rate, since the charge
    // may include a card processing fee (metadata fee_cents, 2026-10-11).
    let settled = false;
    if (charge && charge.amount_refunded > 0 && !charge.disputed && pi.amount_received > 0) {
      let boughtUnits: bigint | null = null;
      try {
        boughtUnits = amountUnits(pi.metadata?.btr_amount ?? "");
      } catch {
        boughtUnits = null;
      }
      if (boughtUnits !== null) {
        const owedUnits = (boughtUnits * BigInt(charge.amount_refunded)) / BigInt(pi.amount_received);
        settled = (reversedUnits.get(pi.id) ?? 0n) >= owedUnits;
      }
    }
    if (charge && !settled && (charge.amount_refunded > 0 || charge.disputed)) {
      open++;
      add("warning", `refund-or-dispute:${pi.id}:${charge.amount_refunded}:${charge.disputed}`, `PaymentIntent ${pi.id} was ${charge.disputed ? "disputed" : "refunded"}; resolve it on the admin ledger page`, {
        payment_intent: pi.id,
        user_id: pi.metadata?.user_id,
        amount_refunded: charge.amount_refunded,
        disputed: charge.disputed,
      });
    }
  }

  // Gold Nº: Gold payments in the window, plus older ones a rebate row points
  // at when that row is unverified OR still inside its 120-day lock, so a
  // late chargeback (day 31-120, the window the lock exists for) is still
  // caught here (security audit 2026-10-25).
  const goldById = new Map(allIntents.filter((pi) => pi.metadata?.purpose === "gold_membership").map((pi) => [pi.id, pi]));
  const lockSince = dbNow.getTime() - GOLD_LOCK_DAYS * 86_400_000;
  for (const row of input.rows) {
    if (row.reward_type !== GOLD_REBATE_TYPE) continue;
    if (verified.has(row.reward_id) && new Date(row.created_at).getTime() < lockSince) continue;
    const piId = row.source_id?.startsWith(GOLD_SOURCE_PREFIX) ? row.source_id.slice(GOLD_SOURCE_PREFIX.length) : null;
    if (!piId?.startsWith("pi_") || goldById.has(piId)) continue;
    const pi = await stripeGet<PaymentIntent | null>(key, `payment_intents/${piId}`, { "expand[]": "latest_charge" });
    if (pi) goldById.set(piId, pi);
  }
  const gold = reconcileGold({ rows: input.rows, byId: goldById, verified, nowSec, graceSec: grace });
  findings.push(...gold.findings);
  open += gold.open;

  return { findings, state: { verified_purchase_rows: [...verified] }, open_refunds_disputes: open };
}
