---
summary: "Saved, replayable automations the agent writes from your instructions — triggered by mail, chat, or a button, with documents, deliveries, and approval gates"
read_when:
  - You want the agent to turn a repeated job into something it can run again on its own
  - A Duty's document render or mail trigger is failing and you need the prerequisites
  - You want to know who can approve a Duty's question, or gate edits to a live Duty
title: "Duties plugin"
---

The bundled `duties` plugin lets the agent save a job you do repeatedly — book the flight, send the quote, file the renewal — as a **Duty**: an ordered list of steps it can replay later without you re-explaining anything. You describe the job once, in your own words; the agent explores the real site with you, writes the steps, and saves them. After that a Duty runs from a button, from a chat message, or from an inbound mail.

Duties appear as their own tab in the Control UI, and the agent works with them through its `duty_*` and `template_*` tools.

A Duty normally runs on whatever machine your Gateway is on, which has to be on and awake for a mail or scheduled trigger to fire. [Run it on a hosted desk](/hosted-desk) to keep Duties running around the clock instead.

## What a Duty is

A Duty is a name, a summary, and a list of steps. Each step is one of:

| Step               | What it does                                                                 |
| ------------------ | ---------------------------------------------------------------------------- |
| `browser`          | Opens, navigates, clicks, fills, selects, presses, waits, or reads a page    |
| `browser.evaluate` | Runs a small function in the page and saves what it returns                  |
| `ai`               | Reads something unstructured (a mail body, a page of text) into named values |
| `ask`              | Asks **you** a question and waits for your tapped answer                     |
| `template`         | Renders a saved template into a PDF, or into message text                    |
| `deliver`          | Sends text and/or the rendered documents to a chat                           |
| `when` / `stop`    | Branches on a condition, or ends the run early with a reason                 |

Steps read each other's results through placeholders: `{{in:name}}` for a Duty input, `{{out:key}}` for something an earlier step saved, `{{file:<stepId>}}` for a document an earlier `template` step produced.

Every run records what happened step by step, with a screenshot of each browser step and the documents it produced, so you can see exactly what the agent did.

## Triggers

Each Duty carries one or more triggers:

- **Manual** — the Run button on the Duties page, the agent's `duty_run` tool, or the CLI.
- **Chat** — a message that matches the Duty's description of when it applies ("someone asks to renew the domain"). Written in plain words, not as a regex.
- **Mail** — an inbound Gmail message, routed to a small dispatcher agent that picks the matching Duty. See [Setup](#setup) below.

## Logins

A Duty that signs in somewhere needs the password, and it must never pass through the agent's context. Save it under a key on the Duties page's **Logins** panel; the value goes straight to the OS keychain. The step then refers to it as `{{cred:site.password}}`, which is resolved at run time, typed into the field, and masked in the run's evidence.

A credential placeholder is accepted in exactly one place — the value a `browser` `fill` or `select` step types. Anywhere else (a model instruction, a question, a URL, a page script) it is refused when the Duty is saved.

## Templates and files

A **template** is a saved document (`pdf`) or message (`message`) with named slots. A `template` step fills each slot either from a value the run already has, or by asking the model to write it from the run's own data — and the rendered PDF becomes a file the run owns, attachable by a later `deliver` step.

There is one install-wide **brand** block (name, logo, colours, contact lines) that templates can draw on, so every document the agent sends looks like it came from the same place.

Rendering happens in the managed browser, which prints the page to PDF. A run also keeps a PNG of the rendered page beside the PDF, so you can see a document in the Control UI without opening a PDF viewer.

## Deliver

A `deliver` step sends to one of:

- `trigger` — back to whoever or whatever started this run (the chat it came from, else you).
- `owner` — you, on the channel and target set on the Duties page.
- `{ to: "team:<memberId>" }` — that Team member. Name `channel` alongside it to force one of
  their channels (failing if they have no identity there); leave `channel` out and the step
  fans out to every channel identity that member has, so they get the message wherever they
  actually are. A channel that fails to send does not stop delivery on their other channels —
  the step only fails if every channel failed.
- an explicit channel target, which needs `channel` alongside it.

Its `files` entries name earlier `template` steps (`{{file:<stepId>}}`) and nothing else — a Duty cannot attach an arbitrary path from disk.

## Asks and approvals

An `ask` step is how a Duty stops and waits for you — typically in front of something irreversible, like confirming a hold before it is booked. It reaches you as a message with tappable choices, and the run parks until you tap one.

Two rules matter when authoring one:

- **2–4 distinct options.** A channel renders buttons only for 2–4 distinct choices. With one, five, or duplicated options the question arrives as plain text, and a typed reply does not answer it — so a Duty with unusable options is refused at save time. For genuinely free-form input, the agent should ask you directly in conversation rather than putting it in the Duty.
- **The owner answers by default.** A question goes to your own chat even when the run was triggered from a group, because anyone who can see a card can tap it. Set `target: "team:<memberId>"` to raise it in that Team member's own session instead — resolved through the same routing an ordinary message from them would use, so whichever of their linked channels they actually answer from resolves it, the same "reply everywhere" behavior their chat already has.

### Gating edits to a live Duty

By default the agent may edit a Duty that is already active — that is how a broken Duty gets repaired the moment it breaks. If you would rather see every change to a live Duty first, turn the gate on:

```json
{ "requireApprovalForEdits": true }
```

sent as `duties.settings.set`. With it on, an edit to an `active` Duty is held as a pending change, the live Duty keeps running exactly as it was, and you get a one-line note saying what would change. Apply it with `duties.change.apply { id }`, or drop it with `duties.change.discard { id }`. A newer edit replaces the waiting one, so you are never asked about a change the agent has already moved past. Duties still being written (`building`) and pausing or resuming a Duty are never gated.

<a id="setup" />

## Setup

`openclaw duties setup --account you@example.com` prints every prerequisite, what is already in place, and the exact config blocks to merge. There are two.

### Rendering

The managed browser has to be allowed to open the Gateway's own loopback address, or every `template` step and every preview fails:

```json
{
  "browser": {
    "ssrfPolicy": {
      "allowedHostnames": ["127.0.0.1"]
    }
  }
}
```

This is the narrowest opt-in available — it permits one address, unlike `dangerouslyAllowPrivateNetwork`, which permits the whole private network. Restart the Gateway afterwards.

### Mail triggers

The fastest way to wire this up is Settings → Connections → Channels' guided **[Gmail](/channels/gmail)**
card: it writes a Gmail app-password IMAP account pointed at the `duties-mail` agent, with no Google
Cloud project, `gcloud` auth, or public exposure needed. Use the `hooks.gmail`/Pub-Sub checklist
below instead only if you specifically need a Gmail-hook feature the IMAP card does not provide,
such as fetching attachment content via `gog gmail <read/download>` (the IMAP path only ever sees an
attachment's filename) — see [Gmail vs. hooks.gmail](/channels/gmail#when-to-use-hooks-gmail/pub/sub-instead).

Mail dispatch over `hooks.gmail` needs the Gmail push path plus a small dispatcher agent. The setup command prints all of it; the checklist is:

1. `gogcli` installed and authenticated for the account (`gog auth add you@example.com`).
2. `hooks.enabled: true` and `hooks.gmail.account` set to that account.
3. A hook mapping routing Gmail to the `duties-mail` agent, one message at a time, with `deliver: false` — `openclaw webhooks gmail setup --account you@example.com` writes it.
4. The hook session-key settings that mapping needs: `allowRequestSessionKey`, an `allowedSessionKeyPrefixes` entry covering `hook:gmail:`, a `defaultSessionKey`, and `allowedAgentIds` naming only the dispatcher.
5. An `agents.entries.duties-mail` entry — a minimal-profile agent that can only list, get and run Duties, message you, run an `ai` step and shell out to `gog`.
6. Because that is a second agent, `agents.ownership: "explicit"`, `agents.defaults.systemAgent`, and one `bindings` entry per enabled channel. Without them your existing channels stop answering.
7. `llm-task` enabled and allowed, since that is how an `ai` step reaches a model.
8. The `gog` binary exec-approved for the dispatcher: `openclaw approvals allowlist add --agent duties-mail <path-to-gog>`.

Restart the Gateway, then check the Duties page's Settings strip: it reports each piece of the mail path and whether rendering is allowed.

### The owner target

Set the channel and target you want approvals and reports to reach — the fastest way is the [Team page](/plugins/team#the-owner), which also creates your Team roster row in the same step. Until an owner is set (on the Team page, or here), a Duty still runs — it just has nowhere to report, and a Duty that asks you something cannot ask.

Duties keeps its own copy of this target (`duties.settings.set { owner }`) too, but only as a fallback for when the Team plugin has no answer yet (not installed, or not yet set up) — the [Team plugin](/plugins/team) is the canonical answer to "who is the owner" once it has one, and nothing here mirrors into its roster.

## Team

Duties no longer owns the people list. Who may give the agent instructions, which channels they're reachable on, and delivering a step to `{ to: "team:<memberId>", channel: "whatsapp" }` or asking one with `{ target: "team:<memberId>" }` are all the [Team plugin](/plugins/team)'s own responsibility — see that page for the full model. `duty.ts`'s `team:<memberId>` target parsing (shared by both `deliver.to` and `ask.target`) stays here — it's pure string-shape parsing with no roster access of its own — but resolving a target to an actual identity, and to that identity's live session for an `ask`, goes through Team's own Gateway method.
