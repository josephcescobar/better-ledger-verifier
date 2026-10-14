# $BTR ledger incident runbook

For alerts from the ledger verifier (github.com/josephcescobar/better-ledger-verifier) and the app's verifier heartbeat. Lives in the public verifier repo so it is reachable from anywhere during an incident; it holds no secrets.

**Where to look first:** /admin/ledger shows the latest verifier run with full details (account ids, amounts, row ids). The public repo and its run logs only show short messages.

## Ground rules

- The ledger is **append-only**. Never edit or delete `Rewards`, `RewardsSeal` or `LedgerAnchor` rows, even as a fix. Corrections are new offsetting rows (`sign` -1 to take back, +1 to give back) with a `source_id` that explains them (e.g. `correction:<incident date>:<reward_id>`).
- **Never "fix" a tamper alert by re-sealing.** Re-sealing would make the chain consistent again and destroy the evidence. The anchors on Solana still hold the true history.
- Write down what you did and when, in the private incident log (kept outside this public repo).

## Critical alerts

### Hash chain breaks at seal_seq N (`chain`)
**Meaning:** a sealed row was edited, deleted or reordered after sealing. Something with database write access bypassed the append-only triggers (a superuser, or someone dropped the triggers).
1. Open the finding's details: `seal_seq`, `reward_id`, `verified_upto`.
2. Compare that row with the nightly backup (R2 bucket, `ledger/<date>/`) and the Supabase backups to see what changed and when.
3. Check that the triggers still exist: `SELECT tgname FROM pg_trigger WHERE tgname LIKE 'rewards%' OR tgname LIKE 'ledger%';` (expect all 7: `rewards_no_update_delete`, `rewards_no_truncate`, `rewards_seal_no_update_delete`, `rewards_seal_no_truncate`, `ledger_anchor_no_delete`, `ledger_anchor_no_truncate`, `ledger_anchor_guard_update`).
4. Rotate the database password and every key with write access (Supabase dashboard, Vercel `DATABASE_URL` and `DIRECT_URL`). Check Supabase's audit and auth logs for who connected.
5. Recovery: restore the true row values in a separate database from the backup, prove they hash to the anchored values (run the verifier against it), then decide with the external consult how to bring production back. Don't touch production rows on your own.

### Anchor no longer matches / anchor commits to more rows than verify (`anchors`)
**Meaning:** the ledger as it is now disagrees with what was posted on Solana. The chain itself may look fine (someone recomputed every hash after the edit), but the anchor proves the earlier state. `anchor-beyond` means rows the anchor covers are missing.
Same steps as a chain break. The details give the first anchor that fails; the anchor before it is the last provably good state.

### An anchor on Solana the app never recorded (`chain-anchor-unrecorded`)
**Meaning:** the anchoring wallet (`DWHfzWyQubYPMweTRugS3o6L69aHtxX8szS8rXJJy2qC`) signed a transaction the app didn't make. Treat the anchoring key as **leaked**.
1. Remove `LEDGER_ANCHOR_SOLANA_SECRET_KEY` from Vercel right away (anchoring pauses; sealing continues).
2. Move the remaining SOL out of the wallet with the key from your offline backup.
3. Make a new keypair offline, fund it, put it in Vercel, and change the address in BOTH places: `EXPECTED_ANCHOR_ADDRESS` in `lib/ledger/anchor.ts` and `anchorAddress` in the verifier's `config.json`. Old anchors stay valid; the verifier reads the new wallet from then on (keep the old address documented for history).

### The app records an anchor that isn't on Solana, or with a different memo (`db-anchor-missing`, `db-anchor-memo`)
**Meaning:** the `LedgerAnchor` table claims something Solana doesn't have. Either the table was edited, or the RPC the verifier uses is missing data.
1. Look the `tx_sig` up on explorer.solana.com yourself. If it's there and matches, the verifier's RPC is at fault (switch `SOLANA_RPC_URL`).
2. If it's not there, the table was altered: handle as a chain break.

### Negative balance (`rules`, critical)
**Meaning:** an account has spent more $BTR than it has. A spend path skipped `assertSufficientAvailable()` or raced.
1. Find the rows in the finding's details and the path that wrote them (`reward_type`, `source_id`).
2. Fix the code path first. Then decide whether to offset (give the shortfall back as a correction row) or leave it and recover from the account later.

### Stripe: purchase row doesn't match, or credited twice (`stripe`, critical)
**Meaning:** a `BTR_PURCHASE` row isn't backed by a matching successful payment, or one payment was credited twice.
1. Check the PaymentIntent in the Stripe dashboard.
2. Credited twice: write one offsetting -1 row for the duplicate. Not backed by a payment: find how the row was written (only `pages/api/payments/btr/webhook.ts` should write them), fix that, then offset the row.

## Warnings

| Finding | Meaning | First steps |
|---|---|---|
| Rows not sealed for 30+ minutes (`coverage`) | The anchor cron (it also seals) is failing or not running | Vercel logs: `npx --yes vercel logs betterweb3.io --since 1h --json`, look at `/api/ledger/cron/anchor`. Check Vercel's Cron Jobs page |
| No new anchor for 25+ hours | Anchoring stopped | Wallet SOL balance (the anchor job skips when under 0.001 SOL), Helius key, anchor cron logs |
| Last 3 anchor attempts failed / anchor stuck in "sending" | Solana sends are failing | `error` column on /admin/ledger; Helius status; priority fee too low under congestion |
| Unknown reward type | A new earn or spend path didn't add its type to `lib/ledgerRewardTypes.ts` | Add it there AND copy the file into the verifier's `src/vendor/` |
| One-time reward paid twice / daily cap exceeded | A grant path has a race or a bug | Fix the path; offset the extra rows if it was abused |
| Credit larger than the maximum | A single $BTR purchase credit over 5,000 $BTR (the $500 maximum purchase at the $0.10 peg), or any other single credit over 10,000 $BTR | A purchase over 5,000 is always wrong: check the PaymentIntent and the webhook, then offset the extra. Otherwise check it's legitimate; raise `maxCreditBtrByType` in the verifier's `config.json` if a new path needs more (and update the purchase limit there if the $500 cap or the peg ever changes) |
| Admin-path row in the last 24 hours | An admin path (arm script, admin tools) wrote $BTR | Confirm it was you and expected. Clears by itself after 24 hours |
| Paid but not credited | A successful $BTR payment has no ledger row | Stripe dashboard > Developers > Webhooks: find the event and resend it (the webhook is idempotent) |
| Refund or dispute | Money came back out of Stripe without the $BTR being taken back: a refund made in the Stripe dashboard, or a card dispute | Resolve it in the refunds queue on /admin/ledger: **Reverse** takes the $BTR back, **Absorb** keeps it as a loss (a note is required). Rule: refund $BTR purchases ONLY with the Refund button on /admin/ledger (it takes the $BTR back first, then refunds the card), never from the Stripe dashboard. Refunds made that way don't raise this warning |
| The verifier could not run a check | A check failed to run (database, Solana RPC or Stripe unreachable, expired key) | Open the Actions run log. A one-off is usually a network blip; repeated means a secret needs replacing |

## The verifier stopped reporting (app heartbeat email)

**Meaning:** no signed report reached the app for 2 hours. Nothing independent is checking the ledger until it's back.
1. Actions tab of the verifier repo: is the workflow disabled? GitHub turns off scheduled workflows in repos with no activity for 60 days; re-enable it there.
2. Failing runs: open the latest log. Expired or rotated secrets are the usual cause: `DATABASE_URL` (database password), `SOLANA_RPC_URL` (the Alchemy Solana URL) or `STRIPE_READ_KEY` (the restricted Stripe read key).
3. Runs green but the app gets nothing: check the `REPORT_URL` repository variable and the app's `VERIFIER_PUBLIC_KEY` (it must be the public half of the verifier's `VERIFIER_SIGNING_KEY`). The app rejects reports that don't verify or are over an hour old.

## Contacts

- The BETTER owner (holds the keys; contact details are kept privately, not in this public repo).
- External security consult: to be named.

## Incident log

Kept privately, not in this public repo.
