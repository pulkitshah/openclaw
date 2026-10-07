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

Token usage is priced from `plugins.entries.wallet.config.rateCard`. Any field you leave out keeps its default. The default card is Anthropic list price at ₹100 per dollar, with a 30% premium shown as extra tokens rather than a higher rate: every recorded token count (input, output, cache read, cache write) is multiplied by `tokenMarkup` (1.3, rounded half-up per class) before pricing and storage. The statement's token counts therefore include the 30%, priced at the list rate. `rateCard.inrPerUsd`, `tokenMarkup` and `multiplier` override it per desk.

| Field         | Meaning                                                                                                                                                                                     | Default                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `inrPerUsd`   | Exchange rate applied to USD prices.                                                                                                                                                        | `100`                                                           |
| `tokenMarkup` | Factor applied to every recorded token count before pricing and storage.                                                                                                                    | `1.3`                                                           |
| `multiplier`  | Extra factor on the price per token; leave at 1 to charge list price.                                                                                                                       | `1`                                                             |
| `models`      | Per-model rates, keyed by model id, each with `inputUsdPerM`, `outputUsdPerM`, `cacheReadUsdPerM`, `cacheWriteUsdPerM` (USD per million tokens).                                            | Built-in table of current Claude, Gemini and GPT models         |
| `fallback`    | Rates for a model not in `models`; the debit is marked unpriced.                                                                                                                            | Opus rates                                                      |
| `aliases`     | Model names the runtime reports (such as claude-cli's `sonnet`) mapped to a `models` id. A leading `claude-cli/`, `anthropic/`, `google/`, `gemini/` or `openai/` is ignored before lookup. | `opus`, `sonnet`, `haiku`, and `default` (the fallback's model) |
| `services`    | Non-token charges, keyed by service, each `{ unit, inrPerUnit }`.                                                                                                                           | `hosting` at 80 per `day`, `apify` at 0.5 per `compute-unit`    |

The built-in table covers the current Claude models plus `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.1-pro-preview`, `gpt-5`, `gpt-5.2`, `gpt-5.4`, `gpt-5-mini` and `gpt-5-nano`. A model that is not in the table (and not an alias) is priced at the `fallback` rates and flagged "(not in rate card)" under **By model**.

Hosting is on by default at the `hosting` rate; set `services.hosting.inrPerUnit` to `0` to turn it off for a desk.

`plugins.entries.wallet.config.contact` names who customers are told to ask for a recharge. It defaults to "TripIn Studio".

## Backfill

`wallet.backfill` (the **Import past usage** button on the page; `operator.admin`) is a one-time import. It reads recorded usage from the `sessions.usage` aggregates, split into India Standard Time days, and imports it per day, per agent, per model: each model's tokens for that agent-day become debits priced with the current rate card. A mail agent's usage is booked to Mail. For other agents, each model's usage is split between Chat and System by the share of that agent-day that came through a chat channel; the rest (cron, heartbeat, and other system work) goes to System. Rows are labelled like "Chat — 28 Sep (history)" and dated noon IST of their day.

The cutover is the moment the live meter first started on the desk (when the Wallet plugin first ran there):

- Days before the cutover day are imported in full.
- On the cutover day, each agent imports only the tokens the live meter did not already record for it that day. Live rows are matched by agent, so a live row recorded without an agent id is not subtracted, and that day can be over-imported by those tokens.
- Days after the cutover are never imported; the live meter already covers them.

The result reports the `days` and `agents` imported, the `paise` debited, and how many agent-days `failed`. Each agent-day's debits and its mark are written in one transaction, so an agent-day that fails is left wholly unimported and the import is not marked done, so running it again imports just the failed agent-days. Once an import finishes with no failures, running it again does nothing and returns the earlier result with `alreadyDone: true`; the page then shows "Imported past usage on <date>" instead of the button. Only one backfill runs at a time. Because it reads aggregates rather than the session list, it covers every session, however many there are.

## By model

Under **Where it went**, the page lists **By model**: every model used in the selected period, with its provider, spend, tokens, and number of calls, biggest spend first. Hosting and other non-token charges are not part of it. `/wallet` adds the top three models by spend ("Models: Claude Opus 5 ₹5,002.11, Claude Sonnet 5 ₹8.75.").

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
agent-day). The database enforces one credit per `reference` and one hosting debit per day. The
plugin closes it when disabled or restarted.

## The `/wallet` command and `wallet_status` tool

`/wallet` replies with the balance and where it went this month, plus the recharge contact when paused. The `wallet_status` tool gives the agent the same read-only view (balance, usage this month, days remaining), so it can answer "how much is left?".

## Who may recharge

Recharge, Adjust, Settings and Backfill belong to the operator (TripIn Studio), not to the desk's customer login, even though that login holds `operator.admin` for the rest of the desk. The wallet refuses these actions for any front-door identity unless it is listed in `plugins.entries.wallet.config.operators`; the operator's own local calls (`gateway call` over SSH, a paired device) are always allowed. The Wallet page hides the admin controls for everyone else.

A desk you do not bill for tokens sets `rateCard.multiplier: 0`: every model call is still recorded with its tokens and shown on the page, prices as ₹0, and only service charges such as hosting reach the balance.
