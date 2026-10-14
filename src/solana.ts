import type { ChainAnchor } from "./types.ts";

// Reads the anchors straight from Solana (Stage E2): the anchoring wallet's
// transaction history, through a different RPC provider than the app uses
// (the app uses Helius). Never through BETTER's API. Only "finalized"
// transactions count, so a cached anchor can never be rolled back.

const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export type AnchorCache = {
  /** Newest signature already read; the next run only asks for newer ones. */
  newest_sig: string | null;
  anchors: ChainAnchor[];
};

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, attempt * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Solana RPC ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`Solana RPC ${method}: ${body.error.message}`);
    return body.result as T;
  }
}

type SigInfo = { signature: string; slot: number; err: unknown; blockTime: number | null };

type ParsedTx = {
  slot: number;
  blockTime: number | null;
  meta: { err: unknown } | null;
  transaction: {
    message: {
      accountKeys: { pubkey: string; signer: boolean }[];
      instructions: { programId: string; parsed?: unknown }[];
    };
  };
};

/** The memo of an anchoring transaction, or null if the tx isn't one. */
export function anchorMemoOf(tx: ParsedTx, address: string): string | null {
  if (tx.meta?.err) return null;
  // Anyone can mention the address in a transaction; only the wallet's own
  // signed transactions (it pays the fee) are anchors.
  const payer = tx.transaction.message.accountKeys[0];
  if (!payer || payer.pubkey !== address || !payer.signer) return null;
  const memo = tx.transaction.message.instructions.find((i) => i.programId === MEMO_PROGRAM_ID);
  return memo && typeof memo.parsed === "string" ? memo.parsed : null;
}

/** All anchors posted by `address`, reading only transactions newer than the cache. */
export async function readChainAnchors(url: string, address: string, cache: AnchorCache): Promise<AnchorCache> {
  const fresh: SigInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await rpc<SigInfo[]>(url, "getSignaturesForAddress", [
      address,
      { limit: 1000, commitment: "finalized", ...(before ? { before } : {}), ...(cache.newest_sig ? { until: cache.newest_sig } : {}) },
    ]);
    fresh.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  if (!fresh.length) return cache;

  const anchors = [...cache.anchors];
  // Oldest first, so anchors stay in chain order.
  for (const sig of fresh.slice().reverse()) {
    if (sig.err) continue;
    const tx = await rpc<ParsedTx | null>(url, "getTransaction", [
      sig.signature,
      // Anyone can send to the wallet, in any transaction version (a v1
      // dust spam on 2026-10-14 made the RPC refuse at 0 and stopped the
      // anchors check). Accept v1; non-anchors are ignored below anyway.
      { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 1 },
    ]);
    if (!tx) throw new Error(`Solana RPC returned no transaction for ${sig.signature}`);
    const memo = anchorMemoOf(tx, address);
    if (memo !== null) anchors.push({ tx_sig: sig.signature, slot: tx.slot, block_time: tx.blockTime, memo });
  }
  anchors.sort((a, b) => a.slot - b.slot);
  return { newest_sig: fresh[0].signature, anchors };
}
