# Hosted desk — live proof (Task 6)

Goal, as extended by the owner: `vasudev-desk` is not a fresh demo desk but **a copy of the
proof setup running on the operator's Mac** — the same Duties, templates, brands, settings,
agents (`krishna`, `duties-mail`), workspace, run history, Telegram bot (`@SoCynicBot`) and
Gmail push account, moved to a DigitalOcean droplet in `blr1`.

Everything below is redacted: no Tailscale key, bot token, Gateway token, hook token, Gmail
push token, Amigos login, or OAuth token appears in this file or in any command output it
records. Secrets moved only as mode-600 files.

- Desk: `vasudev-desk`, droplet `600371144`, `s-2vcpu-4gb`, `ubuntu-24-04-x64`, `blr1`,
  tailnet `tail325f09.ts.net` (`100.79.76.6`), git ref `feat/hosted-desk`, owner target
  `5995225650`.
- Control UI (once the Gateway claims its Serve route): `https://vasudev-desk.tail325f09.ts.net`

## Status

**Phase A (migration bundle) is complete and independently verified.** **Phase B (apply on
the desk) is blocked** on two things outside this task's authority — see
[Blockers](#blockers-owner-actions).

## Timings — five create attempts

`deploy/desk/new-desk.sh vasudev-desk --ts-authkey-file <f> --tg-token-file <f>
--owner-target 5995225650 --git-ref feat/hosted-desk`

| # | Start | Droplet | Outcome | Fix |
| - | ----- | ------- | ------- | --- |
| 1 | 18:27:41 | 600360994 | Never joined the tailnet; `root` SSH impossible, so undiagnosable — the script's default `DESK_SSH_KEY_NAME` matched no DigitalOcean key for this Mac | `45c60d211f` — pick the doctl key by matching a local public key, no personal default |
| 2 | ~18:40 | 600365069 | cloud-init: `Failed loading yaml blob. unacceptable character #x0080` → `empty cloud config`; nothing in the template ran. The rendered user-data carried an em dash and `§` in comments and DigitalOcean's user-data path mangled the UTF-8 | `3085998470` — renderer refuses non-ASCII output, with a test |
| 3 | 18:47:10 | 600366210 | `users:` block without `default` dropped `root`'s SSH key; Tailscale also sat behind the heavy package installs | `8e47fea526` — keep the default user; join the tailnet before the heavy installs |
| 4 | 19:05:27 | 600370581 | SSH worked and the config ran, but `write_files` aborted on the `openclaw`-owned entries because the user did not exist yet — the Tailscale key, bot token, Gateway token and `openclaw.json` were never written | `343a3740a0` — `defer: true` on those entries; `6c6761a4dc` — time out `tailscale up` |
| 5 | ~19:05 | 600371144 | **Joined the tailnet 19:11:19 (≈6 min).** Gateway never answered `https://vasudev-desk.tail325f09.ts.net/healthz` within 1800 s → `new-desk.sh` exit 4 at 19:41:19 | see [Blockers](#blockers-owner-actions) |

Attempts 1–4 were deleted. Only `600371144` remains.

**Cost:** `s-2vcpu-4gb` in `blr1` is $24/month ≈ $0.0357/hour. Five droplets, each alive well
under an hour, plus one `desk-no-inbound` cloud firewall (free) — under $0.20 of droplet time
for the whole session. A standing desk is $24/month; `snapshot.sh` keeps at most 4 snapshots
(DigitalOcean snapshots bill at $0.06/GiB/month).

## Phase A — the migration bundle

Built in a mode-700 scratchpad directory (`desk-migration/`); every credential file inside is
mode 600 and is `shred -u`'d on the desk after use.

### 1. State (paths relative to the state dir)

Source: `~/.openclaw-duties/` with the local Gateway **stopped** and the WAL checkpointed.

```sh
sqlite3 ~/.openclaw-duties/state/openclaw.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"   # 0|0|0
sqlite3 ~/.openclaw-duties/state/openclaw.sqlite \
  "VACUUM INTO '<bundle>/openclaw.sqlite';"                                          # 0.8 s
tar --no-mac-metadata --no-xattrs -czf <bundle>/rest.tar.gz plugins agents workspace  # 10 MB
```

- `state/openclaw.sqlite` — 245 MB, shipped raw (`VACUUM INTO`, so consistent by
  construction). 280 `plugin_state_entries` (Duties, templates, brands, settings) and 840
  `plugin_blob_entries`; `dbstat` shows 238 MB of the 245 MB is `plugin_blob_entries`, i.e.
  past run screenshots and previews. Compression is pointless on that (PNG), hence raw.
- `plugins/duties/files/{runs,previews}` — 2.1 MB of run files.
- `agents/krishna`, `agents/duties-mail` — each agent's `openclaw-agent.sqlite`, WAL
  checkpointed, `-wal`/`-shm` dropped.
- `workspace/` — `AGENTS.md` (with the Duties repair rule), `USER.md`, `SOUL.md`,
  `IDENTITY.md`, `DREAMS.md`, `memory/`, `duties-mail/`, `drafts/`, `backups/`.
- Deliberately **not** copied: `browser/` (an 88 MB macOS Chrome profile is useless to Linux
  Chromium), `logs/`, `cache/`, `tmp/`, `media/`, `credentials/`, every `*.bak*`.

### 2. Config overlay — `merge-config.mjs`

`node merge-config.mjs <local openclaw.json> <the desk's rendered openclaw.json> <out>`.
It prints key names only, never values. Dry-run against the rendered template:

```
merged keys: agents, tools, commands, bindings, plugins, hooks, browser.ssrfPolicy,
             telemetry, wizard, meta, channels.telegram.groups
kept from desk: gateway, secrets, channels
```

- **Taken from the Mac:** `agents` (both entries, `ownership: explicit`, defaults incl. the
  `systemAgent: krishna` and the `anthropic/*` → `agentRuntime: claude-cli` model map),
  `tools`, `commands.ownerAllowFrom` (`telegram:5995225650`), `plugins.entries` (a superset of
  the template's three: `+anthropic, codex, duckduckgo`), `bindings`, the whole `hooks` block
  including `hooks.token` and `hooks.gmail` (account `pulkit.works@gmail.com`, topic,
  subscription, `pushToken`, funnel path `/gmail-pubsub`) — those two values are secrets and
  are carried inside the file, never printed — plus `browser.ssrfPolicy`, and
  `telemetry`/`wizard`/`meta` so the desk does not re-run onboarding.
- **Kept from the desk:** `gateway` (`bind: loopback`, `tailscale.mode: serve`, auth token as a
  file SecretRef), `secrets.providers`, and `channels.telegram.botToken` / `dmPolicy` /
  `allowFrom`. Only `channels.telegram.groups` (`requireMention`) moves across.
- **Path rewriting:** every `/Users/pulkitshah/.openclaw-duties` string anywhere in a taken
  value becomes `/home/openclaw/.openclaw`, verified by asserting the merged JSON contains no
  `/Users/pulkitshah` substring. This covers `agents.defaults.workspace`,
  `agents.entries.*.workspace` and `agents.entries.krishna.agentDir`.
- `hooks.gmail.hookUrl` is dropped: the Mac's value is a loopback URL on the Mac's Gateway
  port. The desk's own Gmail setup rewrites it.

**The same bot, not a second one.** The Task 6 brief assumed a *new* BotFather bot; the owner
chose to move the live one. Verified without printing either value — the SHA-256 of
`channels.telegram.botToken` in the Mac's config equals the SHA-256 of the desk's
`--tg-token-file` contents, so `/etc/openclaw/secrets/telegram-bot-token` on the desk is
`@SoCynicBot`. Safe because the Mac's Gateway is stopped; two Gateways must never poll it.

### 3. Duty logins (Amigos)

macOS stores Duties credentials **hex-encoded** (`extensions/duties/src/creds.ts` `credSet`
writes `Buffer.from(value,"utf8").toString("hex")` via `security -i`, and `credGet` refuses a
value that is not even-length hex). A naive `security … -w > file` therefore ships hex text,
which the Linux store would encrypt verbatim and hand to the browser as the wrong password.

```sh
security find-generic-password -s openclaw-duties.amigos.username -w   # hex text
security find-generic-password -s openclaw-duties.amigos.password -w   # hex text
```

Both were read straight into mode-600 files, hex-decoded in-process, and written to one
mode-600 `creds/amigos.json`; the intermediate files were removed. Decode check printed only
shape: `amigos.username: decoded 26 chars, ascii=true`, `amigos.password: decoded 12 chars,
ascii=true`.

On the desk they go into the AES-256-GCM store at
`/home/openclaw/.openclaw/plugins/duties/creds.enc`, keyed by `/etc/openclaw/keyfile`, by
calling the plugin's own owner (`createLinuxCredStore` from
`extensions/duties/src/creds-linux.ts`) as the `openclaw` user while the Gateway is stopped.

Why not `duties.cred.set`: the only way to reach it from a shell is
`openclaw gateway call duties.cred.set --params '<json>'`, and `--params` is the sole params
input (`src/cli/gateway-cli/register.ts:497`) — there is no `--params-file`, so the password
would sit in the process's `argv`. Using the same module the Gateway method itself uses avoids
that and needs no running Gateway. `duties.cred.list` / `duties.cred.has` verify afterwards
without revealing values.

### 4. Gmail push (`gog`) — an export/import path exists, no re-login needed

`gog auth --help` has a `tokens` subcommand group with **`export <email> --out <file>`** and
**`import <inPath>`**, which is exactly the move this needs.

```sh
gog auth tokens export pulkit.works@gmail.com --out <bundle>/gog/refresh-token.json --overwrite
# WARNING: exported file contains OAuth tokens (keep it safe and delete it when done)
# exported true / email pulkit.works@gmail.com / client default
```

The export carries `refresh_token`, `access_token`, scopes and subject — but **not** the OAuth
client secret, which `gog auth status` reports as `client_secret_in_keyring true` and which
lives in the macOS keychain under service `gogcli`, account `client/default/client-secret`.
`~/Library/Application Support/gogcli/credentials.json` holds only `client_id`. So the client
was reassembled into a standard installed-app credentials JSON (mode 600) from that
`client_id` plus the keychain secret (35 chars, i.e. a `GOCSPX-` Desktop client).

This whole path was **proved end to end on the Mac** in an isolated `GOG_HOME`, which is the
same sequence the desk will run:

```sh
export GOG_HOME=<bundle>/gog-test GOG_KEYRING_PASSWORD=<generated, mode 600>
gog auth keyring file
gog auth credentials set <bundle>/gog/client-credentials.json --no-input
gog auth tokens import <bundle>/gog/refresh-token.json
gog auth doctor -p
```

```
ok     keyring.backend      file (source: config)
ok     keyring.password     GOG_KEYRING_PASSWORD is set
hint   keyring.password     keep this value identical across shell, service, and agent configs
ok     keyring.open         opened
ok     tokens               1 readable OAuth token of 1 stored token account
ok     credentials.default  OAuth client credentials available
status ok
```

So **no `gog auth add` device flow on the desk, and no owner OAuth re-login.** Two
consequences the runbook does not cover yet:

- The `file` keyring backend **requires `GOG_KEYRING_PASSWORD`**; without it every write fails
  with `no TTY available for keyring file backend password prompt`. The Gateway spawns
  `gog gmail watch start` / `serve` itself (`src/hooks/gmail-watcher.ts`), so it needs the same
  value. `apply-on-desk.sh` writes `/etc/openclaw/secrets/gateway.env` (`root:openclaw`, 0640)
  with `GOG_HOME` and `GOG_KEYRING_PASSWORD`, to be picked up by a systemd drop-in
  (`EnvironmentFile=-/etc/openclaw/secrets/gateway.env`) — `roll.sh` never rewrites units, so a
  drop-in survives rolls.
- `gog` is **not installed by cloud-init**, and on Linux `ensureDependency` cannot install it
  (`src/hooks/gmail-setup-utils.ts:154` — outside macOS it just throws `gog not installed`).
  `desk-prereqs.sh` installs `gogcli 0.40.0` from the release tarball the Homebrew tap uses:
  `https://github.com/openclaw/gogcli/releases/download/v0.40.0/gogcli_0.40.0_linux_amd64.tar.gz`
  → `/usr/local/bin/gog`, which is on systemd's default `PATH`.

### 5. Bundle contents

| File | Mode | What |
| ---- | ---- | ---- |
| `openclaw.sqlite` | 600 | the shared DB (`VACUUM INTO`) |
| `rest.tar.gz` | 600 | `plugins/ agents/ workspace/`, relative to the state dir |
| `openclaw.json` | 600 | produced by `merge-config.mjs` against the desk's rendered config |
| `creds/amigos.json` | 600 | decoded Duty logins; shredded on the desk |
| `gog/refresh-token.json`, `gog/client-credentials.json`, `gog/keyring-password` | 600 | shredded on the desk |
| `desk-prereqs.sh` | 700 | `tailscale set --operator=openclaw`, install `gog` |
| `apply-on-desk.sh` | 700 | stop-gated unpack, config, creds, gog, ownership/modes |
| `merge-config.mjs` | 600 | the overlay |

`apply-on-desk.sh` refuses to run while `openclaw-gateway` is active — the runbook's "never
hot-edit a running desk's config" rule is enforced, not just documented. It keeps the desk's
rendered config at `openclaw.json.desk-template`, then `chown -R openclaw:openclaw` and
`chmod 700`/`600` across the whole state dir.

## Blockers (owner actions)

### B1. `ssh root@vasudev-desk` cannot be reached non-interactively

Every SSH attempt stalls after `SSH2_MSG_SERVICE_ACCEPT`, and verbose output shows why:

```
# Tailscale SSH requires an additional check.
# To authenticate, visit: https://login.tailscale.com/a/<redacted>
```

The desk runs `tailscale up --ssh`, so `tailscaled` intercepts port 22 for tailnet peers and
shadows the host `sshd`; the tailnet's SSH rule for this identity is `action: "check"`, which
demands a browser click. The DigitalOcean key is irrelevant here — key auth never gets
offered. The public IP is unreachable by design (`desk-no-inbound` allows no inbound), so
there is no second route.

The runbook currently claims the opposite — *"without such a grant, Tailscale SSH has no
matching local user to log in as and the plain `ssh root@<desk-name>` route above still works
regardless"* (`deploy/desk/README.md`). With a `check` rule that is wrong, and it makes a desk
un-automatable. Either the rule needs to be `accept` for the operator on desk nodes, or the
runbook must say a one-time browser check is required per node per `checkPeriod`.

One of these unblocks Phase B:

1. In the Tailscale admin console, make the SSH rule `"action": "accept"` (rather than
   `"check"`) for this identity → `root` on desk nodes. Durable, and what automation needs.
2. Run `ssh root@vasudev-desk` once in an interactive terminal and open the printed
   `https://login.tailscale.com/a/…` URL. Lasts for the ACL's `checkPeriod` (12 h by default).
3. Temporarily allow inbound TCP 22 from this Mac's public IP on the `desk-no-inbound`
   firewall, then `ssh -i ~/.ssh/id_ed25519 root@165.22.219.58`.

Stale host keys were a separate, already-fixed red herring: `100.79.76.6` had been reused by
three deleted droplets, so `ssh` said `Host key verification failed`. Cleared with
`ssh-keygen -R vasudev-desk`, `-R 100.79.76.6`, `-R vasudev-desk.tail325f09.ts.net`.

### B2. The Gateway on the desk almost certainly cannot claim its Serve route

Attempt 5 joined the tailnet and then never answered `/healthz` for 30 minutes; port 443 on
`vasudev-desk.tail325f09.ts.net` refuses the connection outright, i.e. no Serve route exists
at all. `src/infra/tailscale.ts:390-410` explains that:

```ts
claim = await start(tailscaleBin);        // tailscale serve status --json  → access denied
…
claim = await start("sudo", ["-n", …]);   // openclaw has no sudoers entry, shell /usr/sbin/nologin
…
throw new Error(`Tailscale ${mode} needs elevated access and non-interactive sudo failed: …` +
  "Run `sudo tailscale set --operator=$USER` once so the unprivileged path succeeds.");
```

`deploy/desk/cloud-init.yaml.tmpl` runs `tailscale up --ssh` as `root` and never sets an
operator, while `openclaw-gateway.service` runs `User=openclaw`. The same gap breaks the Gmail
push Funnel, which `src/hooks/gmail-watcher.ts` claims through the identical helper.

The fix is one line in `runcmd`, right after `tailscale up`:

```yaml
- tailscale set --operator=openclaw
```

`desk-prereqs.sh` applies it on the existing desk once SSH works, so `600371144` can be
recovered with a `systemctl restart openclaw-gateway` rather than a sixth droplet. It was
**not** committed to `deploy/desk/` here because another worker holds uncommitted changes in
that file.

This is a hypothesis supported by code reading and by 443 being closed — it is not yet
confirmed against the desk's journal, because of B1. `journalctl -u openclaw-gateway` will
confirm or refute it in seconds once SSH is available. The alternative explanation is simply
that `pnpm install` + `pnpm build` + the Playwright Chromium download + a reboot had not
finished inside 30 minutes on 2 vCPU, in which case `DESK_READY_POLL_SECONDS` wants raising
and the operator line is still needed before the Gateway's first Serve attempt succeeds.

### B3. Claude sign-in on the desk

The proof setup's agents run on the owner's Claude subscription through the `claude-cli`
runtime: the Mac's config maps every `anthropic/*` model to `agentRuntime: { id: "claude-cli" }`
and holds **no API key**. `extensions/anthropic/cli-constants.ts` is explicit that auth belongs
to the installed CLI — *"Non-secret marker telling OpenClaw that the installed Claude CLI owns
auth"*, with `ANTHROPIC_API_KEY` and every `CLAUDE_CODE_OAUTH_*` variable stripped before each
run, and Claude's own config directory deliberately inherited because "it owns the selected
native login".

So the model map is carried across unchanged (the desk is a copy, and the desk template
specifies no provider at all), and the desk needs the CLI plus one interactive login. No API
key and no OAuth token were copied. Owner step:

```sh
ssh root@vasudev-desk
npm install -g @anthropic-ai/claude-code
sudo -H -u openclaw claude setup-token        # or: sudo -H -u openclaw claude  → /login
systemctl restart openclaw-gateway
```

Until that is done, any Duty step that calls `llm-task` — the Duties AI adapter goes through
`tools.invoke` → `llm-task` (`extensions/duties/src/adapters/ai.ts`) — has no model to run on,
so the `amigos-search` and `book-flight-by-mail` proof runs cannot be attempted.

### B4. `gcloud` for the Pub/Sub repoint

`openclaw webhooks gmail setup` calls `ensureDependency("gcloud", …)` and `ensureGcloudAuth()`
(`src/hooks/gmail-ops.ts:81,87`), and `ensureGcloudAuth` falls back to an interactive
`gcloud auth login`. `gcloud` is not installed by cloud-init and a desk login is interactive,
so running the command verbatim on the desk will stop there.

A non-interactive equivalent exists, because the Mac's `gcloud` is already authenticated
(`pulkit.sub@gmail.com`) and the topic and subscription already exist. The subscription's push
endpoint today is `https://pulkits-macbook-pro.tail325f09.ts.net/gmail-pubsub?token=<redacted>`.
Everything else the desk does for itself: the Gateway's own watcher calls
`ensureTailscaleEndpoint` (Funnel) and `gog gmail watch start`/`serve`
(`src/hooks/gmail-watcher.ts:343,369`). So the repoint is one Mac-side command:

```sh
gcloud pubsub subscriptions update gog-gmail-watch-push \
  --project tripin-studio-2026 \
  --push-endpoint="https://vasudev-desk.tail325f09.ts.net/gmail-pubsub?token=<pushToken from the desk config>"
```

The `pushToken` is unchanged by the migration, so the desk accepts the same pushes the Mac
did. Funnel itself needs no admin change: Funnel is already enabled on this tailnet (the Mac
serves `https://pulkits-macbook-pro.tail325f09.ts.net` over Funnel today), though the
`vasudev-desk` node still needs its own `funnel` attribute in the policy file if the tailnet
grants Funnel per node rather than tailnet-wide.

## Phase B — the sequence, ready to run

```sh
# 0. one of the B1 unblocks, then:
ssh root@vasudev-desk 'journalctl -u openclaw-gateway -u cloud-init-output --no-pager | tail -100'

# 1. prereqs (operator + gog) and stop the Gateway before touching its config
scp desk-prereqs.sh apply-on-desk.sh root@vasudev-desk:/root/
ssh root@vasudev-desk 'systemctl stop openclaw-gateway && bash /root/desk-prereqs.sh'

# 2. merge the desk's rendered config with the proof config, on the Mac
ssh root@vasudev-desk 'cat /home/openclaw/.openclaw/openclaw.json' > <bundle>/desk-rendered.json
node <bundle>/merge-config.mjs ~/.openclaw-duties/openclaw.json \
  <bundle>/desk-rendered.json <bundle>/openclaw.json

# 3. ship the bundle (secrets only via file pipes, never argv)
ssh root@vasudev-desk 'install -d -m 700 /root/desk-migration /root/desk-migration/{creds,gog}'
scp <bundle>/{openclaw.sqlite,rest.tar.gz,openclaw.json} root@vasudev-desk:/root/desk-migration/
ssh root@vasudev-desk 'cat > /root/desk-migration/creds/amigos.json' < <bundle>/creds/amigos.json
ssh root@vasudev-desk 'cat > /root/desk-migration/gog/refresh-token.json'      < <bundle>/gog/refresh-token.json
ssh root@vasudev-desk 'cat > /root/desk-migration/gog/client-credentials.json' < <bundle>/gog/client-credentials.json
ssh root@vasudev-desk 'cat > /root/desk-migration/gog/keyring-password'        < <bundle>/gog/keyring-password

# 4. apply, add the env drop-in, start
ssh root@vasudev-desk 'bash /root/desk-migration/apply-on-desk.sh'
ssh root@vasudev-desk 'install -d /etc/systemd/system/openclaw-gateway.service.d && \
  printf "[Service]\nEnvironmentFile=-/etc/openclaw/secrets/gateway.env\n" \
    > /etc/systemd/system/openclaw-gateway.service.d/desk-proof.conf && \
  systemctl daemon-reload && systemctl start openclaw-gateway'
curl -fsS https://vasudev-desk.tail325f09.ts.net/healthz

# 5. verify the copy landed (no values printed)
ssh root@vasudev-desk 'cd /opt/openclaw && sudo -u openclaw node openclaw.mjs gateway call duties.desk.status --json'
ssh root@vasudev-desk 'cd /opt/openclaw && sudo -u openclaw node openclaw.mjs gateway call duties.list --json'
ssh root@vasudev-desk 'cd /opt/openclaw && sudo -u openclaw node openclaw.mjs gateway call duties.cred.list --json'
ssh root@vasudev-desk 'cd /opt/openclaw && sudo -u openclaw node openclaw.mjs channels status'

# 6. mail: B4's Mac-side repoint, then
ssh root@vasudev-desk 'cd /opt/openclaw && sudo -u openclaw node openclaw.mjs duties setup'
ssh root@vasudev-desk 'cd /opt/openclaw && sudo -u openclaw node openclaw.mjs gateway call duties.mail.status --json'

# 7. proof runs (needs B3), then the update and snapshot paths
deploy/desk/roll.sh vasudev-desk --git-ref feat/hosted-desk
deploy/desk/snapshot.sh vasudev-desk
```

`duties.desk.status`'s `chromium` chip reads `pgrep -u openclaw -f "chrom(e|ium)"`
(`deploy/desk/desk-health.sh`), so it is `false` unless a Duty run has a browser open — "all
green" is only meaningful while a run is live, or the chip needs redefining.

The `book-flight-by-mail` run from a test mail stays the **owner's** action, as briefed: after
B3 and B4, the owner sends a mail matching the Duty to `pulkit.works@gmail.com`, and the
Hold? card should arrive on Telegram from `@SoCynicBot` — now served by the desk, not the Mac.

## Defects found

| # | Defect | State |
| - | ------ | ----- |
| 1 | `new-desk.sh` default SSH key name matched no local key; README carried a personal key name | fixed `45c60d211f` (another worker) |
| 2 | Rendered cloud-init was non-ASCII → DigitalOcean mangled it → `empty cloud config` | fixed `3085998470` |
| 3 | `users:` without `default` dropped `root`'s SSH key | fixed `8e47fea526` |
| 4 | `write_files` for `openclaw`-owned paths ran before the user existed | fixed `343a3740a0`, `6c6761a4dc` |
| 5 | cloud-init never runs `tailscale set --operator=openclaw`, so the `User=openclaw` Gateway cannot claim Serve or the Gmail Funnel | **open** — one line in `runcmd`; not committed here because another worker holds that file |
| 6 | cloud-init never installs `gog`, and `ensureDependency` cannot install it off macOS, so the mail watcher refuses to start | **open** — `desk-prereqs.sh` has the tarball install |
| 7 | The `file` keyring backend needs `GOG_KEYRING_PASSWORD` in the Gateway's environment; the unit has no `EnvironmentFile` | **open** — drop-in + `/etc/openclaw/secrets/gateway.env` |
| 8 | cloud-init never installs the Claude Code CLI, which `claude-cli` agents require | **open** — owner login needed anyway (B3) |
| 9 | README claims plain `ssh root@<desk>` "works regardless" of tailnet SSH rules; a `check` rule blocks it entirely | **open** — doc fix + policy guidance |
| 10 | `duties.desk.status`'s `chromium` chip can only be green during a browser run, so "all chips green" is unreachable at idle | **open** — chip semantics |
