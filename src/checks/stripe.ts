import { amountUnits } from "../vendor/canonical.ts";
import type { Config, Finding, UnsealedRow } from "../types.ts";

// Stage E3 "Stripe reconciliation", with a restricted read-only key
// (PaymentIntents + Charges: read). Both directions:
//   - every BTR_PURCHASE row is backed by a succeeded PaymentIntent for the
//     same account and the same amount at the $0.10 peg;
//   - every succeeded $BTR PaymentIntent in the window was credited exactly once.
// Refunds and disputes are listed until an admin resolves them (Stage F3);
// the verifier never treats them as a ledger error on its own.

// $0.10 per $BTR: one cent buys 0.1 $BTR = 1,000 units of 10^-4 $BTR.
const UNITS_PER_CENT = 1000n;

type Charge = { refunded: boolean; amount_refunded: number; disputed: boolean };
type PaymentIntent = {
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
  const intents = (await listIntents(key, since)).filter((pi) => pi.metadata?.purpose === "btr_purchase");
  const byId = new Map(intents.map((pi) => [pi.id, pi]));

  const purchases = input.rows.filter((r) => r.reward_type === "BTR_PURCHASE");
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
    if (charge && (charge.amount_refunded > 0 || charge.disputed)) {
      open++;
      add("warning", `refund-or-dispute:${pi.id}:${charge.amount_refunded}:${charge.disputed}`, `PaymentIntent ${pi.id} was ${charge.disputed ? "disputed" : "refunded"}; resolve it on the admin ledger page`, {
        payment_intent: pi.id,
        user_id: pi.metadata?.user_id,
        amount_refunded: charge.amount_refunded,
        disputed: charge.disputed,
      });
    }
  }

  return { findings, state: { verified_purchase_rows: [...verified] }, open_refunds_disputes: open };
}
