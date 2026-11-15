import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VENDORED } from "../src/checks/drift.ts";

// Confirms src/vendor/ is still identical to the app's files (line endings
// aside). The same list is checked on every run against GitHub
// (src/checks/drift.ts), and sync-vendor.yml opens a pull request with
// --write when they differ.
//   node scripts/check-drift.ts ../betterweb3           # compare
//   node scripts/check-drift.ts ../betterweb3 --write   # copy the app's files over
// A difference in the type list is normal (new types). A difference in
// canonical.ts or trees.ts must come with a new encoding version and new
// fixtures, never a silent change.

const app = process.argv[2];
const write = process.argv.includes("--write");
if (!app) throw new Error("Usage: node scripts/check-drift.ts <path to the betterweb3 repo> [--write]");

const normal = (b: Buffer) => b.toString("utf8").replace(/\r\n/g, "\n");
let drift = false;
for (const f of VENDORED) {
  const theirs = normal(readFileSync(join(app, f.app)));
  const oursPath = new URL(`../${f.ours}`, import.meta.url);
  const same = theirs === normal(readFileSync(oursPath));
  console.log(`${same ? "same   " : "DRIFTED"} ${f.ours}  (app: ${f.app})`);
  if (!same && write) writeFileSync(oursPath, theirs);
  drift ||= !same;
}
if (drift && !write) process.exitCode = 1;
