# Duties — core plugin and UI (sub-project 1)

**Date:** 2026-09-13 · **Status:** approved in conversation by the owner; written for implementation planning.
**Owner decisions** are quoted where they shape the design. Later sub-projects: #2 Registers, #3 Desktop steps (after a Windows VM spike), #4 Windows cloud VM hosting.

## 1. What a Duty is

A Duty is a saved, replayable job that OpenClaw's agent **authors from the owner's instructions** and a deterministic runner **replays without the model**, except for the steps that need AI or a human. It is the core concept of the owner's earlier project (Vasudev); OpenClaw becomes the host. Vasudev is a reference for concepts only, not code to port.

Example the whole design is tested against: *Book flight by mail — Amigos*. A client's booking mail arrives → AI reads it → look up the requester's corporate account in a register → sign in to Amigos with Keychain credentials → emulate the client account → search → identify the flight by airline and time → ask the owner to confirm → pick the fare → fill passengers → Hold → ask the owner to approve → confirm → render a confirmation → send it on Telegram. Live-tested on 2026-09-13 with OpenClaw's agent driving the owner's signed-in Chrome; only the last screens were left to the owner.

### 1.1 Document shape

```
Duty {
  id, name, summary, status: "active" | "paused" | "building",
  machine: node id or "gateway",            // where browser/desktop steps run
  reportsTo: contact name,                  // never a chat id
  exclusive?: boolean,                      // runs alone (e.g. one Amigos session)
  inputs: Input[], steps: Node[], triggers: Trigger[],
  updatedAt, lastRunAt                      // no versioning (owner decision)
}
Input  = { name, source: "ask" | "file" | "trigger" | "cred" | "literal", prompt?, value? }
Node   = Step | When | ForEach | Stop
Step   = { id, kind, label, params, target?, check?, saveAs?, timeoutMs? }
When   = { kind:"when", cond: Predicate, then: Node[], else?: Node[] }
ForEach= { kind:"for-each", over: "{{out:rows}}", as: "row", body: Node[] }
Stop   = { kind:"stop", reason }           // resolved with real values, never placeholders
```

`label` is in the owner's words (never a selector). `target` is durable: `{ role, name, text, css }` candidates tried in order; refs are never saved. `check` is one of `visible | text_matches | url_matches | non_empty | file_exists | attribute`. Outputs are referenced as `{{out:name}}`, inputs as `{{in:name}}`, credentials as `{{cred:key}}`.

### 1.2 Step kinds in this sub-project

| kind | does | backed by (verified) |
|---|---|---|
| `browser` | open, navigate, click, fill, select, press, wait, read text, download, upload, screenshot | Gateway method `browser.request` (`src/meeting-bot/browser-request.ts` pattern) or `tools.invoke` → `browser` |
| `browser.evaluate` | page-script fallback for widgets click/fill can't drive; highlighted in UI | browser `act evaluate` |
| `ai` | schema-validated extraction/decision → named outputs | `llm-task` plugin tool via `tools.invoke` |
| `ask` | question or approval to the owner; run parks until answered | Gateway `question.request` / `question.resolve` + `question.resolved` event (`src/gateway/server-methods`) — same cards Telegram/Control UI/TUI show today |
| `cred` (inside `browser` fill) | `{{cred:key}}` resolved from the OS keychain at fill time | new: `security` (macOS) / Credential Manager (Windows) adapter, value passed via stdin/env, never argv; never logged; registered for redaction |
| `mcp` | call `server.tool(args)` on a connected MCP server | in-process session MCP runtime (`acquireSessionMcpRuntime`, `src/agents/agent-bundle-mcp-manager-api.ts:30`) behind a plugin-sdk seam |
| `template` | render a template with run outputs → PDF/message file; usable anywhere, many times | new: template library + AI slot fill + browser print-to-PDF |
| `deliver` | send message/files to a contact over Gmail/WhatsApp/Telegram… | OpenClaw message tool via `tools.invoke` |
| `file` / `print` | move/copy/save/read; silent print to a named printer | Gateway filesystem tools; print = `lp` (mac/linux) / SumatraPDF (Windows) |
| `when` / `for-each` / `stop` | control flow | runner |
| `register` | reserved; implemented in sub-project 2 | — |
| `desktop` | reserved; implemented in sub-project 3 | — |

**Login gateway:** a `when` whose condition is a *logged-in probe* (`visible` of something only a signed-in page shows). If visible, the sign-in group is skipped; otherwise it fills `{{cred:*}}`, clicks sign-in, checks the landing URL, and contains `ask` sub-steps that fire only when their trigger text (OTP / CAPTCHA) appears. Exactly Vasudev's guarded login block.

### 1.3 Templates

A template is an HTML document (PDF output) or message text with named slots, a **brand** (logo, colours, phone, footer), stored in a library shared across Duties and referenced by name. `template.render { template, data, format: pdf | message }` → file. **AI fills the slots** (prose slots written fresh each run; row slots mapped from outputs), the deterministic engine renders; an unfillable slot fails the step rather than inventing a value. A Duty may be nothing more than *ask for data (typed or a shared file) → template → deliver* ("Make a package quotation").

## 2. Authoring — "always through instructions"

No recording of a demo, ever. The owner describes the job in any chat; the agent:

1. **Understands** — restates the job as stages, asks the questions that matter (existing `ask_user` cards).
2. **Explores** — opens the site/app live with the browser/computer tools, finds real fields and quirks, re-asks if what it sees changes the plan.
3. **Writes steps only when sure**, per stage, with durable targets, a check, owner-language labels.
4. **Test-runs to here** — `duty_run` executes the draft up to the current stage and **keeps the tab/window open**; the agent fixes failures on the spot, then explores the next screen from where the run stopped and builds ahead ("make sure it reaches the current screen and then build ahead").
5. Repeats; designs templates and delivery the same way.
6. **Saves** — any time; no green-run gate (owner decision). Status is `building` until saved-and-activated.

**Templates during build:** when a `template` step is added, the build stage gets a *Template* tab that replaces the machine view. It offers the library or "new"; the agent drafts from a description or from an example file the owner attaches, renders a preview from the last test run, iterates on chat feedback. The agent must state **how every slot will be filled** and add steps for what nothing provides yet (e.g. a "Google Maps link" slot → a web-search step).

**Credentials:** the moment a login appears, the agent asks the owner to store the credential under a key on the **Logins** screen (masked input → OS keychain). Never in chat.

**Editing = resuming the build session.** There is no step editor; the UI is read-only and "Edit with agent" opens the chat.

Agent tools registered by the plugin: `duty_list`, `duty_get`, `duty_draft` (create/update header+inputs+triggers), `duty_set_steps` (validated; the only write path), `duty_run` (`{id, toStep?, fromStep?, keepOpen}`), `duty_save` (activate), `template_list/get/set/render_preview`, `cred_needed(key, reason)` (creates the owner prompt, returns whether stored), `duty_repair_propose`. A bundled skill (`skills/duties/SKILL.md`) teaches the loop above.

## 3. Runner

- **Run record first** (`queued` → `running` → `ok | failed | blocked | needs_input | cancelled`; `lost` for runs orphaned by restart). Inputs resolved before step 1 (`ask` inputs asked now; `file` inputs required; `cred` left as placeholders until fill).
- **Execution** inside the Gateway as a plugin service, no agent turn. Each step: resolve target fresh (snapshot → first unique visible candidate) → act → check → record evidence. A failed check fails the run loudly with the step name.
- **`ask`**: `question.request` on the owner's channel (or the triggering channel), run parks `needs_input` durably, resumes on `question.resolved`; timeout → `blocked`, never a silent proceed. Approvals use the same mechanism with Approve/Decline options.
- **Concurrency**: many runs at once; each owns a browser tab. Locks: one desktop execution per machine (OpenClaw allows one), and `exclusive: true` Duties never overlap themselves. Queued runs show why.
- **Evidence per step**: status, duration, resolved target, short result, screenshot on browser/desktop steps (always on failure), rendered files, ask answers. Secrets masked (registered for redaction); login pages snapshotted in `interactive` mode so field values never appear (verified: the default `ai` snapshot prints password values).
- **Reporting**: live status line on the triggering channel in our wording; finish line carries the Duty's report output; every failure notifies the owner with the step name.
- **Repair (v1)**: on failure the agent takes over from the failed step (tab kept), completes the run under the same ask gates, then analyses the cause and **proposes** a corrected Duty as an approval card; applied only on Approve. Cap: 3 proposals per Duty per day.

## 4. Triggers

- **Manual**: chat ("run X") or ▶ Run on the Duty page.
- **Schedule**: the plugin creates an OpenClaw automation with a `script` payload that calls `duty_run` headlessly (script payloads run tools without a model turn; verified `docs/automation/cron-jobs/payloads.md`).
- **Incoming mail**: v1 uses OpenClaw's Gmail/IMAP trigger → a short agent turn instructed to call `duty_run` with the mail as input. (A model-free mail watcher is a follow-up.)
- **Channel file/message**: plugin `message_received` hook matches a phrase or a file drop → `duty_run`.
- **Webhook**: plugin HTTP route `POST /duties/<id>/run` with a per-Duty secret.

## 5. Storage

Plugin keyed store (SQLite, bundled-only): namespaces `duties`, `runs`, `run-steps`, `templates`, `brands`, `cred-index` (keys only, never values). Screenshots and rendered files in the plugin blob store. Runs and evidence are retained 90 days; Duties forever. No JSON sidecar files.

## 6. UI (validated in the live spike, `~/Developer/duties-ui-spike`)

Bundled plugin browser bundle (Workboard pattern): sidebar **Duties**; pages:
- **Board**: rollups (Active · Successful runs today · Waiting on you · Being built), exception banner naming the fix, filters, cards (summary, trigger, integrations derived from steps, last successful run, Run / Edit with agent).
- **Duty**: header (status, last updated, last run, machine, reports to, runs alone), read-only steps Plain⇄Raw with the login gateway as a group and gates highlighted, **successful runs only**, triggers, inputs (credentials by key only), uses. Actions: Run, Pause, Edit with agent, Delete.
- **Build session**: stage (Machine view with Watch/Take control; Template tab only when a template step exists) + steps trail + chat mirrored from the channel; only **Save**.
- **Live run**: status line, step list as progress, machine view, answered asks, outputs, evidence, repair card.
- **Templates**, **Logins** (add/replace key; list with used-by; never shows values).
- Gateway methods `duties.*` (`operator.read` for reads, `operator.write` for run/save, `operator.admin` for delete) and events `plugin.duties.changed` / `plugin.duties.run` for live progress.

**Machine view with control** (new): OpenClaw has only a view-only browser-tab screencast. v1 ships the tab screencast in the stage with "Take control" = focus the real window on that machine (Gateway host) and pause the runner; a true remote-desktop bridge (VNC/RDP through the Gateway) is part of sub-project 4.

## 7. Constraints and decisions to honor

- Bundled plugin under `extensions/duties` in this fork; imports only `openclaw/plugin-sdk/*`. Where a needed core capability has no SDK seam (session MCP runtime, question request from a service), add a narrow typed subpath and move bundled callers onto it (AGENTS.md "expand the boundary").
- Safari cannot load plugin assets over plain `http://127.0.0.1` (Secure cookie); Chrome or HTTPS.
- The AI may decide obvious choices itself (COK for "KOCHIN"); asks are for genuinely owner-owned decisions.
- No draft status, no versions, no step editor, no green-run gate, no owner hand-recording.
- Credentials: keys in the Duty, values only in the OS keychain, never in chat/logs/model.

## 8. Out of scope here

Registers (#2), desktop steps and the Windows computer-use spike (#3), Windows cloud VM hosting and the remote-desktop bridge (#4), a model-free mail watcher, a marketplace.

## 9. Acceptance

1. From Telegram: "make a Duty that reads a booking mail and books it on Amigos" → the agent explores, asks, writes, test-runs stage by stage, and saves; the Duty appears on the board as Active.
2. "Run it on this mail" → the runner replays without the model except `ai`/`ask` steps; asks arrive as Telegram cards; the run parks and resumes; the confirmation PDF is delivered; the run shows per-step evidence in the UI.
3. Two Duties run at the same time in separate tabs; an `exclusive` Duty queues its second run with a visible reason.
4. A forced failure (changed selector) → owner notified, agent completes the run, a fix card arrives; Approve updates the Duty.
5. "Make a package quotation" → asks for data or a file → renders the template → delivers, with no browser step at all.
