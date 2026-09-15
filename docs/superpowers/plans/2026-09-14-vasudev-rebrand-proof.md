# Vasudev rebrand — Task 5 proof

Worktree: `/Users/pulkitshah/Developer/vasudev-openclaw-brand`, branch `feat/vasudev-brand`, HEAD `524eff8c80` ("fix(brand): guard docs.json, keep bundle names and generated blocks, locale fixture").

Proof Gateway: port `19002`, state dir `~/.openclaw-brand-proof`, config
`{"gateway":{"mode":"local","port":19002,"bind":"loopback","auth":{"mode":"token","token":"brand-proof-token"}}}`
(throwaway loopback token). Ports `19001`/`18789` and state dirs `~/.openclaw`, `~/.openclaw-duties` were never touched.

## 1. Build

```
OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 pnpm build
```

Succeeded: `✓ built in 8.86s` (Control UI), `[build-all] phase timings: total 53.4s`. `dist/build-info.json` recorded `version 2026.9.4`, `commit 524eff8c80842e589e27843f748fff8741114101`.

## 2. CLI version/banner/help

```
$ node openclaw.mjs --version
OpenClaw 2026.9.4 (524eff8)

$ node openclaw.mjs -V
OpenClaw 2026.9.4 (524eff8)

$ node openclaw.mjs --no-color --version
OpenClaw 2026.9.4 (524eff8)

$ node "$(node -p "require('./package.json').bin.vasudev")" --version
OpenClaw 2026.9.4 (524eff8)

$ node openclaw.mjs   # no args (non-interactive TTY)
Vasudev TUI needs an interactive TTY. Use `openclaw agent --local ...` for automation.

$ node openclaw.mjs --help | head -20

Vasudev 2026.9.4 (524eff8) — All your chats, one Vasudev.

Usage: openclaw [options] [command]

Options:
  --container <name>   Run the CLI inside a running Podman/Docker container
                       named <name> (default: env OPENCLAW_CONTAINER)
  --dev                Dev profile: isolate state under ~/.openclaw-dev, default
                       gateway port 19001, and shift derived ports
                       (browser/canvas)
  -h, --help           Display help for command
  --log-level <level>  Global log level override for file + console
                       (silent|fatal|error|warn|info|debug|trace)
  --no-color           Disable ANSI colors
  --profile <name>     Use a named profile (isolates
                       OPENCLAW_STATE_DIR/OPENCLAW_CONFIG_PATH under
                       ~/.openclaw-<name>)
  -V, --version        output the version number
```

**Does not match acceptance.** The `--help` banner and TUI message correctly read "Vasudev" (`PRODUCT_NAME` from `src/brand.ts` is wired through `src/cli/program/help.ts`'s `addHelpText("beforeAll", …)`), but `-V`/`--version`/`-v` print `"OpenClaw …"`, not `"Vasudev …"`, regardless of `vasudev` vs `openclaw` invocation. Root cause is two hardcoded literals that bypass `PRODUCT_NAME` entirely:

- `openclaw.mjs:435` — root launcher fast path (exact argv `["node","openclaw.mjs","--version"|"-V"|"-v"]`): `` process.stdout.write(commit ? `OpenClaw ${version} (${commit})\n` : `OpenClaw ${version}\n`); ``
- `src/entry.version-fast-path.ts:58` — the general fast path used for any other invocation shape (`isRootVersionInvocation`, checked before `dist/entry.js` even runs commander's own `.version()`/`isRootVersionInvocation` branch in `src/cli/program/help.ts:139-140`, which *does* use `PRODUCT_NAME` correctly but is unreachable for `--version`/`-V`/`-v` because this fast path always wins first): `` output(commit ? `OpenClaw ${VERSION} (${commit})` : `OpenClaw ${VERSION}`); ``

Both are inside the CLI surface the spec's inventory names (`src/cli/banner.ts`/`help.ts` mechanism row: "brand module where a wordmark appears"), but neither file was migrated. This is a real T1 gap, not a proof-environment artifact — confirmed by reading `dist/entry.version-fast-path-CawzgHXm.mjs` (the built chunk for `src/entry.version-fast-path.ts`) and `openclaw.mjs` directly.

## 3. Proof Gateway

```
$ OPENCLAW_STATE_DIR=~/.openclaw-brand-proof OPENCLAW_CONFIG_PATH=~/.openclaw-brand-proof/openclaw.json \
  nohup node openclaw.mjs gateway run --port 19002 > ~/.openclaw-brand-proof/gateway.log 2>&1 &
$ curl -s http://127.0.0.1:19002/healthz
{"ok":true,"status":"live"}
```

Gateway log: `http server listening (19 plugins: …)`, `ready` — reached `healthz` 200 after 4 seconds.

## 4. Screenshots (playwright-core + the host's installed Chromium, `chromium-1234` under `~/Library/Caches/ms-playwright`, same resolution approach as `scripts/brand/render-orb-icons.mjs`)

All under `docs/superpowers/plans/assets/2026-09-14-vasudev-rebrand-proof/`:

- [`01-login-gate.png`](assets/2026-09-14-vasudev-rebrand-proof/01-login-gate.png) — `http://127.0.0.1:19002/`, tab title **"Vasudev Control"**, login card shows the **Vasu orb** + **"Vasudev"** wordmark, heading "This Gateway expects its token". Matches acceptance.
- [`02-model-setup-page.png`](assets/2026-09-14-vasudev-rebrand-proof/02-model-setup-page.png) — after signing in via `http://127.0.0.1:19002/?token=brand-proof-token` (confirmed the Control UI accepts `?token=`/`#token=`, see `ui/src/app/startup-settings.ts:184-218`; a fresh proof state dir has no model configured, so it lands on Model Setup). Sidebar reads **"Ask Vasudev"**. One leftover string: "Connect to a llama.cpp server managed outside OpenClaw".
- [`03-about-page.png`](assets/2026-09-14-vasudev-rebrand-proof/03-about-page.png) — Settings → About. Heading **"Vasudev"**, tagline "Your personal AI assistant, running on your own devices.", footer license line **"Vasudev · by TripIn Studio. Built on OpenClaw, MIT License."** (matches spec's `MAKER_LINE` exactly, plus a deliberate upstream-attribution mention of OpenClaw that the spec itself keeps — see `ui/src/i18n/locales/en.ts` comment cited by `scripts/rebrand-apply.mjs:464-467`). **Mismatch:** the mascot rendered above the wordmark is still the old red lobster/crab mark, not the Vasu orb — the spec says "the logo everywhere is the Vasu orb … instead of the lobster marks," but this About-page mascot was not swapped.
- [`04-ask-vasudev-chat-page.png`](assets/2026-09-14-vasudev-rebrand-proof/04-ask-vasudev-chat-page.png) — clicked "Ask Vasudev" in the sidebar. Header **"Vasudev"** / "System setup and care.", message box placeholder **"Message Vasudev…"** (matches acceptance exactly), sidebar icon is again the small lobster/crab glyph, not the orb. **Mismatch:** the inference-not-configured error banner reads verbatim **"OpenClaw requires working inference: OpenClaw could not verify a usable inference route. Check model setup and try again."** — two visible "OpenClaw" occurrences on the actual chat page, directly against "no OpenClaw visible on any page."

Built title check:
```
$ grep -o "<title>[^<]*</title>" dist/control-ui/index.html
<title>Vasudev Control</title>
```

### Traced source of the leftover "OpenClaw" strings

The chat-page error text comes from the Gateway/system-agent layer, not the UI:
- `src/system-agent/inference-fallback.ts:200` — `error: "OpenClaw could not verify a usable inference route. Check model setup and try again."`
- `src/gateway/server-methods/system-agent.ts:461` — `` `OpenClaw requires working inference: ${inference.error}` ``
- Same pattern (not screenshotted, but same class) in `src/commands/system-agent-with-inference.ts:116,121,130`, `src/commands/onboard-interactive.ts:48`, `src/system-agent/onboarding-welcome.ts:138`, `src/system-agent/operations-execution-helpers.ts:412,421,457`.

None of these files are under `src/cli/**`, `src/wizard/**`, or `src/flows/**`, so they sit outside both the spec's §1 inventory rows and `scripts/rebrand-apply.mjs`'s enforced `TYPESCRIPT_AWARE_GLOBS`/`collectTargetFiles()` allowlist — a real inventory gap, not just an unapplied rewrite.

## 5. `pnpm brand:check`

```
$ pnpm brand:check
$ node scripts/check-brand.mjs
brand check: clean — no allowlisted file contains a literal "OpenClaw".
```

Clean, as expected — but this is a narrower claim than acceptance's "no OpenClaw visible on any page." `scripts/rebrand-apply.mjs` enforces only: `docs/*.md` (excluding `docs/superpowers/**`), `README.md`, `docs/docs.json`, `extensions/*/openclaw.plugin.json`, `extensions/*/package.json`, `src/cli/*.ts(x)`, `src/wizard/*.ts(x)`, `src/flows/*.ts(x)`, and three single-file targets (`src/channels/plugins/pairing-message.ts`, `extensions/telegram/src/bot-message-context.session.ts`, `extensions/bonjour/src/advertiser.ts`). `ui/src/**/*.ts`, `ui/index.html`, and `ui/public/manifest.webmanifest` are listed in the script's own `DEFERRED_ALLOWLIST_GLOBS` with a comment explaining enforcement was deliberately deferred to a follow-up task (`scripts/rebrand-apply.mjs:459-473`). `src/system-agent/**`, `src/commands/**`, and `src/gateway/server-methods/**` (the source of the chat-page "OpenClaw" strings above) are not mentioned in the guard at all. So the "brand:check clean" result and the actual "OpenClaw" text visible on the live chat page (§4) are both true at once — the guard's scope is narrower than the acceptance bullet it's meant to prove.

## 6. Upstream merge dry run

```
$ git fetch upstream main   # remote already configured: https://github.com/openclaw/openclaw.git
$ git merge --no-commit --no-ff upstream/main
```

68 conflicts (`git diff --name-only --diff-filter=U`). Classification against `scripts/rebrand-apply.mjs`'s enforced allowlist (`collectTargetFiles()`):

**Inside the allowlist (re-running `pnpm brand:apply` after merge is expected to resolve these):**
- 63 `docs/**/*.md` pages (all under the `docs/*.md` glob, which crosses `/` under git's default fnmatch and is not under `docs/superpowers/`): `docs/automation/cron-jobs/payloads.md`, `docs/channels/discord-activities.md`, `docs/channels/discord/voice-channels.md`, `docs/channels/imessage-from-bluebubbles.md`, `docs/channels/index.md`, `docs/channels/nextcloud-talk.md`, `docs/channels/signal.md`, `docs/channels/telegram/transports.md`, `docs/channels/wecom.md`, `docs/channels/whatsapp.md`, `docs/cli/backup.md`, `docs/cli/gateway/restart-and-supervision.md`, `docs/cli/triage.md`, `docs/cli/update.md`, `docs/cli/update/how-updates-run.md`, `docs/concepts/compaction.md`, `docs/concepts/managed-worktrees.md`, `docs/concepts/models.md`, `docs/gateway/cloud-sessions.md`, `docs/gateway/cloud-workers/session-lifecycle.md`, `docs/gateway/cloud-workers/setup-and-bundle-installation.md`, `docs/gateway/config-agents/models.md`, `docs/gateway/config-extensions.md`, `docs/gateway/protocol/rpc-session-control.md`, `docs/gateway/sandbox-vs-tool-policy-vs-elevated.md`, `docs/gateway/sandboxing/docker-backend.md`, `docs/gateway/secrets/secretref-contract.md`, `docs/gateway/security/secure-file-operations.md`, `docs/help/faq/chat-commands-and-stopping.md`, `docs/install/backups.md`, `docs/install/installer.md`, `docs/install/updating.md`, `docs/install/updating/rollback-and-recovery.md`, `docs/install/updating/update-methods.md`, `docs/maturity/scorecard.md`, `docs/maturity/taxonomy.md`, `docs/nodes/computer-use.md`, `docs/nodes/session-hosting.md`, `docs/platforms/mac/remote.md`, `docs/platforms/omarchy.md`, `docs/plugins/codex-computer-use.md`, `docs/plugins/codex-harness-reference/app-server-transport.md`, `docs/plugins/codex-harness-reference/approval-and-sandbox.md`, `docs/plugins/google-meet.md`, `docs/plugins/google-meet/config.md`, `docs/plugins/google-meet/tool-and-modes.md`, `docs/plugins/google-meet/transports.md`, `docs/plugins/google-meet/troubleshooting.md`, `docs/plugins/manifest/surfaces.md`, `docs/plugins/meeting-plugins.md`, `docs/plugins/sdk-testing.md`, `docs/plugins/session-share.md`, `docs/plugins/voice-call/realtime-and-streaming.md`, `docs/providers/comfy.md`, `docs/tools/acp-agents/troubleshooting.md`, `docs/tools/browser/remote.md`, `docs/tools/code-mode/quickstart.md`, `docs/tools/code-mode/tool-surface.md`, `docs/tools/lobster.md`, `docs/tools/subagents/operations.md`, `docs/web/control-ui.md`, `docs/web/control-ui/feature-reference.md`, `docs/web/control-ui/panels.md`, `docs/web/control-ui/sessions-and-sidebar.md`.
- `src/cli/gateway-cli/startup-maintenance.ts`, `src/cli/program/config-guard.ts` (both match `src/cli/*.ts`, which likewise crosses `/`).

**Outside the enforced allowlist (re-running the apply script will *not* touch these — a maintainer resolves them by hand):**
- `docs/.generated/config-baseline.sha256` — a generated checksum, not `.md`.
- `scripts/plugin-sdk-surface-report.mts` — not under any allowlisted prefix.
- `ui/index.html`, `ui/src/i18n/locales/en.ts`, `ui/src/i18n/locales/en-session-placement.ts` — all three are named in `scripts/rebrand-apply.mjs`'s own `DEFERRED_ALLOWLIST_GLOBS` (documented, not yet enforced; see §5).

**So acceptance's last bullet ("conflicts only in the files the apply script rewrites, and re-running the script resolves them") does not fully hold today**: 5 of 68 conflicting files sit outside `collectTargetFiles()`'s scope, matching exactly the `ui/**` deferral the script's own comments already flag, plus two files (`docs/.generated/config-baseline.sha256`, `scripts/plugin-sdk-surface-report.mts`) not mentioned anywhere in the rebrand plan.

Aborted cleanly:
```
$ git merge --abort
```
No merge state remained (`.git/MERGE_HEAD` absent afterward); nothing was resolved or committed.

### Note: concurrent working-tree activity (not mine, not touched)

At the moment of the merge dry run, `git status -sb` (taken *before* `git fetch`/`git merge` were run) already showed uncommitted local modifications to `scripts/rebrand-apply.mjs`, `src/cli/profile.test.ts`, and `test/scripts/check-brand.test.ts` — predating this task's edits (this task made none). Content inspection shows a plausible in-progress fix unrelated to this proof: `scripts/rebrand-apply.mjs`'s working copy has the `PROTECTED_PROSE_PHRASES` exemption list removed, and `src/cli/profile.test.ts`'s working copy reverts the Windows service task name test expectation from `"Vasudev Gateway"` back to `"OpenClaw Gateway"` (consistent with the spec's "internals stay openclaw" rule for service labels — `resolveGatewayWindowsTaskName` is infra, not user-visible prose). `git merge --abort` correctly preserved these (git's documented `reset --merge` behavior keeps working-tree changes unrelated to the merge) rather than discarding them. Verified no conflict markers and `node --check` passes on the `.mjs` file. Left untouched; excluded from this task's commit by pathspec.

## 7. Proof Gateway shutdown

```
$ lsof -nP -iTCP:19002 -sTCP:LISTEN
node  20674 pulkitshah  … TCP 127.0.0.1:19002 (LISTEN)
$ kill -TERM 20674
# exited within 2s
$ lsof -nP -iTCP:19002 -sTCP:LISTEN
(no output — no listener)
```

Ports `19001`/`18789` and `~/.openclaw`, `~/.openclaw-duties` were confirmed untouched throughout (checked before and after).

## Summary vs. spec §4 acceptance

| Acceptance bullet | Result |
| --- | --- |
| `openclaw --version`/banner show "Vasudev …" and "All your chats, one Vasudev."; `vasudev` runs the same CLI | **Partial.** Banner (`--help`) and TUI message: match. `--version`/`-V`/`-v` (both `openclaw` and `vasudev` binaries): **does not match** — prints `"OpenClaw …"` (see §2). |
| Control UI: tab title "Vasudev Control", login wordmark "Vasudev" beside the orb, chat "Ask Vasudev"/"Message Vasudev…", favicon = orb; no "OpenClaw" visible on any page (guard passes) | **Partial.** Title, login wordmark+orb, "Ask Vasudev", "Message Vasudev…": match. "No OpenClaw visible on any page": **does not match** — the live chat page shows "OpenClaw requires working inference: OpenClaw could not verify a usable inference route…" (§4); the About-page and chat-page mascot glyph is still the old lobster/crab mark, not the orb. Guard (`pnpm brand:check`) does pass, but its scope is narrower than this bullet (§5). Favicon itself not independently re-verified pixel-for-pixel in this pass beyond the login-gate screenshot's orb rendering. |
| Telegram: pairing "✅ Vasudev access approved…", assistant label "Vasudev"; Bonjour "… (Vasudev)" | Not exercised in this proof pass (no channels configured in the throwaway Gateway; out of this task's steps as scoped). |
| Docs site name/logo updated; README title updated | Not independently re-verified in this pass (covered by the merge dry-run's docs conflict list in §6, which shows those pages are still on the enforced allowlist for `brand:apply`). |
| `git merge upstream/main` conflicts only in apply-script-owned files, resolved by re-running it | **Does not fully match** — 5 of 68 conflicting files fall outside `collectTargetFiles()`'s scope (§6). |

## Concerns for follow-up (not fixed here — proof only)

1. `openclaw.mjs:435` and `src/entry.version-fast-path.ts:58` hardcode `"OpenClaw"` for `--version`/`-V`/`-v`, bypassing `src/brand.ts`'s `PRODUCT_NAME` entirely.
2. `src/system-agent/inference-fallback.ts:200`, `src/gateway/server-methods/system-agent.ts:461`, `src/commands/system-agent-with-inference.ts:116,121,130`, `src/commands/onboard-interactive.ts:48`, `src/system-agent/onboarding-welcome.ts:138`, `src/system-agent/operations-execution-helpers.ts:412,421,457` hardcode `"OpenClaw"` in strings shown directly in the Control UI chat page and CLI onboarding output; none are covered by the spec's §1 inventory or `scripts/rebrand-apply.mjs`'s allowlist.
3. `scripts/rebrand-apply.mjs`'s own `DEFERRED_ALLOWLIST_GLOBS` comment (lines ~459-473) documents that `ui/src/**/*.ts`, `ui/index.html`, and `ui/public/manifest.webmanifest` are intentionally not yet guarded/rewritten — this is a known, self-declared gap, not new information, but it is the direct cause of 3 of the 5 out-of-allowlist merge conflicts in §6.
4. The About page and the chat header/sidebar still render the old lobster/crab mascot glyph instead of the Vasu orb (the login gate correctly uses the orb).
5. A concurrent, uncommitted edit to `scripts/rebrand-apply.mjs`/`src/cli/profile.test.ts`/`test/scripts/check-brand.test.ts` was present in the shared worktree during this proof run (§6 note) — left untouched, flagged here for visibility since it touches the same guard script this proof exercised.
