import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GENESIS_PREV_HASH, encodeLedgerRow, rowHash } from "../src/vendor/canonical.ts";
import { anchorMemo, balanceRoot, mmrRoot } from "../src/vendor/trees.ts";
import { Mmr } from "../src/mmr.ts";

// fixtures.json was produced by the APP's code (scripts/gen-fixtures.ts).
// If any of these fail, the verifier and the app no longer agree on bytes.
const fx = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));

test("row encoding and hash chain match the app", () => {
  let prev: Buffer = GENESIS_PREV_HASH;
  for (const c of fx.chain) {
    const row = { ...c, seal_seq: BigInt(c.seal_seq), created_at: new Date(c.created_at) };
    assert.equal(encodeLedgerRow(row).toString("hex"), c.encoding, `encoding of seal_seq ${c.seal_seq}`);
    const h = rowHash(row, prev);
    assert.equal(h.toString("hex"), c.row_hash, `row_hash of seal_seq ${c.seal_seq}`);
    prev = h;
  }
});

test("history roots match the app, and the incremental MMR matches mmrRoot", () => {
  const leaves = [
    ...fx.chain.map((c: { row_hash: string }) => Buffer.from(c.row_hash, "hex")),
    ...fx.mmr.extra_leaves.map((h: string) => Buffer.from(h, "hex")),
  ];
  const inc = new Mmr();
  assert.equal(inc.root().toString("hex"), fx.mmr.roots[0]);
  leaves.forEach((leaf: Buffer, i: number) => {
    inc.append(leaf);
    assert.equal(mmrRoot(leaves.slice(0, i + 1)).toString("hex"), fx.mmr.roots[i + 1], `mmrRoot of ${i + 1}`);
    assert.equal(inc.root().toString("hex"), fx.mmr.roots[i + 1], `incremental root of ${i + 1}`);
  });
});

test("balance root and anchor memo match the app", () => {
  const entries = fx.balance.entries.map((e: { user_id: string; units: string; last_seal_seq: string }) => ({
    user_id: e.user_id,
    units: BigInt(e.units),
    last_seal_seq: BigInt(e.last_seal_seq),
  }));
  const bal = balanceRoot(entries, fx.balance.secret, fx.balance.epoch);
  assert.equal(bal.root.toString("hex"), fx.balance.root);
  assert.equal(bal.total.toString(), fx.balance.total);
  assert.equal(bal.leafCount, fx.balance.leaf_count);

  const n = fx.chain.length;
  const memo = anchorMemo({
    network: "mainnet",
    seq: 7n,
    sealSeqUpto: BigInt(n),
    head: Buffer.from(fx.chain[n - 1].row_hash, "hex"),
    mmr: Buffer.from(fx.mmr.roots[n], "hex"),
    bal: bal.root,
    balTotal: bal.total,
    leafCount: bal.leafCount,
    saltEpoch: 1,
  });
  assert.equal(memo, fx.memo);
});
