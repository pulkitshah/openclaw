# Duties Part 2 — triggers, templates → PDF, deliver

Extends [Duties — core plugin and UI](./2026-09-13-duties-core-design.md) (Part 1, shipped on
`feat/duties`). Part 1 gives a Duty that the agent authors from instructions and the plugin replays
without the model except `ai`/`ask` steps. Part 2 makes the flight-search Duty useful end to end:
a request arrives (mail or chat), the Duty runs, the flight options are rendered into a branded
PDF, and the PDF is delivered back to whoever asked.

Reference flow (the owner's case): a travel-request mail (often with a PDF attached) reaches the
agency's Google Workspace mailbox → the Duty parses it → searches on the portal → renders a
"flight options" PDF → sends it to the owner on Telegram. The same request typed or dropped as a
file in Telegram gets the PDF back in that chat.

## 1. Decisions (owner, 2026-09-14)

- **Every trigger is an agent turn that ends in `duty_run`.** No message is claimed before the
  model (`before_dispatch` matching was considered and rejected). Mail, chat, and "run it on that
  earlier mail" all go through an agent.
- **Triggers in this slice:** incoming Gmail (Google Workspace), a Telegram/WhatsApp message or
  file drop, and a request in chat to run a Duty on an earlier mail. Manual (UI ▶ Run) stays.
- **Deliver rule:** if the run was triggered from a chat, the result goes to that same
  chat/person; otherwise it goes to the owner. Replying to the mail's requester is out of scope.
- **PDF template:** the agent drafts a branded HTML template from the owner's description; the
  owner refines it in chat and sees the rendered preview.
- **Out of scope here:** model-free mail watcher, schedule and webhook triggers, MCP / file /
  print / for-each steps, failure repair, the build-session machine view and its Template tab,
  desktop steps, registers. Each is a later slice.

### 1.1 Planning deviations

- The owner delivery target lives in the plugin keyed store `settings` namespace, set on the
  Duties page, not in plugin config.
- Rendered HTML is served once over a Gateway HTTP route (`auth: "plugin"`, single-use token,
  60 s TTL) because the browser plugin only navigates to http(s).
- Rendered PDFs are files under `<stateDir>/plugins/duties/files/<runId>/`, not blob entries.
- `openclaw duties setup-mail` prints config snippets and commands and verifies prerequisites, it
  does not mutate openclaw.json.
- The Gmail hook payload documents only `id, from, subject, snippet, body` — `threadId` is not
  relied on.

## 2. Verified platform facts this design builds on

| Fact                                                                                                                                                                                      | Where                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The Gmail hook always produces an **agent turn** (`action: "agent"` or `"wake"` only); the preset template carries `from/subject/snippet/body`, one isolated session per message          | `src/gateway/hooks-mapping.ts` (gmail preset), `docs/gateway/config-hooks.md`          |
| Gmail one-time setup: Pub/Sub topic + `gog` OAuth + `openclaw webhooks gmail setup --account <email>`; the Gateway auto-starts `gog gmail watch serve`                                    | `docs/automation/cron-jobs/gmail.md`                                                   |
| A plugin tool factory receives `sessionKey`, `sessionId`, `messageChannel`, `agentAccountId`, `agentId` for the calling turn                                                              | `src/plugins/tool-types.ts` (`OpenClawPluginToolContext`)                              |
| A plugin service can send a message with attachments without a model turn: `sendDurableMessageBatch` (`mediaUrls`)                                                                        | `openclaw/plugin-sdk/channel-outbound`, `src/plugin-sdk/reply-payload.ts`              |
| Channel targets are strings: Telegram chat id / `@username`, E.164 for WhatsApp, etc.                                                                                                     | `src/infra/outbound/channel-target.ts`                                                 |
| HTML → PDF exists: browser plugin `POST /pdf { targetId }` → `{ ok, path }` (Chromium `page.pdf`, print background on, no other options); unsupported only on `existing-session` profiles | `extensions/browser/src/browser/routes/agent.snapshot.ts`, `pw-tools-core.snapshot.ts` |
| `llm-task` accepts `prompt`, `input` (any JSON), `schema` — text only, no files                                                                                                           | `extensions/llm-task/src/llm-task-tool.ts`                                             |
| Core has no PDF text extraction; the agent itself reads PDFs (proved in the Part 1 live test)                                                                                             | repo grep; Part 1 proof                                                                |

Consequences: mail dispatch needs a (small) model turn; PDF text reaches the Duty as text supplied
by the dispatching agent; delivery and rendering are model-free.

## 3. Triggers and inputs

### 3.1 Trigger declarations

`DutyTrigger` becomes:

```ts
type DutyTrigger =
  | { kind: "manual" }
  | { kind: "mail"; match: string } // plain words the dispatcher reads, e.g. "travel requests from *@licindia.com"
  | { kind: "chat"; match: string }; // plain words, e.g. "a forwarded travel request or its PDF"
```

`match` is descriptive: it is rendered in the UI and included in the dispatcher's instructions.
There is no matching engine. Validation: non-empty `match` for `mail`/`chat`; at least one trigger
(Part 1 rule).

### 3.2 Mail

The plugin owns a **dispatcher agent** `duties-mail`:

- tools: `duty_list`, `duty_get`, `duty_run`, the Gmail read tools the host exposes to agents
  (`gog`-backed), and the host `message` tool (used only to tell the owner about a mail it could
  not dispatch); no browser, no exec;
- skill: `duties` (the Part 1 skill gains a "dispatch" section);
- session mode isolated per mail (host default for the Gmail preset).

The hook mapping is the Gmail preset with a custom `messageTemplate` that adds
`Message-Id: {{messages[0].id}}` and `Thread-Id: {{messages[0].threadId}}` when present, and
`agentId: duties-mail`. The turn's instruction (skill text): list active Duties with a `mail`
trigger; if exactly one fits the mail, fetch attachments by message id, extract their text, and
call `duty_run` with a `mail` input; if none fits, end the turn with a one-line note; if several
fit, run none and message the owner target (§5) naming the mail and the candidate Duties — an
`ask` card is not available in an isolated hook session, so the owner re-triggers from chat.

### 3.3 Chat and "that earlier mail"

The owner's normal agent, unchanged, with the skill's dispatch section: for a dropped file it reads
the file and passes `file` (and its text) inputs; for "run X on the mail LIC sent yesterday" it
uses Gmail search, reads the message and attachments, and calls `duty_run` with a `mail` input.
Ambiguity is resolved by asking the owner in the same chat (normal agent behavior).

### 3.4 Inputs

`DutyInput.source` gains `mail` and `file`; `duty_run.inputs` is validated against the Duty's
`inputs[]`:

```ts
type MailInput = {
  from: string;
  subject: string;
  body: string;
  receivedAt?: string;
  messageId?: string;
  threadId?: string;
  attachments?: Array<{ name: string; text?: string; path?: string }>;
};
type FileInput = { name: string; path: string; text?: string };
```

`{{in:<name>.<field>}}` reaches nested fields (`{{in:mail.body}}`, `{{in:mail.attachments.0.text}}`).
A missing required input fails the run before step 1 with the input name.

### 3.5 Origin

`DutyRun.origin` is recorded from the tool context when `duty_run` is called:
`{ sessionKey, channel?: messageChannel, accountId?: agentAccountId, agentId?, kind: "chat" | "mail" | "manual" }`.
`kind` is `mail` when `agentId` is the dispatcher, `chat` when `messageChannel` is a chat channel,
else `manual` (UI/CLI). UI runs and gateway `duties.run` calls record `kind: "manual"`.

## 4. Templates and PDF

### 4.1 Model

Keyed-store namespaces `templates` and `brands` (Part 1 store pattern).

```ts
type Brand = {
  id: "default";
  name: string;
  logoDataUrl?: string;
  primary?: string;
  accent?: string;
  phone?: string;
  email?: string;
  footer?: string;
  updatedAt: number;
};
type Template = {
  id: string;
  name: string;
  kind: "pdf" | "message";
  html: string; // for message: plain text with slots
  slots: Array<{
    name: string;
    kind: "text" | "rows" | "prose";
    description: string;
    columns?: string[];
  }>;
  usedBy?: string[];
  updatedAt: number;
};
```

Slot syntax in `html`: `{{slot:name}}` for text/prose; rows use a repeated block
`{{#rows:name}} … {{col:airline}} … {{/rows:name}}`. The brand is available as `{{brand:field}}`.
No logic beyond substitution and row repetition (deterministic, no template engine dependency).

### 4.2 `template` step

```ts
{ kind: "template", params: { template: string, format?: "pdf" | "message",
    fill: Record<string, { from: string } | { ai: string }>,  // from: "{{out:flights}}" | ai: instruction
    saveAs?: string } }
```

Execution: `from` slots resolve through the cred-free resolver (Part 1); rows expect an array of
objects whose keys match `columns`. `ai` slots are filled by **one** `llm-task` call with a JSON
schema of the `ai` slot names, given the run's outputs and inputs as `input`. Any slot left empty
after both passes fails the step: `slot "notes" could not be filled`. Substitution then renders:
`message` → the text goes to `outputs[saveAs]`; `pdf` → HTML is written to a temp file under the
plugin's state dir, opened in a managed-profile tab (`/tabs/open` with a `file://` URL), rendered
with `POST /pdf`, the tab closed, and the PDF stored as a run file (blob `evidence` + path in
`run.files[]`). `{{file:<stepId>}}` resolves to that path for later steps. Evidence: slot values
(redacted), file name and size.

### 4.3 Agent tools

`template_list`, `template_get`, `template_set` (validated: slots referenced in `html` exist and
vice versa), `template_preview { id, data? }` → renders with the given data or with placeholder
values, returns the PDF path (the agent sends it to the owner with the message tool during a
build), `brand_get`, `brand_set`.

### 4.4 Authoring loop (skill)

When a template step is needed: propose the template from the owner's description (or the
Vasudev-style options layout), state **how each slot is filled** (mapped output, `ai`, or a new
step to add), `template_set`, `template_preview` from the last test run's outputs, send the
preview, iterate on feedback, then add the `deliver` step. Never invent slot values; an `ai`
slot's instruction says what to write and from which outputs.

## 5. Deliver

```ts
{ kind: "deliver", params: { to: "trigger" | "owner" | string,   // string = explicit channel target
    channel?: string, text?: string, files?: string[] /* {{file:…}} placeholders */ } }
```

Resolution: `"trigger"` → the run's `origin` route when `origin.kind === "chat"`, else falls back
to `"owner"`; `"owner"` → `plugins.entries.duties.config.owner = { channel, target }`; an explicit
string target uses `channel` (required then). Sending uses `sendDurableMessageBatch` with
`mediaUrls` = the resolved file paths. Evidence: channel, target (masked to its last 4 characters
for phone numbers), message ids, error text. A `deliver` with no resolvable route fails the step
with `no owner target configured — set it on the Duties page`. The plugin uses the same send path
for run status lines to the triggering chat ("Running <Duty>…", "Done — <report>",
"Failed at <step>").

## 6. Runner changes

- `STEP_KINDS` += `template`, `deliver`; per-kind param validation as in Part 1's `validateNodes`.
- `DutyRun` += `origin`, `files: Array<{ stepId, name, path, blobId, bytes }>`; run files older
  than 30 days are deleted by the Part 1 orphan/cleanup pass.
- Placeholders: `{{file:<stepId>}}` (deliver/template params only), nested `{{in:…}}` paths.
- Adapters: `TemplateAdapter { render(html, format) }` over the browser adapter (managed profile)
  and `DeliverAdapter { send(route, text, files) }` over `sendDurableMessageBatch`; both injectable
  for tests like Part 1's adapters.
- Cancellation and `needs_input` semantics unchanged; a cancelled run never delivers.

## 7. Setup and health

`openclaw duties setup-mail --account <email>` (plugin CLI via `api.registerCli`):

1. writes the `duties-mail` agent entry (tool allowlist, skill, model = owner's default);
2. writes the Gmail hook mapping (custom template, `agentId`, isolated session);
3. runs the host's `webhooks gmail setup` when `gog` is authorized, otherwise prints the exact
   remaining commands (Pub/Sub topic, `gog` auth) and stops.

The Duties page shows **Mail trigger** health: hook enabled, watcher running (host status), last
mail dispatched (from the dispatcher's last `duty_run`). All three are read from existing host
state; nothing is polled by the plugin.

## 8. UI

- **Board / Duty page:** trigger chips from `triggers[]` ("Mail: travel requests from
  *@licindia.com", "Telegram", "Manual"); runs show "Delivered to <channel>".
- **Run page:** file rows (name, size, open/download via `duties.run.file { runId, stepId }`),
  deliver rows (recipient, status).
- **Templates page:** cards (name, kind, used-by, updated), preview (renders with placeholder
  data → PDF shown inline via `duties.template.preview`), "Edit with agent"; **Brand** editor
  (name, logo upload → data URL, colours, phone, email, footer). The brand form and the Logins form
  are the only editable forms in the UI; templates themselves are edited through the agent.
- **Settings strip on the Duties page:** owner delivery target (channel + target) and mail-trigger
  health.

Gateway methods added: `duties.template.list/get/preview` (read), `duties.template.delete`,
`duties.brand.get/set` (write), `duties.run.file` (read), `duties.settings.get/set` (owner target;
admin), `duties.mail.status` (read).

## 9. Storage

Keyed store: `templates`, `brands`, `settings`. Blob store `evidence` also holds rendered files
(≤ 10 MB each). Temp HTML lives under the plugin state dir and is deleted after rendering. No new
SQLite tables, no new dependencies.

## 10. Errors

Every failure names the step and the next action: unfillable slot; unknown template; rows slot
given a non-array; `/pdf` unsupported on the configured profile ("switch `browserProfile` to a
managed profile"); no owner target; channel send error (host message). Mail dispatch problems are
visible on the Duties page (watcher not running, hook disabled) and in the dispatcher's isolated
session transcript.

## 11. Testing

- Unit: trigger/input validation; nested `{{in:}}`; template substitution (text, rows, prose,
  brand, missing slot, redaction of secrets in slot values); deliver target resolution
  (trigger→chat, trigger→owner fallback, explicit, none); origin classification.
- Runner: `template` and `deliver` steps with fake adapters, evidence rows, cancelled run does not
  deliver.
- Gateway methods and tools: contracts + scopes.
- Render: template page, brand form, trigger chips, run file rows.
- Live proof (plan's last task): (a) forward an LIC-style request mail to the configured Gmail →
  dispatcher runs the Duty → PDF arrives on the owner's Telegram; (b) type the same request in
  Telegram with the PDF attached → PDF returns in that chat; (c) `template_preview` round trip
  during a build session.

## 12. Acceptance

1. The flight-search Duty declares a mail trigger and a chat trigger; both are visible on its page.
2. A request mail produces a run whose evidence shows the parsed request, the search, a rendered
   PDF, and a delivery to the owner's Telegram.
3. The same request in Telegram produces the PDF in that chat.
4. The template was drafted by the agent and refined in chat; the owner never edited HTML.
5. No model call happens after `duty_run` except the Duty's own `ai` steps and `ai` slots.
