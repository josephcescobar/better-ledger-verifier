import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Builds test/fixtures.json by running the APP's encoder and trees, so the
// parity test proves the verifier's copies give the same bytes.
//   node scripts/gen-fixtures.ts ../betterweb3
// Rerun only when the app deliberately adds a new encoding version; an
// unexpected diff in fixtures.json means the two have drifted.

const app = process.argv[2];
if (!app) throw new Error("Usage: node scripts/gen-fixtures.ts <path to the betterweb3 repo>");
const load = (rel: string) => import(pathToFileURL(join(app, rel)).href);
const canonical = await load("lib/ledger/canonical.ts");
const trees = await load("lib/ledger/trees.ts");

const rows = [
  { reward_id: "00000000-0000-4000-8000-000000000001", user_id: "11111111-1111-4111-8111-111111111111", reward_type: "EARLY_ADOPTER_BONUS", reward_point: "100.0000", sign: 1, source_id: "early_adopter_slot:1", created_at: "2026-10-10T02:55:23.961Z" },
  { reward_id: "00000000-0000-4000-8000-000000000002", user_id: "22222222-2222-4222-8222-222222222222", reward_type: "DAILY_CHECKIN", reward_point: "0.0001", sign: 1, source_id: null, created_at: "2026-10-10T12:00:00.000Z" },
  { reward_id: "00000000-0000-4000-8000-000000000003", user_id: "11111111-1111-4111-8111-111111111111", reward_type: "STORE_PURCHASE", reward_point: "12.5", sign: -1, source_id: "order_ä✓", created_at: "2026-10-10T13:14:15.016Z" },
  { reward_id: "ABCDEF00-0000-4000-8000-0000000000FF", user_id: "22222222-2222-4222-8222-222222222222", reward_type: "BTR_PURCHASE", reward_point: "200", sign: 1, source_id: "pi_3Example", created_at: "1999-12-31T23:59:59.999Z" },
  { reward_id: "00000000-0000-4000-8000-000000000005", user_id: "33333333-3333-4333-8333-333333333333", reward_type: "TOOLTIP_EARN", reward_point: "0.25", sign: 1, source_id: "", created_at: "2026-10-11T00:00:00.000Z" },
];

let prev: Buffer = canonical.GENESIS_PREV_HASH;
const chain = rows.map((r, i) => {
  const input = { ...r, seal_seq: BigInt(i + 1), created_at: new Date(r.created_at) };
  const encoding = canonical.encodeLedgerRow(input).toString("hex");
  const hash: Buffer = canonical.rowHash(input, prev);
  prev = hash;
  return { ...r, seal_seq: String(i + 1), encoding, row_hash: hash.toString("hex") };
});

const hashes = chain.map((c) => Buffer.from(c.row_hash, "hex"));
const extra = Array.from({ length: 12 }, (_, i) => Buffer.alloc(32, i + 1));
const all = [...hashes, ...extra];
const mmr = Array.from({ length: all.length + 1 }, (_, n) => trees.mmrRoot(all.slice(0, n)).toString("hex"));

const entries = [
  { user_id: "11111111-1111-4111-8111-111111111111", units: 875000n, last_seal_seq: 3n },
  { user_id: "22222222-2222-4222-8222-222222222222", units: 2000001n, last_seal_seq: 4n },
  { user_id: "33333333-3333-4333-8333-333333333333", units: 2500n, last_seal_seq: 5n },
];
const bal = trees.balanceRoot(entries, "fixture-secret", 1);
const memo = trees.anchorMemo({
  network: "mainnet",
  seq: 7n,
  sealSeqUpto: 5n,
  head: hashes[hashes.length - 1],
  mmr: Buffer.from(mmr[hashes.length], "hex"),
  bal: bal.root,
  balTotal: bal.total,
  leafCount: bal.leafCount,
  saltEpoch: 1,
});

const out = {
  generated_from: "betterweb3 lib/ledger/canonical.ts + trees.ts",
  chain,
  mmr: { extra_leaves: extra.map((b) => b.toString("hex")), roots: mmr },
  balance: {
    secret: "fixture-secret",
    epoch: 1,
    entries: entries.map((e) => ({ ...e, units: e.units.toString(), last_seal_seq: e.last_seal_seq.toString() })),
    root: bal.root.toString("hex"),
    total: bal.total.toString(),
    leaf_count: bal.leafCount,
  },
  memo,
};
writeFileSync(new URL("../test/fixtures.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log("Wrote test/fixtures.json");
