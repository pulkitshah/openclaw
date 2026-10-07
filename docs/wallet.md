---
doc-schema-version: 1
summary: "Prepaid Wallet: balance, usage buckets, how TripIn Studio credits it, the rate card, backfill, and what pauses when it runs out"
read_when:
  - Reading or explaining the Wallet page, its balance, or its statement
  - Crediting, adjusting, or configuring a desk's wallet
  - Tuning the wallet rate card or importing past usage
  - Working out why chats or Duty runs are being refused for balance
title: "Wallet"
---

The Wallet plugin keeps a prepaid balance for a desk. Every model call, Duty run, mail reply, and daily hosting charge is a debit in an append-only ledger; credits are added by TripIn Studio. Amounts are in rupees, stored as paise.

## What the Wallet page shows

- **Balance** and a **state chip**: Active, Low (at or below the low-balance notice level), or Paused since a date (balance and credit limit both used up).
- **Buckets** that split this month's spend: Chats, Duties, Mail, System, Hosting, and Integrations. Select a bucket to drill down to the individual chats, Duties, or services behind it.
- **Statement**: the ledger, newest first, with a Load more control. **Export CSV** downloads it.

## How TripIn Studio credits a desk

On the Wallet page, the admin bar has **Recharge**, **Adjust**, and **Settings** tabs. The same operations are available over the Gateway with the `operator.admin` scope:

| Method            | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `wallet.credit`   | Add a paid recharge.                                                 |
| `wallet.adjust`   | Add a correcting entry (refund, goodwill, fix).                      |
| `wallet.settings` | Set `creditLimitPaise`, the low-balance notice level, and `enforce`. |

Reads (`wallet.get`, the statement) need only `operator.read`.

## Rate card

Token usage is priced from `plugins.entries.wallet.config.rateCard`. Any field you leave out keeps its default.

| Field        | Meaning                                                                                                                                                    | Default                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `inrPerUsd`  | Exchange rate applied to USD prices.                                                                                                                       | `88`                                                            |
| `multiplier` | Markup on provider cost.                                                                                                                                   | `2`                                                             |
| `models`     | Per-model rates, keyed by model id, each with `inputUsdPerM`, `outputUsdPerM`, `cacheReadUsdPerM`, `cacheWriteUsdPerM` (USD per million tokens).           | Built-in table of current Claude models                         |
| `fallback`   | Rates for a model not in `models`; the debit is marked unpriced.                                                                                           | Opus rates                                                      |
| `aliases`    | Model names the runtime reports (such as claude-cli's `sonnet`) mapped to a `models` id. A leading `claude-cli/` or `anthropic/` is ignored before lookup. | `opus`, `sonnet`, `haiku`, and `default` (the fallback's model) |
| `services`   | Non-token charges, keyed by service, each `{ unit, inrPerUnit }`.                                                                                          | `hosting` at 80 per `day`, `apify` at 0.5 per `compute-unit`    |

Hosting is on by default at the `hosting` rate; set `services.hosting.inrPerUnit` to `0` to turn it off for a desk.

`plugins.entries.wallet.config.contact` names who customers are told to ask for a recharge. It defaults to "TripIn Studio".

## Backfill

`wallet.backfill` (the **Import past usage** button on the page; `operator.admin`) is a one-time import. It reads recorded session usage from `sessions.usage`, split into India Standard Time days, and writes each (session, day) as a debit priced with the current rate card and attributed to a bucket.

The cutover is the moment the live meter first started on the desk (when the Wallet plugin first ran there):

- Days before the cutover day are imported in full.
- On the cutover day, each session imports only the tokens the live meter did not already record for it that day.
- Days after the cutover are never imported; the live meter already covers them.

A day that fails is reported in `failed` and the import is not marked done, so running it again imports just the failed days. Once an import finishes with no failures, running it again does nothing and returns the earlier result with `alreadyDone: true`; the page then shows "Imported past usage on <date>" instead of the button. Only one backfill runs at a time. It reads up to 1000 sessions.

## What pauses and what does not

With `enforce` on, once the balance falls to the negative of `creditLimitPaise` or below:

- New chat turns and new Duty runs are refused with a message that names the `contact`: "Vasu is paused: the wallet balance is exhausted. Ask TripIn Studio to recharge, then send your message again." Each sender gets it once per stop; later messages in the same stop are refused silently. The core runner appends "(blocked by wallet)", and the channel may prefix "Your message could not be sent". A refused Duty run appears on the Runs board as Blocked.
- Runs and turns already in progress finish.
- Hosting debits keep accruing daily.
- Credits always land, and service resumes once the balance is back above the limit.

The owner is told once when the balance first drops below the low-balance level and once when the desk pauses; both notices go out only while `enforce` is on. A Recharged notice goes out on every credit. If the wallet cannot read its own database, turns are allowed rather than blocked.

With `enforce` off (the default), the wallet meters usage without refusing anything. If the Wallet plugin is disabled or not installed, nothing is gated.

## Storage

The ledger lives in the plugin-owned database at
`<state-dir>/plugins/wallet/wallet.sqlite`, with three tables: `wallet_entries` (the append-only
ledger, one row per credit, debit, or adjustment), `wallet_state` (the single row of limit,
threshold, `enforce`, and notice bookkeeping), and `wallet_backfill_marks` (one row per imported
session-day). The database enforces one credit per `reference` and one hosting debit per day. The
plugin closes it when disabled or restarted.

## The `/wallet` command and `wallet_status` tool

`/wallet` replies with the balance and where it went this month, plus the recharge contact when paused. The `wallet_status` tool gives the agent the same read-only view (balance, usage this month, days remaining), so it can answer "how much is left?".
