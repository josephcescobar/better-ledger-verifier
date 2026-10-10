import pg from "pg";
import type { DbAnchor, LedgerSnapshot, SealedRow, UnsealedRow } from "./types.ts";

// Reads the ledger through the read-only ledger_verifier role
// (sql/readonly-role.sql). Everything is read in ONE repeatable-read,
// read-only transaction, so the rows, seals and anchors all come from the
// same moment and a row sealed mid-run can't look like a gap.

// "Rewards".created_at is TIMESTAMP(3) WITHOUT TIME ZONE holding UTC (that's
// how Prisma writes it). node-postgres would parse it as local time, which
// would change every row hash on a machine that isn't on UTC.
pg.types.setTypeParser(1114, (s) => new Date(s.replace(" ", "T") + "Z"));

export async function readSnapshot(databaseUrl: string, caCert?: string): Promise<LedgerSnapshot> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: caCert ? { ca: caCert, rejectUnauthorized: true } : { rejectUnauthorized: false },
    statement_timeout: 120_000,
    application_name: "better-ledger-verifier",
  });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const now = await client.query<{ now: Date }>("SELECT now() AT TIME ZONE 'UTC' AS now");

    const sealed = await client.query(`
      SELECT s.seal_seq, s.prev_hash, s.row_hash, s.reward_id AS seal_reward_id,
             r.reward_id, r.user_id, r.reward_type, r.reward_point, r.sign, r.source_id, r.created_at
        FROM "RewardsSeal" s LEFT JOIN "Rewards" r ON r.reward_id = s.reward_id
       ORDER BY s.seal_seq ASC`);

    const unsealed = await client.query<UnsealedRow>(`
      SELECT r.reward_id, r.user_id, r.reward_type, r.reward_point, r.sign, r.source_id, r.created_at
        FROM "Rewards" r LEFT JOIN "RewardsSeal" s ON s.reward_id = r.reward_id
       WHERE s.reward_id IS NULL
       ORDER BY r.created_at ASC, r.reward_id ASC`);

    const anchors = await client.query(`
      SELECT seq, network, seal_seq_upto, memo, status, tx_sig, created_at
        FROM "LedgerAnchor" ORDER BY seq ASC`);

    await client.query("COMMIT");

    const rows: SealedRow[] = [];
    const orphan_seals: LedgerSnapshot["orphan_seals"] = [];
    for (const r of sealed.rows) {
      if (r.reward_id === null) {
        orphan_seals.push({ reward_id: r.seal_reward_id, seal_seq: BigInt(r.seal_seq) });
        continue;
      }
      rows.push({
        seal_seq: BigInt(r.seal_seq),
        prev_hash: r.prev_hash,
        row_hash: r.row_hash,
        reward_id: r.reward_id,
        user_id: r.user_id,
        reward_type: r.reward_type,
        reward_point: r.reward_point,
        sign: r.sign,
        source_id: r.source_id,
        created_at: r.created_at,
      });
    }

    return {
      db_now: now.rows[0].now,
      sealed: rows,
      unsealed: unsealed.rows,
      orphan_seals,
      anchors: anchors.rows.map(
        (a): DbAnchor => ({ ...a, seq: BigInt(a.seq), seal_seq_upto: BigInt(a.seal_seq_upto) }),
      ),
    };
  } finally {
    await client.end();
  }
}
