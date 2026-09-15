# Hosted desk — a Linux VM that runs Duties (sub-project 4, Linux first)

A **desk** is a cloud VM that runs this fork's Gateway with the Duties plugin, a headed Chromium on a virtual display, and the channels a client needs, reachable only over the owner's tailnet. One desk per client. It reproduces the pattern that worked in Vasudev's hosted desks (Ubuntu droplet, Xvfb, headed Chrome, tunnel-only access) using OpenClaw's own building blocks where they exist.

Owner decisions (2026-09-14): Linux first (Windows desk later, when a Tally/Excel Duty exists); DigitalOcean blr1 via `doctl` (already authenticated on the owner's Mac); **Tailscale Serve, tailnet-only** access (no control plane, no reverse SSH); **no desktop control** (computer-use) in this slice — browser Duties only; parallel Duty runs must work.

## 1. What ships

- `deploy/desk/` in this repo: `new-desk.sh` (create), `roll.sh` (update in place), `cloud-init.yaml` (first boot), systemd units, a Chrome policy file, and `README.md` (runbook: create, attach, watch, roll, snapshot, troubleshoot, tear down).
- A Linux credential backend for the Duties `{{cred:key}}` store.
- A `duties.desk.status` Gateway method + "Desk" health line on the Duties page (Gateway, display, Chromium, Tailscale, mail watcher, load, parallel limit).
- A per-desk `maxParallelRuns` setting (Duties settings) wired to the run manager.
- Docs page `docs/hosted-desk.md`.
- Proof: a real desk in blr1 running `book-flight-by-mail` from a mail, watched from the owner's laptop over the tailnet.

## 2. Verified facts this design relies on

| Fact                                                                                                                                                                                                                                                                                               | Where                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Gateway as a systemd user service on Linux; unit template with graceful-drain timeout and OOM bias                                                                                                                                                                                                 | `docs/platforms/linux.md` (headless-server section)                                                                     |
| Managed `openclaw` Chromium falls back to headless when `DISPLAY` is unset (`headlessSource: "linux-display-fallback"`); `OPENCLAW_BROWSER_HEADLESS=0` forces headed and errors without a display                                                                                                  | `docs/tools/browser/configuration.md`                                                                                   |
| Control UI Browser panel = live screencast of a tab with input forwarding (`POST /screencast`)                                                                                                                                                                                                     | `docs/tools/browser-control.md`, `docs/web/control-ui/panels.md`                                                        |
| `gateway.tailscale.mode: serve` exposes the Control UI over the tailnet with identity auth while binding loopback                                                                                                                                                                                  | `docs/gateway/tailscale.md`                                                                                             |
| SecretRefs (`file`, `env`, `exec`, store) are the server-side replacement for a keychain                                                                                                                                                                                                           | `docs/gateway/secrets.md`                                                                                               |
| Duties credentials today: macOS `security` and a Windows PowerShell adapter in `extensions/duties/src/creds.ts`; no Linux backend                                                                                                                                                                  | Part 1                                                                                                                  |
| Vasudev's desk: `Xvfb :99 -screen 0 1920x1080x24` unit, headed Chrome with a policy blocking `chrome://`/`file://`, Liberation/Noto/DejaVu fonts, AES-256-GCM cred file keyed by a root-owned keyfile the service user can read but not write, reverse-SSH front door (replaced here by Tailscale) | Vasudev `docs/rebuild/2026-09-09-hosted-desk-*.md`, `docs/ops/HOSTED-DESK-RUNBOOK.md`, `deploy/desk/spike-provision.sh` |
| The Gateway retitles its process `openclaw-gateway`; SIGTERM drains and can hang while sessions are live; config hot-reload leaves the MCP loopback catalog stale                                                                                                                                  | Part 2 proof (2026-09-14)                                                                                               |
| DigitalOcean: account active, blr1 available, `ubuntu-24-04-x64`, `s-2vcpu-4gb` $24/mo, `s-4vcpu-8gb` $48/mo, SSH keys registered                                                                                                                                                                  | `doctl` (2026-09-14)                                                                                                    |

## 3. Provisioning

`deploy/desk/new-desk.sh <desk-name> [--size s-2vcpu-4gb] [--tailscale-authkey-file <path>]`:

1. `doctl compute droplet create <desk-name> --region blr1 --size <size> --image ubuntu-24-04-x64 --ssh-keys <owner key id> --tag-names desk --user-data-file <rendered cloud-init> --wait`.
2. The rendered cloud-init (from `cloud-init.yaml` + the auth key, never committed) does everything in §4 unattended and reboots.
3. The script waits for the desk to appear on the tailnet (`tailscale status --json` from the owner's Mac), then prints the Control UI URL `https://<desk-name>.<tailnet>.ts.net`, and the `openclaw gateway auth-token --show` instruction for the first sign-in.
4. A DigitalOcean **cloud firewall** `desk-no-inbound` (created once) drops all inbound; outbound open. Tailscale needs no inbound rule.
5. `deploy/desk/roll.sh <desk-name> [<git-ref>]`: over `ssh <desk-name>` (tailnet SSH), fetches the ref into `/opt/openclaw`, builds, and restarts the Gateway with the safe recipe — **but skips** (exit 3, message) when `duties.runs.recent` reports a `running`/`needs_input` run unless `--force`.
6. After the first successful desk: `doctl compute droplet-action snapshot` → later desks are created from the snapshot (`--image <snapshot id>`), cutting setup to minutes.

Secrets on the owner's side (Tailscale auth key, Telegram bot token per desk, `gog` OAuth client) are passed as files at create time; nothing is committed.

## 4. The desk itself (cloud-init, in order)

1. **Users/dirs**: system user `openclaw` (no sudo), `/opt/openclaw` (the fork checkout, `root:openclaw` 0755, read-only to the service user), state `~openclaw/.openclaw` (0700), `/etc/openclaw/keyfile` (root:openclaw 0640, 32 random bytes).
2. **Packages**: Node 26 (NodeSource), git, `xvfb`, `x11-utils`, fonts (`fonts-liberation`, `fonts-noto-core`, `fonts-noto-color-emoji`, `fonts-dejavu`), Chromium runtime deps (the Playwright-listed libs), `tailscale`, `unattended-upgrades`; timezone `Asia/Kolkata`, locale `en_IN.UTF-8`.
3. **Tailscale**: `tailscale up --authkey <key> --ssh --hostname <desk-name>` (tailnet SSH replaces sshd for humans; sshd stays bound to the tailnet interface only).
4. **Fork**: clone `pulkitshah/openclaw` (branch from the roll ref), `pnpm install --frozen-lockfile --ignore-scripts` with the minimum-release-age env vars, `pnpm build`; managed Chromium via `npx playwright install chromium` under the service user.
5. **Display**: `xvfb.service` (system unit): `Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp`, `Restart=always`. Gateway unit `Environment=DISPLAY=:99 OPENCLAW_BROWSER_HEADLESS=0`.
6. **Gateway**: `openclaw-gateway.service` (system unit running as `openclaw`, `WorkingDirectory=/opt/openclaw`, `ExecStart=node openclaw.mjs gateway run`, `TimeoutStopSec=45` then `KillMode=mixed` (SIGKILL after the drain window — the Part 2 lesson), `Restart=always`, `OOMScoreAdjust=-500`). Config `~openclaw/.openclaw/openclaw.json` rendered from a template: `gateway.tailscale.mode: serve`, `browser.ssrfPolicy.allowedHostnames: ["127.0.0.1"]` (rendering), plugins duties/telegram enabled, `duties` `browserProfile: openclaw`, the owner target, the `duties-mail` agent + hooks (via `openclaw duties setup` output), `agents.ownership: explicit` + bindings.
7. **Chrome policy**: `/etc/chromium/policies/managed/desk.json` — `URLBlocklist: ["chrome://*", "file://*"]`, no password manager, no sync.
8. **Watchdog**: `desk-health.timer` (every 2 min) writes `/var/lib/openclaw/desk-health.json` (`gateway`, `display`, `chromium`, `tailscale`, `load1`, `memFreeMb`, `mailWatcher`) — the file the Gateway method reads; restarts Xvfb if `xdpyinfo -display :99` fails.
9. **Updates**: `unattended-upgrades` security-only, `Automatic-Reboot false`; kernel reboots happen only via `roll.sh --reboot` in a window the owner picks.

## 5. Credentials on Linux

`extensions/duties/src/creds.ts` gains a `linux` backend behind the same `credGet/credSet/credDelete/credHas`:

- Store: `~/.openclaw/plugins/duties/creds.enc` (0600) — one AES-256-GCM blob over a JSON map `{ key: value }`, IV per write, key = `HKDF(keyfile bytes, "openclaw-duties-creds")`, keyfile path from `DUTIES_CRED_KEYFILE` (default `/etc/openclaw/keyfile`); missing keyfile → `credSet` fails with `no credential keyfile at <path> — create it as root with 32 random bytes, readable by the service user`.
- Same key regex and same "never log values" rules; `duties.cred.list` reads the index as before.
- Selection: `process.platform === "linux"` → file backend; macOS/Windows unchanged.
- Tests: round-trip, tamper detection (auth tag), missing keyfile message, concurrent `credSet` (write lock via rename).

Bot/hook tokens use the Gateway's SecretRefs (`file` under `/etc/openclaw/secrets/`, 0640) instead of plaintext in `openclaw.json`.

## 6. Parallel runs

- `DutiesSettings.maxParallelRuns` (default 4; 1–8) set on the Duties page; the RunManager reads it at `start()` (not only at construction). Queued runs keep their "waiting for a free slot" reason.
- Each run owns its tab in the single headed Chromium; `exclusive` Duties still serialize themselves; the Amigos one-session rule stays a Duty-level `exclusive: true`.
- Sizing note in the runbook: `s-2vcpu-4gb` ≈ 2–3 concurrent browser runs, `s-4vcpu-8gb` ≈ 6.

## 7. Watching a run

Unchanged from Part 2: the run page (evidence, screenshots, files, Now panel) plus the host's Browser panel screencast for a live look at the tab, all through `https://<desk>.<tailnet>.ts.net`. Whole-desktop VNC and take-control belong with desktop control (deferred).

## 8. Gateway surface and UI

- `duties.desk.status` (operator.read): reads `/var/lib/openclaw/desk-health.json` when present (else `{ hosted: false }`), plus `maxParallelRuns` and current active/queued counts from the RunManager.
- Duties page settings strip gains **Desk**: health chips (Gateway · Display · Chromium · Tailscale · Mail · load), the parallel-runs number input (`duties.settings.set { maxParallelRuns }`).
- `openclaw duties setup` prints the desk-specific prerequisites too when `hosted: true`.

## 9. Ops

- Logs: `journalctl -u openclaw-gateway -u xvfb -u desk-health`; the Gateway log is the systemd journal.
- Restart recipe (runbook + `roll.sh`): `systemctl stop` (45 s drain) → unit's SIGKILL → `systemctl start`; never edit the config on a running desk — edit, then restart.
- Snapshots: weekly `doctl` snapshot via a `snapshot.sh` the owner runs or schedules from the Mac; retention 4.
- Datacenter-IP challenges: documented fallback per Vasudev's runbook (use the agent/trade portal; residential proxy only as a last, owner-approved resort).
- Tear-down: `doctl compute droplet delete`, remove the tailnet node, revoke the bot token.

## 10. Security

No public ports (cloud firewall + loopback binds + Tailscale Serve). The service user cannot write the app, the keyfile, or the policy file; `chrome://` and `file://` blocked. The Control UI is tailnet-identity-gated plus the Gateway token. Secrets never in cloud-init logs (auth key passed via a file with `chmod 600`, deleted after use; `write_files` with `permissions: '0600'`). The owner's laptop keeps the only copy of the DO API token (doctl).

## 11. Testing

- Unit: Linux cred backend; `desk.status` shape with/without the health file; `maxParallelRuns` read at start; `roll.sh` skip logic (bash test with a stubbed `openclaw` CLI).
- Script lint: `shellcheck` on `deploy/desk/*.sh`; `cloud-init schema --config-file`.
- Live proof (last task): create `desk-proof` in blr1 from the Mac, sign in over the tailnet, store Amigos logins on its Logins page, run `book-flight-by-mail` from a mail, watch it on the run page and in the Browser panel, two runs in parallel (the search Duty twice), roll once, snapshot, tear down or keep (owner's call). Nothing in the proof touches the owner's Mac Gateways.

## 12. Out of scope

Windows desks (research recorded 2026-09-14), desktop control / whole-desktop VNC, a control plane or fleet admin page, multi-tenant hosts, autoscaling, backups of client data beyond snapshots.
