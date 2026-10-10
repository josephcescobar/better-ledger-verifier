import { createHash, createHmac } from "crypto";

// The two commitments each anchor posts (ledger master plan, Stage D).
// Every hash is SHA-256 with a one-byte domain prefix, so a leaf can never
// be passed off as an inner node (or a history node as a balance node):
//   0x00 leaf, 0x01 inner node, 0x02 peak bagging.
// The verifier (Stage E) recomputes both from the database and must get the
// same roots as the anchors on Solana.

const sha = (...parts: Buffer[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
};
const ZERO32: Buffer = Buffer.alloc(32);

// ── History: a Merkle Mountain Range over row_hash, in seal order ────────
// Append-only by construction: adding rows never changes earlier peaks, so a
// later root provably extends an earlier one.

export function mmrRoot(rowHashes: Buffer[]): Buffer {
  const peaks: { hash: Buffer; height: number }[] = [];
  for (const rowHash of rowHashes) {
    let node = { hash: sha(Buffer.from([0x00]), Buffer.from("BTRMMR"), rowHash), height: 0 };
    while (peaks.length && peaks[peaks.length - 1].height === node.height) {
      const left = peaks.pop()!;
      node = { hash: sha(Buffer.from([0x01]), left.hash, node.hash), height: node.height + 1 };
    }
    peaks.push(node);
  }
  if (!peaks.length) return ZERO32;
  // Bag the peaks right to left into one root.
  let acc = peaks[peaks.length - 1].hash;
  for (let i = peaks.length - 2; i >= 0; i--) acc = sha(Buffer.from([0x02]), peaks[i].hash, acc);
  return acc;
}

// ── Balances: a salted Merkle sum tree over every account's total ─────────
// Each leaf is salted per account and epoch, so the public root reveals no
// balance. Inner nodes carry the sum of their children, so the root also
// commits to the total $BTR outstanding (and a negative or hidden balance
// can't be slipped in). Leaves are sorted by hash and padded to a power of
// two with zero-balance dummies, hiding the account order.

export type BalanceEntry = { user_id: string; units: bigint; last_seal_seq: bigint };

export function balanceSalt(secret: string, userId: string, epoch: number): Buffer {
  return createHmac("sha256", secret).update(`${userId}:${epoch}`).digest();
}

export function balanceLeaf(entry: BalanceEntry, salt: Buffer): Buffer {
  return sha(
    Buffer.from([0x00]),
    Buffer.from("BTRBAL"),
    salt,
    Buffer.from(entry.user_id.replace(/-/g, ""), "hex"),
    u64(entry.units),
    u64(entry.last_seal_seq),
  );
}

export function balanceRoot(
  entries: BalanceEntry[],
  secret: string,
  epoch: number,
): { root: Buffer; total: bigint; leafCount: number } {
  let level = entries
    .map((e) => {
      if (e.units < 0n) throw new Error(`Balance tree: negative balance for ${e.user_id}`);
      return { hash: balanceLeaf(e, balanceSalt(secret, e.user_id, epoch)), sum: e.units };
    })
    .sort((a, b) => Buffer.compare(a.hash, b.hash));
  const leafCount = level.length;
  if (!leafCount) return { root: ZERO32, total: 0n, leafCount: 0 };

  let size = 1;
  while (size < level.length) size *= 2;
  for (let i = level.length; i < size; i++) {
    level.push({ hash: sha(Buffer.from([0x00]), Buffer.from("BTRPAD"), u64(BigInt(i))), sum: 0n });
  }
  while (level.length > 1) {
    const next: { hash: Buffer; sum: bigint }[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i];
      const r = level[i + 1];
      next.push({ hash: sha(Buffer.from([0x01]), l.hash, u64(l.sum), r.hash, u64(r.sum)), sum: l.sum + r.sum });
    }
    level = next;
  }
  return { root: level[0].hash, total: level[0].sum, leafCount };
}

// ── The memo posted on Solana (well under the 566-byte Memo limit) ────────
export function anchorMemo(a: {
  network: string;
  seq: bigint;
  sealSeqUpto: bigint;
  head: Buffer;
  mmr: Buffer;
  bal: Buffer;
  balTotal: bigint;
  leafCount: number;
  saltEpoch: number;
}): string {
  return [
    "BTR1",
    a.network,
    a.seq.toString(),
    a.sealSeqUpto.toString(),
    a.head.toString("hex"),
    a.mmr.toString("hex"),
    a.bal.toString("hex"),
    a.balTotal.toString(),
    String(a.leafCount),
    String(a.saltEpoch),
  ].join("|");
}
