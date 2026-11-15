import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDrift, VENDORED } from "../src/checks/drift.ts";

// The app's ledger files vs this verifier's reviewed copy (src/checks/drift.ts).

const ours: Record<string, string> = Object.fromEntries(VENDORED.map((f) => [f.ours, `// ${f.what}\nexport const X = 1;\n`]));
const read = (path: string) => ours[path];

/** GitHub as seen through the token: the app's files, or an error status. */
function github(files: Record<string, string | number>) {
  const calls: { url: string; auth: string }[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, auth: init.headers.authorization });
    const path = decodeURIComponent(new URL(url).pathname.split("/contents/")[1]);
    const body = files[path];
    if (typeof body === "number") return { ok: false, status: body, text: async () => "" };
    return { ok: true, status: 200, text: async () => body };
  };
  return { fetch, calls };
}
const appCopy = (): Record<string, string | number> => Object.fromEntries(VENDORED.map((f) => [f.app, ours[f.ours]]));

test("no token: an info finding only, so it never alerts", async () => {
  const r = await checkDrift({ token: undefined, read });
  assert.deepEqual(r.findings.map((f) => f.severity), ["info"]);
  assert.deepEqual(r.drifted, []);
});

test("the same files (line endings aside): nothing to report, read with the token", async () => {
  const files = appCopy();
  const first = VENDORED[0].app;
  files[first] = (files[first] as string).replace(/\n/g, "\r\n");
  const gh = github(files);
  const r = await checkDrift({ token: "t0k", read, fetch: gh.fetch });
  assert.deepEqual(r.findings, []);
  assert.equal(gh.calls.length, VENDORED.length);
  assert.ok(gh.calls.every((c) => c.auth === "Bearer t0k" && c.url.includes("/repos/BETTER-Web3-Co/betterweb3/contents/")));
});

test("a new type in the app's list: a warning until the sync is merged; the encoder: critical", async () => {
  const files = appCopy();
  files["lib/ledger/rewardTypes.ts"] += '  "NEW_TYPE",\n';
  files["lib/ledger/canonical.ts"] += "// changed\n";
  const r = await checkDrift({ token: "t", read, fetch: github(files).fetch });
  assert.deepEqual(r.drifted, ["lib/ledger/rewardTypes.ts", "lib/ledger/canonical.ts"]);
  assert.deepEqual(
    r.findings.map((f) => [f.detail?.app_file, f.severity]),
    [
      ["lib/ledger/rewardTypes.ts", "warning"],
      ["lib/ledger/canonical.ts", "critical"],
    ],
  );
});

test("the same drift keeps the same key (no repeated alerts); a further change gets a new one", async () => {
  const files = appCopy();
  files["lib/ledger/rewardTypes.ts"] += '  "NEW_TYPE",\n';
  const a = await checkDrift({ token: "t", read, fetch: github(files).fetch });
  const b = await checkDrift({ token: "t", read, fetch: github(files).fetch });
  assert.equal(a.findings[0].key, b.findings[0].key);
  files["lib/ledger/rewardTypes.ts"] += '  "OTHER",\n';
  const c = await checkDrift({ token: "t", read, fetch: github(files).fetch });
  assert.notEqual(a.findings[0].key, c.findings[0].key);
});

test("a file GitHub won't give: a warning, never a silent pass", async () => {
  const files = appCopy();
  files["lib/ledger/trees.ts"] = 404;
  const r = await checkDrift({ token: "t", read, fetch: github(files).fetch });
  assert.deepEqual(r.findings.map((f) => [f.key, f.severity]), [["drift:unreadable:lib/ledger/trees.ts", "warning"]]);
});
