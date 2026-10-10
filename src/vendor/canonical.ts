import { createHash } from "crypto";

// Canonical byte encoding of one $BTR ledger row (ledger master plan, Stage
// C). The hash chain, the anchors and the independent verifier all hash
// exactly these bytes, so the layout is versioned and must never change in
// place: a new layout gets a new version byte.
//
// Layout v1 (big-endian):
//   0x01                      version
//   "BTRROW"                  domain tag (6 ASCII bytes)
//   seal_seq                  u64
//   reward_id                 16 bytes (UUID)
//   user_id                   16 bytes (UUID)
//   reward_type               u16 length + UTF-8
//   amount                    u64, reward_point x 10^4 (never parsed as a float)
//   sign                      i8 (+1 credit, -1 debit)
//   source_id                 u16 length + UTF-8 (empty when null)
//   created_at                i64 microseconds since the Unix epoch, UTC
//
// Left out on purpose: rewarded_time (an app-chosen string), referred_user_id
// and referral_code_id (pointers, not value).
//
// row_hash = SHA-256(encoding || prev_hash); the first row's prev_hash is 32
// zero bytes (GENESIS_PREV_HASH).

export const LEDGER_ROW_VERSION = 1;
export const GENESIS_PREV_HASH: Buffer = Buffer.alloc(32);

const DOMAIN_TAG = Buffer.from("BTRROW", "ascii");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT_RE = /^(\d+)(?:\.(\d{1,4}))?$/;

export type LedgerRowInput = {
  seal_seq: bigint;
  reward_id: string;
  user_id: string;
  reward_type: string;
  reward_point: string;
  sign: number;
  source_id: string | null;
  created_at: Date;
};

function uuidBytes(id: string, field: string): Buffer {
  if (!UUID_RE.test(id)) throw new Error(`Ledger encoding: ${field} is not a UUID (${id})`);
  return Buffer.from(id.replace(/-/g, ""), "hex");
}

function lengthPrefixed(value: string, field: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 0xffff) throw new Error(`Ledger encoding: ${field} is too long`);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

/** reward_point ("12.5", "0.0001", "100.0000") as an integer number of 10^-4 $BTR. */
export function amountUnits(rewardPoint: string): bigint {
  const m = AMOUNT_RE.exec(rewardPoint);
  if (!m) throw new Error(`Ledger encoding: amount "${rewardPoint}" is not a non-negative 4-decimal number`);
  const fraction = (m[2] ?? "").padEnd(4, "0");
  return BigInt(m[1]) * 10000n + BigInt(fraction);
}

export function encodeLedgerRow(row: LedgerRowInput): Buffer {
  if (row.sign !== 1 && row.sign !== -1) throw new Error(`Ledger encoding: sign ${row.sign} is not +1 or -1`);
  const head = Buffer.alloc(1 + DOMAIN_TAG.length + 8);
  head.writeUInt8(LEDGER_ROW_VERSION, 0);
  DOMAIN_TAG.copy(head, 1);
  head.writeBigUInt64BE(row.seal_seq, 1 + DOMAIN_TAG.length);

  const amount = Buffer.alloc(8);
  amount.writeBigUInt64BE(amountUnits(row.reward_point));
  const sign = Buffer.alloc(1);
  sign.writeInt8(row.sign);
  const createdAt = Buffer.alloc(8);
  createdAt.writeBigInt64BE(BigInt(row.created_at.getTime()) * 1000n);

  return Buffer.concat([
    head,
    uuidBytes(row.reward_id, "reward_id"),
    uuidBytes(row.user_id, "user_id"),
    lengthPrefixed(row.reward_type, "reward_type"),
    amount,
    sign,
    lengthPrefixed(row.source_id ?? "", "source_id"),
    createdAt,
  ]);
}

export function rowHash(row: LedgerRowInput, prevHash: Buffer): Buffer {
  if (prevHash.length !== 32) throw new Error("Ledger encoding: prev_hash must be 32 bytes");
  return createHash("sha256").update(encodeLedgerRow(row)).update(prevHash).digest();
}
