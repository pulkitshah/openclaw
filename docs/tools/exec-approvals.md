---
summary: "Host exec approvals: policy knobs, allowlists, and the YOLO/strict workflow"
read_when:
  - Configuring exec approvals or allowlists
  - Inspecting or revoking durable MCP tool grants
  - Implementing exec approval UX in the macOS app
  - Reviewing host-execution approval prompts from a sandboxed agent and their implications
title: "Exec approvals"
sidebarTitle: "Exec approvals"
---

Exec approvals are the **companion app / node host guardrail** for letting a
sandboxed agent run commands on a real host (`gateway` or `node`). Commands
run only when policy + allowlist + (optional) user approval all agree.
Approvals stack **on top of** tool policy and elevated gating. Gateway
full-session and qualifying elevated-full paths can skip host approval
evaluation. See the [strict inline-eval exceptions](/tools/exec#inline-eval-strictinlineeval).

For a mode-first overview of `deny`, `allowlist`, `ask`, `auto`, `full`,
Codex Guardian mapping, and ACPX harness permissions, see
[Permission modes](/tools/permission-modes).

<Note>
Outside the full-permission Gateway session exception described below,
effective policy is the **stricter** of `tools.exec.*` and approvals
defaults: approvals can only tighten config-derived security/ask, never
loosen them. If an approvals field is omitted, the `tools.exec` value is
used. Host exec also uses local approvals state on that machine - a
host-local `ask: "always"` in the execution host approvals document keeps
prompting even if session or config defaults request `ask: "on-miss"`.
An unconfigured node uses the same `full` / `off` baseline as the Gateway.
Node execution still checks the target policy before dispatch: caller
`allowlist` / `off` denies an unmatched command, and target `ask: "always"`
requires approval even when the caller requests `full` / `off`.
</Note>

## Where it applies

Exec approvals are enforced locally on the execution host:

- **Gateway host** -> `openclaw` process on the gateway machine.
- **Node host** -> node runner (macOS companion app or headless node host).

The `claude-cli` backend also checks native Bash commands against the agent's
exec allowlist when `ask: "on-miss"`. This authorizes command arguments while
Claude Code owns execution. It does not provide Vasudev sandboxing. See
[Native Bash and the exec allowlist](/gateway/cli-backends#native-bash-and-the-exec-allowlist)
for matching, prompting, and binding restrictions.

### Trust model

- Gateway-authenticated callers are trusted operators for that Gateway.
- Paired nodes extend that trusted operator capability onto the node host.
- Approvals reduce accidental execution risk, but are **not** a per-user auth boundary or filesystem read-only policy.
- Once approved, a command can mutate files according to the selected host or sandbox filesystem permissions.
- Approved node-host runs bind canonical execution context: cwd, exact argv, env binding when present, and pinned executable path when applicable.
- Gateway approval-backed commands bind every resolved command-segment executable before review and re-check it before launch. Node hosts capture these identities during local policy evaluation and re-check before dispatch. This does not cover inner shell executables across a remote human approval wait. Protected executables use resolved real-path identity only. Writable executables also use a content hash. A changed resolution during the bound window, including a new executable earlier on `PATH`, denies the run. Identity-only binding preserves otherwise eligible `allow-always` decisions. See [Interpreter/runtime commands](/tools/exec-approvals-advanced#interpreter%2Fruntime-commands).
- For shell scripts and direct interpreter/runtime file invocations, Vasudev also tries to bind one concrete local file operand. If that file changes after approval but before execution, the run is denied instead of executing drifted content.
- File binding is best-effort, not a complete model of every interpreter/runtime loader path. If exactly one concrete local file cannot be identified, Vasudev refuses to mint an approval-backed run rather than pretend full coverage.

### macOS split

- The **node host service** forwards `system.run` to the **macOS app** over local IPC.
- The **macOS app** enforces approvals and executes the command in UI context.

## Inspecting the effective policy

| Command                                                          | What it shows                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `openclaw approvals get` / `--gateway` / `--node <id\|name\|ip>` | Requested policy, host policy sources, and the effective result.                           |
| `openclaw exec-policy show`                                      | Local-machine merged view.                                                                 |
| `openclaw exec-policy set` / `preset`                            | Synchronize the local requested policy with the local host approvals document in one step. |

<Note>
Per-session `/exec` overrides are not included. Run `/exec` in the relevant session to inspect its current defaults. See [session overrides](/tools/exec#session-overrides-%2Fexec).
</Note>

Full CLI reference (flags, JSON output, allowlist add/remove): [Approvals CLI](/cli/approvals).

When a local scope requests `host=node`, `exec-policy show` reports that
scope as node-managed at runtime instead of treating the local approvals
file as the source of truth.

If the companion app UI is **not available**, any request that would
normally prompt is resolved by the **ask fallback** (default: `deny`).

<Tip>
Native chat approval clients can seed channel-specific affordances on the
pending approval message. Matrix seeds reaction shortcuts (`✅` allow once,
`♾️` allow always, `❌` deny) while still leaving `/approve ...` in the
message as a fallback.
</Tip>

For native chat approval surfaces, a node exec waits for the decision within
the originating tool call and returns the command output there. Closing or
cancelling that turn invalidates its pending authority. A late approval cannot
restart it. A typed `SYSTEM_RUN_DENIED` result means the node rejected execution,
not that the command may have run.

## Settings and storage

Approvals live in the shared SQLite state database on the execution host. When
`OPENCLAW_STATE_DIR` is set, the database follows that state directory.
Otherwise it uses the default Vasudev state directory:

```text
$OPENCLAW_STATE_DIR/state/openclaw.sqlite#exec_approvals_config
# otherwise
~/.openclaw/state/openclaw.sqlite#exec_approvals_config
```

The `#exec_approvals_config` suffix is a display locator for the singleton
SQLite row, not part of the database filename. The row keeps the JSON document
shown below as its authoritative value, so CLI and Gateway compare-and-swap
hashes remain stable.

The default approval socket follows the same root:
`$OPENCLAW_STATE_DIR/exec-approvals.sock`, or
`~/.openclaw/exec-approvals.sock` when the variable is unset.

State directories are independent trust scopes. When `OPENCLAW_STATE_DIR`
points somewhere else, Vasudev never imports or archives approvals from the
default state directory. Configure approvals separately for the custom state
directory. If the active state directory still contains a legacy
`exec-approvals.json`, stop the Gateway and run `openclaw doctor --fix` once to
import it. Doctor also imports legacy
`plugin-binding-approvals.json` only when it belongs to the active state
directory.

Legacy allowlist entries may contain `null` for `lastUsedAt` or
`lastUsedCommand`. Doctor treats those two usage fields as absent during
import, including when the config still needs repair. This does not relax
canonical policy validation: other malformed fields or conflicting legacy
policies remain preserved for operator recovery, and exec approvals stay
blocked until the legacy file is resolved. After repair, verify with
`openclaw approvals get` using the same state directory.

Example schema:

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/path/to/**/bin/rg",
          "argPattern": "sha256:argv:...",
          "source": "allow-always",
          "lastUsedAt": 1737150000000,
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        },
        {
          "pattern": "~/path/to/**/bin/git"
        }
      ],
      "mcpTools": [
        {
          "server": "project-docs",
          "tool": "publish_page",
          "source": "allow-always",
          "addedAt": 1737150000000
        }
      ]
    }
  }
}
```

## Policy knobs

### `tools.exec.mode`

`tools.exec.mode` is the preferred normalized policy surface for host exec:

| Value       | Behavior                                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deny`      | Block host exec.                                                                                                                                            |
| `allowlist` | Run only allowlisted commands without asking.                                                                                                               |
| `ask`       | Use allowlist policy and ask on misses.                                                                                                                     |
| `auto`      | Run deterministic allowlist matches directly; review eligible misses with `allow` (once), `deny` (reason returned to the agent), or `ask` (human approval). |
| `full`      | Run host exec without ordinary policy prompts; see strict inline-eval behavior below.                                                                       |

Doctor migrates supported legacy `tools.exec.security` / `tools.exec.ask` pairs
to `tools.exec.mode`. If a deploy script, template, or config generator still
sends the old fields, `config patch` and Gateway `config.patch` reject the mixed
policy without changing the file. Update that source in the same exec object
named by the error, including `agents.entries.<agentId>.tools.exec` for an agent
override. Replace `security` / `ask` with the suggested `mode` value when an exact
equivalent exists. For example, `security: "full", ask: "off"` becomes `mode: "full"`.

An incomplete pair needs an explicit choice of the intended policy before
conversion. Pairs with `ask: "always"`, or `security: "full", ask: "on-miss"`,
have no exact mode equivalent: retain both legacy fields and remove `mode` from
that same object to keep their policy. Preserve other exec settings when replacing
an object. Run `openclaw doctor --fix` for a saved file that still needs migration.
Running it again does not update a stale deployment source.

### `exec.security`

<ParamField path="security" type='"deny" | "allowlist" | "full"'>
  - `deny` - block all host exec requests.
  - `allowlist` - allow only allowlisted commands.
  - `full` - do not require an allowlist match. This does not grant elevated access.

Default is `full` for gateway/node hosts. A `sandbox` host defaults to
`deny` instead.
</ParamField>

### `exec.ask`

<ParamField path="ask" type='"off" | "on-miss" | "always"'>
  Configured ask policy for host exec. Controls the baseline approval
  prompt behavior from `tools.exec.mode` and host approvals defaults.
  Default is `off`. The per-call `ask` tool parameter (see
  [Exec tool](/tools/exec#parameters)) can only harden that baseline, and
  channel-origin model calls ignore it when the effective host ask is `off`.

- `off` - no ordinary policy prompts. Separately enabled strict inline-eval checks can still require approval.
- `on-miss` - prompt only when the allowlist does not match.
- `always` - prompt on every command. `allow-always` durable trust does **not** suppress prompts when effective ask mode is `always`.

</ParamField>

### `askFallback`

<ParamField path="askFallback" type='"deny" | "allowlist" | "full"'>
  Resolution when a prompt is required but no UI is reachable (or the
  prompt times out). Defaults to `deny` when omitted.

- `deny` - block.
- `allowlist` - allow only if allowlist matches.
- `full` - add no stricter fallback limit to the active security policy. Allowlist restrictions and explicit-approval requirements, such as recognized strict inline-eval forms, still apply.

</ParamField>

### `tools.exec.strictInlineEval`

<ParamField path="strictInlineEval" type="boolean" default="false">
  When ordinary host approval evaluation runs, `true` treats recognized
  inline code-eval forms as approval-only, including under ordinary
  `full`/`off` policy or an allowlisted interpreter binary. Defense-in-depth
  for interpreter loaders that do not map cleanly to one stable file operand.
</ParamField>

Examples that strict mode catches: `python -c`, `node -e`/`--eval`/`-p`,
`ruby -e`, `perl -e`/`-E`, `php -r`, `lua -e`, `osascript -e` (also `awk`,
`sed`, `make`, `find -exec`, and `xargs` inline forms).

On that approval path, these commands need reviewer or explicit approval. With
`tools.exec.mode: "auto"`, eligible commands receive an `allow`, `deny`, or `ask`
verdict. The reviewer may grant one low- or medium-risk execution, return a denial
reason to the agent, or ask a human. Gateway commands must pass mutable-file
binding checks, but do not need a rendered command with pinned paths to receive
review. POSIX login or interactive shell wrappers skip the reviewer and require
human approval when binding succeeds because their implicit startup files are outside
operand binding. Existing binding rejections, including interactive code-loading forms,
remain denied.
See [Exec modes](/tools/exec#modes) for binding limits and escalation.
`Codex app-server` command approvals that reach the reviewer fallback ask a
human because their approval requests do not expose an enforceable resolved
executable.
`allow-always` does not persist new allowlist entries for inline-eval commands.

Configured `tools.exec.mode: "full"` alone does not bypass this setting. On
the Gateway, a full-permission session with effective security `full` and
ask `off` skips host approval evaluation. Permitted elevated-full execution
also skips it when both exec and host approval policies allow `full`/`off`.
Those paths skip strict inline-eval detection. Ask-only tightening of a full
session restores the approval path while retaining its host-file-floor
exception. See [Inline eval](/tools/exec#inline-eval-strictinlineeval).

### `tools.exec.denySelfCli`

<ParamField path="denySelfCli" type="boolean" default="false">
  When `true`, host exec unconditionally denies any command whose resolved
  executable is this product's own CLI binary (`vasudev`/`openclaw` —
  `package.json`'s `bin` field aliases both names to the same entry point),
  for any subcommand or arguments. Unlike `strictInlineEval`, a hit here is
  terminal: there is no reviewer, no human approval, and no `full`/
  `allowlist`/`ask`/`auto` mode that lets it through. Every other exec
  command is unaffected and keeps its existing policy exactly as configured.
</ParamField>

Set globally under `tools.exec.denySelfCli` or per agent under
`agents.entries.*.tools.exec.denySelfCli`. Team's plugin sets this to `true`
by default for the coordinator agent once a coordinator can be resolved,
unless the operator has already made an explicit choice (`true` or `false`)
for that agent — an explicit choice is never overridden.

**`denySelfCli` is defense-in-depth, not the security boundary.** It guards
an _executable name_, and the privileged capabilities behind that name are
reachable without it: the Gateway serves them to any client presenting an
operator-scoped credential, and `vasudev pairing approve` does not even go
through the Gateway — it writes the shared pairing store directly. So treat
`denySelfCli` as what it is: a cheap, effective stop against casual or
accidental self-CLI use by the agent, layered under the real boundary.

The real boundary for the capability this was originally aimed at — the agent
approving a channel pairing, which admits a new person to instruct it — is
Gateway scope enforcement. An agent-originated Gateway request is refused
`channels.pairing.approve` and `channels.pairing.dismiss` at the router's
authorization fence, before the `operator.admin` wildcard is consulted, so no
scope set the agent can mint reaches them. See
[Access control](/gateway/security/access-control).

This is a binary-identity check, not a substring match: it matches a
command's resolved executable name (bare `PATH` lookup, or a path whose
target is exactly `vasudev`/`openclaw`), so a path that merely contains one
of those names — for example `/home/vasudev-user/script.sh` — is
unaffected. The check also recurses into a generic shell wrapper's inline
payload (for example `bash -lc "vasudev ..."`, `sh -c "vasudev ..."`, or a
nested `env bash -lc "vasudev ..."`), up to several levels of nesting, so
wrapping the CLI in a shell does not bypass it.

**This is layer 1 of a two-layer defense.** It is a _static_ check: it
inspects the command's resolved segments before anything is spawned, and it
can only recognize a bounded set of shapes (bare/path invocation, a
transparent dispatch wrapper whose own resolved identity is the self-CLI
binary, and a recognized shell wrapper's inline payload). It cannot see a
self-CLI invocation buried inside an indirection tool it does not itself
unwrap — for example `pnpm exec bash -c "vasudev ..."` (the observed argv
still has a `pnpm exec` prefix the shell-wrapper recursion does not match),
`find . -exec vasudev ... \;`, or `xargs -I{} vasudev {}`. Recognizing every
such tool one at a time is an open-ended enumeration problem, not something
a finite list can ever finish closing.

Layer 1 runs unconditionally on **every** exec host once `denySelfCli` is
set — gateway, node, and sandbox alike. Each host has its own call site
(there is no shared dispatch path across all three), so this is enforced
per host: the gateway host runs it both on its normal allowlist path and
independently on its full-trust `bypassApprovals` path (so an explicit
full-session grant cannot skip it), the node host runs it unconditionally
as part of dispatching to the remote device, and the sandbox host — which
has no allowlist/approval layer of its own at all — runs it as the _only_
gate standing between the command and the sandbox backend's spawn.

**Layer 2: the PATH-shadow environment defense.** When `denySelfCli` is
active, every exec host's environment-building code prepends a small stub
directory ahead of every other `PATH` entry in the spawned command's own
environment. That directory contains executable files literally named
`vasudev`/`openclaw` that immediately deny and exit non-zero. Because
`PATH` search order is a property of the environment inherited by the
_entire_ process tree a command spawns — not something each wrapper tool
has to individually support — this closes the whole class of "unrecognized
indirection tool" bypasses at once (including `pnpm exec`, `find -exec`,
`xargs`, and a scripting language's subprocess-by-name call), without
needing layer 1 to recognize any of those tools by name. Layer 2 is
additive: layer 1 still runs first and denies plenty of cases (including
every direct/absolute-path invocation, on any host) before anything is
spawned.

But putting the directory's path into `PATH` only helps if a real directory
with real deny-stub files actually exists at that path *inside the
filesystem the spawned command sees* — layer 2's real scope is therefore
per sandbox backend, not a blanket "sandbox host" claim:

- **Gateway host:** in scope. The command runs in this process's own
  filesystem, where the stub directory genuinely lives.
- **Sandbox via the Docker/Podman backend:** in scope. `docker-backend.ts`'s
  container-provisioning code (`docker.ts`'s
  `ensureSandboxContainerLifecycle`) bind-mounts the stub directory
  read-only into the container at container-creation time, at the exact
  same host-absolute path the PATH entry already carries, so PATH
  resolution inside the container finds the real stub files.
- **Sandbox via the remote-shell/SSH backend:** *not* in scope. This
  backend's PATH-building runs through the same code as every other host,
  so the stub directory's path still lands in the spawned command's `PATH`
  string — but that directory is a local, host-side path with no
  equivalent on the genuinely separate remote filesystem the command
  actually runs on, and there is no bind-mount primitive over SSH to make
  one appear there. The PATH entry is real but resolves to nothing.
  Shipping stub files to an arbitrary remote host on every exec call would
  be disproportionate scope for this layer, so this backend's self-CLI
  defense is layer 1 alone — the same tier as the node host, below.
- **Node host:** not in scope, for a different, structural reason: the node
  host dispatches a command to a genuinely remote device via `system.run`,
  and this process never controls that device's `PATH` (the same reason
  `tools.exec.pathPrepend` is already documented as ignored for
  `host=node`).

Layer 1's static check runs unconditionally regardless of any of the above
(see above), so it remains every host and every sandbox backend's floor.

The shadow stub directory is re-verified (and, if missing, transparently
recreated) on every exec call that needs it, not only the first: an
ordinary, already-permitted command can delete the stub directory mid-session
(`$OPENCLAW_STATE_DIR`, where it lives, is a visible env var inside every
exec'd command, `denySelfCli` or not), and a later `denySelfCli:true` call
in the same session must not silently lose layer 2 coverage because of that.

**Known limitations (read honestly — this is not an unconditional "no
chances" guarantee against every conceivable path):**

- Invoking the underlying entry script directly through a generic
  interpreter (for example `node /path/to/openclaw.mjs ...`) is not
  detected by either layer. Closing that would require binding argv-token
  realpaths against the entry script itself, which is the kind of general
  interpreter/loader coverage the exec-approvals engine already documents
  as best-effort elsewhere — out of scope for this narrow identity check.
- A command that explicitly reassigns `PATH` before invoking the bare name
  (`env PATH=/usr/bin vasudev ...`, or a script doing `export PATH=...`
  then calling `vasudev`) can still reach the real binary if the
  reassigned value omits the shadow directory and still contains the real
  one. This is an accepted residual gap: it requires deliberately naming a
  PATH value, a materially higher bar than the zero-PATH-knowledge
  bypasses layer 2 closes.
- Layer 2 does not extend to the node host or to the sandbox's
  remote-shell/SSH backend (see above); a buried, unrecognized-indirection-
  tool invocation on either is covered only by layer 1.
- The PATH-shadow stub directory's repair check runs at preparation time,
  immediately before its path is used to build the spawned command's
  environment — not atomically at the instant of spawn. A command that
  deletes the directory concurrently with a separate, in-flight exec call
  (as opposed to a strictly earlier, already-finished call) could in theory
  still race that one in-flight spawn. This is an accepted, narrow TOCTOU
  window, not the structural, permanent gap that a never-re-verified cache
  used to be.

Rationale: an agent that reaches its own CLI is usually doing something it
has a tool-call path for, and closing the whole binary is simpler than
denying dangerous subcommands (`pairing approve`, `config set`, ...) one at
a time. Note what this does _not_ claim: roster writes do have an agent tool
path — `team_add`, `team_remove`, `team_transfer_ownership` — and `team_add`
approves a pending pairing request whose sender it is putting on the roster,
in that same call. That path is the sanctioned one, and `denySelfCli`
neither creates nor removes it. What `denySelfCli` removes is the unrouted
CLI shortcut (`vasudev pairing approve`), which admits a sender with no
roster row behind it.

**Open gap, stated plainly: the agent can still read the operator's Gateway
credential.** `exec` has no read-path restrictions, so at the coordinator's
default `security: "full"` it can read `gateway.auth.token` out of the config
file (or the file a `SecretRef` points at — on a hosted desk,
`/etc/openclaw/secrets/gateway-token`, mode `0600` owned by the same user the
agent runs as), and `OPENCLAW_GATEWAY_TOKEN` stays in the exec environment.
With that token it can talk to the loopback Gateway as a genuine operator,
carrying none of the agent-origin markers the router checks, and reach
privileged methods that way. Closing this needs token readability locked down
in the exec context, which is deliberately deferred and not done. Until it is:

- The Gateway fence stops the agent's own tool dispatch and any
  agent-runtime-authenticated connection. It does not stop an agent that
  impersonates an operator with the operator's own token.
- `denySelfCli` raises the cost of the CLI route but, as above, is not a
  boundary.

**Second open gap, also stated plainly: the pairing store can be written with
no Gateway method involved.** `vasudev pairing approve` writes the shared
pairing store directly. That is not a CLI quirk — the agent's `exec` runs as
the same OS user that owns the state directory, so any direct write to that
SQLite file (a `sqlite3` invocation, a few lines of Node) reaches the same
outcome. Neither `denySelfCli` nor the Gateway fence touches that class at all.
Closing it needs OS-level isolation — running exec as a different,
unprivileged user, or without the state directory reachable — which is
explicitly out of scope for this round.

Treat the coordinator's exec surface accordingly: on a desk where this matters,
narrow `security`/allowlists for that agent rather than relying on these
layers to make the credential or the state directory unreachable.

### `tools.exec.commandHighlighting`

<ParamField path="commandHighlighting" type="boolean" default="false">
  Presentation only: when enabled, Vasudev may attach parser-derived
  command spans so Web approval prompts can highlight command tokens. Does
  **not** change `security`, `ask`, allowlist matching, strict inline-eval
  behavior, approval forwarding, or command execution.
</ParamField>

Set globally under `tools.exec.commandHighlighting` or per agent under
`agents.entries.*.tools.exec.commandHighlighting`.

## YOLO mode (no-approval)

To run host exec without approval prompts, open **both** policy layers:
requested exec policy in Vasudev config (`tools.exec.*`) **and**
host-local approvals policy in the execution host approvals document.

For ordinary configured full-mode execution of recognized inline-eval forms
without prompts, leave `tools.exec.strictInlineEval` unset or set it to
`false` (the default). If detection runs with strict mode enabled,
`askFallback: "full"` does not replace reviewer or explicit approval. The
Gateway session and elevated exceptions described above skip that detection.

Omitted `askFallback` defaults to `deny`. Set host `askFallback` to `full`
explicitly when a no-UI approval prompt should fall back to allow.

| Layer              | YOLO setting               |
| ------------------ | -------------------------- |
| `tools.exec.mode`  | `full` on `gateway`/`node` |
| Host `askFallback` | `full`                     |

<Warning>
**Important distinctions:**

- `tools.exec.host=auto` chooses **where** exec runs: sandbox when available, otherwise gateway.
- YOLO chooses **how** host exec is approved: `security=full` plus `ask=off`.
- YOLO does **not** add a separate heuristic command-obfuscation approval gate or script-preflight rejection layer on top of the configured host exec policy. Node preparation still reads the target policy and resolves the working directory once. If both sides allow full/off and strict inline eval is disabled, ordinary path aliases and inline scripts do not require approval binding. Restrictive policy and later policy changes remain enforced.
- `auto` does not make node or gateway routing a free override from a sandboxed session. Per-call `host=node` and `host=gateway` requests are allowed from `auto` only when no sandbox runtime is active. For a stable non-auto default, set `tools.exec.host` or use `/exec host=...` explicitly.

</Warning>

For Vasudev-managed Claude sessions, Vasudev launches Claude Code in its
`default` permission mode. Vasudev's effective exec policy remains
authoritative through native tool hooks and permission requests, including YOLO and
restrictive policies, even if raw Claude backend args request
`bypassPermissions`.

If you want a more conservative setup, tighten Vasudev exec policy back to
`allowlist` / `on-miss` or `deny`.

### Persistent gateway-host "never prompt" setup

<Steps>
  <Step title="Set the requested config policy">
    ```bash
    openclaw config set tools.exec.host gateway
    openclaw config set tools.exec.mode full
    openclaw config set tools.exec.strictInlineEval false
    openclaw gateway restart
    ```
  </Step>
  <Step title="Match the host approvals document">
    ```bash
    openclaw approvals set --stdin <<'EOF'
    {
      version: 1,
      defaults: {
        security: "full",
        ask: "off",
        askFallback: "full"
      }
    }
    EOF
    ```
  </Step>
</Steps>

### Local shortcut

```bash
openclaw exec-policy preset yolo
```

Updates both local `tools.exec.host/security/ask` and the local approvals
file defaults (including `askFallback: "full"`). It is intentionally
local-only. To change gateway-host or node-host approvals remotely, use
`openclaw approvals set --gateway` or
`openclaw approvals set --node <id|name|ip>`.

Other built-in presets: `cautious` (`host=gateway`, `security=allowlist`,
`ask=on-miss`, `askFallback=deny`) and `deny-all` (`host=gateway`,
`security=deny`, `ask=off`, `askFallback=deny`). Apply the same way:
`openclaw exec-policy preset cautious`.

To set individual fields instead of a full preset, use `openclaw exec-policy set --host <auto|sandbox|gateway|node> --security <deny|allowlist|full> --ask <off|on-miss|always> --ask-fallback <deny|allowlist|full>` with any subset of those flags.

### Node host

Apply the same approvals document on the node instead:

```bash
openclaw approvals set --node <id|name|ip> --stdin <<'EOF'
{
  version: 1,
  defaults: {
    security: "full",
    ask: "off",
    askFallback: "full"
  }
}
EOF
```

<Note>
**Local-only limitations:**

- `openclaw exec-policy` does not synchronize node approvals.
- `openclaw exec-policy set --host node` is rejected.
- Node exec approvals are fetched from the node at runtime, so node-targeted updates must use `openclaw approvals --node ...`.

</Note>

### Session and turn shortcuts

- `/exec security=full ask=off <task>` requests that policy for the current message only. Include the task in the same message. A standalone directive does not affect the next message. Session permission modes and host policy can still restrict the request.
- `/elevated full` is a break-glass shortcut that skips exec approvals only
  when both the requested policy and the host approvals document resolve to
  `security: "full"` and `ask: "off"`. A stricter host file, such as `ask:
"always"`, still prompts.

Outside the full-permission Gateway session exception, if the host approvals
document stays stricter than config, the stricter host policy still wins.

## Allowlist (per agent)

Allowlists are **per agent**. If multiple agents exist, switch which agent
you are editing in the macOS app. Patterns are glob matches.

Patterns can be resolved binary path globs or bare command-name globs.
Bare names match only commands invoked through `PATH`, so `rg` can match
`/opt/homebrew/bin/rg` when the command is `rg`, but **not** `./rg` or
`/tmp/rg`. Use a path glob to trust one specific binary location.

Legacy `agents.default` entries are migrated to `agents.main` on load.
Shell chains such as `echo ok && pwd` still need every top-level segment
to satisfy allowlist rules.

Examples:

- `rg`
- `~/path/to/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

### Restricting arguments with argPattern

Add `argPattern` when an allowlist entry should match a binary and a
specific argument shape. Vasudev uses ECMAScript (JavaScript) regular
expression semantics on every host and evaluates the expression against
the parsed command arguments, excluding the executable token (`argv[0]`).
For hand-authored entries, arguments are joined with a single space, so
anchor the pattern when you need an exact match.

```json
{
  "version": 1,
  "agents": {
    "main": {
      "allowlist": [
        {
          "pattern": "python3",
          "argPattern": "^safe\\.py$"
        }
      ]
    }
  }
}
```

That entry allows `python3 safe.py`. `python3 other.py` is an allowlist
miss. If a path-only entry for the same binary is also present, unmatched
arguments can still fall back to that path-only entry. Omit the path-only
entry when the goal is to restrict the binary to the declared arguments.

Entries saved by approval flows use an internal separator format for exact
argv matching. Prefer the UI or approval flow to regenerate those entries
instead of hand-editing the encoded value. If Vasudev cannot parse argv
for a command segment, entries with `argPattern` do not match.

Generated `allow-always` entries are bound to both the exact argv and the working
directory where you approved them. Choosing **Always allow here** authorizes the
same command only in that directory. Running it elsewhere is an allowlist miss.

Generated entries saved before 2026.8.1 are not directory-bound and are inactive
after upgrading. `openclaw update` removes them during its automatic Doctor pass,
or you can run `openclaw doctor --fix` yourself. Rerun an affected workflow and
choose **Always allow here** to create the replacement. Manual allowlist rules
are not changed. For a manual path-only rule, omit both `source` and
`argPattern`.

Each allowlist entry supports:

| Field              | Meaning                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `pattern`          | Resolved binary path glob or bare command-name glob                      |
| `argPattern`       | ECMAScript argv regex or generated exact-argv hash; omitted is path-only |
| `id`               | Stable opaque ID; generated as a UUID when absent                        |
| `source`           | Generated entry source, such as `allow-always`; omit for manual entries  |
| `commandText`      | Legacy plaintext input; discarded during load                            |
| `lastUsedAt`       | Last-used timestamp                                                      |
| `lastUsedCommand`  | Last command that matched; omitted for generated hashed argv entries     |
| `lastResolvedPath` | Last resolved binary path                                                |

## MCP tool grants

For Gateway-hosted Codex runs, **Allow Always** can save a durable grant for one
MCP tool on a server configured in `mcp.servers`. The Gateway writes the grant
to `agents.<agentId>.mcpTools` in this same approvals document. It covers the
exact agent, configured server name, and tool name, **with any arguments**.
It does not grant access to other agents, servers, or tools.

Each entry has `server`, `tool`, `source: "allow-always"`, and `addedAt`
(Unix milliseconds). `lastUsedAt` is optional. Codex apps, native plugin
servers, and computer-use servers do not receive Vasudev MCP tool grants.
Vasudev only mints when durable persistence is offered and it can unambiguously
match the approval to a live Gateway-owned tool call. Missing or ambiguous
correlation retains Codex's existing native/session behavior instead.

Grants apply when the server's `codex.defaultToolsApprovalMode` is `auto` or
unspecified. Explicit `prompt` wins over a stored grant and keeps asking.
Explicit `approve` already bypasses per-call approval. See
[Codex tool approvals](/cli/mcp#codex-tool-approvals).

The durable grant is read when Vasudev next prepares the Codex thread
configuration and hook registration, such as for a new session or after a
restart. The current session continues using Codex's remembered decision.
Vasudev does not reload grants for every tool call.

To inspect grants, run `openclaw approvals get --gateway`. To revoke one,
export the document, remove its entry from `agents.<agentId>.mcpTools`, and
replace the document with the existing `set` command:

```bash
openclaw approvals get --gateway --json | jq '.file' > approvals.json
# Edit approvals.json, preserving other settings, allowlists, and grants.
openclaw approvals set --gateway --file approvals.json
```

Omit `--gateway` from both commands to edit local approvals. Revocation takes
effect at the next thread preparation/registration too. Start a new session
or restart to discard the active session's remembered approval. If Codex also
persisted a separate approval in its native config, remove that native grant
there as well.

## Standing grants for automations

Approvals raised by gateway-host automation (cron) runs are delivered only to
connected exec approval clients: the Control UI, the macOS/iOS/Android apps,
and API clients that declare the `approvals` or `exec-approvals` capability.
The TUI does not render exec approval cards, and chat channels never receive
automation approvals, which would repeat a card on every occurrence. While a reviewer
surface is connected, the scheduled run waits for the decision like an
interactive run. Automations are single-flight, so at most one card per job
is pending at a time. With no approval surface connected, the request is
denied immediately and the run's error explains the policy fix. Node-host
automation execs keep the fully headless policy (no cards) until node
execution gains its own standing-grant path.

When an approval originates from an automation's isolated run, resolving it
with **Always allow** does not write a JSON allowlist entry. Instead the
Gateway mints a scoped standing grant bound to that exact agent, automation,
job configuration, and operation (command text, working directory, and
requested environment). Later occurrences of the same job execute that exact
operation without prompting while the grant is valid. The approval card says
so up front: automation approvals carry a scope line describing exactly what
Always allow will mint.

### What a grant covers, and when it stops

A grant fails closed back to a normal prompt whenever anything changed: the
job was edited or deleted (any configuration change invalidates it), the
command, working directory, or environment differs by even one byte, the
grant was revoked or expired, or the original approval record is gone. The
check runs immediately before the process spawns, so a revocation or job
edit that lands mid-flight still wins. Mutable file operands and commands
that require explicit review (heredocs, strict inline eval, audit
suppression) keep prompting per occurrence. Non-automation approvals are
unchanged.

### Grant lifetime

By default a grant lives **until revoked** — the same meaning Always allow
has everywhere else in the product. Terms freeze at mint time and never
change retroactively:

- `tools.exec.grantExpiryDays` (unset by default) sets the default lifetime,
  in days, for **future** grants. Existing grants keep the terms they were
  minted with. Use revocation to retire them early. This is the fleet-policy
  knob for managed deployments that require periodic re-approval.
- A resolving surface may override the default per grant with the
  `grantExpiresInDays` field on `approval.resolve` /
  `exec.approval.resolve`, or `openclaw approvals resolve <id> allow-always
--expires-in-days <n>`. The override wins over the config default.
- Expired grants fall back to prompting and are pruned opportunistically.

### Listing and revoking

Every standing grant is visible and revocable:

- **Control UI**: Settings → Approvals shows the standing-grant ledger —
  automation, exact command, use count, and state (until revoked, expires in
  N days, expired, revoked) — with a Revoke action per active row.
- **CLI**: `openclaw approvals grants list` renders the same ledger.
  `openclaw approvals grants revoke <grant-id>` revokes one grant. Revocation
  is idempotent and takes effect at the next occurrence's spawn boundary —
  that occurrence prompts again.
- Deleting or editing the automation, or reversing the minting approval,
  also invalidates the grant without touching the grants surface.

The minting `operator_approvals` row remains the sole authorization owner: a
grant is derivative correlation, revalidated against the live approval row,
automation row, and revocation state on every use.

## Auto-allow skill CLIs

When **Auto-allow skill CLIs** (`autoAllowSkills`) is enabled, executables
referenced by known skills are treated as allowlisted on nodes (macOS node
or headless node host). This uses `skills.bins` over the Gateway RPC to
fetch the skill bin list. Disable this if you want strict manual
allowlists.

Skill trust belongs to the Gateway that supplied it. Switching Gateways retires
the previous cache, including the Mac app's trusted-binary list and an approval
check that is still in progress. A failed refresh can keep the last known trust
from the same Gateway. It cannot import another Gateway's trust.

The Mac's Exec Approvals pane refreshes its trusted binaries and agent choices
when the selected Gateway connects. Local policy, the selected scope, and
unfinished allowlist edits stay on the Mac.

<Warning>
- This is an **implicit convenience allowlist**, separate from manual path allowlist entries.
- It is intended for trusted operator environments where Gateway and node are in the same trust boundary.
- If you require strict explicit trust, keep `autoAllowSkills: false` and use manual path allowlist entries only.

</Warning>

## Safe bins and approval forwarding

For safe bins (the stdin-only fast-path), interpreter binding details, and
how to forward approval prompts to Slack/Discord/Telegram (or run them as
native approval clients), see
[Exec approvals - advanced](/tools/exec-approvals-advanced).

## Control UI editing

Use the **Control UI -> Nodes -> Exec approvals** card to edit defaults,
per-agent overrides, and allowlists. Pick a scope (Defaults or an agent),
tweak the policy, add/remove allowlist patterns, then **Save**. The UI
shows last-used metadata per pattern so you can keep the list tidy.

The target selector chooses **Gateway** (local approvals) or a **Node**.
Nodes must advertise `system.execApprovals.get/set` (macOS app or headless
node host). If a node does not advertise exec approvals yet, edit its
local approvals document directly.

Some node hosts, including the Windows companion, own a different approval
policy format. Control UI shows these host-native policies read-only. Use the
companion app or `openclaw approvals set --node <id|name|ip>` with the native
policy shape to edit them. See [Approvals CLI](/cli/approvals).

CLI: `openclaw approvals` supports gateway or node editing - see
[Approvals CLI](/cli/approvals).

## Approval flow

When a prompt is required, the gateway broadcasts
`exec.approval.requested` to operator clients. The Control UI and macOS
app resolve it via `exec.approval.resolve`, then the gateway forwards the
approved request to the node host.

The macOS approval panel keeps ordinary commands compact, with the supplied agent
and host in one summary. It shows the working directory beneath the full,
wrapping command. Longer commands scroll. Expand **Details** to inspect the
executable path. Directory and executable paths remain fully selectable.
**Copy** copies the displayed command, including visible escapes for control and
invisible characters. The host comes from the request. A gateway or node can be
remote from the Mac displaying the panel.

Choose **Allow Once** or press **Command-Return** to approve one execution.
Return alone does not approve. **Escape** dismisses the panel, denying the request
when **Don't Allow** is available. Otherwise it closes without a decision.
**Always Allow Here** appears only when the request's policy permits durable
approval.

For `host=node`, approval requests include a canonical `systemRunPlan`
payload. The gateway uses that plan as the authoritative command/cwd/session
context when forwarding approved `system.run` requests:

- The node exec path prepares one canonical plan up front.
- The approval record stores that plan and its binding metadata.
- Once approved, the final forwarded `system.run` call reuses the stored plan instead of trusting later caller edits.
- If the caller changes `command`, `rawCommand`, `cwd`, `agentId`, or `sessionKey` after the approval request was created, the gateway rejects the forwarded run as an approval mismatch.

## Approval scope summaries

An approval owner can attach a typed, display-only scope describing the action's
blast radius. Vasudev renders the sanitized summary on channel approval cards
and includes the bounded scope in the safe approval presentation available to
Control UI clients. Scope never grants authorization or changes approval policy.

- `message-send`: destination, recipient count, optional recipient preview, and
  whether the audience is internal or external.
- `payment`: exact decimal amount, currency, and payee or payment system.
- `external-post`: destination and whether the post is public or restricted.

For example, an email approval might show `Send to 3 recipients via email
(external): alice@example.com, bob@example.com, +1 more`. Owners supply these
facts. Channels never infer them from commands or message text. Without a
declared scope, approval cards render exactly as before.

## System events and denials

When an approval can be delivered, ordinary agent runs wait for the decision
and receive the exec result in the same turn. The final reply uses the original
delivery path, including an inbound A2A task. An operator denial returns a denied
tool result without running the command.

Diagnostic and export commands that explicitly use asynchronous execution retain
their separate follow-up delivery. For those workflows:

Exec lifecycle posts an `Exec finished` system message to the agent's
session after the node reports completion. Vasudev can also emit an
in-progress notice once an approval is granted, after
`tools.exec.approvalRunningNoticeMs` elapses (default `10000`, `0` disables
it). Denied exec approvals are terminal for the host command: the command
does not run.

- For main-agent async approvals with an originating session, Vasudev
  posts the denial back into that session as an internal followup so the
  agent can stop waiting on the async command and avoid a missing-result
  repair.
- If there is no session or the session cannot be resumed, Vasudev can
  still report a concise denial to the operator or direct chat route.
- Denials for subagent and cron sessions are not posted back into that
  session.

Gateway-host exec approvals emit the same completion lifecycle event.
Approval-gated execs reuse the approval id to correlate the pending
request with its completion/denial message (`Exec finished (gateway
id=...)` / `Exec denied (gateway id=...)`).

## Implications

- **`full`** is powerful. Prefer allowlists when possible.
- **`ask`** keeps you in the loop while still allowing fast approvals.
- Per-agent allowlists prevent one agent's approvals from leaking into others.
- Approvals only apply to host exec requests from **authorized senders**. Unauthorized senders cannot issue `/exec`.
- `/exec security=full <task>` is a current-turn request by an authorized operator, subject to effective session and host policy. To hard-block exec, deny the `exec` tool via tool policy. See [session overrides](/tools/exec#session-overrides-%2Fexec) for the full-access session exception to host approval floors.

## Related

<CardGroup cols={2}>
  <Card title="Exec approvals - advanced" href="/tools/exec-approvals-advanced" icon="gear">
    Safe bins, interpreter binding, and approval forwarding to chat.
  </Card>
  <Card title="Exec tool" href="/tools/exec" icon="terminal">
    Shell command execution tool.
  </Card>
  <Card title="Elevated mode" href="/tools/elevated" icon="shield-exclamation">
    Break-glass path that also skips approvals.
  </Card>
  <Card title="Sandboxing" href="/gateway/sandboxing" icon="box">
    Sandbox modes and workspace access.
  </Card>
  <Card title="Security" href="/gateway/security" icon="lock">
    Security model and hardening.
  </Card>
  <Card title="Sandbox vs tool policy vs elevated" href="/gateway/sandbox-vs-tool-policy-vs-elevated" icon="sliders">
    When to reach for each control.
  </Card>
  <Card title="Skills" href="/tools/skills" icon="sparkles">
    Skill-backed auto-allow behavior.
  </Card>
</CardGroup>
