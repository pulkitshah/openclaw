# Hosted desk runbook

A **desk** is a DigitalOcean droplet running this fork's Gateway with the Duties plugin, a
headed Chromium on a virtual display, and Telegram, reachable only over the operator's
tailnet. See `docs/superpowers/specs/2026-09-14-hosted-desk-design.md` for the design this
runbook implements.

Everything below assumes the [Prerequisites](#prerequisites) are installed, `doctl`
authenticated, `tailscale` joined to the same tailnet a desk will join, and this repo checked
out locally so the three scripts in `deploy/desk/` are on hand (`new-desk.sh`, `roll.sh`,
`snapshot.sh`). No script here ever prints a secret; commands below use `<...>` placeholders
instead of real names.

## Prerequisites

Install these once on the operator's Mac:

```sh
brew install doctl jq tailscale
```

`ssh` and `curl` ship with macOS — nothing to install for either. Each script checks for the
tools it needs (`doctl`, `jq`, `ssh`, `tailscale`, `curl`) on `PATH` and fails immediately
with a clear message instead of a raw "command not found" if one is missing. After
installing:

```sh
doctl auth init          # one-time: paste a DigitalOcean API token
tailscale up              # join the tailnet a desk will join, if not already
```

### SSH access

The scripts SSH into a desk as `DESK_SSH_USER` (default `root`) over the tailnet with the
SSH key chosen at create time (`new-desk.sh` picks the DigitalOcean key whose fingerprint
matches a public key in your `~/.ssh`, so `ssh root@<desk-name>` works from the machine that
created the desk). The cloud firewall keeps public port 22 closed; sshd is reachable only on
the tailnet interface. Override with `DESK_SSH_USER=<name>` (for both `new-desk.sh` and
`roll.sh`) if a desk's key lands on a different account.

Desks deliberately do not enable Tailscale SSH: under a tailnet SSH rule with
`"action": "check"` every login becomes an interactive browser step, which breaks
`roll.sh` and the migration scripts. If you want Tailscale SSH for humans, enable it on the
desk with `tailscale set --ssh` and keep the rule for your identity on `accept`.

## Create

```sh
deploy/desk/new-desk.sh <desk-name> \
  --ts-authkey-file <path-to-a-file-holding-one-tailscale-preauth-key> \
  --tg-token-file <path-to-a-file-holding-the-desk's-telegram-bot-token> \
  --owner-target <telegram-user-or-chat-id>
```

This creates the `desk-no-inbound` cloud firewall the first time (no inbound, all outbound —
Tailscale needs no inbound rule), boots a `s-2vcpu-4gb` droplet from `ubuntu-24-04-x64` in
`blr1`, and waits in two phases: first up to 15 minutes for the desk to join the tailnet
(cloud-init runs `tailscale up` early), then — since the fork checkout, install, build,
managed-Chromium install, and reboot all happen _after_ that — polls the Control UI itself
(`https://<desk-name>.<tailnet>.ts.net/healthz`) until it answers, printing a progress line
once a minute. This second phase is typically 15–25 minutes; the command waits until the
desk actually answers before printing anything, so a printed URL is always ready to use:

```
Control UI: https://<desk-name>.<tailnet>.ts.net
Sign in:    ssh -t root@<desk-name> 'sudo -H -u openclaw node /opt/openclaw/openclaw.mjs gateway auth-token --show'
```

If first boot failed partway through (the fork checkout, the Claude CLI install, or the managed
Chromium install), the script prints a `provision-failed` warning alongside the URL — the Gateway
is up, but browser Duties will not work until it is fixed. See
[Troubleshooting](#troubleshooting).

Useful flags: `--profile client` for a desk you hand to someone else (see
[Client desk](#client-desk)), `--size s-4vcpu-8gb` for more parallel runs, `--git-ref <ref>` to pin a
non-`main` checkout, `--image <snapshot-id>` to create a new desk from a prior desk's
snapshot instead of a bare image (minutes instead of a full first-boot install — see
[Snapshot / restore](#snapshot--restore)). Run `deploy/desk/new-desk.sh --help` for the full
flag and environment-override list, including `DESK_SSH_KEY_NAME` to pick a specific `doctl`
SSH key (by default the script uses the first `doctl` key whose fingerprint matches a public
key in your `~/.ssh`, so the printed sign-in command works from this machine), and
`DESK_READY_POLL_SECONDS` if 30 minutes isn't enough for a particularly slow first boot.

## Client desk

A desk created with `--profile client` is the same machine, minus the operator's own setup. Use
it for a desk somebody else will own:

```sh
deploy/desk/new-desk.sh <desk-name> --profile client \
  --ts-authkey-file <path-to-a-file-holding-one-tailscale-preauth-key>
```

No `--tg-token-file` and no `--owner-target`: a client desk configures no Telegram channel, so
there is nothing for either to configure. Pass them anyway and the renderer says it is ignoring
them rather than pretending the bot is wired up.

What first boot writes into `~openclaw/.openclaw/openclaw.json` is then only desk plumbing
(`deploy/desk/openclaw.client.json.tmpl`): the Gateway's local/loopback mode, its Tailscale mode,
token auth reading the per-desk Gateway-token file, that one secret provider, the browser SSRF
allowlist, the four bundled plugin entries (`anthropic`, `duties`, `telegram`, `llm-task` — all
enabled, none configured) and `tools.alsoAllow`. No `channels`, no `agents`, no `bindings`, no
`hooks`, and no Telegram-token secret provider or secret file. The cloud-init that builds the box
skips the Telegram token `write_files` entry and the Gmail webhook Funnel entirely — they are not
rendered empty.

Everything else is identical to an owner desk: same image, same Chromium, same units, same health
timer, same tailnet-only Control UI, same `roll.sh`/`snapshot.sh`.

### What the client sees first

The operator still does [First sign-in](#first-sign-in) steps 1–3 (reveal the token, open the
Control UI, approve the device) and hands over the URL and token. From there the client meets the
same onboarding a fresh Vasudev install gives anyone:

1. **Model Setup** — connect Claude by signing in. The desk already has the Claude CLI installed;
   the client signs in with their own Claude account from the Control UI's Model Setup screen.
2. **Name the assistant** — the first conversation runs the workspace bootstrap ritual
   (`BOOTSTRAP.md`, see [Bootstrapping](/start/bootstrapping)), which asks what to call the
   assistant and writes the answer into the workspace. Nothing is pre-named.
3. **Add Telegram** — from **Settings → Telegram**, pasting a bot token the client creates with
   [BotFather](https://t.me/BotFather). The `telegram` plugin is already enabled, so this is the
   only step.

Gmail connect is a coming feature on a client desk: the mail-trigger setup below needs `gcloud`
and per-desk Google Cloud work, so a client desk ships without hooks and without the webhook
Funnel rather than with a half-configured one.

## First sign-in

1. Run the command `new-desk.sh` printed to reveal the Gateway token:
   ```sh
   ssh -t root@<desk-name> 'sudo -H -u openclaw node /opt/openclaw/openclaw.mjs gateway auth-token --show'
   ```
   Both flags matter: `gateway auth-token --show` refuses to print outside an interactive terminal,
   so a plain `ssh host 'cmd'` (which allocates no TTY) always fails, and `sudo -H` is what gives
   the command the service user's own `$HOME` — without it `HOME=/root` on stock Ubuntu sudoers and
   the CLI reads a config that does not exist. Equivalent, if you would rather not go through the
   CLI: `ssh root@<desk-name> 'cat /etc/openclaw/secrets/gateway-token'` — that file is the token's
   source of truth.
2. Open `https://<desk-name>.<tailnet>.ts.net` in a browser on a device joined to the same
   tailnet, and sign in with that token.
3. **Approve the device pairing request.** A first-time browser session (and a first-time CLI
   client, such as `openclaw` run from another machine against this desk) each register a
   pending pairing request that the desk's Gateway refuses to serve until the owner approves it
   — the sign-in token alone is not enough. From the desk itself:
   ```sh
   ssh root@<desk-name> 'sudo -H -u openclaw node /opt/openclaw/openclaw.mjs devices list'
   ssh root@<desk-name> 'sudo -H -u openclaw node /opt/openclaw/openclaw.mjs devices approve <request-id>'
   ```
   `devices list` prints the pending request's id; run `approve` with that id once per new
   device (the browser tab from step 2 included) before it can do anything beyond sign-in.

## Sign Claude in

This section is for an owner desk. On a [client desk](#client-desk) the client connects Claude
themselves from the Control UI's Model Setup screen instead, and nothing below applies.

The desk's agents run on the `claude-cli` provider — the owner's own Claude subscription, not
an API key — so nothing answers until Claude Code is signed in as the `openclaw` service user.
The routing half is already in the desk's config: `openclaw.json.tmpl` enables the `anthropic`
plugin and maps every `anthropic/*` model to `agentRuntime: { id: "claude-cli" }` under
`agents.defaults.models`, so `claude auth login` below is the only step — no separate
`openclaw models auth login --provider anthropic` is needed on a desk.
Sign in through the CLI's own stored login, **not** `claude setup-token` +
`CLAUDE_CODE_OAUTH_TOKEN`: the embedded `claude-cli` backend deliberately clears
`CLAUDE_CODE_OAUTH_TOKEN` (and every other `CLAUDE_CODE_*` credential env var) from the CLI
process it spawns — only a plain node-host route honors that variable — so setting it in
`gateway.env` has no effect on agent replies:

```sh
ssh -t root@<desk-name> 'sudo -H -u openclaw claude auth login'
```

This prints a URL; open it on your own machine, sign in, and paste the resulting code back into
the `ssh -t` session. The login is stored under `openclaw`'s own `~/.claude`, which the
`claude-cli` provider inherits directly — no Gateway config or restart needed. Verify it stuck:

```sh
ssh root@<desk-name> 'sudo -H -u openclaw claude auth status'
```

should report `loggedIn: true`. If Telegram replies still say `Not logged in · Please run
/login`, re-run `claude auth login` as `openclaw` (not as `root` — the login is per-user).

`/etc/openclaw/secrets/gateway.env` is the Gateway systemd unit's `EnvironmentFile`
(`deploy/desk/units/openclaw-gateway.service`) — root:root, mode 0600, read by systemd itself
before it drops privileges to `openclaw`, absent on a fresh desk. Claude sign-in does not use
it; it carries the Gmail watcher's environment instead (see
[Gmail push per desk](#gmail-push-per-desk)):

| Line                   | Needed for                                  | Set by                                            |
| ---------------------- | ------------------------------------------- | ------------------------------------------------- |
| `GOG_HOME`             | `gog`'s per-desk state dir                  | picked by the operator when setting up Gmail push |
| `GOG_KEYRING_PASSWORD` | Unlocking `gog`'s file-backed OAuth keyring | picked by the operator when setting up Gmail push |

Create it with a `read -rs` prompt, never on the command line where a value would land in shell
history and `ps`:

```sh
ssh root@<desk-name>
install -d -m 700 /etc/openclaw/secrets
read -rs -p 'GOG_KEYRING_PASSWORD: ' pw && echo &&
  printf 'GOG_HOME=%s\nGOG_KEYRING_PASSWORD=%s\n' '<gog-home-dir>' "$pw" \
    > /etc/openclaw/secrets/gateway.env
unset pw
chown root:root /etc/openclaw/secrets/gateway.env
chmod 0600 /etc/openclaw/secrets/gateway.env
systemctl restart openclaw-gateway
```

Restart `openclaw-gateway` after adding or changing any line in this file — `EnvironmentFile`
is read once at process start, same as every other config change (see
[Restart recipe](#restart-recipe)).

## Store logins

Open the desk's Control UI **Logins** page and add the credentials the desk's Duties need
(site logins, API keys, etc.). On Linux, the Duties credential store is an AES-256-GCM file
keyed by `/etc/openclaw/keyfile` (root:openclaw, 0640) — cloud-init creates this file on
first boot, so no extra setup is needed before storing logins. The store itself lives under the
Gateway's own state dir (`~openclaw/.openclaw/plugins/duties/creds.enc` on a desk; wherever
`OPENCLAW_STATE_DIR` points otherwise), so it travels with a state backup.

A desk created from a snapshot **keeps the keyfile the snapshot carries** — cloud-init generates
one only when none is present, precisely so the encrypted store the snapshot also carries stays
readable. Never delete or regenerate `/etc/openclaw/keyfile` on a desk that has stored logins:
every one of them becomes unreadable ("credential store is corrupt or was written with another
keyfile") and has to be entered again.

## Gmail push per desk

The Gateway claims Tailscale Serve on port 443 as a FOREGROUND listener for the Control UI
(`gateway.tailscale.mode: "serve"`, set at provisioning time) — a foreground Funnel for the
Gmail webhook can never share that port (`foreground listener already exists for port 443`),
and `openclaw webhooks gmail setup --tailscale funnel` both defaults to exactly that and
requires `gcloud`, which a desk does not have. **`webhooks gmail setup` cannot be used on a
desk at all.**

Instead, cloud-init sets up a **persistent background Funnel on a different port (8443)** right
after `tailscale up`, forwarding only the webhook path to `gog`'s own local serve process:

```sh
tailscale funnel --bg --https=8443 --set-path=/gmail-pubsub http://127.0.0.1:8788
```

`tailscaled` persists this independently of the Gateway process, so it survives restarts and
reboots and needs setting only once — it is already in place on every desk. The desk's config
template keeps `hooks.gmail.tailscale.mode: "off"` and pins `hooks.gmail.serve` to
`{ bind: "127.0.0.1", port: 8788, path: "/" }`, so `gog watch serve` only ever binds loopback;
the Funnel rule above is what makes it public. The tailnet's Funnel policy must allow port 8443
for the desk's node (`funnel-ports`) and grant the node the `funnel` attribute — the Tailscale
admin console's default Funnel policy grants both, but a tailnet with a custom policy may not, and
the cloud-init step fails quietly if it does not. Verify it before wiring Pub/Sub:

```sh
ssh root@<desk-name> 'tailscale funnel status'
```

should list the `:8443` route to `http://127.0.0.1:8788`. If it lists nothing, fix the tailnet
policy and re-run the `tailscale funnel` command above on the desk.

To wire up a mailbox, run the Duty mapping setup on the desk, then set the Gmail account fields
in its config by hand (a desk cannot run `webhooks gmail setup` itself — no `gcloud`), reusing
the topic/subscription/tokens from a Gmail Pub/Sub setup created on a machine that has `gcloud`:

```sh
ssh root@<desk-name>
sudo -H -u openclaw node /opt/openclaw/openclaw.mjs duties setup
```

(`-H` on every `sudo -u openclaw` here: stock Ubuntu sudoers is `env_reset` without
`always_set_home`, so plain `sudo -u openclaw` leaves `HOME=/root` and a config-reading command
reads root's non-existent config — `duties setup` then reports every item as missing.)

Then point the desk at that existing setup: put the bearer in
`/etc/openclaw/secrets/hooks-token.env` as `HOOKS_TOKEN=<token>` (root:root 0600 — the Gateway
unit reads it as systemd and `openclaw.json` resolves it through `${HOOKS_TOKEN}`, so the token
never lands in a file the service user can read), and edit
`/home/openclaw/.openclaw/openclaw.json` to set `hooks.gmail.account`, `hooks.gmail.topic`,
`hooks.gmail.subscription`, and `hooks.gmail.pushToken` to match. Then restart the Gateway (see [Restart recipe](#restart-recipe) — never
hot-edit a running desk's config and expect it to take effect on its own). Finally repoint the
existing Pub/Sub subscription's push endpoint at the desk, from the machine that has `gcloud`:

```sh
gcloud pubsub subscriptions update <subscription> --project <project> \
  --push-endpoint="https://<desk-name>.<tailnet>.ts.net:8443/gmail-pubsub?token=<pushToken>"
```

`<pushToken>` is `hooks.gmail.pushToken` from the config above — unchanged by the move, so the
desk accepts the same pushes the previous endpoint did.

## Watch a run

Open the Duty's run page for evidence, screenshots, files, and the live "Now" panel, and open
the Control UI's **Browser** panel for a live screencast of the desk's headed Chromium tab
with input forwarding. Both are reachable at `https://<desk-name>.<tailnet>.ts.net` — nothing
extra to configure.

Watching from the CLI instead, `openclaw gateway call duties.run.wait --params
'{"runId":"<id>"}'` blocks until the run finishes — but `gateway call`'s own transport timeout
defaults to 10 s, well under how long a real browser Duty can take, so it returns `gateway
timeout after 10000ms` while the run itself is still fine. Pass a longer budget explicitly:

```sh
openclaw gateway call duties.run.wait --params '{"runId":"<id>"}' --timeout 60000
```

## Parallel limit

The desk's **Desk** card on the Duties settings page shows health chips (Provisioned, Gateway,
Display, Chromium, Tailscale, Mail watcher, load), how old that reading is, and a parallel-runs
number input
(`maxParallelRuns`, default 4, range 1–8). Each run gets its own tab in the one headed
Chromium; an `exclusive: true` Duty still serializes itself regardless of this limit. Rough
sizing: `s-2vcpu-4gb` handles 2–3 concurrent browser runs, `s-4vcpu-8gb` handles about 6.

**"Provisioned"** is false when first boot left `/var/lib/openclaw/provision-failed` behind, and
the whole chip row goes grey with a "health readings are stale" line once the desk's health file is
more than five minutes old (the probe runs every two minutes). Grey chips are not evidence of
anything: they mean nobody is updating the file — check `systemctl status desk-health.timer` on the
desk. Never read green chips as proof during an incident without checking the age next to them.

## Roll

```sh
deploy/desk/roll.sh <desk-name> [<git-ref>]      # default ref: main
deploy/desk/roll.sh <desk-name> <git-ref> --force
deploy/desk/roll.sh <desk-name> --reboot
```

`roll.sh` first checks the desk is idle (no Duty run `running`, `needs_input`, or `queued`)
and exits with status 3 and a `desk is busy: run <id> is <status>; retry later or --force`
message if it is not. Otherwise — or with `--force` — it snapshots the current build (`dist`
and the git ref that produced it) and **stops `openclaw-gateway` first**, then fetches and
checks out `<git-ref>`, reinstalls (frozen lockfile, `--ignore-scripts`) and rebuilds against
the now-idle checkout. The rebuild is **runtime-only**
(`OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=4352`, the same mode and
heap ceiling cloud-init's first-boot build uses): the declaration build needs ~4.7 GB and refuses
outright on a `s-2vcpu-4gb` desk, and a desk only ever runs the Gateway. **The desk is briefly
down for the whole build — the Control UI is
unreachable and Duties are refused — from the moment it stops the Gateway until it answers
`/healthz` again** (this replaces rebuilding `dist` while the old Gateway kept running, which
used to surface a transient "assets could not be prepared" and skills `EACCES` on the Control
UI mid-roll).

- **On success**: restores `root:openclaw` ownership, discards the snapshot, starts
  `openclaw-gateway` again, waits for `/healthz` to answer, and prints the desk's reported
  version.
- **On failure** (the fetch, install, or build step itself fails — a network hiccup or an
  out-of-memory build, both of which have happened during this project): restores the
  snapshotted `dist`, the git ref that produced it, **and that ref's own `node_modules`**
  (`pnpm install --frozen-lockfile --prefer-offline`, because the forward install has by then
  already replaced the tree with the new ref's dependencies) — the desk goes back to exactly what
  it was serving before this roll — restarts the Gateway on it, and exits **5** once `/healthz`
  answers again, or **6** if the Gateway does not come back up even on the restored build (the
  failure message prints the `journalctl` command to investigate with). Either way the desk is
  left in a working state rather than down indefinitely; nothing needs manual recovery unless it
  exits 6.

Two things to know about what a roll can move under you:

- The rolled ref must exist **on the fork the desk clones** (its `origin`, the URL the desk was
  created with), not only in your local checkout — the desk runs `git fetch origin <ref>` itself.
  A local-only branch fails that fetch and comes back as exit 5 with the previous build restored.
  Push the branch first.
- `desk-health.service` runs `/opt/openclaw/deploy/desk/desk-health.sh` **from the rolled tree**
  (a deliberate trade-off: the script cannot be written before the clone exists). A ref that moves
  or renames that script silently stops the health probe, so the Desk card's chips go stale — which
  the card now says out loud rather than showing green.

The body that runs on the desk is `deploy/desk/remote/roll-remote.sh`, sent over stdin; run
`roll.sh` from a complete checkout so it is on hand.

Pass `--reboot` instead of a plain roll when a kernel or package update needs the whole box
restarted, in a window the operator picks — `unattended-upgrades` on the desk never reboots on
its own; the Gateway stops the same way first (with the same failure recovery above), then the
enabled unit starts it back up once the box comes back.

## Snapshot / restore

```sh
deploy/desk/snapshot.sh <desk-name>
```

Takes a DigitalOcean snapshot named `desk-<desk-name>-<timestamp>` and prunes older
`desk-<desk-name>-*` snapshots down to the newest 4. Schedule this from the operator's Mac
(cron/launchd) for a standing weekly snapshot, or run it by hand before a risky roll.

To restore, create a new desk from a snapshot instead of the base image:

```sh
deploy/desk/new-desk.sh <new-desk-name> --image <snapshot-id> \
  --ts-authkey-file <f> --tg-token-file <f> --owner-target <id>
```

A snapshot carries the previous desk's `/etc/openclaw/keyfile` **and** its encrypted credential
store, and cloud-init deliberately leaves an existing keyfile alone, so stored logins keep working
on the restored desk. It also carries that desk's `openclaw.json`; cloud-init rewrites it from the
template with the new desk's own tokens, so the Telegram bot token and Gateway token you pass are
the ones in force.

> **A snapshot carries the source desk's live secrets. Never provision a client from another
> client's snapshot.** `--image <snapshot-id>` is only ever the _same_ desk's snapshot, restored
> for that same client. `snapshot.sh` names snapshots `desk-<desk-name>-<timestamp>` precisely so
> you can tell whose they are; nothing enforces the match, so this is on you.

What a restored desk still holds from the source desk, after cloud-init has run:

- `/etc/openclaw/keyfile` and the encrypted credential store it unlocks — every stored login the
  source desk had, working, on the new box (that is the point of restoring, and the problem when
  the new box is somebody else's).
- `/var/lib/cloud/instances/<old-instance-id>/user-data.txt` — the **source** desk's rendered
  cloud-init, with its Tailscale auth key, Telegram bot token, Gateway token and hooks token in
  plain text. cloud-init writes the new instance's own directory beside it and never removes the
  old one, and `/etc/openclaw/secrets/*` is rewritten for the new instance — so this stale copy
  is the one place those credentials survive. Root-readable.
- Any log, transcript, Duty artifact, browser profile and `~/.openclaw` state the source desk
  wrote.

Checklist before a restored desk serves anyone:

1. Confirm the snapshot is this same desk's. If it is not, stop — build a fresh desk instead.
2. `ssh root@<desk-name> 'ls /var/lib/cloud/instances'` and remove every directory that is not
   the current instance id (`cat /var/lib/cloud/data/instance-id`).
3. Rotate the source desk's Tailscale auth key if it was reusable, and its Telegram bot token if
   the restored desk is not the same client's.
4. `ssh root@<desk-name> 'systemctl status desk-metadata-guard'` — the guard must be active
   before the desk takes traffic; it is what keeps the service user off the live metadata
   endpoint, and it does not cover the stale on-disk copy above.

## Secrets on the box

DigitalOcean keeps a droplet's user-data — the rendered cloud-init, including the Tailscale auth
key, the Gateway token and (on an owner desk) the Telegram bot token and the minted hooks token — retrievable for the
droplet's whole life from `http://169.254.169.254/metadata/v1/user-data`, unauthenticated, by any
local process. Two things follow:

- **Use a single-use (ephemeral) and tagged Tailscale auth key** when creating a desk. The copy
  left in user-data is then already spent, instead of being a standing way onto your tailnet. If
  you used a reusable key, treat it as compromised and rotate it once the desk is up.
- Every desk boots `desk-metadata-guard.service`, which rejects egress to `169.254.169.254` for
  every non-root uid (`iptables … -m owner ! --uid-owner 0 -j REJECT`). It is enabled as the last
  provisioning step (cloud-init itself needs the metadata service) and re-applied on every boot, so
  the `openclaw` service user — and anything a Duty or an `exec` step runs as it — cannot read the
  user-data. Root still can. Check it with
  `ssh root@<desk-name> 'systemctl status desk-metadata-guard; iptables -S OUTPUT'`.

## Logs

```sh
ssh root@<desk-name> journalctl -u openclaw-gateway -u xvfb -u desk-health
```

The Gateway's own log is the systemd journal — there is no separate log file to tail.

## Restart recipe

Never hot-edit `~openclaw/.openclaw/openclaw.json` on a running desk — config hot-reload
leaves the Gateway's MCP loopback catalog stale. Instead: edit the file, then restart the
service:

```sh
ssh root@<desk-name> systemctl restart openclaw-gateway
```

The unit gives the Gateway 45 seconds to drain any live session on `SIGTERM`, then
`SIGKILL`s the whole process group (`KillMode=mixed`) — a restart never hangs indefinitely
even mid-run. `roll.sh` uses this same recipe automatically.

## Troubleshooting

- **`provision-failed` marker** (`/var/lib/openclaw/provision-failed`): first boot failed at the
  fork checkout, the Claude CLI install, or the managed Chromium install. The Gateway still answers
  `/healthz`, so this is the only signal — `new-desk.sh` warns about it after the readiness wait,
  and the Duties page's Desk card shows `✗ Provisioned`. Find which step failed with
  `ssh root@<desk-name> journalctl -u cloud-init-output --no-pager`, fix it by hand (usually
  re-running `sudo -H -u openclaw bash -lc 'cd /opt/openclaw && npx playwright install chromium'`
  or `npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code`), then
  `rm /var/lib/openclaw/provision-failed` so the chip clears on the next health run.
- **Headless fallback**: the managed Chromium falls back to headless when `DISPLAY` is
  unset. Check `echo $DISPLAY` is `:99` in the Gateway's environment
  (`systemctl show openclaw-gateway -p Environment`) and that `xvfb.service` is active.
- **Pages render mobile/tablet layouts**: check `OPENCLAW_BROWSER_WINDOW_SIZE` matches the
  Xvfb geometry (a desk has no window manager, so headed Chromium otherwise opens at its
  default ~920x1030 window).
- **Render 404 in the Browser panel**: check `browser.ssrfPolicy.allowedHostnames` in the
  desk's config includes the host the page is asking to load — the desk's default only
  allows `127.0.0.1`.
- **Tools missing after a config change**: restart `openclaw-gateway`; never expect a config
  edit to take effect without one (config hot-reload does not refresh the MCP loopback
  catalog).
- **Datacenter-IP challenge from a target site**: cloud droplet IPs get blocked or
  challenged more than residential ones. Prefer the target's own agent/trade portal when one
  exists; fall back to a residential proxy only as a last, owner-approved resort.
- **`new-desk.sh` exits 4**: the desk joined the tailnet but its Gateway never answered
  `/healthz` within `DESK_READY_POLL_SECONDS` (default 30 minutes) — the box is still
  building, or something failed partway through. `ssh` in as the exit message's printed
  command shows and check `journalctl -u openclaw-gateway -u cloud-init-output --no-pager`
  for where it stalled; a slow first boot (large apt mirror, slow Chromium download) can
  simply need `DESK_READY_POLL_SECONDS` raised and a rerun of the poll rather than a new
  droplet.

## Tear down

```sh
doctl compute droplet delete <desk-name>
```

Then remove the node from the tailnet admin console and revoke the desk's Telegram bot
token (BotFather → `/revoke`) so a deleted desk's credentials cannot be reused.
