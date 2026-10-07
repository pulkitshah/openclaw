# TripIn Studio desk migration — design

Move the desk now serving as `vasudev-desk-1` (DigitalOcean, blr1) to the owner's Windows 11
office PC, rename it from Prabhat Foods to **TripIn Studio**, and keep the droplet as the public
front door for every client.

## 1. Goal

- The desk's agent, Duties, automations (cron), workspace, memory, Claude and gog logins, stored
  Duty credentials, Chromium profile, media and run history continue on the office PC with no
  data loss.
- The desk is TripIn Studio's own: the agent, identity, Duty names, cron job names and front-door
  login say TripIn Studio. Prabhat Foods is no longer served from it (owner decision 2026-10-07).
- `vasudev.tripinstudio.com` keeps working for Amigos and Prasthan throughout; the droplet is
  never taken down for this move and is downsized only after the cutover is verified.
- Runs on Windows 11 with no second machine: Ubuntu 24.04 under **WSL2** (a built-in Windows
  feature) with systemd, so the existing Linux desk layout applies almost unchanged.

## 2. Decisions (from the design conversation)

| Decision | Choice |
| --- | --- |
| Office PC runtime | WSL2 Ubuntu 24.04 with `systemd=true`; the PC stays Windows-only. |
| Front door | Stays on the droplet (Caddy + auth-server); routes the TripIn Studio desk over Tailscale to the PC. |
| Prabhat login | Replaced by a TripIn Studio login on the front door; the Prabhat email is removed from `users.json` and the Caddy route. |
| Timing | Planned in parallel with the Wallet proof; executed after it, with a droplet snapshot first. |
| Reachability | The PC joins the existing tailnet (`tail325f09.ts.net`). No public address at the office. |

## 3. What moves (inventory from the live desk, 2026-10-07)

| Item | Where it is today | Size | How it moves |
| --- | --- | --- | --- |
| State dir | `/home/openclaw/.openclaw` (`openclaw.json`, `state/openclaw.sqlite` 294 MB, `media` 752 MB, `agents/`, `workspace/`, `credentials/`, `plugins/`, `browser/openclaw/user-data`) | ~1.2 GB | `rsync` over Tailscale as `openclaw`, Gateway stopped on both ends, WAL checkpointed first |
| Claude login | `~openclaw/.claude`, `~openclaw/.claude.json` | 66 MB | copied; re-login if the token is device-bound |
| gog (Gmail) | `~openclaw/.gogcli` (config, keyring, gmail-watch state) + `GOG_HOME`/`GOG_KEYRING_PASSWORD` in `gateway.env` | 36 MB | copied; keyring password file copied as mode 600 |
| Playwright Chromium | `~openclaw/.cache/ms-playwright` | 658 MB | reinstalled on the PC (`npx playwright install chromium`), not copied |
| Secrets | `/etc/openclaw/secrets/{gateway-admin-password,gateway.env,gateway-token,gog-keyring-password,vnc-password}`, `/etc/openclaw/keyfile`, `/etc/openclaw/vncpasswd` | — | piped over `ssh 'cat > file'` as mode 600, never via argv; the keyfile must be byte-identical or `plugins/duties/creds.enc` cannot be decrypted |
| Checkout + build | `/opt/openclaw` at the branch ref | — | fresh clone + runtime build on the PC (same commands as `roll-remote.sh`) |
| Cron jobs | `cron_jobs` table in `openclaw.sqlite` (heartbeat, weekly skill review, Memory Dreaming, Daily cook menu 5 PM) | — | travel with the database; names renamed in step 6 |
| Duties | `duties`/`runs`/`settings`/`creds` plugin tables + `plugins/duties/files/runs/` | 1.5 MB + files | travel with the state dir |

Not moved: Caddy, the front-door auth server, `users.json` and `sessions.json` (stay on the
droplet); `desk-metadata-guard` (DigitalOcean only); the swapfile; `desk-vnc` (replaced by WSLg or
x11vnc inside WSL at the owner's choice).

## 4. Architecture on the office PC

```
Windows 11
└── WSL2: Ubuntu 24.04 (systemd=true)
    ├── tailscaled            joins tail325f09.ts.net as `tripin-studio`
    ├── xvfb.service          :99, 1920x1080   (unchanged unit)
    ├── openclaw-gateway      /opt/openclaw, User=openclaw, DISPLAY=:99 (unchanged unit)
    │     gateway.bind = tailnet IP, NO gateway.tailscale.mode (no managed serve)
    │     gateway.trustedProxies = [droplet tailnet IP 100.88.53.43]
    │     gateway.auth.mode = trusted-proxy, allowUsers/identityScopes = TripIn Studio login
    ├── desk-health.timer     unchanged; `/var/lib/openclaw/desk-health.json`
    └── (optional) x11vnc on :99, loopback, for watching headed runs
Windows scheduled task "WSL Boot" (onstart) keeps the distro and its services up before login.
```

**Why no managed Tailscale serve.** The Amigos desk could not be routed from the front door over
its tailnet name because that hits the Gateway's managed Tailscale ingress, which refuses a chained
proxy (`src/gateway/ingress-attribution.ts`, `proxy_attribution_required`). The ordinary
transport has a separate trusted-proxy path: a request from an address in `gateway.trustedProxies`
is attributed from its forwarded headers. The front door's Caddy therefore proxies to
`http://<pc-tailnet-ip>:18789` with `X-Forwarded-User` (and the proto/host headers Caddy adds),
and the PC's Gateway accepts it because the droplet's tailnet IP is its trusted proxy. The Control
UI's `allowedOrigins` keeps `https://vasudev.tripinstudio.com`.

**Windows specifics.** `wsl --install -d Ubuntu-24.04`; `/etc/wsl.conf` with `[boot] systemd=true`;
`networkingMode=mirrored` in `.wslconfig` so tailscaled inside WSL has a stable interface; the
`WSL Boot` scheduled task from `docs/platforms/windows.md` ("Gateway auto-start before Windows
login"); Windows sleep disabled while plugged in. Playwright's Chromium runs headed under Xvfb
inside WSL exactly as on the droplet.

## 5. Provisioning

A new `deploy/desk/local/provision-wsl.sh` derived from `cloud-init.yaml.tmpl`: same apt packages
(Xvfb, fonts, Chromium deps), NodeSource Node 26, corepack pnpm, `openclaw` system user, `/opt/openclaw`
clone at a given ref, runtime build with the same env as `roll-remote.sh`, the three units from
`deploy/desk/units/` (gateway, xvfb, desk-health), `/etc/sysctl.d/60-openclaw-desk-chromium.conf`,
Chromium policy file, `/usr/local/bin/{vasudev,openclaw}` wrappers. It omits the metadata guard,
swapfile, Caddy, front door and DigitalOcean agent. Idempotent; re-runnable.

`roll.sh` gains nothing: rolling the PC desk is `ssh root@tripin-studio` + the same
`roll-remote.sh` body (it only assumes ssh + systemd + `/opt/openclaw`, all present under WSL).
`snapshot.sh` does not apply; backups of the PC desk are a `tar` of the state dir to the owner's
chosen location (out of scope here).

## 6. Rename

Performed on the PC after the copy, before the front door is repointed, by a one-shot script
`deploy/desk/local/rename-desk.sh <old-agent> <new-agent> <new-name> <old-email> <new-email>`:

1. `openclaw.json`: `agents.entries.prabhat` → `agents.entries.tripin-studio` (`name`,
   `identity.name` "TripIn Studio"); `agents.defaults.authInheritance.agentId`; `bindings[*].agentId`;
   `gateway.auth.trustedProxy.allowUsers`, `gateway.identityScopes` → the TripIn Studio login email;
   `gateway.bind`, `gateway.trustedProxies`, remove `gateway.tailscale`.
2. `agents/prabhat/` → `agents/tripin-studio/` (directory rename; the agent sqlite travels).
3. Workspace: `IDENTITY.md` rewritten for TripIn Studio; `SOUL.md`/`AGENTS.md` unchanged (no
   Prabhat text); memory files keep their history (they are the agent's past, not identity).
4. Cron: `openclaw cron` rename of `heartbeat-prabhat` → `heartbeat-tripin-studio`,
   `skill-collection-review-prabhat` → `skill-collection-review-tripin-studio`; `agentId` on every
   job → `tripin-studio`.
5. Duties: `duties.save` of the two Duties with new names ("Add cooker" stays; "to Prabhat Foods"
   dropped); run history untouched.
6. Front door (droplet): `users.json` gains the TripIn Studio login (bcrypt cost 14) and drops the
   Prabhat email; Caddyfile route `@prabhat` → `@tripin` with `reverse_proxy http://<pc-tailnet-ip>:18789`;
   `sessions.json` entries for the old email removed; Caddy reloaded.

The Gateway's `sessions` table keys (`agent:prabhat:…`) are migrated by the same script through the
existing session-key rename path if one exists; otherwise the owner's chat sessions start fresh
after the move and the old transcripts remain readable in the copied database (decision recorded
at implementation; both are acceptable to the owner's stated goal).

## 7. Cutover sequence

1. `snapshot.sh vasudev-desk-1` (DigitalOcean snapshot; rollback point).
2. Provision the PC (step 5), join the tailnet, verify `tailscale ping` both ways.
3. Stop the droplet's Gateway (announce; drains 45 s). WAL checkpoint. `rsync` state, logins, secrets.
4. Start the PC Gateway; `/healthz` 200 on the tailnet IP; `duties list` and `cron list` show the
   migrated items; rename (step 6).
5. Repoint the front door; sign in as TripIn Studio; open Duties, run a Duty to a safe step
   (headed Chromium visible in the Browser panel); send one WhatsApp/Telegram message and get a reply.
6. Leave the droplet's Gateway **disabled** (not deleted) for 7 days; then remove the desk pieces
   from the droplet and downsize it to the smallest plan that runs Caddy + auth-server.

Rollback at any point before step 6: start the droplet's Gateway again and restore the Caddy route.

## 8. Out of scope

Billing for the studio desk (the Wallet is per customer desk; the studio desk runs with
`enforce: false`), moving the front door, a Windows-native (non-WSL) Gateway, and migrating
Prasthan or Amigos.

## 9. Testing

- `deploy/desk/render-cloud-init.test.ts`-style unit test for `provision-wsl.sh`'s rendered unit and
  config edits (`scripts.test.ts` already tests the desk scripts' argument handling; extend it).
- `rename-desk.sh` dry-run mode prints every edit; a test runs it against a fixture state dir.
- Live proof file `docs/superpowers/plans/<date>-tripin-studio-desk-migration-proof.md` records
  each cutover step's observed result and the rollback point.
