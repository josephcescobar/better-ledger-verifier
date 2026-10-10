import { GENESIS_PREV_HASH, rowHash } from "../vendor/canonical.ts";
import type { Finding, LedgerSnapshot } from "../types.ts";

// Stage E3 "Chain" and "Coverage": recompute every row_hash from the
// Rewards row and the previous hash, and make sure every row is sealed.
// The chain is only trusted up to the first break; anchors are checked
// against `trusted`, which stops there.

export type ChainResult = {
  findings: Finding[];
  /** Recomputed hashes of the unbroken prefix; trusted[i] is seal_seq i + 1. */
  trusted: Buffer[];
  head_seq: bigint;
};

export function checkChain(snap: LedgerSnapshot, graceMinutes: number): ChainResult {
  const findings: Finding[] = [];
  const trusted: Buffer[] = [];
  let prev: Buffer = GENESIS_PREV_HASH;
  let expected = 1n;

  for (const row of snap.sealed) {
    const fail = (reason: string) =>
      findings.push({
        check: "chain",
        severity: "critical",
        key: `chain-break:${row.seal_seq}`,
        message: `Hash chain breaks at seal_seq ${row.seal_seq}: ${reason}`,
        detail: { seal_seq: row.seal_seq.toString(), reward_id: row.reward_id, verified_upto: trusted.length },
      });
    if (row.seal_seq !== expected) {
      fail(`expected seal_seq ${expected} (rows missing or out of order)`);
      break;
    }
    if (!row.prev_hash.equals(prev)) {
      fail("prev_hash does not match the previous row_hash");
      break;
    }
    let recomputed: Buffer;
    try {
      recomputed = rowHash(row, prev);
    } catch (err) {
      fail(`row can't be encoded: ${(err as Error).message}`);
      break;
    }
    if (!recomputed.equals(row.row_hash)) {
      fail("row contents no longer match row_hash (the row was edited)");
      break;
    }
    trusted.push(recomputed);
    prev = recomputed;
    expected += 1n;
  }

  for (const o of snap.orphan_seals) {
    findings.push({
      check: "coverage",
      severity: "critical",
      key: `orphan-seal:${o.reward_id}`,
      message: `Seal ${o.seal_seq} points at a Rewards row that no longer exists (${o.reward_id})`,
      detail: { seal_seq: o.seal_seq.toString(), reward_id: o.reward_id },
    });
  }

  const cutoff = snap.db_now.getTime() - graceMinutes * 60_000;
  const late = snap.unsealed.filter((r) => r.created_at.getTime() < cutoff);
  if (late.length) {
    const oldest = late[0];
    findings.push({
      check: "coverage",
      severity: "warning",
      // One alert per oldest stuck row, so a growing backlog doesn't re-alert every run.
      key: `unsealed:${oldest.reward_id}`,
      message: `${late.length} ledger row(s) older than ${graceMinutes} minutes are not sealed (oldest ${oldest.created_at.toISOString()})`,
      detail: { count: late.length, oldest_reward_id: oldest.reward_id, oldest_created_at: oldest.created_at.toISOString() },
    });
  }

  return { findings, trusted, head_seq: BigInt(trusted.length) };
}
