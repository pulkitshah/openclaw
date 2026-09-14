# Hosted desk runbook

A **desk** is a DigitalOcean droplet running this fork's Gateway with the Duties plugin, a
headed Chromium on a virtual display, and Telegram, reachable only over the operator's
tailnet. See `docs/superpowers/specs/2026-09-14-hosted-desk-design.md` for the design this
runbook implements.

Everything below assumes: `doctl` authenticated on the operator's Mac, `tailscale` joined to
the same tailnet a desk will join, and this repo checked out locally so the three scripts in
`deploy/desk/` are on hand (`new-desk.sh`, `roll.sh`, `snapshot.sh`). No script here ever
prints a secret; commands below use `<...>` placeholders instead of real names.

## Create

```sh
deploy/desk/new-desk.sh <desk-name> \
  --ts-authkey-file <path-to-a-file-holding-one-tailscale-preauth-key> \
  --tg-token-file <path-to-a-file-holding-the-desk's-telegram-bot-token> \
  --owner-target <telegram-user-or-chat-id>
```

This creates the `desk-no-inbound` cloud firewall the first time (no inbound, all outbound —
Tailscale needs no inbound rule), boots a `s-2vcpu-4gb` droplet from `ubuntu-24-04-x64` in
`blr1`, waits up to 15 minutes for the desk to join the tailnet, and prints:

```
Control UI: https://<desk-name>.<tailnet>.ts.net
Sign in:    ssh <desk-name> 'sudo -u openclaw node /opt/openclaw/openclaw.mjs gateway auth-token --show'
```

Useful flags: `--size s-4vcpu-8gb` for more parallel runs, `--git-ref <ref>` to pin a
non-`main` checkout, `--image <snapshot-id>` to create a new desk from a prior desk's
snapshot instead of a bare image (minutes instead of a full first-boot install — see
[Snapshot / restore](#snapshot--restore)). Run `deploy/desk/new-desk.sh --help` for the full
flag and environment-override list, including `DESK_SSH_KEY_NAME` if the operator's `doctl`
SSH key is not named `<key-name>` (the script's own default).

## First sign-in

1. Run the `ssh <desk-name> '... gateway auth-token --show'` command `new-desk.sh` printed to
   reveal the Gateway token.
2. Open `https://<desk-name>.<tailnet>.ts.net` in a browser on a device joined to the same
   tailnet, and sign in with that token.

## Store logins

Open the desk's Control UI **Logins** page and add the credentials the desk's Duties need
(site logins, API keys, etc.). On Linux, the Duties credential store is an AES-256-GCM file
keyed by `/etc/openclaw/keyfile` (root:openclaw, 0640) — cloud-init creates this file on
first boot, so no extra setup is needed before storing logins.

## Gmail push per desk

Each desk that watches a mailbox needs two one-time steps, run on the desk itself:

```sh
ssh <desk-name>
sudo -u openclaw node /opt/openclaw/openclaw.mjs duties setup
sudo -u openclaw node /opt/openclaw/openclaw.mjs webhooks gmail setup \
  --account <the-watched-gmail-address> --tailscale funnel
```

Gmail Pub/Sub push needs a publicly reachable endpoint, so this step uses Tailscale **Funnel**
(not Serve) for that one webhook path — Funnel is scoped to the hook route; the Control UI
stays tailnet-only via Serve as configured at provisioning time.

## Watch a run

Open the Duty's run page for evidence, screenshots, files, and the live "Now" panel, and open
the Control UI's **Browser** panel for a live screencast of the desk's headed Chromium tab
with input forwarding. Both are reachable at `https://<desk-name>.<tailnet>.ts.net` — nothing
extra to configure.

## Parallel limit

The desk's **Desk** card on the Duties settings page shows health chips (Gateway, Display,
Chromium, Tailscale, Mail watcher, load) and a parallel-runs number input
(`maxParallelRuns`, default 4, range 1–8). Each run gets its own tab in the one headed
Chromium; an `exclusive: true` Duty still serializes itself regardless of this limit. Rough
sizing: `s-2vcpu-4gb` handles 2–3 concurrent browser runs, `s-4vcpu-8gb` handles about 6.

## Roll

```sh
deploy/desk/roll.sh <desk-name> [<git-ref>]      # default ref: main
deploy/desk/roll.sh <desk-name> <git-ref> --force
deploy/desk/roll.sh <desk-name> --reboot
```

`roll.sh` first checks the desk is idle (no Duty run `running`, `needs_input`, or `queued`)
and exits with status 3 and a `desk is busy: run <id> is <status>; retry later or --force`
message if it is not. Otherwise — or with `--force` — it fetches and checks out `<git-ref>`,
reinstalls (frozen lockfile, `--ignore-scripts`) and rebuilds, restores `root:openclaw`
ownership, restarts `openclaw-gateway`, waits for `/healthz` to answer, and prints the
desk's reported version. Pass `--reboot` instead of a plain roll when a kernel or package
update needs the whole box restarted, in a window the operator picks — `unattended-upgrades`
on the desk never reboots on its own.

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

## Logs

```sh
ssh <desk-name> journalctl -u openclaw-gateway -u xvfb -u desk-health
```

The Gateway's own log is the systemd journal — there is no separate log file to tail.

## Restart recipe

Never hot-edit `~openclaw/.openclaw/openclaw.json` on a running desk — config hot-reload
leaves the Gateway's MCP loopback catalog stale. Instead: edit the file, then restart the
service:

```sh
ssh <desk-name> systemctl restart openclaw-gateway
```

The unit gives the Gateway 45 seconds to drain any live session on `SIGTERM`, then
`SIGKILL`s the whole process group (`KillMode=mixed`) — a restart never hangs indefinitely
even mid-run. `roll.sh` uses this same recipe automatically.

## Troubleshooting

- **Headless fallback**: the managed Chromium falls back to headless when `DISPLAY` is
  unset. Check `echo $DISPLAY` is `:99` in the Gateway's environment
  (`systemctl show openclaw-gateway -p Environment`) and that `xvfb.service` is active.
- **Render 404 in the Browser panel**: check `browser.ssrfPolicy.allowedHostnames` in the
  desk's config includes the host the page is asking to load — the desk's default only
  allows `127.0.0.1`.
- **Tools missing after a config change**: restart `openclaw-gateway`; never expect a config
  edit to take effect without one (config hot-reload does not refresh the MCP loopback
  catalog).
- **Datacenter-IP challenge from a target site**: cloud droplet IPs get blocked or
  challenged more than residential ones. Prefer the target's own agent/trade portal when one
  exists; fall back to a residential proxy only as a last, owner-approved resort.

## Tear down

```sh
doctl compute droplet delete <desk-name>
```

Then remove the node from the tailnet admin console and revoke the desk's Telegram bot
token (BotFather → `/revoke`) so a deleted desk's credentials cannot be reused.
