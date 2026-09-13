---
name: duties
description: Build and run Duties — saved, replayable automations — from the owner's instructions
user-invocable: false
---

# Authoring Duties

A Duty is a saved, replayable automation you build once and the owner (or a trigger) runs
later. You always author from the owner's spoken/written instructions — there is no
"record my clicks" mode. Explore the real site live and write down what you learned as
steps.

## The authoring loop

1. **Understand.** Read the owner's instructions for this Duty. Note what's genuinely
   ambiguous or owner-owned (e.g. "which account", "how much to spend") versus what's an
   obvious detail you can just decide (e.g. the domestic airport for a named city).
2. **Explore live** with the `browser` tool — open the real site, look at the real page,
   note the real button/field labels in the owner's own words.
3. **Ask** only what matters, with `ask` steps or `ask_user` — never invent an owner-owned
   decision, and never ask for a credential (see Credentials below).
4. **Write steps for one stage at a time** with `duty_set_steps` — don't try to author the
   whole flow before running any of it.
5. **Run that stage** with `duty_run { id, toStepId, keepOpen: true }`. This stops right
   after `toStepId` and leaves the browser tab open, returning `targetId`.
6. **Continue** by passing that `targetId` into the next `duty_run` (and into exploration),
   so you keep working in the same live tab instead of restarting.
7. Repeat steps 2-6 stage by stage until the whole Duty is authored.
8. **Save** with `duty_save { id }` once the flow is complete. There is no "green run"
   gate — you decide when a Duty is ready; a Duty that has never fully run end-to-end can
   still be saved.

A Duty can be as small as `ask` → (a template step, later) → deliver — not every Duty
needs a browser at all.

## Step vocabulary

Every step (and `when`/`stop` node) has a `label` in **the owner's words** — never a
selector, ref, or CSS-ish string like `#btn-login`. Steps also take an optional `check`
and `saveAs`.

- **`browser`** — `params.action` is one of:
  `open` (`params.url`), `navigate` (`params.url`), `click` (needs `target`), `fill`
  (`target` + `params.value`, may use `{{cred:...}}`), `select` (`target` +
  `params.value`), `press` (`params.key`), `wait` (`target` and/or `params.text`/`url`),
  `read` (`target`, saves text via `saveAs`), `screenshot`.
  - `target` is `{ role, name }`, `{ text }`, or `{ css }` — prefer role+name or visible
    text; use `css` only when nothing else identifies the element.
  - `check` (on any step) is one of `visible: <target>`, `text_matches: <regex>`,
    `url_matches: <regex>`, `non_empty: <outputKey>`, `attribute: { target, name }`.
- **`browser.evaluate`** — fallback only, for when nothing above can express the action.
  `params.fn` is a function body string run in the page. Prefer the named `browser`
  actions whenever they suffice.
- **`ai`** — `params.instruction`, `params.input`, `params.schema` (JSON Schema for the
  extracted result). `saveAs` may be a single key or an array of keys pulled off the
  result object.
- **`ask`** — `params.question`, optional `params.header`, optional `params.options`
  (multiple-choice). Answer is saved via `saveAs`.
- **`when`** — `cond` is one of `{ visible: <target> }`, `{ equals: [a, b] }`,
  `{ text_matches: <regex> }`; has `then` and optional `else` node lists.
- **`stop`** — ends the run early with a `reason` (e.g. once a login gateway determines no
  further action is needed).

## Placeholders

Strings in `params`/`reason` may use `{{in:name}}` (a Duty input), `{{out:key}}` (a value
an earlier step saved), and `{{cred:key}}` (a stored credential, resolved only at run
time — the value never appears in your context or in evidence/logs).

## The login gateway pattern

Put a login check at the top of any stage that needs to be signed in, so re-runs skip it
when already logged in:

```
when:
  label: "Check if already signed in"
  cond: { visible: { text: "My Account" } }
  then: []
  else:
    - fill:  { target: { role: "textbox", name: "Email" }, value: "{{cred:site.username}}" }
    - fill:  { target: { role: "textbox", name: "Password" }, value: "{{cred:site.password}}" }
    - click: { target: { role: "button", name: "Sign in" } }
    - check: { url_matches: "/dashboard" }
    - when:
        label: "Handle one-time code if asked"
        cond: { text_matches: "Enter the code" }
        then:
          - ask: { question: "What's the one-time code sent to your phone?" }
          - fill: { target: { role: "textbox", name: "Code" }, value: "{{out:otp}}" }
          - click: { target: { role: "button", name: "Verify" } }
```

## Credentials

Never ask the owner for a password (or any secret) in chat. Before authoring a step that
needs one, call `cred_needed { key, reason }` — it tells you whether it's already stored
and, if not, how the owner stores it out-of-band. It never accepts or echoes a value.
