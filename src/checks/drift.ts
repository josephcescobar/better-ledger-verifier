import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Finding } from "../types.ts";

// One source of truth for the ledger (2026-11-14): the app's lib/ledger/ is
// it; src/vendor/ is this verifier's reviewed copy. Every run reads the app's
// current files from GitHub and compares. A difference means the app changed
// what the ledger may contain before the copy here was reviewed, so the
// report can't be green until the sync pull request (sync-vendor.yml) is
// merged. The copy stays here on purpose: the app can't change the rules this
// verifier checks against without someone approving it in this repo.

export type VendoredFile = {
  /** Path in the app repo. */
  app: string;
  /** Path in this repo. */
  ours: string;
  /** A change here is expected (new types) or must never be silent (the encoder). */
  severity: "warning" | "critical";
  what: string;
};

export const VENDORED: VendoredFile[] = [
  { app: "lib/ledger/rewardTypes.ts", ours: "src/vendor/ledgerRewardTypes.ts", severity: "warning", what: "ledger type list" },
  { app: "lib/ledger/canonical.ts", ours: "src/vendor/canonical.ts", severity: "critical", what: "row hash encoding" },
  { app: "lib/ledger/trees.ts", ours: "src/vendor/trees.ts", severity: "critical", what: "balance tree encoding" },
];

export const APP_REPO = "BETTER-Web3-Co/betterweb3";
export const APP_REF = "master";

/** Line endings don't matter (Windows checkouts); every other byte does. */
const normal = (text: string) => text.replace(/\r\n/g, "\n");
const short = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The app's current copy of a file, read through the GitHub API with a read-only token. */
async function appFile(path: string, token: string, repo: string, ref: string, doFetch: Fetch): Promise<string> {
  const res = await doFetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github.raw",
      "x-github-api-version": "2022-11-28",
      "user-agent": "better-ledger-verifier",
    },
  });
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for ${path}`);
  return res.text();
}

/**
 * Compares each vendored file with the app's. No token: an info finding
 * (never alerts), so the verifier still runs before it is set up. A file that
 * can't be read: a warning, never a silent pass.
 */
export async function checkDrift(opts: {
  token: string | undefined;
  repo?: string;
  ref?: string;
  read?: (ours: string) => string;
  fetch?: Fetch;
}): Promise<{ findings: Finding[]; drifted: string[] }> {
  const { token, repo = APP_REPO, ref = APP_REF } = opts;
  const read = opts.read ?? ((ours: string) => readFileSync(new URL(`../../${ours}`, import.meta.url), "utf8"));
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
  if (!token) {
    return {
      findings: [
        {
          check: "drift",
          severity: "info",
          key: "drift:not-configured",
          message: "The drift check is off: APP_READ_TOKEN is not set, so the app's ledger files can't be compared with this copy",
        },
      ],
      drifted: [],
    };
  }
  const findings: Finding[] = [];
  const drifted: string[] = [];
  for (const f of VENDORED) {
    let theirs: string;
    try {
      theirs = normal(await appFile(f.app, token, repo, ref, doFetch));
    } catch (err) {
      findings.push({
        check: "drift",
        severity: "warning",
        key: `drift:unreadable:${f.app}`,
        message: `The verifier could not read the app's ${f.what} (${f.app}): ${(err as Error).message}`,
      });
      continue;
    }
    const ours = normal(read(f.ours));
    if (theirs === ours) continue;
    drifted.push(f.app);
    findings.push({
      check: "drift",
      severity: f.severity,
      // Re-alerts when the app's file changes again, not on every run.
      key: `drift:${f.app}:${short(theirs)}`,
      message:
        f.severity === "critical"
          ? `The app's ${f.what} (${f.app}) changed. Ledger rows may no longer hash the same; review the sync pull request before merging, and it must come with a new encoding version`
          : `The app's ${f.what} (${f.app}) changed and this verifier hasn't reviewed it yet. Merge the sync pull request after checking the new entries`,
      detail: { app_file: f.app, app_sha: short(theirs), ours_sha: short(ours), repo, ref },
    });
  }
  return { findings, drifted };
}
