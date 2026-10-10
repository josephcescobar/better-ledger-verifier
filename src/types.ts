import { readFileSync } from "node:fs";

// critical = the ledger or its anchors disagree with themselves (tamper or
// data loss); warning = something needs a human (lag, a broken rule, a
// Stripe mismatch); info = context only, never alerts.
export type Severity = "critical" | "warning" | "info";

export type Finding = {
  check: string;
  severity: Severity;
  // Stable identity of the problem, so the same finding is not re-alerted
  // every run (alerts.ts). Include what makes it distinct, not the time.
  key: string;
  message: string;
  detail?: Record<string, unknown>;
};

export type Config = {
  network: "mainnet" | "devnet";
  anchorAddress: string;
  unsealedGraceMinutes: number;
  anchorStaleHours: number;
  anchorSendingStuckMinutes: number;
  failedAnchorsInARow: number;
  stripeWindowDays: number;
  stripeWebhookGraceMinutes: number;
  rules: {
    oneTimePerUser: string[];
    dailyWindowStartHourUtc: number;
    dailyCaps: Record<string, number>;
    maxCreditBtr: string;
    maxCreditBtrByType: Record<string, string>;
    adminSourcePrefixes: string[];
    adminRewardTypes: string[];
    adminAlertHours: number;
  };
  alerts: { repeatHours: number };
};

export function loadConfig(path = new URL("../config.json", import.meta.url)): Config {
  return JSON.parse(readFileSync(path, "utf8")) as Config;
}

/** One sealed ledger row as the verifier reads it (Rewards joined to RewardsSeal). */
export type SealedRow = {
  seal_seq: bigint;
  prev_hash: Buffer;
  row_hash: Buffer;
  reward_id: string;
  user_id: string;
  reward_type: string;
  reward_point: string;
  sign: number;
  source_id: string | null;
  created_at: Date;
};

/** A Rewards row with no seal yet. */
export type UnsealedRow = Omit<SealedRow, "seal_seq" | "prev_hash" | "row_hash">;

/** The LedgerAnchor table row (the app's own record of what it posted). */
export type DbAnchor = {
  seq: bigint;
  network: string;
  seal_seq_upto: bigint;
  memo: string;
  status: string;
  tx_sig: string | null;
  created_at: Date;
};

/** An anchor memo read from Solana, signed by the anchoring wallet. */
export type ChainAnchor = {
  tx_sig: string;
  slot: number;
  block_time: number | null;
  memo: string;
};

export type LedgerSnapshot = {
  db_now: Date;
  sealed: SealedRow[];
  unsealed: UnsealedRow[];
  orphan_seals: { reward_id: string; seal_seq: bigint }[];
  anchors: DbAnchor[];
};
