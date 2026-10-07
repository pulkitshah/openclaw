# Wallet — design

**Status:** approved in conversation 2026-10-07; awaiting file review.
**Branch:** `staging/team-v2-test`. **Owner of money:** a new bundled plugin, `extensions/wallet`.

## 1. Goal

Every Vasudev desk (one customer per desk) carries a prepaid **rupee** balance. Everything the
desk spends is debited from it — model tokens priced by a rate card, metered third-party services
(Apify and the like), and hosting — and every roster member can see **where the balance went**, by
activity and down to the single call. TripIn Studio recharges the balance by hand from the desk's
Control UI today; a Razorpay webhook becomes another caller of the same credit method later. When
the balance falls below the customer's agreed **credit limit**, the desk pauses new work until a
recharge.

Modeled on Vasudev Legacy (`balanceUsd` on the tenant, one `Usage` row per turn, `top-up` operator
CLI, `402 empty_balance` gate) with three deliberate differences: rupees and integer paise instead
of USD floats; an append-only ledger with rate snapshots instead of a mutable balance column; and
service/hosting charges alongside tokens.

## 2. Decisions (from the design conversation)

| Decision | Choice |
| --- | --- |
| Denomination | Rupees, integer paise; per-model rate card |
| Rate card source | Provider list price (USD) × `inrPerUsd` × `multiplier`; defaults 88 and 2 until set |
| What is shown | Activity buckets on top, each opening into its entries |
| Exhausted balance | Hard stop below `−credit_limit`; the limit is set per customer by TripIn Studio (default ₹0) |
| In-flight Duty run at the limit | Finishes; new runs and turns are refused |
| Hosting while paused | Keeps accruing |
| Recharge surface | Admin controls on the desk's Wallet page (`operator.admin` only); CLI not required |
| Visibility | Every roster member sees everything; `/wallet` in chat for all of them |
| Customer-facing contact | "TripIn Studio" (config `contact`), never a person |
| First rollout (Amigos) | Backfill all token usage since provisioning → negative balance → credit limit ₹5,000, enforcement on |

## 3. Data model

Tables live in the desk's agent SQLite database through Kysely (same pattern as the Duties store).
Money is **integer paise**; no floats anywhere in the ledger.

### `wallet_entries` (append-only)

| Column | Notes |
| --- | --- |
| `id` | uuid |
| `at` | ms epoch; backfilled rows carry the day they describe |
| `kind` | `credit` \| `debit` \| `adjustment` |
| `amount_paise` | signed: credits and positive adjustments `+`, debits and negative adjustments `−` |
| `balance_after_paise` | running balance after this row |
| `charge` | debits only: `tokens` \| `service` |
| `provider`, `model` | `tokens` debits |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | `tokens` debits |
| `rate_json` | snapshot of the four ₹/M figures (tokens) or `{unit, unit_rate_paise}` (service) actually applied |
| `unpriced` | `1` when the model fell back to `rateCard.fallback` |
| `service`, `units`, `unit` | `service` debits (`hosting`, `apify`, …) |
| `activity` | `chat` \| `duty` \| `mail` \| `system` \| `hosting` \| `integration` |
| `ref` | session key (chat), run id (duty), agent id (mail/system), `hosting:<YYYY-MM-DD>`, service name |
| `label` | what the owner reads: "Chat — Anuj", "Book flight — Sumit Negi, 12 Oct", "Mail — ticketing@", "System — heartbeat", "Hosting — 7 Oct" |
| `session_key`, `agent_id`, `run_id` | raw attribution inputs, nullable |
| `source` | credits/adjustments: `manual` \| `razorpay`; debits: `live` \| `backfill` |
| `reference` | credits: UPI/bank ref or payment id — **unique among credits** |
| `note`, `by` | free text; `by` = admin identity for credits/adjustments |

Rows are never updated or deleted. Balance = `SUM(amount_paise)`; `balance_after_paise` is a
convenience that must equal that sum at every row (a test asserts the chain).

### `wallet_state` (one row)

`credit_limit_paise` (default 0), `low_balance_paise` (default 20,000 = ₹200), `enforce` (default
`false`), `last_low_notice_at`, `last_stop_notice_at`, `stopped_since`, `hosting_started_on`
(ISO date; set when the plugin first starts on the desk), `backfill_done_at`.

### `wallet_backfill_marks`

`(session_key, day)` primary key — one mark per session-day imported, so `wallet.backfill` is
idempotent.

## 4. Rate card (config, hot-reloadable)

```json5
plugins.entries.wallet.config = {
  contact: "TripIn Studio",
  rateCard: {
    inrPerUsd: 88,
    multiplier: 2,
    models: {
      "anthropic/claude-opus-5":   { inputUsdPerM: 15, outputUsdPerM: 75, cacheReadUsdPerM: 1.5,  cacheWriteUsdPerM: 18.75 },
      "anthropic/claude-sonnet-5": { inputUsdPerM: 3,  outputUsdPerM: 15, cacheReadUsdPerM: 0.3,  cacheWriteUsdPerM: 3.75 },
      "anthropic/claude-haiku-4-5": { inputUsdPerM: 1, outputUsdPerM: 5,  cacheReadUsdPerM: 0.1,  cacheWriteUsdPerM: 1.25 },
      // claude-cli models are priced by the same Anthropic ids
    },
    fallback: { inputUsdPerM: 15, outputUsdPerM: 75, cacheReadUsdPerM: 1.5, cacheWriteUsdPerM: 18.75 },
    services: {
      hosting: { unit: "day", inrPerUnit: 80 },
      apify:   { unit: "compute-unit", inrPerUnit: 0.5 },
    },
  },
}
```

The model figures above are placeholders for the plan: the implementer fills them from Anthropic's
published price list at implementation time (verified against the docs, not from memory) and records
the date in a comment. ₹ per million = USD × `inrPerUsd` × `multiplier`; a debit = Σ(tokens ×
rate) / 1,000,000, rounded half-up to the paisa per entry. A model missing from `models` is priced
at `fallback` and flagged `unpriced`. A service missing from `services` is **refused** (error to the
caller, nothing recorded). The Wallet page shows the effective card. Editing the card changes
future debits only; `rate_json` preserves history.

## 5. Metering and attribution

### Token calls

The plugin registers `llm_output` (bundled plugins have conversation-hook access by default).
Every model call — embedded runtime **and Claude CLI** (`src/agents/cli-runner.ts` fires it with
`usage`) — yields `usage`, `provider`, `model`, `runId`, `ctx.sessionKey`, `ctx.agentId`. One
`tokens` debit per model call. The write happens synchronously inside the hook; a failed write is
logged at warn and increments an in-memory `unrecorded` counter shown on the Wallet page. A
bookkeeping failure never blocks or delays a turn.

Attribution, first rule that matches:

1. `ctx.attribution` present → use its `kind`/`ref`/`label` (Duty runs, see below).
2. Agent id is the mail dispatcher (`duties-mail`, or any agent with `wallet.role: "mail"` in its
   agent config) → `mail`, label "Mail — <account or subject when the dispatch carries it>".
3. Trigger is `heartbeat` / `cron` / internal → `system`, label "System — heartbeat" or the
   automation's name.
4. Session key is a member session (`agent:<x>:direct:<rosterId>`) → `chat`, label "Chat — <roster
   name>" via the Team plugin; a group session → "Chat — <group name>".
5. Otherwise → `chat` with the raw session key as label. Nothing is dropped.

### Core seams (generic, upstream-shaped)

1. **`runtime.llm.complete` emits `llm_output`.** The plugin-runtime completion path
   (`src/plugins/runtime/runtime-llm.runtime.ts`) already computes usage and audits a session key;
   it now runs the `llm_output` hook with the same event shape the agent loop uses. Today these
   calls (every Duty `ai` step through `llm-task`) are invisible to all hooks.
2. **`tools.invoke` carries `attribution`.** Optional `attribution: { kind: string; ref: string;
   label: string }` on `tools.invoke` params, validated, carried into the hook context of model
   calls the tool makes. The Duties run-service sets `{ kind: "duty", ref: runId, label: "<duty
   name> — <lead input>" }` on every `ai` step it invokes (`extensions/duties/src/adapters/ai.ts`).
   Duties describes what it is doing; the wallet decides what it costs.

### Service charges

`wallet.charge({ service, units, activity?, ref?, label? })` — Gateway method (`operator.write`)
and a plugin-runtime helper for bundled plugins. The wallet prices it from `services`; callers never
compute rupees. Unknown service → `INVALID_REQUEST`. The Apify wrapper (whoever adds Apify) reports
units after each call with the run's attribution when inside a Duty.

### Hosting

The wallet's own daily job posts one `hosting` debit per IST calendar day from
`hosting_started_on`, `ref = "hosting:<date>"` (unique), at the first Gateway activity after
midnight and back-filled for days the desk was off. Idempotent across crash-loop restarts. Posts
while paused. Rate and on/off per desk come from `services.hosting` (absent = off).

## 6. Gate and notices

**Gate.** `before_agent_run` (implemented by the embedded and CLI runners): if `enforce` and
`balance + credit_limit ≤ 0`, return `{ outcome: "block", message }`. The message, delivered once
per sender per stop on the channel the message arrived from:

> Balance exhausted (₹−312 of ₹500 allowed). Ask TripIn Studio to recharge — your message is kept
> and will be answered after recharge.

Later messages from the same sender during the stop get no reply; they stay in the inbound queue
and are answered after a credit. `duties.run` calls `wallet.gate` before admitting a run; a refused
run is recorded `blocked — balance exhausted` and the owner notified. A run already in flight
finishes, including its `ai` steps and service charges. Mail arriving during a stop is not lost: the
dispatcher turn is blocked, the IMAP watcher re-offers unacknowledged mail on later sweeps.

**Notices** (owner route as Duties use it — WhatsApp, then Telegram), each once per transition:

- Low: balance first drops below `−credit_limit + low_balance` → "Balance ₹184 — about 2 days at
  this week's rate. Recharge: TripIn Studio." Re-armed after a credit lifts it above the line.
- Stopped: first refusal → "Vasu is paused — balance ₹−12, allowance ₹0 used up."
- Recharged: every credit → "Recharged ₹5,000 (UPI 4471…). Balance ₹4,988. Vasu is back on."

"Days left" = balance headroom ÷ trailing 7-day average daily spend; shown only with ≥ 3 days of
history. Changing `credit_limit` re-evaluates the stop immediately.

Not provided: per-turn cost caps, per-model budgets, per-member quotas.

## 7. Recharge, adjust, backfill

- `wallet.credit({ amountPaise, reference, note? })` — `operator.admin` only (on every desk only
  TripIn Studio's identity holds it). Appends `credit`, `source: "manual"`, `by: <identity>`;
  refuses a duplicate `reference`; posts the Recharged notice; clears `stopped_since`; re-evaluates
  the gate. Logged at info with the identity.
- `wallet.adjust({ amountPaise, note })` — `operator.admin`, signed; shown as its own kind.
- `wallet.settings({ creditLimitPaise?, lowBalancePaise?, enforce? })` — `operator.admin`.
- `wallet.backfill()` — `operator.admin`, one-time per desk. Reads `sessions.usage` per session per
  day since the desk's first session, prices each (session, day, model) with the current card,
  appends `tokens` debits dated on that day with `source: "backfill"` and best-effort attribution
  (rules 2–5 above), marks `(session_key, day)`, sets `backfill_done_at`. Running it again adds
  nothing. Known gaps, stated on the page: Duty `ai` steps before seam 1 existed were never
  recorded anywhere; hosting starts at `hosting_started_on`, not provisioning (TripIn Studio may
  post a one-off `adjustment` for the gap).
- Razorpay (later): the front-door host receives the webhook, maps the order to a desk, and calls
  that desk's `wallet.credit` with `source: "razorpay"`, `reference: <payment id>` — the
  `reference` uniqueness is the webhook-retry idempotency. No ledger change.

Read methods: `wallet.get` (balance, state, days-left, period totals by bucket), `wallet.ledger`
(paged entries with filters: period, activity, ref), `wallet.export` (CSV of the statement). Event:
`wallet.changed` after every write.

## 8. UI and chat

**Wallet page** (Control UI, sidebar next to Duties, `operator.read`; Vasudev brand):

- Header: balance, "about N days at this week's rate", credit limit if set, state Active / Low /
  Paused since <date>. Admin-only Recharge and Adjust (amount, reference, note).
- Where it went: period switch (Today / This month / Last 30 days / Custom); six tiles — Chat,
  Duties, Mail, System, Hosting, Integrations — with ₹ and tokens where they apply; one share bar
  per bucket (dataviz palette, light and dark).
- Drill-down: bucket → activities (Duties: one line per run with call count and ₹; Chat: per
  member; Mail: per mail; System: per automation; Hosting: per day; Integrations: per service) →
  entries (time, model/service, tokens or units, ₹).
- Statement: the raw ledger newest first with balance-after, CSV export.
- Admin strip (admin only): limit, low-balance threshold, contact, effective rate card,
  `unrecorded` counter, backfill button with its status.
- Live: subscribes to `wallet.changed` (same pattern as Duties' `changed`).

**Chat:** `/wallet` → "₹1,240 left · ₹310 this month (Duties ₹212, Chat ₹71, Hosting ₹24, System
₹3) · about 9 days at this rate." Roster members only. A `wallet_status` tool lets Vasu answer
balance questions from the ledger.

## 9. Config summary

`plugins.entries.wallet = { enabled, config: { contact, rateCard } }`; per-desk runtime state
(limit, threshold, enforce) lives in `wallet_state`, set from the page. Client desk template:
plugin enabled, `enforce` off until TripIn Studio credits the desk and turns it on.

## 10. Testing

- **Plugin (vitest):** ledger append-only and chain; paise rounding; duplicate reference refused;
  pricing incl. fallback/unpriced and refused service; attribution rules 1–5 on synthetic ids; gate
  at limits 0 and 5,000; in-flight run finishes; notices once per transition; recharge clears stop;
  hosting job per IST day, back-fill after downtime, no double post on restarts; backfill
  idempotent.
- **Core seams (core lane):** `runtime.llm.complete` fires `llm_output` with usage and session key;
  `tools.invoke` validates and carries `attribution` into hook context — failing-first tests.
- **UI (ui lane):** page renders from a mocked Gateway; admin strip hidden without
  `operator.admin`; CSV export.
- **Live proof on Amigos:** enable → `wallet.backfill` → page shows all tokens since 21 Sep by
  bucket, balance negative → `credit_limit` ₹5,000, `enforce` on → one chat turn, one Duty run to
  the options PDF, one heartbeat appear live → wallet token totals for the window equal
  `sessions.usage` for the same window (reconciliation) → with a temporary limit of ₹0, confirm the
  stop message, credit, confirm resume, restore the limit.

## 11. Rollout and out of scope

Amigos first as above; Prabhat and Prasthan by the same procedure, each with its own limit, when
TripIn Studio says so. Out of scope: Razorpay, a central multi-customer dashboard, per-run cost
caps, the Apify integration itself.
