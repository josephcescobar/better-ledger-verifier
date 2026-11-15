# better-ledger-verifier

An independent check of the BETTER $BTR ledger, run outside Vercel and Supabase. Every 30 minutes (GitHub Actions) it:

1. **Chain**: recomputes every `row_hash` from `Rewards` + `RewardsSeal` and reports the first break.
2. **Coverage**: every `Rewards` row older than 30 minutes is sealed (the app seals every 15 minutes, skipping rows under 2 minutes old), and no seal points at a missing row.
3. **Anchors**: reads the anchoring wallet's memos straight from Solana, through a different RPC provider than the app's, and checks each memo against the ledger it recomputed: chain head, history root (MMR), $BTR total, account count, and the balance root when `LEDGER_SALT_SECRET` is set. It also cross-checks the app's `LedgerAnchor` table against the chain in both directions, and warns when anchoring stalls or keeps failing.
4. **Business rules**: known `reward_type`, well-formed amounts, sign of ±1, no negative balances, one-time rewards credited once, daily caps, a maximum credit size, and recent admin-path writes (limits in `config.json`).
5. **Stripe**: every `BTR_PURCHASE` row is backed by a succeeded PaymentIntent for the same account and amount at the $0.10 peg, every succeeded $BTR PaymentIntent in the last 30 days was credited exactly once, and refunds and disputes are listed.

Each run writes a signed report (`latest.json`, Ed25519) and its state to the `state` branch, sends alerts for new problems, and fails the Actions run on a critical finding or a check that couldn't run. GitHub's own failed-run email then works as a backup alert for the serious cases; warnings alert once and don't fail the run.

It shares no code with the app at runtime. The app's `lib/ledger/` is the one source of truth for the ledger; `src/vendor/` holds this verifier's reviewed copy of it (`canonical.ts`, `trees.ts`, and `rewardTypes.ts` as `ledgerRewardTypes.ts`), and `test/fixtures.json` was produced by the app's own code, so `npm test` fails if the two ever disagree on a single byte.

The copy is never edited by hand. Every run compares it with the app's files on GitHub (`src/checks/drift.ts`) and reports any difference: a warning for the type list, critical for the encoder. Every hour `sync-vendor.yml` opens (or updates) a pull request copying the app's files over; merging it, after reviewing the diff, clears the drift. The app can't change the rules this verifier checks against without that approval here.

## Setup

1. **Database role**: run `sql/readonly-role.sql` in the Supabase SQL editor (replace `CHANGE_ME` first).
2. **Signing key**: `npm run keygen`. The private key goes in the `VERIFIER_SIGNING_KEY` secret and the public key to the app.
3. **Repository secrets** (Settings > Secrets and variables > Actions):

| Secret | What |
|---|---|
| `DATABASE_URL` | `postgresql://ledger_verifier.<project-ref>:<password>@<pooler-host>:5432/postgres` |
| `DATABASE_CA_CERT` | Supabase CA certificate (PEM, Project Settings > Database > SSL). Optional: without it TLS is encrypted but the server isn't verified |
| `SOLANA_RPC_URL` | Mainnet RPC from a provider other than Helius (e.g. Alchemy Solana) |
| `LEDGER_SALT_SECRET` | Same value as the app's. Optional: without it the balance root is skipped (totals and account counts are still checked) |
| `STRIPE_READ_KEY` | Restricted key, read-only on PaymentIntents and Charges. Optional |
| `APP_READ_TOKEN` | Fine-grained GitHub token, **Contents: Read-only** on `BETTER-Web3-Co/betterweb3` only, for the drift check and the sync pull request. Optional: without it the drift check reports itself off (info, no alert) |
| `VERIFIER_SIGNING_KEY` | From `npm run keygen` |
| `RESEND_API_KEY` | Sending-only Resend key, for email alerts |
| `ALERT_WEBHOOK_URL` | Slack or Discord incoming webhook. Optional |
| `TELEGRAM_BOT_TOKEN` | Optional |

**Repository variables**: `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` (comma-separated), `TELEGRAM_CHAT_ID`, `REPORT_URL` (the app endpoint, once it exists).

4. Run it once by hand: Actions > Verify ledger > Run workflow.

## Commands

```
npm test                                # encoder parity + check logic
npm run typecheck
npm run verify                          # one run; needs the env vars above (see .env.example)
node scripts/check-drift.ts ../betterweb3    # vendor copies still identical to the app? (--write copies them)
node scripts/gen-fixtures.ts ../betterweb3   # only for a deliberate new encoding version
```

When the app adds a reward type, the sync pull request brings it in: review and merge it. When it adds a one-time reward or a daily cap, add it to `config.json`.

## Severity

- **critical**: the ledger or its anchors disagree with themselves (an edited or deleted row, an anchor that no longer matches, an anchor the app didn't record, a double credit). These re-alert every 6 hours until fixed.
- **warning**: needs a person (sealing lag, anchoring stalled, a broken rule, paid but not credited, a refund or dispute, a check that couldn't run). These alert once.

What to do for each is in [RUNBOOK.md](RUNBOOK.md).
