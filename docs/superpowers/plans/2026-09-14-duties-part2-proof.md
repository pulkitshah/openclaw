# Duties Part 2 — live proof

Live proof of the Part 2 Duties work on a real Gateway, a real Google Workspace
mailbox, a real Telegram bot and the real Amigos Alliance portal. This is the
record of what was actually run, what worked, what did not, and what was fixed.

Nothing here is a summary of the code. Every claim below is something a command
printed or a person saw.

## Proof environment

An isolated Gateway, never the operator's live one:

| | |
| --- | --- |
| Gateway | port 19001, state `~/.openclaw-duties`, config `~/.openclaw-duties/openclaw.json` |
| Agents | `krishna` (the owner's authoring agent, claude-cli backend) and `duties-mail` (the dispatcher), `agents.ownership: "explicit"` |
| Channels | Telegram, polling, as the owner's own bot |
| Mail | `hooks.gmail` watching `pulkit.works@gmail.com` INBOX over Pub/Sub through a Tailscale Funnel; `gog` authorized for that account |
| Owner delivery target | `duties.settings.owner` = telegram chat `5995225650` |
| Build | source build of this branch; `pnpm build` before each Gateway restart |

The operator's live Gateway on 18789 was stopped for the duration and never
touched. Credentials, bot tokens, hook tokens and push tokens are not reproduced
anywhere in this document; home paths are written as `~`.

Every command below ran with:

```sh
export OPENCLAW_STATE_DIR=~/.openclaw-duties
export OPENCLAW_CONFIG_PATH=~/.openclaw-duties/openclaw.json
```

## What was proved

Authoring is driven entirely through the agent, as a real owner would:

```sh
node openclaw.mjs agent --agent krishna --session-key duties-p2 --timeout 900 --json --message '<the owner's instructions>'
```

The agent was never handed a selector, a step id or a JSON step body. It was
given the owner's words, and it explored the real site to turn them into steps.

### The Duty

`book-flight-by-mail` — a client emails a corporate travel request, and the Duty
parses it, checks the requester against the corporate register, signs in to
Amigos Alliance, emulates that client's account, searches the route, and carries
on to holding the ticket under an explicit owner approval.

Inputs: `[{ name: "mail", source: "mail" }]`.

Triggers:

```json
[
  { "kind": "mail", "match": "travel requests from clients (an itinerary in the body or an attached PDF)" },
  { "kind": "chat", "match": "a travel request typed in chat or its PDF" },
  { "kind": "manual" }
]
```

### The template and brand

`duties.template.list` and `duties.brand.get` on the proof Gateway:

```
flight-options | Flight options | pdf | slots: ["route:text","date:text","passengers:text","client:text","flights:rows","notes:prose"]
```

```json
{
  "brand": {
    "name": "Amigos Alliance",
    "primary": "#0B3C5D",
    "accent": "#F28C28",
    "email": "sales@amigosalliance.com",
    "footer": "Amigos Alliance · www.amigosalliance.in",
    "updatedAt": 1789343409282
  }
}
```

The agent wrote the template HTML itself from the owner's description, validated
it through `template_set`, rendered it with real data through
`template_preview`, and sent the resulting PDF to the owner's Telegram with the
`message` tool. The owner received it.

### The parse and register stages

Test mail body (the real LIC G703-1002 request, with a `From:` line because the
proof mail is sent by `gog` from a different address):

```
From: os.nagpur@licindia.com

Please book the tickets as per the details mentioned here under: -

Name  Gender Mobile  DOB  Age  Onward Date  Onward Time  From  To  Return Date  Return Time  From  To
NILESH SUDAM THORAT  M  9011071066  24/09/1992  33  02/10/2026  06:00  AURANGABAD  KOCHIN  10/10/2026  11:00  KOCHIN  AURANGABAD
AAKANSHA  F  9011071066  25/11/2001  24  02/10/2026  06:00  AURANGABAD  KOCHIN  10/10/2026  11:00  KOCHIN  AURANGABAD

Important Additional Information
INDIGO FLIGHT TIME 07:15 ON 02.10.2026 FROM AURANGABAD
INDIGO FLIGHT TIME 13:50 ON 10.10.2026 FROM KOCHIN

Regards,
LIC Office Services
```

Parsed by the `parse-request` `ai` step:

| key | value |
| --- | --- |
| requester | `os.nagpur@licindia.com` (from the `From:` line, not the envelope) |
| leadPassenger | NILESH SUDAM THORAT |
| mobile | 9011071066 |
| passengers | `{NILESH SUDAM, THORAT}`, `{AAKANSHA, AAKANSHA}` |
| origin → destination | IXU → COK |
| date | 02/10/2026 |
| adults | 2 |
| airline / time | IndiGo / 07:15 |

The no-surname rule is applied as the owner stated it: a passenger given only
`AAKANSHA` becomes first name AAKANSHA, last name AAKANSHA.

`match-client` carries the corporate register (113 email rows read from
`~/Downloads/CORP-MAIL IDS.xlsx` at authoring time) as its `params.input` and
returned `matched "true"`, `ambiguous "false"`, clientId **91925**, LIFE
INSURANCE CORPORATION OF INDIA NAGPUR, Maharashtra. `register-gate` passed it
through.

The agent found, unprompted, that two register addresses map to several client
ids. The owner's ruling: those must not book. `match-client` returns
`ambiguous`, and `register-gate` stops with a reason that distinguishes "not in
the corporate register" from "maps to more than one client — book this one by
hand".

Register lookup as a first-class Duty feature is Part 3. For this proof the rows
are embedded in the step.

### The emulate stage, learned live

The owner described emulation in words. The agent opened the real Dashboard and
reported what is actually there:

- The control is a jQuery UI autocomplete on the Dashboard header
  (`#txtCorpID`, placeholder "Emulate Account"), a hidden `#hdnnCorpID` that a
  picked suggestion fills with the account number, and an icon-only arrow button
  that runs `EmulateUser()`. Typing alone does not set the hidden number — a
  suggestion has to be clicked first.
- Stage 1, typing `Maharashtra`, gives exactly one suggestion
  `[90872]  AMIGOS Maharashtra ;BOM,MH,IN`. After the arrow: a blue bar
  "Emulating User Ask ! [Switch Back]" and "Welcome AMIGOS Maharashtra !".
- Stage 2, the client id `91925` returns a single suggestion reading **"Not
  found"** and leaves the hidden number empty — exactly as the owner remembered.
  `NAGPUR` and the full client name both return the one real suggestion, so
  `{{out:clientName}}` works as the search text.
- After stage 2 there are **two** Switch Back entries, a
  "Your Balance: INR 55637.69" badge, and "Welcome LIFE INSURANCE CORPORATION OF
  INDIA NAGPUR !".

The agent also caught that the owner's suggested probe does not work: the text
"Emulating User" is already present after stage 1, so it cannot confirm stage 2.
The checks verify the welcome text against `{{out:state}}` and
`{{out:clientName}}` instead. Reruns reset to the base account first (the
`.btn-emulate` whose id ends `__0`) rather than emulating on top of an existing
emulation.

### The search and collect stages, against the live portal

The agent explored the two airport codes rather than trusting the old Duty's
DEL/BOM shape: `IXU` offers one suggestion
`Aurangabad, IN (Chikkalthana Airport - IXU)`, `COK` offers
`Kochi, IN (Kochi Airport - COK)`, and picking one fills hidden fields
`HdnFromI = IXU_Aurangabad_IN` / `HdntToI = COK_Kochi_IN`. Each field has a gate
that reads the code back and compares it with `{{out:origin}}` /
`{{out:destination}}`, so a mis-picked city stops the run instead of searching
the wrong route. Adults is a read-only −/+ spinner, so the step clicks until the
count matches `{{out:adults}}` and checks the summary reads `2 - Economy`.
Direct Flight Only was ticked and got unticked. Search landed on
`/Flight/DResult` with the header confirming IXU → COK, Fri 02 Oct 2026,
Economy, 2 Adults.

The collect step read 19 real flights off the results page. The requested
departure is there:

```json
{"airline":"IndiGo (6E-6126, 6E-673)","depart":"07:15 Aurangabad","arrive":"14:25 Kochi","fare":"₹ 26,722"}
```

which matches the Part 1 live test's 6E-6126 + 6E-673 pairing, and whose Agency
Fare is ₹ 27,772 — the fare the owner recorded then. Fare labels are not
uniform: IndiGo offers Regular / Agency Fare / Flexible Plus / IndiGo Upfront,
Air India offers Corporate Fare / Regular Fare, Air India Express offers
VALUE / CLASSIC / FLEX. The owner's rule is therefore "Agency, else Corporate,
else the cheapest on that flight".

Two limits of the runner shaped the emulate and search checks, and are worth
recording as they are contract, not defect: `text_matches` and a `wait`'s text
are used raw without placeholder substitution, so they cannot carry
`{{out:state}}`; and an `evaluate` script dies if the page reloads underneath it.
The steps work around both by marking the page before an action and waiting for
the reload to clear the mark, then comparing text in a later `evaluate` whose
result is gated with `equals`. No parsed value is written into page script.

### The booking stages, against the live portal

Run `969477a9` drove the real portal from the mail text to the hold confirmation
and stopped there. **Nothing was held.**

The passenger form, as the Duty filled it:

| Field | Adult 1 | Adult 2 |
| --- | --- | --- |
| Title | MR | MS |
| First name | NILESH SUDAM | AAKANSHA |
| Last name | THORAT | AAKANSHA |
| Nationality | India (preset) | India (was blank, set by the Duty) |
| Contact mobile | 9011071066 (replaced the agency's prefilled number) | 9011071066 |
| Contact email | prefilled, untouched | copied from Adult 1 |

Date of birth, meals, seats, reporting details, the address block and GST are
left alone. Titles come from the mail's Gender column (M → MR, F → MS), which
the parse step now reads because the site requires one; a passenger with no
gender stops the run.

Fares offered on the chosen card (IndiGo 6E-6126 / 6E-673, 07:15 → 14:25):
Regular ₹ 26,722, **Agency ₹ 27,772**, Flexible Plus ₹ 28,596, IndiGo Upfront
₹ 33,894. The rule picked Agency — the same fare the Part 1 live test recorded.

Payment offered only Credit Account on this client (no Accounting Balance), so
the `when` took the Credit Account branch, then Hold, then the terms box.

The hold confirmation page, read back by the Duty:

> Cart Booking Reference : AAMH1775599 … Flights: IndiGo 6126 07:15 Fri 02-Oct
> Aurangabad → 08:15 Mumbai · **Agency Fare** · IndiGo 673 12:35 Mumbai → 14:25
> Kochi. Guest Details: Adult1 MR NILESH SUDAM THORAT, Adult2 MS AAKANSHA
> AAKANSHA. **₹ 27772.00** [Cancel] [Hold Booking Proceed]

Two things the live run taught the Duty, both now in its steps:

- Amigos blocks Proceed Hold Booking with an alert, "2 Please Enter EmailID !!",
  until every passenger has a contact email. This was the real cause behind run
  `b37f55cb`; defect 5 was what turned the blocked page into a crash. A blank
  passenger email now takes Adult 1's prefilled address, and the hold-ready gate
  mirrors the site's own validation so a problem stops the run with a reason
  instead of freezing on an alert.
- The PNR read was case-insensitive and could have saved "Booking" (from "Cart
  Booking Reference") or "Status" (from "PNR Status") as the PNR. It now
  requires an uppercase six-character code and falls back to the cart reference.

The unheld cart `AAMH1775599` was left behind the open confirmation with a
roughly nine-minute timer, and expires on its own.

## What failed, and what was fixed

Eight defects were found by running the thing. Six are fixed on this branch,
each with a test that fails without the fix; two are written up below. Five were
first spotted by the authoring agent from its own run evidence; the last, and
the worst for this flow, only surfaced when the approval gate was finally probed
end to end.

### 1. `ai` and `ask` steps could not run at all on a multi-agent install

`fix(duties): run ai and ask steps under the session that started the run`
— commit `7e2d3b7cfa`

The very first authored step failed:

```
parse-request (ai) — failed in 9ms
"Multiple agents are configured, but session key "main" has no explicit owner."
```

`index.ts` built both adapters with a hardcoded `sessionKey: "main"`.
`tools.invoke` and `question.request` resolve the owning agent from the session
key, and under `agents.ownership: "explicit"` with a second agent — which the
`duties-mail` dispatcher itself makes mandatory — `"main"` has no owner. Every
`ai` and `ask` step of every Duty failed before it ran.

A run already records the session that started it, so that session now owns the
run's model and question calls; a run that recorded only an agent falls back to
that agent's own main session, and `"main"` is left only for a run with no
recorded origin.

The authoring agent diagnosed this one itself, from the run evidence, down to
the file and line — worth noting, because it is the loop working as intended.

### 2. Placeholders were not resolved inside object or array params

`fix(duties): resolve placeholders inside object and array params`
— commit `1250edce20`

Silent, and the worst of the five. Placeholders were substituted only when a
param was a string at the top level. An `ai` step's `params.input` is routinely
an object — that is how a model is handed a named payload — so
`{{out:requester}}` inside one reached the model as literal text. Nothing
failed: the step ran, the model answered about the placeholder, and the wrong
answer flowed on down the run. The register lookup quietly matched nobody.

Every string leaf is now resolved through arrays and plain objects. Nesting
widens nothing: the per-leaf resolver still decides which placeholder kinds are
legal, so a `{{cred:...}}` buried in an object reaches the cred-free resolver
and fails the step, and `validateDuty` already walked nested params to reject it
at authoring time.

### 3. `duties setup-mail` printed less than half the config it forces

`fix(duties): setup-mail prints the whole config the dispatcher forces`
— commit `4b7b603417`

The command described only the dispatcher agent and the Gmail mapping. Pasting
that much breaks three things at once, each of which was found the slow way, one
failed run at a time:

- it makes the install multi-agent with no explicit owner, so the operator's
  existing channels stop answering and every `ai` step fails (defect 1);
- `llm-task`, the bundled tool every `ai` step runs through, is off by default
  and nothing in a Duties install turns it on;
- the hook receiver rejects the per-message session key the printed mapping
  itself asks for, so no mail reaches the dispatcher at all.

The agent snippet now carries `agents.ownership`, `agents.defaults.systemAgent`,
a `bindings` example (using the binding schema's own `comment` field, so the
note travels with the config instead of the terminal scrollback) and the
`llm-task` plugin and tool entries. The hooks snippet carries
`defaultSessionKey`, `allowRequestSessionKey`, `allowedSessionKeyPrefixes` and
`allowedAgentIds`.

### 4. `toStepId` did not stop a run at a `when` gate

`fix(duties): stop at toStepId when it names a when gate` — commit `b963890bf6`

`duty_run { toStepId }` was honoured only after a regular step, so naming a gate
ran the whole Duty instead of stopping at it. Authoring works by running up to a
point and inspecting the page that is left open; a stage that silently runs on
reaches steps the author has not reviewed. On this Duty that is the difference
between looking at a results page and clicking through a booking flow. The agent
found it when a stage-A-only test ran on through Search.

`WhenNode.id` is now typed as the optional field it already was in practice, so
a gate the author gave an id can be named like any step.

### 5. One absent `saveAs` key threw away a 59-step live run

`fix(duties): do not store an explicit undefined for a saveAs key a step did not return`
— commit `81a1b0aa51`

Run `b37f55cb` drove the live portal through the fare, Book, the passenger form,
payment mode and the hold-ready gate — 59 steps — and then died at persistence:

```
plugin state value at value.outputs.holdSummary must be JSON-serializable
```

`saveAs: [...]` wrote `outputs.<key> = undefined` for a key the step's result did
not carry, and the host's plugin state store rejects explicit `undefined`. So a
single missing key failed the whole run after every step had already run, with a
message that names neither the step that produced it nor what to do about it.
The key is now left unset, which is exactly how `{{out:key}}` already read it.

The runner is the producer of that invalid state, so the repair is there rather
than in a sanitizer at the store.

### 6. Every `template` step fails under the default browser policy

**Recorded as a Part 2 gap, deliberately not fixed.** The browser plugin owns
this policy and the ruling on this proof was to record it, not to change that
plugin.

```
could not open the render page at http://127.0.0.1:19001/plugins/duties/render/<token>:
browser navigation blocked by policy | INVALID_REQUEST
```

To make a PDF, the plugin publishes the HTML on a single-use,
plugin-authenticated route on the Gateway's own loopback port and has the
managed browser open and print it. The browser plugin's SSRF guard
(`assertBrowserNavigationAllowed` → `resolvePinnedHostnameWithPolicy`) refuses
loopback under the default policy. So on a default install every `template`
step, and every `template_preview`, fails — and the failure is a browser policy
message that says nothing about Duties.

The proof was unblocked with the narrowest documented knob, everything else
still blocked. This is the exact line added to
`~/.openclaw-duties/openclaw.json`, and any install that wants `template` steps
to work needs it today:

```json
{ "browser": { "ssrfPolicy": { "allowedHostnames": ["127.0.0.1"] } } }
```

With it, `duties.template.preview` returns a real `application/pdf`; without it
the render fails on every attempt.

That is a workaround, not the fix. This is not a model-chosen URL: the plugin
constructs it, it points at this Gateway's own plugin route, and it carries a
single-use token. Requiring every operator to widen a security policy to make a
shipped feature work fails "defaults should produce a working, understandable
result". The fix belongs to an owner decision that was out of scope here —
either Duties reaches its own rendered HTML without a policy-checked navigation,
or the browser plugin gains a narrow exemption for this Gateway's own
plugin-authenticated routes. Whichever it is, it needs the browser plugin's
owner, because it is that plugin's security contract.

### 7. A config hot reload leaves an agent session with no tools until restart

**Not fixed — reproducible, recorded.**

Twice, editing `~/.openclaw-duties/openclaw.json` while an agent session was
live left that session permanently unable to reach the tool server:

```
[mcp-loopback] request handling failed: Plugin canvas was reloaded or disabled; use its current tools.
```

The next agent run then connects to the tool server once, gets HTTP 500 /
JSON-RPC `-32603`, and runs the whole turn with **no** OpenClaw tools at all —
not `duty_*`, not `browser`, not `message`. It does not reconnect during the
turn, and resuming the session does not help. Only a full Gateway restart
clears it.

The turn does not fail loudly: the agent simply has no tools and has to work out
why. Three agent turns were lost to this before the pattern was clear. Every
config change in this proof was followed by a Gateway restart from then on.

### 8. Every hyphenated `ask` step failed before it reached anyone

`fix(duties): send a question id the Gateway accepts for an ask step`
— commit `7182a28152`

The ask adapter passed the step id straight through as the question id, but the
two vocabularies do not agree. A duty step id is a slug
(`^[a-z0-9][a-z0-9_-]{0,63}$`, duty.ts) so hyphens and a leading digit are legal
— and hyphens are exactly how these steps get named. `question.request` requires
`^[a-z][a-z0-9_]*$`. So the ask failed with a raw schema error:

```
invalid question.request params: at /questions/0/questionId:
must match pattern "^[a-z][a-z0-9_]*$"
```

Both ask steps in the authored Duty are named `ask-hold` and
`ask-which-flight`, so **the hold approval could never have been raised**. This
surfaced only because the ask was probed end to end on the live Gateway; every
earlier staged run had stopped before the gate. The step id is now translated
for the wire, and the same translation reads the answer back, since the answer
map is keyed by the id that was sent.

## Blocker A, resolved: asks and status lines now reach the owner

`fix(duties): asks and status lines reach the chat origin or the owner`

The Duty's approval gate is an `ask` step, and the owner is meant to answer it
on Telegram. That did not work, for two independent reasons, both found by
probing the live Gateway rather than by reading code.

**Where the question lived.** An ask was raised in the run's own origin session.
For a mail-triggered run that is the `duties-mail` dispatcher's `hook:gmail:*`
session, which belongs to an agent the owner never talks to. Status lines had
the mirror-image hole: they were posted only for chat origins, so an unattended
mail run — the one worth reporting on — reported nowhere at all.

Both now follow the rule `deliver` already uses: back to the chat the run came
from, otherwise to the configured owner. The owner's session key comes from the
host's own `resolveAgentRoute`, so the configured `bindings[]` decide which
agent owns that channel and the session-scope rules decide whether an owner DM
collapses onto that agent's main session. With no owner target configured the
ask fails loudly with the existing `no owner target configured — set it on the
Duties page`.

**Whether anyone was told.** Choosing the session decides who can answer, not
whether anyone is notified. Probed twice against the proof Gateway — once with
the dispatcher's `hook:gmail:*` session, once with the owner's own
`agent:krishna:main` — `question.request` accepted the question and returned an
id, and **no Telegram message was sent either time**. Channel delivery of a
question is performed by the agent turn that raises it
(`runWithQuestionChannelDeliveries`/`registerDelivery`,
`src/infra/question-channel-runtime-internal.ts`), and a Duty run has no such
turn. So the run now also announces the question and its options through the
`deliver` adapter, best-effort, so a run still parks correctly if the note
cannot be delivered.

Verified live, on a run given a **mail** origin:

```
[telegram] outbound send ok chatId=5995225650 messageId=280 …
[telegram] outbound send ok chatId=5995225650 messageId=281 …
```

— the status line and the ask itself — with the run then sitting at
`status: needs_input`,
`waitingOn: { questionId: "…", stepId: "ask-owner" }`. This probe is also what
uncovered defect 8: the first attempt failed outright on the question-id
pattern.

## Blocker B, still open

### B. A self-sent mail can never trigger the Gmail hook

The plan was to send the test mail with `gog` from the watched account to
itself. It was sent successfully (`1a09d65c7e4b31b2`, with the G703-1002 PDF
attached), and nothing dispatched in six minutes of polling.

The message's labels are the reason:

```json
"labelIds": ["UNREAD", "SENT", "INBOX"]
```

The watcher is started with `--exclude-labels SPAM,TRASH,DRAFT,SENT`
(`GMAIL_WATCH_EXCLUDED_LABELS`, `src/hooks/gmail.ts:27`), so a message the
account sent to itself is filtered out before it is ever offered to the hook.
Gmail refuses to remove that label through the API
(`400 invalidArgument: Invalid label: SENT`), and the exclusion list is a
hard-coded constant with no config override.

The exclusion is right for production — an agent's own outbound mail should not
wake it. But it also means the obvious way to verify a Duties mail setup, send
yourself a test, silently does nothing, which is the same class of problem as
defect 6: a supported path that fails quietly. A config override, or a
documented "send from another address" note in `duties setup-mail`, would close
it. Either is a new configuration surface, so it was left for the owner rather
than added here.

The consequence for this task: **the mail proof needs one mail sent from any
address other than the watched account.** Everything else on the mail path is
verified — `duties.mail.status` reports all four checks true, the watcher is
running against `pulkit.works@gmail.com` over the Tailscale Funnel, and the
dispatcher agent, its mapping and its `gog` exec allowlist are all in place.

## Setup gaps that were not code defects

Recorded because they cost real time and the next operator will hit them:

- The Part 2 template and brand tools (`template_list/get/set/preview`,
  `brand_get/set`) and `message` were not in `tools.alsoAllow`, so the authoring
  agent could not use the feature it is meant to author with. The duty tools
  were there; the newer ones had never been added. There is no setup command
  that tells an operator the authoring agent's required tool allowlist —
  `duties setup-mail` covers the dispatcher only.
- `agents.defaults.systemAgent.agentId` was unset. An `ai` step reaches a model
  through an ambient completion, which needs a named owner on a multi-agent
  install. This is now in the `setup-mail` snippet (defect 3).

## Run evidence

`duties.runs.recent` on the proof Gateway, oldest last. Every failure is one of
the defects above, kept deliberately as the before/after record:

```
969477a9 book-flight-by-mail ok     steps=60 chat
b37f55cb book-flight-by-mail failed steps=59 chat  plugin state value at value.outputs.holdSummary must be JSON-serializable
e43553a8 book-flight-by-mail ok     steps=44 chat
fbb701ba book-flight-by-mail ok     steps=43 chat
a0ca02d1 book-flight-by-mail ok     steps=42 chat
3ba91b0f book-flight-by-mail ok     steps=10 chat
47307eeb book-flight-by-mail ok     steps=2  chat
1e62a788 book-flight-by-mail ok     steps=2  chat
d74951d5 book-flight-by-mail ok     steps=2  chat
75f8b3a3 book-flight-by-mail ok     steps=2  chat  The requester is not in the corporate register.
eb758c38 book-flight-by-mail failed steps=1  chat  parse-request  ai step failed: Tool not available: llm-task
77a910eb flight-options-by-mail failed steps=1 chat parse-request  session key "main" has no explicit owner
```

The staircase is the authoring loop: 2 steps (parse and register), 10 (sign-in),
42–44 (emulate, search, collect), 59–60 (fare, Book, passengers, payment, hold
confirmation). `75f8b3a3` is the register gate doing its job on an unlisted
requester, with the stop reason intact in the run report.

`flight-options-by-mail` was the first draft; it was rebuilt as
`book-flight-by-mail` when the scope grew to holding the ticket, and deleted
through `duties.delete` so the dispatcher has exactly one Duty with triggers.

## What is not proved yet

Honest list, because the useful part of this document is the boundary:

- **No mail-origin run exists.** Every run above has `origin.kind === "chat"`
  (the authoring turns). The mail path is blocked on blocker B and needs one
  mail from an outside address.
- **No chat-origin run from Telegram.** That needs the owner to message the bot.
- **The Approve path has never run.** Every staged run stopped at or before the
  approval ask, deliberately: no hold has been placed. The ask itself is now
  proved to reach Telegram from a mail-origin run, but only with a probe Duty. What Amigos shows after
  Hold Booking Proceed is unseen, so the PNR read and the final `deliver` are
  authored but unexercised.
- **The not-found branch has never run**, because the requested flight is always
  found. That branch is the only one that renders and delivers the options PDF,
  so the `template` → `deliver` chain is proved by `template_preview` plus a
  delivered PDF, not yet by a run's own `files[]` row.
- **Amigos duplicate-booking popup.** The site checks for duplicate passenger
  names at final submit. The same test passengers plus an existing cart could
  raise it, and the Duty has no step vocabulary for a JavaScript alert, so it
  would time out rather than explain itself.

## Gates

Run after each of the seven code commits:

```sh
node scripts/run-vitest.mjs extensions/duties   # 223 passed
pnpm tsgo:extensions
pnpm check:assertion-safety                     # ratchet OK
./node_modules/.bin/oxfmt <changed files>
```

Each fix has a test that fails without it, and each was confirmed red before the
change: the session-key wiring is asserted at the real call site in
`index.test.ts` rather than only on the helper, the nested-placeholder case
reproduces the literal `{{out:requester}}` arriving at the model, the gate case
proves the step after the gate does not run, the `saveAs` case proves the
outputs object survives the JSON round-trip the store requires, and the setup
snippets are asserted key by key — including that the hook prefix allowlist
actually covers the session key the printed mapping asks for.

## What the owner needs to do next

1. **Send the request mail from any address other than `pulkit.works@gmail.com`**
   to `pulkit.works@gmail.com`, subject `Fwd: Ref Id G703-1002 travel request`,
   body as quoted above (the `From: os.nagpur@licindia.com` line matters — it is
   what the register lookup matches), ideally with the G703-1002 PDF attached.
   A mail the account sends to itself is filtered out before the hook sees it.
2. **Message the Telegram bot** with the same request, for the chat-origin run.
3. **Answer the approval on Telegram.** The run will message you with the
   flight, fare, passengers and client, then `Approve / Decline`. Answer
   Decline if you would rather not place a real hold on the live account.

The proof Gateway on 19001 is left running with `book-flight-by-mail` saved and
active, so both runs can be observed as they happen. The operator's Gateway on
18789 is still stopped and was never touched.
