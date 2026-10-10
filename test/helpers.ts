import { GENESIS_PREV_HASH, amountUnits, rowHash } from "../src/vendor/canonical.ts";
import { anchorMemo, balanceRoot, type BalanceEntry } from "../src/vendor/trees.ts";
import { Mmr } from "../src/mmr.ts";
import { loadConfig, type ChainAnchor, type DbAnchor, type LedgerSnapshot, type SealedRow, type UnsealedRow } from "../src/types.ts";

// Builds a small, correctly sealed and anchored ledger in memory, the way
// the app's sealer and anchor job would, so tests can tamper with it.

export const config = loadConfig();
export const SECRET = "test-secret";
export const NOW = new Date("2026-10-11T00:00:00.000Z");

const uuid = (n: number, prefix = "0") => `${prefix.repeat(8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const USERS = [uuid(1, "a"), uuid(2, "b"), uuid(3, "c")];

export function rawRows(n: number): UnsealedRow[] {
  return Array.from({ length: n }, (_, i) => ({
    reward_id: uuid(i + 1),
    user_id: USERS[i % USERS.length],
    reward_type: i < USERS.length ? "EARLY_ADOPTER_BONUS" : "STORE_PURCHASE",
    reward_point: i < USERS.length ? "100.0000" : "1.5",
    sign: i < USERS.length ? 1 : -1,
    source_id: null,
    created_at: new Date(Date.UTC(2026, 9, 10, 13, 0, i)),
  }));
}

export function seal(rows: UnsealedRow[]): SealedRow[] {
  let prev: Buffer = GENESIS_PREV_HASH;
  return rows.map((r, i) => {
    const seal_seq = BigInt(i + 1);
    const row_hash = rowHash({ ...r, seal_seq }, prev);
    const sealed = { ...r, seal_seq, prev_hash: prev, row_hash };
    prev = row_hash;
    return sealed;
  });
}

/** Anchors the sealed rows at each given seal_seq, as the app's anchor job would. */
export function anchorAt(sealed: SealedRow[], uptos: number[]): { chain: ChainAnchor[]; db: DbAnchor[] } {
  const chain: ChainAnchor[] = [];
  const db: DbAnchor[] = [];
  uptos.forEach((upto, i) => {
    const rows = sealed.slice(0, upto);
    const mmr = new Mmr();
    const balances = new Map<string, BalanceEntry>();
    for (const r of rows) {
      mmr.append(r.row_hash);
      const e = balances.get(r.user_id) ?? { user_id: r.user_id, units: 0n, last_seal_seq: 0n };
      e.units += amountUnits(r.reward_point) * BigInt(r.sign);
      e.last_seal_seq = r.seal_seq;
      balances.set(r.user_id, e);
    }
    const bal = balanceRoot([...balances.values()], SECRET, 1);
    const seq = BigInt(i + 1);
    const memo = anchorMemo({
      network: "mainnet",
      seq,
      sealSeqUpto: BigInt(upto),
      head: rows[rows.length - 1].row_hash,
      mmr: mmr.root(),
      bal: bal.root,
      balTotal: bal.total,
      leafCount: bal.leafCount,
      saltEpoch: 1,
    });
    const tx_sig = `sig${i + 1}`;
    const time = new Date(NOW.getTime() - (uptos.length - i) * 3_600_000);
    chain.push({ tx_sig, slot: 1000 + i, block_time: Math.floor(time.getTime() / 1000), memo });
    db.push({ seq, network: "mainnet", seal_seq_upto: BigInt(upto), memo, status: "finalized", tx_sig, created_at: time });
  });
  return { chain, db };
}

export function snapshot(sealed: SealedRow[], db: DbAnchor[], unsealed: UnsealedRow[] = []): LedgerSnapshot {
  return { db_now: NOW, sealed, unsealed, orphan_seals: [], anchors: db };
}
