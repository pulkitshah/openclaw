# Runbook: deploy the TripIn Studio desk on the Windows 11 office PC

Written 2026-10-09 for a fresh Claude Code session (or a human) with no memory of this repo. Follow it top
to bottom. Every command that touches a secret reads it from a file or a pipe, never from argv. The design
this implements is `docs/superpowers/specs/2026-10-07-tripin-studio-desk-migration-design.md` (git-ignored
directory; the file is force-added, so `git show HEAD:docs/superpowers/specs/2026-10-07-tripin-studio-desk-migration-design.md`
prints it).

## Status 2026-10-13: executed as a FRESH desk (sections 3-5 parked)

What actually ran, and where it differs from the plan below:

- The owner chose a **fresh TripIn Studio desk** (no restore of the old desk's snapshot; sections 3-5 are
  parked, the snapshot `248986226` is kept). Agents were created by the Control UI onboarding.
- Section 1 was done on the PC by the owner (WSL2 Ubuntu 24.04, mirrored networking, 6 GB, systemd,
  Tailscale inside the distro with `--ssh`, hostname `tripin-studio`, boot task "WSL Boot"). The
  operator reaches it with Tailscale SSH (`ssh root@tripin-studio`; a browser check is asked once per
  12 h).
- Section 2 is now a script: `DESK_GIT_REF=<full sha> DESK_FORK_REPO_URL=<fork> bash provision-wsl.sh`
  run as root on the PC (copy it there first; do not feed it over `bash -s` - its apt/playwright steps
  read stdin). It is idempotent; two things bit on first run: the Playwright CDN download timed out
  while pnpm saturated the link (just re-run), and the office network advertises a dead IPv6 prefix, so
  Node stalled on every download until `/etc/sysctl.d/61-openclaw-desk-no-ipv6.conf` disabled IPv6 in
  the distro.
- The desk's own Caddy (bound to the PC's tailnet IP, `http://100.95.17.69:8443`, basic auth, plain HTTP
  because WireGuard already encrypts the hop) fronts the loopback Gateway with `X-Forwarded-User`, the
  same shape as Prabhat. `openclaw.json` is the client template plus the trusted-proxy block
  (`allowUsers` = the owner's email, `identityScopes` + `pulkitshah@github`, `allowedOrigins` for the
  front door and the ts.net name, `gateway.nodes.browser.mode: "auto"`). Do NOT add `agents.defaults`
  without `agents.entries`: the Gateway refuses to start (exit 78). `/etc/openclaw/secrets` must be
  0755 (files 0600) or the password secret provider fails as the service user.
- Front door: `vasudev-front-door` joined the tailnet (100.64.91.103); `users.json` got the owner's
  login (keep the file `openclaw:openclaw 0600` - a root-only file crashes the login service on every
  sign-in, which happened for an hour on 2026-10-13); the `@tripin` route proxies to
  `http://100.95.17.69:8443` with `header_up Host 100.95.17.69:8443` (without it the PC's Caddy answers
  an empty 200 for everything) and the basic-auth header, placed above the 403 fallthrough.
- Claude sign-in on the desk: `claude auth login` inside `tmux` as the service user needs
  `env SHELL=/bin/bash` (its login shell is nologin, so tmux otherwise exits at once); the owner opened
  the printed link and pasted the code back.
- The owner's MacBook is paired as a browser-only node (`openclaw connect <join-url> --service
--commands browser.proxy,browser.inspect`, from a fork checkout built at the same sha as the desk).
  **Parked by the owner:** its connection through the desk's Tailscale serve address drops with code
  1006 about once a minute and reconnects; the Gateway falls back to the PC's own Chromium when the node
  is down mid-request, so browser Duties still run, but not through the laptop. Not diagnosed.
- Section 10 (Windows node for desktop control) was executed on 2026-10-13/14; the driver defects it
  surfaced are fixed in `bdb36ca0a7b` and the desk runs that commit. Next: the Clicky-style overlay and
  Tally; Tally has its own HTTP XML interface on port 9000 (reachable from the distro as localhost under
  mirrored networking) - prefer it over screen control for data.

## 0. Situation you are walking into

- Vasudev is this fork of OpenClaw (`pulkitshah/openclaw`, branch `main` == `staging/team-v2-test`). A
  "desk" is one Gateway per customer, provisioned by `deploy/desk/` onto an Ubuntu box: systemd units,
  Xvfb + headed Chromium for the Duties plugin, Tailscale, Node 26, pnpm, a runtime-only build.
- **The desk being moved is Prabhat Foods' old desk, renamed to "TripIn Studio"** (owner decision
  2026-10-07: Prabhat Foods is no longer served from it; the agent `prabhat` becomes `tripin-studio`).
- **Its droplet no longer exists.** `vasudev-desk-rc` (DigitalOcean, 160 GB disk) was destroyed on
  2026-10-09. The only copy of its state is the DigitalOcean snapshot
  **`desk-vasudev-desk-rc-20261009080316`** (id `248986226`, 31.9 GiB). There is no file backup on any Mac.
- **The front door** (`vasudev.tripinstudio.com`: Caddy + login service) now runs on its own droplet
  `vasudev-front-door` (`139.59.72.76`, 1 GB). The route for the TripIn Studio desk will be added there
  (section 7). Prabhat's login currently gets a 503 "This desk is being moved."
- Tailnet: `tail325f09.ts.net`. Existing nodes: `vasudev-amigos`, `vasudev-prasthan-1`,
  `pulkits-macbook-pro`. The dead node `vasudev-desk-1` can be removed in the admin console.
- Tooling on the operator's Mac: `doctl` (DigitalOcean), `~/.claude/bin/pnpm12`, Tailscale.
  DigitalOcean API access is already configured for `doctl`.

What you need from the owner before starting: (1) the office PC powered on, on the internet, with an
admin Windows account you can type into (or a remote-control session); (2) a Tailscale pre-auth key for
the tailnet (admin console → Settings → Keys → reusable, 90 days, tag optional) saved to a file;
(3) the new front-door login email for TripIn Studio and a password (you will bcrypt it);
(4) a window where Prabhat's old data can be read from a temporary droplet (costs ~$0.10/hour).

## 1. Prepare Windows (on the office PC, PowerShell as Administrator)

```powershell
wsl --install -d Ubuntu-24.04          # reboots once if WSL was not enabled
wsl --set-default-version 2
```

After the reboot, open "Ubuntu 24.04" once to create the Linux user (name it `tripin`), then back in
PowerShell:

```powershell
notepad $env:USERPROFILE\.wslconfig
```

Put in it (mirrored networking gives WSL the PC's own interfaces, which Tailscale and inbound proxying
need; memory 6 GB leaves room for Windows on a 16 GB PC — adjust):

```ini
[wsl2]
networkingMode=mirrored
memory=6GB
swap=4GB
```

Inside Ubuntu (`wsl -d Ubuntu-24.04`):

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
[network]
generateResolvConf=true
EOF
exit
```

Then `wsl --shutdown` and reopen. `systemctl status` must work inside the distro. Keep the PC from
sleeping: Settings → System → Power → "When plugged in, put device to sleep: Never". Create the boot
task so the distro and its services start before anyone logs in (from `docs/platforms/windows.md`
§"Gateway auto-start before Windows login"):

```powershell
schtasks /create /tn "WSL Boot" /tr "wsl.exe -d Ubuntu-24.04 --exec dbus-launch true" /sc onstart /ru "$env:USERNAME"
```

(Use a Windows account whose password does not expire, or the task stops after a password change.)

## 2. Provision the desk inside WSL

There is no cloud-init in WSL; replay the relevant parts of `deploy/desk/cloud-init.yaml.tmpl` by hand.
Read that file first; the sections are `packages:`, `write_files:`, `runcmd:`. Skip anything that is
DigitalOcean-only: the metadata guard unit (`desk-metadata-guard.service`, 169.254.169.254), the swapfile,
Caddy, the front door, `desk-vnc`. Everything below runs inside Ubuntu as root (`sudo -i`).

1. **Packages**: the `packages:` list from the template (Xvfb, fonts, Chromium deps, git, jq, curl,
   xdpyinfo…). Then Node 26 from NodeSource and corepack-pinned pnpm exactly as the template's `runcmd`
   does, and `tailscale` (`curl -fsSL https://tailscale.com/install.sh | sh`).
2. **Users and dirs**: `useradd -r -m -s /bin/bash openclaw`; `/opt/openclaw` owned `root:openclaw`
   with `chmod g+rX,o-rwx`; `/etc/openclaw/secrets` (root:root 0700); `/var/lib/openclaw`.
3. **Checkout and build** (mirror `deploy/desk/remote/roll-remote.sh`, which is the same steps a roll runs):
   ```bash
   git clone https://github.com/pulkitshah/openclaw.git /opt/openclaw
   cd /opt/openclaw && git checkout main
   corepack enable && corepack prepare "$(node -p "require('./package.json').packageManager")" --activate
   npm_config_minimum_release_age=0 npm_config_minimum_release_age_strict=false pnpm install --frozen-lockfile --ignore-scripts
   OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=4352 pnpm build
   chown -R root:openclaw /opt/openclaw && chmod -R g+rX,o-rwx /opt/openclaw
   ```
   Then Chromium for the Duties browser, as the template does: `cd /opt/openclaw && npx playwright
install-deps chromium` and `sudo -H -u openclaw bash -lc "cd /opt/openclaw && npx playwright install chromium"`.
   Also the policy files the template writes under `/etc/chromium/policies/managed/` and
   `/etc/opt/chrome/policies/managed/`, and `/etc/sysctl.d/60-openclaw-desk-chromium.conf`.
4. **Units**: copy `deploy/desk/units/openclaw-gateway.service`, `xvfb.service`, `desk-health.service`,
   `desk-health.timer` into `/etc/systemd/system/`, plus `deploy/desk/desk-health.sh` to
   `/opt/openclaw/deploy/desk/` (it is in the checkout already). The gateway unit expects
   `/etc/openclaw/secrets/gateway.env` (section 4) — create an empty one for now. `systemctl enable xvfb
desk-health.timer openclaw-gateway` but do **not** start the gateway until the state is in place.
5. **Tailscale**: `tailscale up --auth-key "$(cat /root/ts-authkey)" --hostname tripin-studio` then
   `shred -u /root/ts-authkey`. Note the tailnet IP (`tailscale ip -4`); the front door will proxy to it.
6. **gog** (Gmail CLI the Duties mail dispatcher uses): install the pinned version and arch the template
   names (`gog` section of `cloud-init.yaml.tmpl`; amd64 on the PC).

## 3. Extract Prabhat's state from the snapshot

The snapshot can only be restored to a droplet with a disk of at least 160 GB. On the operator's Mac:

```bash
doctl compute droplet create desk-restore --image 248986226 --size s-4vcpu-8gb --region blr1 \
  --ssh-keys 50131849,50131164 --wait --format ID,PublicIPv4
```

SSH in as root (`ssh root@<ip>`), stop its Gateway (`systemctl stop openclaw-gateway`) so the SQLite
files are quiet, then `sqlite3`-checkpoint or simply copy with the service stopped. What to take:

| Path on the restore droplet                                                                                                                                                      | Purpose                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `/home/openclaw/.openclaw/` (whole dir, ~1.2 GB: `openclaw.json`, `state/`, `agents/`, `workspace/`, `credentials/`, `plugins/`, `media/`, `browser/`)                           | the desk                                                                                    |
| `/home/openclaw/.claude/`, `/home/openclaw/.claude.json`                                                                                                                         | Claude sign-in (claude-cli backend)                                                         |
| `/home/openclaw/.gogcli/`                                                                                                                                                        | gog config, keyring, gmail-watch state                                                      |
| `/etc/openclaw/secrets/*` (`gateway.env`, `gateway-token`, `gateway-admin-password`, `gog-keyring-password`, `vnc-password`), `/etc/openclaw/keyfile`, `/etc/openclaw/vncpasswd` | secrets; `keyfile` MUST be byte-identical or `plugins/duties/creds.enc` cannot be decrypted |
| `/home/openclaw/.openclaw/workspace-duties-mail/` if present                                                                                                                     | dispatcher workspace                                                                        |

Copy droplet → PC over the tailnet with the service user's ownership preserved, e.g. from the PC:

```bash
rsync -a --rsync-path="sudo rsync" root@<restore-ip>:/home/openclaw/.openclaw/ /home/openclaw/.openclaw/
rsync -a root@<restore-ip>:/home/openclaw/.claude /home/openclaw/.claude.json /home/openclaw/.gogcli /home/openclaw/
ssh root@<restore-ip> 'tar -C / -cf - etc/openclaw' | tar -C / -xf -
chown -R openclaw:openclaw /home/openclaw; chmod 700 /home/openclaw/.openclaw; chmod 600 /etc/openclaw/secrets/*
```

Remove any stale lock the copy carries: `rm -rf /home/openclaw/.openclaw/tmp`. Then
`doctl compute droplet delete desk-restore --force` as soon as the copy is verified (`du -sh` both sides).
Do not snapshot the restore droplet; the original snapshot stays.

## 4. Config changes on the PC (`/home/openclaw/.openclaw/openclaw.json`)

Edit as `openclaw` (keep `.bak`). Use the rename script in section 5 for the agent rename; by hand:

- `gateway.bind`: the tailnet IP of the PC (so the front door can reach it); keep port 18789.
- Remove `gateway.tailscale` (no managed serve: the front door must come in through the ordinary
  trusted-proxy path — a managed-serve ingress rejects a chained proxy, see the design §4).
- `gateway.trustedProxies`: `["127.0.0.1", "<tailnet IP of vasudev-front-door>"]` — the front-door box
  must join the tailnet first (`tailscale up` there as root; it is not on it as of 2026-10-09).
- `gateway.auth.trustedProxy.allowUsers` and `gateway.identityScopes`: the TripIn Studio login email.
- `gateway.controlUi.allowedOrigins`: keep `https://vasudev.tripinstudio.com`.
- `plugins.entries.wallet`: this desk is the studio's own; set `config.rateCard.multiplier: 0` if it should
  not be billed, or leave the default to see list-price usage. `enforce` stays off.

`/etc/openclaw/secrets/gateway.env` keeps `GOG_HOME=/home/openclaw/.gogcli` and
`GOG_KEYRING_PASSWORD` (copied). The `CLAUDE_CODE_OAUTH_TOKEN` lines in it are ignored by the claude-cli
backend; the sign-in is the copied `~/.claude` directory. If `claude` reports it is logged out, run
`sudo -H -u openclaw claude auth login` once (interactive, prints a URL).

## 5. Rename Prabhat → TripIn Studio

Do this before starting the gateway, as `openclaw`, with the gateway stopped:

1. `openclaw.json`: `agents.entries.prabhat` → key `tripin-studio`, `name`/`identity.name` "TripIn Studio";
   `agents.defaults.authInheritance.agentId`, every `bindings[].agentId` → `tripin-studio`.
2. `mv agents/prabhat agents/tripin-studio` (the agent's own SQLite travels inside).
3. `workspace/IDENTITY.md`: rewrite for TripIn Studio (the brand voice is in
   `~/.claude/commands/my-brand.md` on the operator's Mac). `SOUL.md`/`AGENTS.md` have no Prabhat text.
   `memory/*` is the agent's past — leave it.
4. Cron jobs live in `state/openclaw.sqlite` (`cron_jobs`); after the gateway starts: `openclaw cron list`,
   then rename `heartbeat-prabhat` → `heartbeat-tripin-studio`, `skill-collection-review-prabhat` →
   `skill-collection-review-tripin-studio`, and set `agentId: tripin-studio` on every job (the `Daily cook
menu 5 PM` job is Prabhat's — disable it).
5. Duties: `openclaw gateway call duties.list`, then `duties.save` each with the new name ("Add cooker to
   Prabhat Foods" → "Add cooker"); run history is untouched.
6. Session keys `agent:prabhat:…` in the sessions table: leave them; the owner accepted that chats may
   start fresh after the move (design §6).

## 6. Start and verify on the PC

```bash
systemctl start xvfb && systemctl start openclaw-gateway
journalctl -u openclaw-gateway -f   # expect "http server listening (N plugins: … duties … wallet …)"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18789/healthz   # 200
sudo -H -u openclaw node /opt/openclaw/openclaw.mjs gateway call duties.list --params '{}' --json | head -c 400
sudo -H -u openclaw node /opt/openclaw/openclaw.mjs cron list
```

`systemctl show openclaw-gateway -p NRestarts` must stay 0. The desk-health timer writes
`/var/lib/openclaw/desk-health.json`; Xvfb `:99` must be up (`xdpyinfo -display :99`).

## 7. Front door route (on `vasudev-front-door`, as root)

1. `tailscale up --auth-key "$(cat /root/ts-authkey)" --hostname vasudev-front-door` (install Tailscale
   first); note its tailnet IP and put it in the PC's `gateway.trustedProxies` (section 4), then restart
   the PC's gateway.
2. `/etc/openclaw/front-door/users.json`: add `"<tripin login email>": {"hash": "<bcrypt cost 14>"}`;
   generate the hash with `node -e 'require("bcryptjs").hash(process.argv[1],14).then(console.log)' "$(cat /root/pw)"`
   from `/opt/vasudev-front-door` and `shred -u /root/pw`. Remove the Prabhat entry. The service re-reads
   the file per login; no restart.
3. `/etc/caddy/Caddyfile`: replace the retired `@prabhat … respond … 503` block with
   ```
   @tripin header X-Forwarded-User <tripin login email>
   reverse_proxy @tripin http://<PC tailnet IP>:18789 {
       header_up X-Forwarded-User {header.X-Forwarded-User}
   }
   ```
   Keep the final `respond … 403` catch-all. `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
   then `systemctl reload caddy`.
4. Sign in at https://vasudev.tripinstudio.com as the TripIn Studio login: the Control UI must open on the
   PC's desk (sidebar shows Duties, Team, Wallet). Run one Duty to a safe step and watch the Browser panel.

## 8. Rolling the PC desk later

`deploy/desk/roll.sh` assumes `ssh root@<name>` over the tailnet and the `roll-remote.sh` body; the PC
qualifies if root SSH is enabled inside WSL (`sshd` listening on the tailnet IP, key auth only) and the
Tailscale hostname is `tripin-studio`: `bash deploy/desk/roll.sh tripin-studio <full sha>`. The idle
check needs `duties.status`; everything else is the same as a droplet.

## 9. Cleanup checklist

- [ ] `desk-restore` droplet deleted (`doctl compute droplet list`)
- [ ] Prabhat login removed from `users.json`; TripIn login works
- [ ] dead tailnet node `vasudev-desk-1` removed in the Tailscale admin console
- [ ] `~/.claude/projects/-Users-pulkitshah-Developer-vasudev-openclaw/memory/office-pc-desk-migration.md`
      and `front-door-droplet.md` updated with the PC's tailnet IP and the date
- [ ] decide whether to keep snapshot `248986226` ($0.06/GB-month) once the PC has run a week

## 10. Give the desk the Windows desktop too (owner requirement)

**Status 2026-10-14: executed.** The Windows side runs the fork natively as a logon task and is paired as
the node "Office PC desktop" with `screen.snapshot` + `computer.act`. The first click-driven trial
surfaced three driver defects, fixed in fork commit `bdb36ca0a7b` and rolled to the desk and the node the
same night; the as-executed recipe below replaces the plan.

The owner wants the PC used "as it is": the desk must be able to see and operate the Windows desktop
(native Windows apps), not only its own WSL Chromium. That is OpenClaw's **node mode**: the Windows side
registers as a node with the Gateway inside WSL and offers `screen.snapshot` + `computer.act`, which the
agent uses through its built-in `computer` tool (`docs/nodes/computer-use.md`).

Everything below is driven from the operator's Mac through WSL interop: `ssh root@tripin-studio` then
`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command '...' </dev/null`.
That PowerShell runs as the desk's Windows account in the interactive session, so GUI apps it starts
appear on the PC's screen. Two traps: redirect its stdin from `/dev/null` (otherwise it swallows the
rest of a script piped over `ssh 'bash -s'`), and never `Stop-Process`/`pkill` by a pattern that can
match your own command line (it kills the SSH session).

1. **Build the fork on the Windows side** (not inside WSL). GitHub runs at ~100 KB/s from the PC, so
   the checkout is copied from the desk instead of cloned: `rsync -a /opt/openclaw/ /mnt/c/opt/openclaw/`
   (excluding `node_modules` and `dist`), then in PowerShell with the existing Node 24:
   ```powershell
   corepack enable --install-directory C:\opt\bin        # pnpm pinned by package.json
   cd C:\opt\openclaw; corepack prepare (node -p "require('./package.json').packageManager") --activate
   $env:npm_config_fetch_timeout = "900000"; $env:npm_config_minimum_release_age = "0"
   pnpm install --frozen-lockfile --ignore-scripts      # retry on ETIMEDOUT; the link is slow
   pnpm build
   ```
   Run long jobs with `Start-Process -WindowStyle Hidden` and log files under `C:\opt\` so an SSH drop
   does not kill them. `node C:\opt\openclaw\dist\index.js` is the CLI; no global install exists.
2. **Enable the Windows computer-use fulfiller** (`docs/nodes/computer-use.md` §"Windows and Linux"):
   ```powershell
   node C:\opt\openclaw\dist\index.js plugins enable cua-computer
   node C:\opt\openclaw\dist\index.js doctor --lint --only cua-computer/driver-artifacts   # no findings
   ```
3. **Give Windows a way in.** The Gateway only admits trusted-proxy identities, and its advertised join
   URL is the ts.net name, which Windows cannot reach (Tailscale lives inside the distro). The desk's
   Caddy therefore has a second, loopback-only listener `http://127.0.0.1:18790` that proxies to the
   Gateway and injects `X-Forwarded-User <owner email>` plus `X-Forwarded-For <PC tailnet IP>` (the
   client is loopback, which is itself the trusted proxy address, so the chain would otherwise be
   empty). **Tradeoff, accepted by the owner:** any process running under the PC's Windows account
   reaches the desk as the owner. Remove the listener block from `/etc/caddy/Caddyfile` to revoke.
4. **Pair and install the node.** On the desk mint a join code and fetch its payload through the
   loopback entrance (the payload's own URL is the unreachable ts.net name):
   ```bash
   sudo -H -u openclaw node /opt/openclaw/openclaw.mjs devices join-code --json   # code + payload url
   curl -s http://127.0.0.1:18790/j/<code> | base64 -w0 | tr '+/' '-_' | tr -d '='   # base64url payload
   ```
   Then on Windows, from the interactive session:
   ```powershell
   node C:\opt\openclaw\dist\index.js node run --pair <base64url payload> --host 127.0.0.1 --port 18790 --no-tls
   node C:\opt\openclaw\dist\index.js node install --host 127.0.0.1 --port 18790 --no-tls --display-name "Office PC desktop"
   ```
   `node install` creates the Scheduled Task "OpenClaw Node" (runs at logon of the desk's account, script
   `%USERPROFILE%\.openclaw\node.cmd`, logs in `%LOCALAPPDATA%\Temp\openclaw\openclaw-<date>.log`).
   The PC must stay signed in and unlocked while the desk is expected to drive the desktop.
5. **Approve the device and its command surface** inside WSL (two separate approvals):
   ```bash
   sudo -H -u openclaw node /opt/openclaw/openclaw.mjs devices list
   sudo -H -u openclaw node /opt/openclaw/openclaw.mjs devices approve <deviceRequestId>
   sudo -H -u openclaw node /opt/openclaw/openclaw.mjs nodes pending
   sudo -H -u openclaw node /opt/openclaw/openclaw.mjs nodes approve <nodeRequestId>
   sudo -H -u openclaw node /opt/openclaw/openclaw.mjs nodes status
   ```
6. **What the first trial taught (all fixed in `bdb36ca0a7b`, see `docs/nodes/computer-use.md`):**
   - every `computer` call failed with `COMPUTER_HOST_BUSY` roughly 30 s after the previous one: the
     Gateway's loopback tool cache rebuilt the tool with a new execution id and never closed the old
     one; the node now serves one execution per CLI run;
   - the Windows key cannot be injected by this driver at all; a bare `win` tap is delivered as
     `ctrl+escape` (opens Start) and `win+<key>` chords are refused;
   - Windows' foreground lock denied the driver's own window activation (`foreground_unavailable ...
     no mouse input was sent`); foreground delivery now raises the window with `bring_to_front` first,
     and when the shell itself holds the foreground (desktop/Start/taskbar) the raise is refused too,
     so the action goes through the background route and the result says `foregroundFallback`. The
     only host-side cure is per-user `ForegroundLockTimeout = 0` plus a sign-in; not applied (owner's
     call, see `docs/nodes/computer-use.md`);
   - clicks on Start/taskbar landed but were reported as errors; they now come back `unverifiable`.
   Proof after the roll (coordinator, 16 calls incl. a 48 s idle gap): no `COMPUTER_HOST_BUSY`; a
   bare `win` tap opened Start; Word's stuck privacy dialog was closed through the node (the raise was
   refused because explorer held the foreground, so the click went through the background route).
7. **Rolling the node later.** The node runs `dist\index.js` and bundled plugins run from
   `dist\extensions\<id>\index.js`, which import shared chunks from the parent `dist` by hashed file
   names, so `dist` is one build unit: after rolling the WSL desk (section 8) copy the **whole** built
   tree across (it is platform-neutral JavaScript; native code lives in `node_modules`), never a single
   plugin directory (the node then logs `cua-computer failed during load ... Cannot find module
   '../../media-runtime-<hash>.mjs'` and silently stops advertising `computer.act`). Exclude the
   per-plugin `node_modules` under `dist/extensions`: on the desk they are symlinks into the pnpm
   store, on Windows they are real directories the Windows build created. Then restart the
   task; `schtasks /end` does not kill the `node.exe` under the task's `cmd.exe`, so stop that process
   by id (match its command line, never a pattern that could match your own shell):
   ```bash
   rsync -a --delete --exclude 'extensions/*/node_modules' /opt/openclaw/dist/ /mnt/c/opt/openclaw/dist/
   powershell.exe -NoProfile -Command 'schtasks /end /tn "OpenClaw Node"; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*node run --host 127.0.0.1*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep 2; schtasks /run /tn "OpenClaw Node"' </dev/null
   ```
   Confirm with the node log (`advertised commands:` must list `computer.act` and `screen.snapshot`) and
   `nodes status` on the desk. The Windows source checkout is bookkeeping only; a fresh fetch there
   fails on CRLF-dirty files unless forced, and nothing runs from it. A rebuild on Windows is never
   needed for a roll. Restarting the task also clears any execution the node still holds for a Gateway
   that is gone.

Desktop control and the WSL desk are independent: if node mode is down, chat, Duties with the WSL
Chromium, mail and cron keep working; only desktop actions fail with a clear "no capable node" refusal.
Layers above this (companion overlay, Tally) start from here; Tally's own HTTP XML interface on port
9000 stays the preferred route for data.
