import { readFileSync } from "node:fs";
import { join } from "node:path";

// Confirms src/vendor/ is still byte-identical to the app's files.
//   node scripts/check-drift.ts ../betterweb3
// Run it whenever the app's ledger code changes. A difference in
// ledgerRewardTypes.ts is normal (new types): copy the file over. A
// difference in canonical.ts or trees.ts must come with a new encoding
// version and new fixtures, never a silent change.

const app = process.argv[2];
if (!app) throw new Error("Usage: node scripts/check-drift.ts <path to the betterweb3 repo>");

const files: [string, string][] = [
  ["lib/ledger/canonical.ts", "src/vendor/canonical.ts"],
  ["lib/ledger/trees.ts", "src/vendor/trees.ts"],
  ["lib/ledgerRewardTypes.ts", "src/vendor/ledgerRewardTypes.ts"],
];
let drift = false;
for (const [appPath, ours] of files) {
  const same = readFileSync(join(app, appPath)).equals(readFileSync(new URL(`../${ours}`, import.meta.url)));
  console.log(`${same ? "same   " : "DRIFTED"} ${ours}`);
  drift ||= !same;
}
if (drift) process.exitCode = 1;
