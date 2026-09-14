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

Not every Duty needs a browser at all — a Duty can end right after a single `ask` step
whose answer is saved via `saveAs`, or after a `template` step renders a document and a
`deliver` step sends it, with no browser involved at all.

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
    `url_matches: <regex>`, `non_empty: <outputKey>`. Anything else is rejected — a check that
    cannot be evaluated would read as a pass.
- **`browser.evaluate`** — fallback only, for when nothing above can express the action.
  `params.fn` is a function body string run in the page. Prefer the named `browser`
  actions whenever they suffice.
- **`ai`** — `params.instruction`, `params.input`, `params.schema` (JSON Schema for the
  extracted result). `saveAs` may be a single key or an array of keys pulled off the
  result object.
- **`ask`** — `params.question` (required), `params.options` (**required**: 2–4 distinct,
  non-blank choices), optional `params.header` (≤ 12 characters). Answer is saved via `saveAs`.
  The 2–4 rule is not style: the owner answers by tapping a button, and a channel only renders
  buttons for 2–4 distinct option values. One option, five options, or `["Yes","yes"]` goes out as
  plain prose — and a typed reply does **not** answer a Duty's question, it reaches the agent as
  ordinary chat while the run waits out its timeout. Saving such a step is refused. If a step
  genuinely needs free text (a one-time code), ask the owner in the conversation yourself with
  `ask_user` instead of putting it in the Duty.
  An `ask` is always raised with the owner — if the run was triggered from a group, the question
  still goes to the owner's own chat, so nobody else can approve it.
- **`template`** — renders a saved template. `params.template` is the template id;
  `params.fill` maps each of its slots to either `{ from: "{{out:...}}" }` (or any other
  placeholder) or `{ ai: "instruction" }` (the model writes that slot from the run's data).
  **Always set `params.filename`** for a `pdf` template: the document lands in someone's inbox, so
  it needs a name they can read at a glance. It is an ordinary string, so `{{in:...}}`/`{{out:...}}`
  work in it (`{{cred:...}}` is rejected like anywhere else), the extension is added for you, and it
  is reduced to a safe single file name. `"Flight options {{out:origin}}-{{out:destination}}
  {{out:date}}"` beats `"quote"`. Leave it out only when you genuinely cannot name the document
  from the data: the model is then asked for a name in the same call that fills the `{ ai }` slots.
  Optional `params.format` must match the template's own kind (`pdf` or `message`) when
  given — it exists to make the step's output format explicit, not to convert one kind
  into the other. A `pdf` template produces a file (usable downstream as
  `{{file:<templateStepId>}}`); a `message` template's rendered text is saved via `saveAs`
  like any other step. See **Templates** below for the authoring loop.
- **`deliver`** — sends text and/or files to a route. `params.to` is `"trigger"` (reply
  to whoever/whatever started this run), `"owner"` (the configured owner), or an explicit
  channel target, in which case `params.channel` is required. `params.text` is a string
  (placeholders resolved as usual); `params.files` is an array of `{{file:<templateStepId>}}`
  placeholders naming earlier `template` steps' output files. Needs at least one of `text`
  or `files`.
- **`when`** — `cond` is one of `{ visible: <target> }`, `{ equals: [a, b] }`,
  `{ text_matches: <regex> }`, `{ url_matches: <regex> }`; has `then` and optional `else` node
  lists.
- **`stop`** — ends the run early with a `reason` (e.g. once a login gateway determines no
  further action is needed).

## Placeholders

Strings in `params`/`reason` may use `{{in:name}}` (a Duty input) and `{{out:key}}` (a value
an earlier step saved). A `mail` input is an object, so its fields are addressed by dotted
path: `{{in:mail.body}}`, `{{in:mail.from}}`, `{{in:mail.attachments.0.text}}`.

`{{file:<templateStepId>}}` names the file a `template` step produced (by that step's id). It
is only valid in a `deliver` step's `params.files`/`params.text` or a later `template` step's
`params.fill` — nowhere else, since it names a path on disk, not a value to hand to a model or
put in a URL.

`{{cred:key}}` (a stored credential) is valid in **exactly one place**: the `params.value` of a
`browser` `fill` or `select` step. There it is resolved at run time, typed into the field, and
masked in evidence — the value never appears in your context, in evidence, or in logs. Anywhere
else (an `ai` instruction or input, an `ask` question, a `navigate`/`open` url, a `press` key, an
`evaluate` body, a `stop` reason, a `when` cond) it is rejected when the Duty is saved, because
resolving it there would ship the secret to a model, a channel, a URL, or a page script.

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

## Templates

A template is a saved document (`pdf`) or message (`message`) with named slots the Duty fills
in at run time. Use `template_list` to see what already exists (id, name, kind, slots) before
authoring a new one — reuse rather than duplicate.

**Prerequisite for `pdf` templates.** Rendering serves the document to the managed browser over
the Gateway's own loopback address, which the browser refuses by default. If a `template` step or
`template_preview` fails with "could not open the render page", the owner has to add `127.0.0.1`
to `browser.ssrfPolicy.allowedHostnames` and restart the Gateway — `openclaw duties setup
--account <email>` prints that block along with the mail prerequisites. Tell the owner that; do
not work around it.

1. **Read or draft** with `template_get { id }`, or write a new one and validate/save it with
   `template_set { template }` (`{ id, name, kind, html, slots, updatedAt }`); it returns
   validation errors verbatim on a bad slot reference or an undeclared/unused slot.
2. **Decide how every slot is filled** before writing the Duty's `template` step: each slot
   needs a `{ from: "{{...}}" }` (a value already available as a Duty input or an earlier
   step's output) or a `{ ai: "instruction" }` (write it from the run's data — good for prose,
   never for facts the data doesn't already contain).
3. **Preview it** with `template_preview { id, data? }` — omit `data` to fill every slot with a
   `[slotName]` placeholder, or pass real values to see the real thing. It returns `{ path }`;
   show the owner the actual rendered file by sending it with the `message` tool:
   `{ action: "send", message: "Preview", media: "<path>" }`.
4. **Check the brand block** with `brand_get`/`brand_set` (name, optional logo, colours,
   contact lines) if the template uses `{{brand:...}}` fields — it's install-wide, not
   per-template.

Slot syntax inside `html`: `{{slot:name}}` for a `text`/`prose` slot, `{{#rows:name}}…
{{col:column}}…{{/rows:name}}` for a `rows` slot (one row per array entry, `{{col:...}}` for
each declared column), and `{{brand:field}}` for a brand field (`name`, `logoDataUrl`,
`primary`, `accent`, `phone`, `email`, `footer`). A twelve-line `pdf` template with a text
slot, a rows slot and a brand field:

```html
<h1>Invoice for {{slot:customerName}}</h1>
<p>{{brand:name}} — {{brand:email}}</p>
<table>
  <tr>
    <th>Item</th>
    <th>Qty</th>
    <th>Price</th>
  </tr>
  {{#rows:items}}
  <tr>
    <td>{{col:item}}</td>
    <td>{{col:qty}}</td>
    <td>{{col:price}}</td>
  </tr>
  {{/rows:items}}
</table>
<p>{{slot:footerNote}}</p>
```

## Credentials

Never ask the owner for a password (or any secret) in chat. Before authoring a step that
needs one, call `cred_needed { key, reason }` — it tells you whether it's already stored
and, if not, how the owner stores it out-of-band. It never accepts or echoes a value.

The owner saves a login themselves on the **Duties → Logins** page; it goes straight into this
machine's keychain. There is no tool, chat message, or file through which you can receive one.

## Triggers and dispatch

A Duty's `triggers` array declares how it can be started beyond a manual `duty_run`: a
`{ kind: "mail", match: "..." }` or `{ kind: "chat", match: "..." }` trigger, where `match` is
a plain-words description of what should route here (e.g. "invoices from our supplier",
"someone asks to renew the domain") — not a regex or a channel-specific filter. Every active
Duty needs at least one trigger; `duty_draft`/`duty_set_steps` default to `[{ kind: "manual" }]`
when none is given.

Inbound Gmail is not routed to a specific Duty directly — it wakes a separate, narrowly-scoped
dispatcher agent (`duties-mail`) that reads the mail, picks the matching Duty, and calls
`duty_run` on it. If you are that dispatcher agent:

1. Read the incoming message (from/subject/body are already in your context) and its
   attachments — a Gmail attachment through `gog gmail <read/download>` via the `exec` tool, a
   dropped file by its given path.
2. Call `duty_list` and match the mail against each active Duty's `triggers[].match` in plain
   words. Pick **exactly one**. If none clearly matches, or more than one plausibly does,
   message the owner with the `message` tool describing the mail and why nothing matched, and
   stop — never guess.
3. Call `duty_run { id, inputs: { mail: { from, subject, body, messageId, attachments: [{
name, text }] } } }`, adding a `{ name, path, text? }` input per dropped file the Duty
   declares (its `name` matches the input's declared name). The Duty's own steps read the
   mail via `{{in:mail...}}` and any dropped file via `{{in:<name>...}}`.

The dispatcher never opens a browser and never authors, edits, or otherwise touches a Duty's
steps — it only reads mail, matches a trigger, and calls `duty_run`. Authoring stays with you,
the authoring agent, exactly as described above.
