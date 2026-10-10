import { amountUnits } from "../vendor/canonical.ts";
import { balanceRoot, type BalanceEntry } from "../vendor/trees.ts";
import { Mmr } from "../mmr.ts";
import type { ChainAnchor, Config, DbAnchor, Finding, SealedRow } from "../types.ts";

// Stage E3 "Anchors": every memo the anchoring wallet posted on Solana must
// equal what the verifier recomputes from the database at that anchor's
// seal_seq_upto: chain head, history root (MMR), balance total and account
// count, and the balance root when the salt secret is configured. Because
// each MMR root is recomputed from the same verified chain prefix, a match
// on every anchor also proves each root extends the one before it.
// The app's own LedgerAnchor table is cross-checked against the chain both
// ways: an anchor the app recorded but Solana doesn't have, or one on
// Solana the app never recorded (the anchoring key used elsewhere).

export type ParsedMemo = {
  network: string;
  seq: bigint;
  upto: bigint;
  head: string;
  mmr: string;
  bal: string;
  balTotal: bigint;
  leafCount: number;
  saltEpoch: number;
};

const HEX32 = /^[0-9a-f]{64}$/;
const UINT = /^\d+$/;

export function parseMemo(memo: string): ParsedMemo | null {
  const p = memo.split("|");
  if (p.length !== 10 || p[0] !== "BTR1") return null;
  const [, network, seq, upto, head, mmr, bal, total, leaves, epoch] = p;
  if (![seq, upto, total, leaves, epoch].every((v) => UINT.test(v))) return null;
  if (![head, mmr, bal].every((v) => HEX32.test(v))) return null;
  return {
    network,
    seq: BigInt(seq),
    upto: BigInt(upto),
    head,
    mmr,
    bal,
    balTotal: BigInt(total),
    leafCount: Number(leaves),
    saltEpoch: Number(epoch),
  };
}

export type AnchorResult = {
  findings: Finding[];
  verified: number;
  latest: { seq: string; seal_seq_upto: string; tx_sig: string; block_time: number | null } | null;
  bal_root_checked: boolean;
};

export function checkAnchors(input: {
  config: Config;
  sealed: SealedRow[];
  trusted: Buffer[];
  chainAnchors: ChainAnchor[];
  dbAnchors: DbAnchor[];
  dbNow: Date;
  saltSecret?: string;
}): AnchorResult {
  const { config, sealed, trusted, chainAnchors, saltSecret } = input;
  const findings: Finding[] = [];
  const crit = (key: string, message: string, detail?: Record<string, unknown>) =>
    findings.push({ check: "anchors", severity: "critical", key, message, detail });
  const warn = (key: string, message: string, detail?: Record<string, unknown>) =>
    findings.push({ check: "anchors", severity: "warning", key, message, detail });

  // Parse and order-check the on-chain anchors.
  const parsed: { anchor: ChainAnchor; memo: ParsedMemo }[] = [];
  let lastSeq = 0n;
  let lastUpto = 0n;
  for (const a of chainAnchors) {
    const memo = parseMemo(a.memo);
    if (!memo) {
      crit(`memo-format:${a.tx_sig}`, `The anchoring wallet signed a memo that is not a BTR1 anchor (${a.tx_sig})`, {
        tx_sig: a.tx_sig,
        memo: a.memo.slice(0, 200),
      });
      continue;
    }
    if (memo.network !== config.network) {
      crit(`memo-network:${a.tx_sig}`, `Anchor ${memo.seq} on ${config.network} says network "${memo.network}"`, { tx_sig: a.tx_sig });
    }
    if (memo.seq <= lastSeq) {
      crit(`memo-seq:${a.tx_sig}`, `Anchor seq ${memo.seq} does not increase (previous ${lastSeq})`, { tx_sig: a.tx_sig });
    }
    if (memo.upto < lastUpto) {
      crit(`memo-upto:${a.tx_sig}`, `Anchor ${memo.seq} covers fewer rows (${memo.upto}) than the one before (${lastUpto})`, {
        tx_sig: a.tx_sig,
      });
    }
    lastSeq = memo.seq;
    lastUpto = memo.upto;
    parsed.push({ anchor: a, memo });
  }

  // One pass over the verified chain, checking each anchor at its row.
  const byUpto = [...parsed].sort((x, y) => (x.memo.upto < y.memo.upto ? -1 : x.memo.upto > y.memo.upto ? 1 : 0));
  const mmr = new Mmr();
  const balances = new Map<string, BalanceEntry>();
  let verified = 0;
  let latest: AnchorResult["latest"] = null;
  let i = 0;

  const checkAt = (upto: bigint) => {
    while (i < byUpto.length && byUpto[i].memo.upto === upto) {
      const { anchor, memo } = byUpto[i++];
      const at = `anchor ${memo.seq} (seal_seq ${upto}, tx ${anchor.tx_sig})`;
      const mismatches: string[] = [];
      const head = upto === 0n ? Buffer.alloc(32) : trusted[Number(upto) - 1];
      if (head.toString("hex") !== memo.head) mismatches.push("chain head");
      if (mmr.root().toString("hex") !== memo.mmr) mismatches.push("history root");

      const entries = [...balances.values()];
      const negative = entries.filter((e) => e.units < 0n);
      if (negative.length) {
        mismatches.push(`${negative.length} negative balance(s)`);
      } else {
        const total = entries.reduce((s, e) => s + e.units, 0n);
        if (total !== memo.balTotal) mismatches.push(`balance total (${total} vs ${memo.balTotal})`);
        if (entries.length !== memo.leafCount) mismatches.push(`account count (${entries.length} vs ${memo.leafCount})`);
        if (saltSecret) {
          const bal = balanceRoot(entries, saltSecret, memo.saltEpoch);
          if (bal.root.toString("hex") !== memo.bal) mismatches.push("balance root");
        }
      }

      if (mismatches.length) {
        crit(`anchor-mismatch:${anchor.tx_sig}`, `The ledger no longer matches ${at}: ${mismatches.join(", ")}`, {
          tx_sig: anchor.tx_sig,
          seq: memo.seq.toString(),
          seal_seq_upto: upto.toString(),
          mismatches,
        });
      } else {
        verified++;
        if (!latest || memo.seq > BigInt(latest.seq)) {
          latest = { seq: memo.seq.toString(), seal_seq_upto: upto.toString(), tx_sig: anchor.tx_sig, block_time: anchor.block_time };
        }
      }
    }
  };

  checkAt(0n);
  for (let n = 0; n < trusted.length; n++) {
    const row = sealed[n];
    mmr.append(trusted[n]);
    const e = balances.get(row.user_id) ?? { user_id: row.user_id, units: 0n, last_seal_seq: 0n };
    e.units += amountUnits(row.reward_point) * BigInt(row.sign);
    e.last_seal_seq = row.seal_seq;
    balances.set(row.user_id, e);
    checkAt(BigInt(n + 1));
  }
  // Anchors beyond the verified prefix: the rows they commit to are missing
  // or fail the chain check.
  for (; i < byUpto.length; i++) {
    const { anchor, memo } = byUpto[i];
    crit(
      `anchor-beyond:${anchor.tx_sig}`,
      `Anchor ${memo.seq} commits to ${memo.upto} rows but only ${trusted.length} verify (rows deleted or the chain is broken)`,
      { tx_sig: anchor.tx_sig, seq: memo.seq.toString(), seal_seq_upto: memo.upto.toString(), verified_rows: trusted.length },
    );
  }

  // Cross-check the app's LedgerAnchor table against the chain.
  const onChain = new Map(chainAnchors.map((a) => [a.tx_sig, a]));
  const recorded = new Set<string>();
  const settleMs = 10 * 60_000;
  const mine = input.dbAnchors.filter((a) => a.network === config.network);
  for (const a of mine) {
    if (a.tx_sig) recorded.add(a.tx_sig);
    const age = input.dbNow.getTime() - a.created_at.getTime();
    if ((a.status === "confirmed" || a.status === "finalized") && a.tx_sig && age > settleMs) {
      const c = onChain.get(a.tx_sig);
      if (!c) {
        crit(`db-anchor-missing:${a.seq}`, `The app records anchor ${a.seq} (${a.tx_sig}) but it is not on Solana`, {
          seq: a.seq.toString(),
          tx_sig: a.tx_sig,
        });
      } else if (c.memo !== a.memo) {
        crit(`db-anchor-memo:${a.seq}`, `Anchor ${a.seq}: the app's stored memo differs from the one on Solana`, {
          seq: a.seq.toString(),
          tx_sig: a.tx_sig,
        });
      }
    }
    if (a.status === "sending" && age > config.anchorSendingStuckMinutes * 60_000) {
      warn(`db-anchor-stuck:${a.seq}`, `Anchor ${a.seq} has been "sending" for over ${config.anchorSendingStuckMinutes} minutes`, {
        seq: a.seq.toString(),
      });
    }
  }
  for (const a of chainAnchors) {
    if (!recorded.has(a.tx_sig)) {
      crit(`chain-anchor-unrecorded:${a.tx_sig}`, `An anchor on Solana was never recorded by the app (${a.tx_sig}); the anchoring key may be in use elsewhere`, {
        tx_sig: a.tx_sig,
      });
    }
  }

  const lastN = mine.slice(-config.failedAnchorsInARow);
  if (lastN.length === config.failedAnchorsInARow && lastN.every((a) => a.status === "failed")) {
    warn(`anchor-failing:${lastN[lastN.length - 1].seq}`, `The last ${lastN.length} anchor attempts failed`, {
      seqs: lastN.map((a) => a.seq.toString()),
    });
  }

  const newest = chainAnchors.reduce<number | null>((m, a) => (a.block_time && (!m || a.block_time > m) ? a.block_time : m), null);
  const staleMs = config.anchorStaleHours * 3_600_000;
  if (!newest || input.dbNow.getTime() - newest * 1000 > staleMs) {
    warn(
      `anchor-stale:${newest ?? "none"}`,
      newest
        ? `No new anchor on Solana for over ${config.anchorStaleHours} hours (last ${new Date(newest * 1000).toISOString()})`
        : "No anchors found on Solana",
    );
  }

  return { findings, verified, latest, bal_root_checked: Boolean(saltSecret) };
}
