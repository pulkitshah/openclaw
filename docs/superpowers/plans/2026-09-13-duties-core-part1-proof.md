# Duties core (Part 1) — live proof on the fork's Gateway

Task 12 of `.superpowers/sdd/2026-09-13-duties-core-part1`. A real Duty was authored by the
agent through the fork's own Gateway and replayed against the live
`https://amigosalliance.co.in` site. This records what ran, what broke, what was fixed, and
what is still shaky.

Branch `feat/duties`, starting commit `6462bb38f4`.

## Environment

The proof ran on an isolated Gateway so the owner's live Gateway (port 18789, LaunchAgent,
`~/.openclaw`) was never stopped, restarted, or read from.

- State dir `~/.openclaw-duties`, config `~/.openclaw-duties/openclaw.json`, port **19001**.
- No channels configured; agent `krishna`; model `anthropic/claude-opus-5` via the
  `claude-cli` backend.
- Browser: OpenClaw's own managed Chromium on profile **`openclaw`** (Playwright over CDP,
  user data dir `~/.openclaw-duties/browser/openclaw/user-data`) — never the Chrome-extension
  `chrome` profile, so the owner's paired Chrome was untouched.
- Credentials `amigos.username` / `amigos.password` were already in the plugin's keychain
  namespace (`openclaw-duties.*`). Their values never appear in this document, in the Duty, in
  run evidence, or in any agent context.

Start (detached, so nothing else was signalled):

```
(cd /Users/pulkitshah/Developer/vasudev-openclaw && \
 OPENCLAW_STATE_DIR=$HOME/.openclaw-duties \
 OPENCLAW_CONFIG_PATH=$HOME/.openclaw-duties/openclaw.json \
 nohup node openclaw.mjs gateway run --port 19001 > /tmp/claude-501/duties-proof-gateway.log 2>&1 &)
```

`plugins list` on the proof Gateway: `Duties | duties | openclaw | enabled | stock:duties/index.js`.
Startup line: `http server listening (21 plugins: … duties …)`.

Every command below was run with that same `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` pair.
The Gateway token is not reproduced anywhere in this document.

## Preparatory code changes

Committed before the proof, per the controller's ruling:

**`e5ee16658b` `feat(duties): configurable browser profile; enabled by default`**

- `extensions/duties/index.ts` no longer hard-codes `profile: "chrome"`. A new exported
  `resolveBrowserProfile(api.pluginConfig)` reads
  `plugins.entries.duties.config.browserProfile` and falls back to `"openclaw"`.
- `browserProfile` (string) added to the manifest `configSchema.properties`.
- `"enabledByDefault": true` added to `extensions/duties/openclaw.plugin.json`.
- Covered by the existing `extensions/duties/index.test.ts`.

`dist/extensions/duties/index.js` is produced by the `tsdown-unified` phase of
`scripts/build-all.mts`, not by `external-plugins:local-dist` (the duties package is not one
of the 92 isolated plugins). The minimal refresh sequence used after each source change was:

```
OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 node --import ./scripts/tsx.mjs scripts/tsdown-build.mts \
  --config tsdown.config.ts --filter openclaw-unified   # ~12-16s
node --import ./scripts/tsx.mjs scripts/build-external-plugin-local-dist.mts
node --import ./scripts/tsx.mjs scripts/bundled-plugin-assets.mts --phase copy
node --import ./scripts/tsx.mjs scripts/runtime-postbuild.mts
node --import ./scripts/tsx.mjs scripts/build-stamp.mts
node --import ./scripts/tsx.mjs scripts/runtime-postbuild-stamp.mts
```

The `tsdown-unified` phase cleans `dist/`, so the last four steps are mandatory: without
`external-plugins:local-dist` the 92 isolated plugins lose their `index.js` and the config
becomes invalid (`ERROR codex: extension entry not found: index.js`), which is exactly how the
first Gateway start failed.

## Isolation fixes to the proof config

Two changes were needed before the proof Gateway would start or be useful. Both are config,
not plugin code.

1. **The agent pointed at the owner's live state.** `agents.entries.krishna.agentDir` and
   `agents.defaults.workspace` still referenced `~/.openclaw/...`, so startup aborted with
   `OpenClaw agent database /Users/pulkitshah/.openclaw/agents/krishna/agent/openclaw-agent.sqlite
   uses schema version 19; … run openclaw doctor --fix`. Migrating that database would have
   mutated the owner's live agent state, so instead both paths were repointed into
   `~/.openclaw-duties/`. The owner's database was never opened or migrated.
2. **The Duty tools were not reachable by the agent.** `tools.profile: "coding"` plus
   `tools.alsoAllow: ["browser"]` does not cover plugin tools, so the agent's first turn
   correctly reported that `cred_needed`, `duty_draft`, `duty_set_steps`, `duty_run` and
   `duty_save` were missing. `alsoAllow` is a list of tool names, so it became
   `["browser", "duty_list", "duty_get", "duty_draft", "duty_set_steps", "duty_run",
   "duty_save", "cred_needed"]`.

## Authoring through the agent

Five turns of `openclaw agent --agent krishna --session-key duties-proof --json
--message-file <turn>.txt`, same session key throughout.

1. **Turn 1 — explore.** The agent opened the site on profile `openclaw` and reported the real
   page: `amigosalliance.co.in` redirects to `/Home/IndexAmi`; the header **Login** button
   opens a right-hand panel with **User Name** (`#UserId`), **Password** (`#Password`) and a
   **Sign-in** `<input type=button>` (`#btnlogin`). It also found that the instructed
   logged-in probe was wrong: the guest page says **"Welcome Guest!"**, so a "Welcome" check
   matches either way, and the login fields exist in the DOM before the panel opens. It could
   not create the Duty — the tools were missing (fixed above). It never asked for a credential
   value.
2. **Turn 2 — first login stage.** `cred_needed` reported `stored: true` for both keys,
   `duty_draft` created `amigos-search`. `duty_set_steps` rejected the agent's first draft with
   `steps[1].cond: unknown condition kind "url_matches"` — `when.cond` only accepts `visible`,
   `equals` and `text_matches`. The agent worked around it with a `browser.evaluate` step that
   saves `yes`/`no` plus an `equals` cond. Two test runs both ended `failed`; the second
   exposed a real plugin bug (below). The agent also discovered that the account permits only
   one session at a time (`Login from another system logout in progress`), so a re-run that
   signs in again logs the previous session out.
3. **Turn 3 — login gateway made idempotent.** With the two plugin bugs fixed, the agent
   verified by hand that `/Home/Dashboard` redirects to `/Home/IndexAmi` when logged out, and
   rewrote the gate on the URL alone (dropping the Login-button check, which is unreliable
   because the signed-in Dashboard carries a stray guest panel with its own Login button).
   Result: run 1 from a fresh tab signed in, all 8 steps `ok`; run 2 with the returned
   `targetId` ran only 3 steps (`open-dashboard`, `read-signed-in` → `"yes"`,
   `confirm-signed-in`) and skipped the sign-in entirely. The account was signed in exactly
   once.
4. **Turn 4 — search stage.** Authored the whole search flow (One Way, `DEL`→Delhi,
   `BOM`→Mumbai, 27/09/2026, travellers/class gate, untick Direct Flight Only, Search). The
   CLI stopped waiting at 930s but the work landed on the Gateway: the Duty went to 24 steps.
   Its best test run got 17 steps `ok`, stopping on a travellers check that read the
   Travellers/Class box's *text* (empty) instead of its input values.
5. **Turn 5 — finish and save.** Travellers gate rewritten to read the Adults `value` and the
   Economy radio's `checked`; `direct-only-gate` plus a `confirm-direct-off` verification
   added; `check: { url_matches: "/Flight/DResult" }` put on `click-search`. `duty_save` ran —
   `amigos-search` is **`active`** with **27 top-level steps**. The agent's own two end-to-end
   attempts in this turn failed on browser timeouts (see Gaps), and it said so plainly rather
   than claiming success.

## Plugin bugs found and fixed

**`217b20040b` `fix(duties): drop undefined run-patch fields before storing`**

Symptom, from the agent's second test run: every step returned `ok`, yet the run ended
`failed` with `plugin state value at value.failedStep must be JSON-serializable` and returned
no `targetId` (run `a538d27e`, `failed`, 8 steps, no `failedStep`).

Cause: `RunManager.finish()` builds its patch from optional outcome fields, so a run that
stopped cleanly at `toStepId` passed `failedStep: undefined` and `targetId: undefined`.
`DutyStore.updateRun` spread those straight into the stored record, and the host's plugin
state validation (`src/plugin-state/plugin-store-validation.ts`) rejects explicit `undefined`
values. A clean partial run was therefore reported as a failure.

Fix: `updateRun` now drops undefined-valued keys before writing — absent means "leave
unchanged", which is what every caller meant. Test:
`store.test.ts > updateRun drops undefined patch fields instead of storing them`, covering
both the atomic-`update` and the `lookup`+`register` fallback paths.

**`63ce1d363e` `fix(duties): resume an open step in the handed-in tab`**

Symptom: the agent passed the `targetId` from a `keepOpen` run into the next `duty_run`, and
the run still started in a brand-new tab, replayed the login stage, and signed in a second
time — which on this single-session account logged the first tab out.

Cause: the `browser` `open` action in `runner.ts` unconditionally called
`deps.browser.open(url)`, discarding `options.targetId`. That contradicts the `duties` skill,
which tells the agent to pass `targetId` "so you keep working in the same live tab instead of
restarting".

Fix: when a tab is already in hand, `open` navigates it instead of opening a new one. Test:
`runner.test.ts > resumes an open step in the tab it was handed instead of opening a new one`.

Both fixes were verified live in turn 3: the partial run finished `ok` and returned its
`targetId`, and the resumed run reused the same tab and skipped the sign-in.

Full `extensions/duties` suite after the fixes: **12 files, 90 tests, all passing.**

## The saved Duty

`amigos-search`, status `active`, 27 top-level steps. Login is a `when` gate keyed on a URL
probe, so a re-run that is already signed in skips it; each fragile form interaction is
followed by a read-back and a `stop` gate.

```json
{
  "id": "amigos-search",
  "name": "Amigos flight search",
  "summary": "Sign in to Amigos Alliance if needed and search one-way DEL→BOM flights on 27/09/2026 for 1 adult, economy, including connecting flights.",
  "status": "active",
  "machine": "gateway",
  "reportsTo": "owner",
  "inputs": [],
  "triggers": [],
  "steps": [
    { "id": "open-dashboard", "kind": "browser", "label": "Open the Amigos Dashboard",
      "params": { "action": "open", "url": "https://amigosalliance.co.in/Home/Dashboard" } },
    { "id": "read-signed-in", "kind": "browser.evaluate",
      "label": "Note whether the Dashboard stayed open (already signed in)",
      "params": { "fn": "return /\\/Home\\/Dashboard/i.test(location.href) ? 'yes' : 'no';" },
      "saveAs": "onDashboard" },
    { "id": "login-gateway", "kind": "when",
      "label": "Sign in only if Amigos sent me back to the home page",
      "cond": { "equals": ["{{out:onDashboard}}", "yes"] },
      "then": [],
      "else": [
        { "id": "open-login-panel", "kind": "browser", "label": "Click the Login button in the header",
          "params": { "action": "click" }, "target": { "role": "button", "name": "Login" } },
        { "id": "wait-login-panel", "kind": "browser", "label": "Wait for the User Name box to appear",
          "params": { "action": "wait" }, "target": { "role": "textbox", "name": "User Name" } },
        { "id": "fill-username", "kind": "browser", "label": "Enter the Amigos user name",
          "params": { "action": "fill", "value": "{{cred:amigos.username}}" },
          "target": { "role": "textbox", "name": "User Name" } },
        { "id": "fill-password", "kind": "browser", "label": "Enter the Amigos password",
          "params": { "action": "fill", "value": "{{cred:amigos.password}}" },
          "target": { "role": "textbox", "name": "Password" } },
        { "id": "click-sign-in", "kind": "browser", "label": "Click Sign-in",
          "params": { "action": "click" }, "target": { "role": "button", "name": "Sign-in" } }
      ] },
    { "id": "confirm-signed-in", "kind": "browser", "label": "Make sure the Dashboard is showing",
      "params": { "action": "wait", "text": "MY REPORTS" },
      "check": { "url_matches": "/Home/Dashboard" } },
    { "id": "open-flight-search", "kind": "browser", "label": "Go to the Flight Booking page",
      "params": { "action": "navigate", "url": "https://amigosalliance.co.in/Flight/fltSearch" } },
    { "id": "wait-flight-form", "kind": "browser.evaluate", "label": "Wait for the Flight Booking form",
      "params": { "fn": "return new Promise(function (resolve) { var started = Date.now(); (function poll() { if (document.getElementById('FromI') && document.getElementById('Isdirectflight')) return resolve('ready'); if (Date.now() - started > 12000) return resolve('not ready'); setTimeout(poll, 250); })(); });" },
      "saveAs": "flightFormReady", "check": { "url_matches": "/Flight/fltSearch" } },
    { "id": "flight-form-gate", "kind": "when", "label": "Make sure the Flight Booking form loaded",
      "cond": { "equals": ["{{out:flightFormReady}}", "ready"] }, "then": [],
      "else": [ { "id": "stop-form-not-loaded", "kind": "stop",
        "label": "Stop: the Flight Booking form did not load",
        "reason": "The Flight Booking form did not load within 12 seconds." } ] },
    { "id": "pick-one-way", "kind": "browser", "label": "Choose One Way",
      "params": { "action": "click" }, "target": { "css": "label[for=\"flighttype1\"]" } },
    { "id": "type-from", "kind": "browser", "label": "Type DEL in From",
      "params": { "action": "fill", "value": "DEL" }, "target": { "css": "#FromI" } },
    { "id": "wait-from-suggestion", "kind": "browser", "label": "Wait for the Delhi suggestion",
      "params": { "action": "wait", "text": "Delhi" } },
    { "id": "pick-from-delhi", "kind": "browser", "label": "Pick the Delhi suggestion",
      "params": { "action": "click" },
      "target": { "css": "ul.ui-autocomplete[style*=\"display: block\"] li a" } },
    { "id": "read-from-city", "kind": "browser.evaluate", "label": "Note whether From now shows Delhi",
      "params": { "fn": "var f = document.getElementById('FromI'); return f && /Delhi/i.test(f.value) ? 'yes' : 'no';" },
      "saveAs": "fromIsDelhi" },
    { "id": "from-gate", "kind": "when", "label": "Make sure From is Delhi",
      "cond": { "equals": ["{{out:fromIsDelhi}}", "yes"] }, "then": [],
      "else": [ { "id": "stop-from-not-delhi", "kind": "stop",
        "label": "Stop: From did not become Delhi",
        "reason": "The From suggestion picked was not Delhi." } ] },
    { "id": "type-to", "kind": "browser", "label": "Type BOM in To",
      "params": { "action": "fill", "value": "BOM" }, "target": { "css": "#ToI" } },
    { "id": "wait-to-suggestion", "kind": "browser", "label": "Wait for the Mumbai suggestion",
      "params": { "action": "wait", "text": "Mumbai" } },
    { "id": "pick-to-mumbai", "kind": "browser", "label": "Pick the Mumbai suggestion",
      "params": { "action": "click" },
      "target": { "css": "ul.ui-autocomplete[style*=\"display: block\"] li a" } },
    { "id": "read-to-city", "kind": "browser.evaluate", "label": "Note whether To now shows Mumbai",
      "params": { "fn": "var t = document.getElementById('ToI'); return t && /Mumbai/i.test(t.value) ? 'yes' : 'no';" },
      "saveAs": "toIsMumbai" },
    { "id": "to-gate", "kind": "when", "label": "Make sure To is Mumbai",
      "cond": { "equals": ["{{out:toIsMumbai}}", "yes"] }, "then": [],
      "else": [ { "id": "stop-to-not-mumbai", "kind": "stop",
        "label": "Stop: To did not become Mumbai",
        "reason": "The To suggestion picked was not Mumbai." } ] },
    { "id": "fill-depart-date", "kind": "browser", "label": "Set Depart Date to 27/09/2026",
      "params": { "action": "fill", "value": "27/09/2026" }, "target": { "css": "#from" } },
    { "id": "close-date-picker", "kind": "browser", "label": "Close the calendar",
      "params": { "action": "press", "key": "Escape" } },
    { "id": "read-travellers", "kind": "browser.evaluate", "label": "Note whether it is 1 adult, Economy",
      "params": { "fn": "var a = document.getElementById('flightAdult-travellers'); var e = document.getElementById('flightClassEconomic'); return a && a.value === '1' && e && e.checked ? '1 adult, Economy' : 'adults=' + (a && a.value) + ', economy=' + (e && e.checked);" },
      "saveAs": "travellersClass" },
    { "id": "travellers-gate", "kind": "when", "label": "Make sure it is 1 adult, Economy",
      "cond": { "equals": ["{{out:travellersClass}}", "1 adult, Economy"] }, "then": [],
      "else": [ { "id": "stop-wrong-travellers", "kind": "stop",
        "label": "Stop: travellers or class is not 1 adult, Economy",
        "reason": "Travellers/Class is {{out:travellersClass}}, not 1 adult, Economy." } ] },
    { "id": "read-direct-only", "kind": "browser.evaluate",
      "label": "Note whether Direct Flight Only is ticked",
      "params": { "fn": "var b = document.getElementById('Isdirectflight'); return b && b.checked ? 'ticked' : 'unticked';" },
      "saveAs": "directOnly" },
    { "id": "direct-only-gate", "kind": "when", "label": "Untick Direct Flight Only if it is ticked",
      "cond": { "equals": ["{{out:directOnly}}", "ticked"] },
      "then": [ { "id": "untick-direct-only", "kind": "browser", "label": "Untick Direct Flight Only",
        "params": { "action": "click" }, "target": { "css": "#Isdirectflight" } } ],
      "else": [] },
    { "id": "confirm-direct-off", "kind": "browser.evaluate",
      "label": "Note whether Direct Flight Only is now unticked",
      "params": { "fn": "var b = document.getElementById('Isdirectflight'); return b && !b.checked ? 'unticked' : 'ticked';" },
      "saveAs": "directOnlyAfter" },
    { "id": "direct-off-gate", "kind": "when", "label": "Make sure Direct Flight Only is unticked",
      "cond": { "equals": ["{{out:directOnlyAfter}}", "unticked"] }, "then": [],
      "else": [ { "id": "stop-direct-still-on", "kind": "stop",
        "label": "Stop: Direct Flight Only is still ticked",
        "reason": "Direct Flight Only could not be unticked." } ] },
    { "id": "click-search", "kind": "browser", "label": "Click Search",
      "params": { "action": "click" },
      "target": { "css": "#nonMulticityblock button[type=\"submit\"]" },
      "check": { "url_matches": "/Flight/DResult" } }
  ]
}
```

## Acceptance 1 — the Duty is saved and listed

```
node openclaw.mjs gateway call duties.list --json
→ amigos-search   active   steps=27   exclusive=false
```

## Acceptance 2 — a full manual run replays end to end

```
node openclaw.mjs gateway call duties.run --params '{"id":"amigos-search"}'
node openclaw.mjs gateway call duties.run.get --params '{"runId":"<id>"}'   # polled to terminal
```

Run **`0174f2c0-5bff-4101-be3a-4591bf8dcaf7` — `ok`, 26 steps, 29.7s**, from a clean tab,
signing in (the profile was signed out) and ending on the results page. `click-search` carries
`check: { url_matches: "/Flight/DResult" }`, so `ok` means the results page was reached. Every
step carries a screenshot blob id; credential values are masked in evidence.

| step | status | ms | screenshot | summary |
|---|---|---|---|---|
| open-dashboard | ok | 1450 | `380ce905` | https://amigosalliance.co.in/Home/Dashboard |
| read-signed-in | ok | 1011 | `ef5eb087` | `"no"` |
| open-login-panel | ok | 980 | `997a6108` | `button "Login"` |
| wait-login-panel | ok | 643 | `1c518ffa` | waited |
| fill-username | ok | 991 | `2d571a26` | `textbox "User Name" ← ••••••` |
| fill-password | ok | 974 | `15791a4c` | `textbox "Password" ← ••••••` |
| click-sign-in | ok | 2176 | `d99c63f7` | `button "Sign-in"` |
| confirm-signed-in | ok | 750 | `a22e7c3b` | waited |
| open-flight-search | ok | 3019 | `b49db4fc` | https://amigosalliance.co.in/Flight/fltSearch |
| wait-flight-form | ok | 1096 | `c57c7c78` | `"ready"` |
| pick-one-way | ok | 1081 | `c5a6e065` | `label[for="flighttype1"]` |
| type-from | ok | 1088 | `7c9562cf` | `#FromI ← DEL` |
| wait-from-suggestion | ok | 772 | `190ed5dd` | waited |
| pick-from-delhi | ok | 1149 | `03160b4f` | `ul.ui-autocomplete[…] li a` |
| read-from-city | ok | 1105 | `dd6c3cb6` | `"yes"` |
| type-to | ok | 1096 | `7d571373` | `#ToI ← BOM` |
| wait-to-suggestion | ok | 774 | `ab64fca6` | waited |
| pick-to-mumbai | ok | 1099 | `29842486` | `ul.ui-autocomplete[…] li a` |
| read-to-city | ok | 1046 | `30bd3c14` | `"yes"` |
| fill-depart-date | ok | 1036 | `ffd53afa` | `#from ← 27/09/2026` |
| close-date-picker | ok | 1091 | `63c8c5b7` | Escape |
| read-travellers | ok | 1067 | `926fa50a` | `"1 adult, Economy"` |
| read-direct-only | ok | 1070 | `07442e52` | `"ticked"` |
| untick-direct-only | ok | 1104 | `90bfac6d` | `#Isdirectflight` |
| confirm-direct-off | ok | 1096 | `c55839db` | `"unticked"` |
| click-search | ok | 870 | `42cc07dd` | `#nonMulticityblock button[type="submit"]` |

Run outputs:

```json
{"onDashboard":"no","flightFormReady":"ready","fromIsDelhi":"yes","toIsMumbai":"yes",
 "travellersClass":"1 adult, Economy","directOnly":"ticked","directOnlyAfter":"unticked"}
```

Across the 19 stored runs, 203 step-evidence rows carry a screenshot blob id.

## Acceptance 3 — concurrency, then exclusive queueing

**Two concurrent runs of the same non-exclusive Duty.** Two `duties.run` calls back to back:

```
A: 7e0b34e2-c4f5-4433-bd0c-087ae7e8ec1a  started
B: 449dd7dc-4582-4481-80b4-88a06fff0331  started
```

Ten seconds in, `browser tabs` on profile `openclaw` showed both runs driving their own tab
at the same time:

```
tabs 2
  t10  https://amigosalliance.co.in/Flight/fltSearch
  t9   https://amigosalliance.co.in/Flight/fltSearch
```

Both finished **`ok`** with 21 steps each (the login gate correctly skipped sign-in, because
the profile was already signed in from the previous run) — 29.6s and 29.1s.

**Exclusive Duty queues the second start.** `amigos-search` was copied to
`amigos-search-x` with `exclusive: true` via `duties.save`, then started twice back to back:

```
saved  amigos-search-x  active  exclusive=true
first  : {"runId":"ff988dd6-3b3b-4843-8082-b712856f42f4","queued":false}
second : {"runId":"a2368538-2b9b-4b1a-8176-12e60a441dab","queued":true,
          "reason":"runs alone — waiting for the current run"}
```

Both then completed `ok`, strictly serialized — the second started 3 ms after the first ended:

| run | status | steps | startedAt | endedAt |
|---|---|---|---|---|
| `ff988dd6` (first) | ok | 21 | 1789306863270 | 1789306889993 |
| `a2368538` (queued) | ok | 21 | 1789306889996 | 1789306917313 |

## Acceptance 4 — Control UI

The Duties page is served by the proof Gateway:

- `GET http://127.0.0.1:19001/duties` → `200 text/html`, `<title>OpenClaw Control</title>`.
- The plugin's Control UI bundle is registered and auth-gated:
  `GET /__openclaw__/plugins/control-ui/duties/<build-hash>/index.js` → `401` unauthenticated
  (and `404` for any other path, i.e. the manifest `controlUi.entry` is the one being served).

**For the owner, to view it:** in a real terminal run
`OPENCLAW_STATE_DIR=~/.openclaw-duties node openclaw.mjs gateway auth-token --show`
from `/Users/pulkitshah/Developer/vasudev-openclaw`, then open
<http://127.0.0.1:19001/duties> and sign in with that token. The token is deliberately not
recorded here. Note the Gateway on 19001 is stopped at the end of this task and must be
restarted (command at the top of this document) before the page will load.

## Full run ledger

19 runs stored on the proof Gateway, newest first. The `failed` rows before `0174f2c0` are the
authoring iterations, and they are the evidence for the two fixes and the gaps below.

| run | duty | status | steps | ms | failed step |
|---|---|---|---|---|---|
| `a2368538` | amigos-search-x | ok | 21 | 27317 | — |
| `ff988dd6` | amigos-search-x | ok | 21 | 26723 | — |
| `449dd7dc` | amigos-search | ok | 21 | 29134 | — |
| `7e0b34e2` | amigos-search | ok | 21 | 29561 | — |
| `0174f2c0` | amigos-search | ok | 26 | 29661 | — |
| `c7bc320a` | amigos-search | failed | 2 | 26551 | read-signed-in (`connectOverCDP` timeout) |
| `0937aa61` | amigos-search | failed | 2 | 240671 | read-signed-in (browser request timed out) |
| `4c6e34f9` | amigos-search | failed | 9 | 419837 | open-flight-search |
| `562e74ec` | amigos-search | failed | 10 | 31876 | wait-flight-form |
| `894338bc` | amigos-search | ok | 17 | 144352 | — (stopped at old travellers gate) |
| `09b04d49` | amigos-search | failed | 7 | 7561 | type-from |
| `ef9dd871` | amigos-search | failed | 5 | 87552 | wait-flight-form |
| `fb04f590` | amigos-search | failed | 6 | 18155 | pick-one-way |
| `e5381117` | amigos-search | failed | 6 | 26465 | pick-one-way |
| `3d837791` | amigos-search | failed | 5 | 25837 | wait-flight-form |
| `943773b9` | amigos-search | ok | 3 | 3037 | — (login gate skipped sign-in) |
| `4a430c45` | amigos-search | ok | 8 | 10418 | — (login stage signed in) |
| `a538d27e` | amigos-search | failed | 8 | 18058 | — (**the `failedStep` serialization bug**) |
| `a7025dbd` | amigos-search | failed | 8 | 36863 | confirm-signed-in |

## Remaining gaps

1. **The managed browser's `evaluate` route degrades under sustained use.** After the
   authoring session, `browser evaluate` failed **6/6** times with
   `browserType.connectOverCDP: Timeout 9000ms exceeded` (~25s per attempt) while `open`,
   `tabs` and `doctor` on the same profile stayed fast and `doctor` reported
   `running/cdpReady/cdpHttp/pageReady` all true with only 3 open tabs. `openclaw browser stop`
   then `start` restored it (evaluate back to ~4.5s), and the clean end-to-end run followed
   immediately. This is in the host browser plugin, not `extensions/duties`, and it is the
   cause of most of the long `failed` rows above (`open-flight-search` at 419s,
   `read-signed-in` at 240s). It needs its own investigation; until then a long authoring
   session should restart the managed browser before a proof run. **The Duties runner has no
   retry or reconnect for this** — a transient browser-transport failure fails the whole run.
2. **`when.cond` has no `url_matches`.** The spec's cond vocabulary is `visible` / `equals` /
   `text_matches`, so the single most natural login gate — "am I on the dashboard?" — needs a
   `browser.evaluate` step to stringify the answer first. Four of the Duty's gates are this
   shape. Worth adding `url_matches` to `Cond` in a later part.
3. **Most search-stage targets are `css`.** The agent reported that role+name and visible-text
   targets missed elements on this page (the One Way radio's real input sits transparent
   behind its label; the autocomplete list needs
   `ul.ui-autocomplete[style*="display: block"]`). That is against the skill's preference and
   makes the Duty brittle to site markup changes, but it reflects the real page.
4. **Single-session account.** Amigos permits one session at a time, so any run that signs in
   logs out whoever else is using that account, including the owner's own browser. The login
   gate now avoids signing in when already signed in, which contains but does not remove this.
5. **`triggers: []` passes validation.** The saved Duty has no triggers at all yet is `active`
   and runs manually, so "manual" is implicit rather than declared. Worth deciding whether
   `validateDuty` should require an explicit `{ kind: "manual" }`.
6. **Long agent turns outrun the CLI.** Turn 4 exceeded the 930s CLI wait; the Gateway kept
   running the turn and the work landed, but the CLI reported a timeout and the reply was
   lost. Authoring turns need either a longer `--timeout` or a way to reattach to an accepted
   run.
7. **Not covered here** (Part 2 by design): `for-each`, `template`, `deliver`, `file/print`,
   `mcp` steps, and the schedule/mail/channel/webhook triggers. The `ai` and `ask` step kinds
   have unit coverage but were not exercised live by this Duty.

## Cleanup

Only the proof Gateway on 19001 was stopped at the end. The owner's live Gateway on 18789 was
verified still listening, and `~/.openclaw` was never written to. `~/.openclaw-duties` and its
stored duties/runs are left in place as the evidence behind this document.
