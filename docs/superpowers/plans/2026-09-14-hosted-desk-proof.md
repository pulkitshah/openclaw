# Hosted desk — live proof (Task 6)

Goal, as extended by the owner: `vasudev-desk` is not a fresh demo desk but **a copy of the
proof setup that was running on the operator's Mac** — the same Duties, templates, brand,
settings, agents (`krishna`, `duties-mail`), workspace, run history, approvals, Telegram bot
(`@SoCynicBot`) and Gmail push account, moved to a DigitalOcean droplet in `blr1`.

Everything below is redacted: no Tailscale key, bot token, Gateway token, hook token, Gmail
push token, Amigos login, or OAuth token appears in this file or in any output it records.
Secrets moved only as mode-600 files, piped over `ssh 'cat > file'`, never through `argv`.

- Desk: droplet `600383557`, `s-4vcpu-8gb`, `ubuntu-24-04-x64`, `blr1`; machine hostname
  `vasudev-desk`, **tailnet name `vasudev-desk-1`** (a stale node from an earlier attempt still
  holds `vasudev-desk`), `tail325f09.ts.net`. Git ref `feat/hosted-desk`, owner target
  `5995225650`.
- Control UI: **https://vasudev-desk-1.tail325f09.ts.net** — `/healthz` answers `200` over the
  tailnet.

## Status

**The copy is done and the desk is serving it.** Two parallel `amigos-search` runs both
completed `ok` on the desk, driving a real headed Chromium and logging into Amigos with the
migrated credentials. `roll.sh` and `snapshot.sh` both proved out.

Outstanding, both owner actions: **Claude sign-in** (needed for agent replies and for
`book-flight-by-mail`'s LLM steps) and a **Gmail push decision** (the Funnel collides with the
Gateway's Serve route on port 443).

## Timings

### Create — five attempts before one stuck

`deploy/desk/new-desk.sh vasudev-desk …` (run by the coordinator, not by this task):

| # | Droplet | Outcome | Fix |
| - | ------- | ------- | --- |
| 1 | 600360994 | Never joined the tailnet; `root` SSH impossible, so undiagnosable — the script's default `DESK_SSH_KEY_NAME` matched no DigitalOcean key for this Mac | `45c60d211f` — match the doctl key against a local public key; no personal default |
| 2 | 600365069 | cloud-init: `Failed loading yaml blob. unacceptable character #x0080` → `empty cloud config`; nothing ran. The rendered user-data carried an em dash and `§` in comments and DigitalOcean's user-data path mangled the UTF-8 | `3085998470` — renderer refuses non-ASCII, with a test |
| 3 | 600366210 | `users:` without `default` dropped `root`'s SSH key; Tailscale also sat behind the heavy package installs | `8e47fea526` |
| 4 | 600370581 | SSH worked and the config ran, but `write_files` aborted on the `openclaw`-owned entries because the user did not exist yet — the Tailscale key, bot token, Gateway token and `openclaw.json` were never written | `343a3740a0` (`defer: true`), `6c6761a4dc` (time out `tailscale up`) |
| 5 | 600371144 | Joined the tailnet in ≈6 min, but the Gateway never answered `/healthz` in 1800 s → `new-desk.sh` exit 4 | superseded |
| 6 | **600383557** | **Up.** `s-4vcpu-8gb`, Serve route live, healthz 200 | — |

### Phase B — the copy

| Step | Wall clock | Note |
| ---- | ---------- | ---- |
| `gog` install + prereq checks | 22:50 → 22:51 | `claude` 2.1.270 was already installed |
| `media.tar` build | 22:51 | 247 MB, 893 entries, uncompressed (861 JPEGs) |
| Stop Gateway, stage bundle dir | 22:52 | 147 GB free on `/` |
| `scp openclaw.sqlite` (245 MB) | 22:52:40 → 22:58:21 | 5 m 42 s, ≈0.72 MB/s to blr1 |
| `scp media.tar` (247 MB) | 22:58:27 → 23:03:09 | 4 m 42 s |
| secret files via `ssh 'cat >'` | 23:03 | four mode-600 files |
| `apply-on-desk.sh` | 23:04:22 → 23:04:57 | 35 s, after two fixes below |
| Gateway start + healthz | 23:05:06 → 23:05:58 | 52 s cold start, 22 plugins |
| `/tmp` repair + restart | 23:11:30 → 23:12:01 | see defect 7 |
| `roll.sh vasudev-desk-1 feat/hosted-desk` | 23:14:45 → 23:32:15 | **17 m 30 s**, ended `rolled to feat/hosted-desk and is healthy`, OpenClaw 2026.9.4 (12c94b1) |
| `snapshot.sh vasudev-desk` | 23:33:17 → 23:35:25 | **2 m 08 s**, `desk-vasudev-desk-20260914180320`, snapshot `3407055615` |
| 2 × `amigos-search` in parallel | 23:39:43 → 23:40:31 | both `ok`, 26/26 steps, ≈45 s each |

**Cost.** `s-4vcpu-8gb` in `blr1` is $48/month ≈ $0.0714/hour; the five discarded `s-2vcpu-4gb`
droplets were $24/month ≈ $0.0357/hour and each lived well under an hour. Total droplet spend
for the session is under $0.50. One snapshot of a 154 GB disk with ~8 GB used bills at
$0.06/GiB/month on the used size (well under $1/month); `snapshot.sh` keeps at most 4. The
`desk-no-inbound` cloud firewall is free. A standing desk at this size is **$48/month**.

## What the copy moved

Source: `~/.openclaw-duties/` on the Mac, Gateway stopped, WAL checkpointed.

```sh
sqlite3 ~/.openclaw-duties/state/openclaw.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"   # 0|0|0
sqlite3 ~/.openclaw-duties/state/openclaw.sqlite "VACUUM INTO '<bundle>/openclaw.sqlite';"
tar --no-mac-metadata --no-xattrs -czf <bundle>/rest.tar.gz plugins agents workspace   # 10 MB
tar --no-mac-metadata --no-xattrs -cf  <bundle>/media.tar media                        # 247 MB
```

- `state/openclaw.sqlite` — 245 MB via `VACUUM INTO` (consistent by construction). 280
  `plugin_state_entries` and 840 `plugin_blob_entries`; `dbstat` attributes 238 MB of the 245 MB
  to `plugin_blob_entries`, i.e. past run screenshots and previews.
- `plugins/duties/files/{runs,previews}`, `agents/krishna`, `agents/duties-mail` (each agent
  DB WAL-checkpointed, `-wal`/`-shm` dropped), `workspace/` (`AGENTS.md` with the Duties repair
  rule, `USER.md`, `SOUL.md`, `IDENTITY.md`, `DREAMS.md`, `memory/`, `duties-mail/`, `drafts/`).
- `media/` — 893 entries (861 JPEGs, 24 PDFs) carried at the owner's request so attachments
  referenced by copied sessions resolve on the desk.
- Deliberately not copied: `browser/` (an 88 MB macOS Chrome profile is useless to Linux
  Chromium), `logs/`, `cache/`, `tmp/`, `credentials/`, every `*.bak*`.

All three large artefacts were verified by digest after transfer — `sha256sum` on the desk
matched `shasum -a 256` on the Mac for `openclaw.sqlite`, `media.tar` and `rest.tar.gz`.

### Config overlay — `merge-config.mjs`

```
merged keys: agents, tools, commands, bindings, plugins, hooks, browser.ssrfPolicy,
             telemetry, wizard, meta, channels.telegram.groups
kept from desk: gateway, secrets, channels
```

Verified on the merged output, values never printed:

```
gateway.mode: local | bind: loopback | tailscale: {"mode":"serve"}
gateway.auth.token is file SecretRef: true
hooks.token === LOCAL hooks.token: true
hooks.gmail.pushToken === LOCAL: true
hooks.gmail.hookUrl present: false
telegram.botToken is file SecretRef: true
agents: krishna, duties-mail | ownership: explicit
krishna.workspace: /home/openclaw/.openclaw/workspace
krishna.agentDir: /home/openclaw/.openclaw/agents/krishna/agent
models->claude-cli: true
commands.ownerAllowFrom: ["telegram:5995225650"]
plugins: anthropic, codex, duckduckgo, duties, telegram, llm-task
mac path leak: false
```

The desk keeps `gateway` (including the coordinator's `mode: local` patch), `secrets.providers`
and `channels.telegram.botToken`/`dmPolicy`/`allowFrom`; only `channels.telegram.groups`
(`requireMention`) moves across. `hooks.token` and `hooks.gmail.pushToken` are taken from the
**Mac's** config so the existing Pub/Sub push token keeps matching. Every
`/Users/pulkitshah/.openclaw-duties` path is rewritten to `/home/openclaw/.openclaw`, asserted
by checking the merged JSON contains no `/Users/pulkitshah` substring. The Mac's loopback
`hooks.gmail.hookUrl` is dropped.

**Same bot, not a second one.** The Task 6 brief assumed a *new* BotFather bot; the owner chose
to move the live one. Verified without printing either value: the SHA-256 of
`channels.telegram.botToken` in the Mac's config equals the SHA-256 of the desk's
`--tg-token-file` contents. Safe only because the Mac's Gateway is stopped.

### Duty logins (Amigos)

macOS stores Duties credentials **hex-encoded** — `extensions/duties/src/creds.ts` `credSet`
writes `Buffer.from(value,"utf8").toString("hex")` through `security -i`, and `credGet` refuses
a value that is not even-length hex. A naive `security … -w > file` therefore ships hex text,
which the Linux store would encrypt verbatim and hand to the browser as the wrong password.
Both values were read into mode-600 files, hex-decoded in process (`amigos.username: decoded 26
chars, ascii=true`; `amigos.password: decoded 12 chars, ascii=true`) and written to one
mode-600 `creds/amigos.json`, with the intermediates removed.

On the desk they went into the AES-256-GCM store at
`/home/openclaw/.openclaw/plugins/duties/creds.enc` (114 bytes, `0600 openclaw:openclaw`),
keyed by `/etc/openclaw/keyfile` (`0640 root:openclaw`), through the plugin's own owner
`createLinuxCredStore` (`extensions/duties/src/creds-linux.ts`) as the `openclaw` user with the
Gateway stopped.

Not via `openclaw gateway call duties.cred.set --params '<json>'`: `--params` is the only params
input (`src/cli/gateway-cli/register.ts:497`), so the password would sit in the process's
`argv`. Using the same module the Gateway method itself uses avoids that and needs no running
Gateway.

`duties.cred.set` also writes an index (`store.recordCredKey`) that the Logins page reads, which
a direct store write skips — and the Mac's DB turned out to have **no `creds` namespace at all**,
so its own `duties.cred.list` was empty too (the logins predate that code path). After the copy
both keys were re-set through the canonical gateway method, reading each value back out of the
desk-local encrypted store so it never left the desk:

```
{"keys":["amigos.password","amigos.username"],
 "updatedAt":{"amigos.password":1789407570933,"amigos.username":1789407568581}}
```

### Gmail push (`gog`) — no owner re-login needed

`gog auth tokens export <email> --out <file>` / `gog auth tokens import <file>` is the move.
The export carries `refresh_token`, `access_token`, scopes and subject, but **not** the OAuth
client secret — `gog auth status` reports `client_secret_in_keyring true`, and
`~/Library/Application Support/gogcli/credentials.json` holds only `client_id`. The client was
reassembled into an installed-app credentials JSON from that `client_id` plus the macOS keychain
item `gogcli` / `client/default/client-secret` (35 chars, a `GOCSPX-` Desktop client).

Proved end to end on the Mac first, in an isolated `GOG_HOME`, then run identically on the desk:

```
ok     keyring.backend      file (source: config)
ok     keyring.password     GOG_KEYRING_PASSWORD is set
ok     keyring.open         opened
ok     tokens               1 readable OAuth token of 1 stored token account
ok     credentials.default  OAuth client credentials available
status ok
```

The `file` keyring backend **requires `GOG_KEYRING_PASSWORD`** — without it every write fails
with `no TTY available for keyring file backend password prompt`. The Gateway spawns
`gog gmail watch start`/`serve` itself (`src/hooks/gmail-watcher.ts`), so it needs the same
value: `apply-on-desk.sh` writes `/etc/openclaw/secrets/gateway.env` (`root:openclaw`, 0640)
with `GOG_HOME` and `GOG_KEYRING_PASSWORD`, supplied by a systemd drop-in
`/etc/systemd/system/openclaw-gateway.service.d/desk-proof.conf`
(`EnvironmentFile=-/etc/openclaw/secrets/gateway.env`). `roll.sh` never rewrites units, so the
drop-in survived the roll.

## Proof

### The desk reports itself healthy

```
$ duties.desk.status
{"hosted":true,"gateway":true,"display":true,"chromium":true,"tailscale":true,
 "mailWatcher":false,"load1":1.29,"memFreeMb":6100,"maxParallelRuns":4,"active":2,"queued":0}
```

Every chip green except `mailWatcher` (the Funnel conflict below). `chromium` reads
`pgrep -u openclaw -f "chrom(e|ium)"` (`deploy/desk/desk-health.sh`), so it is only true while a
run has a browser open — captured above with 19 Chromium processes live during the parallel
runs. At idle it is `false` by design, so "all chips green" is unreachable without a live run.

### The copied Duties, templates, brand, settings and history are all there

```
duties (5):  amigos-search steps=27 | amigos-search-x steps=27 | ask-probe steps=1
             book-flight-by-mail steps=80 | package-quotation steps=8
templates (2): flight-options, package-quotation
brand: Amigos Alliance (#0B3C5D / #F28C28, sales@amigosalliance.com)
settings: owner = telegram:5995225650
          lastMailDispatchDutyId = book-flight-by-mail, lastDispatchAt = 1789378288519
runs.recent: … package-quotation failed 2026-09-14T11:00:54Z, 10:37:56Z   ← the Mac's history
approvals:  duties-mail /opt/homebrew/bin/gog "19h ago"                   ← the Mac's approval
```

`openclaw duties setup --account pulkit.works@gmail.com` confirms the whole wiring:

```
Already in place:
  hooks enabled: yes
  Gmail account configured: yes
  hook mapping to duties-mail: yes
  agent entry duties-mail: yes
  rendering allowed (browser.ssrfPolicy.allowedHostnames): yes
Desk:
  credential keyfile present (/etc/openclaw/keyfile): yes
  display up (DISPLAY + xdpyinfo): yes
```

Its one actionable command was run: `openclaw approvals allowlist add --agent duties-mail
/usr/local/bin/gog` (the Linux path alongside the Mac's Homebrew one).

```
$ duties.mail.status
{"hooksEnabled":true,"gmailAccountSet":true,"mappingPresent":true,"agentPresent":true,
 "lastDispatchAt":1789378288519,"lastDispatchDutyId":"book-flight-by-mail","renderAllowed":true}
```

### Telegram: the bot now answers from the desk

```
[telegram] [default] starting provider (@SoCynicBot)
[telegram] Inbound message telegram:5995225650 -> @SoCynicBot (direct, 8 chars)
$ openclaw channels status
- Telegram default: enabled, configured, running, connected, out:1m ago,
  transport:just now, mode:polling, token:***
```

Nothing was sent to the owner from here. The owner's own DM reached **the desk**, which is the
proof the bot moved; the reply then failed on the one remaining blocker:

```
[diagnostic] lane task error: lane=session:agent:krishna:main error="Not logged in · Please run /login"
[model-fallback/decision] requested=anthropic/claude-opus-5 reason=auth detail=Not logged in · Please run /login
Embedded agent failed before reply: Not logged in · Please run /login
```

### Two parallel `amigos-search` runs — both ok

```
run1=610b39d7-a1cf-4bdd-a791-d18d2b25792c queued=false
run2=55ef0968-bdd1-4c97-887f-76a163f8cf89 queued=false
t+0s   run1=running/0   run2=running/2
t+10s  run1=running/7   run2=running/11
t+20s  run1=running/16  run2=running/21
t+30s  run1=running/25  run2=ok/26
t+40s  run1=ok/26       run2=ok/26
chips: {"chromium":true,"display":true,"gateway":true,"tailscale":true,"load1":1.29}
```

`queued=false` on both means each got a slot immediately rather than serialising — real
parallelism under `maxParallelRuns: 4`. `amigos-search` has no inputs and only `browser`,
`browser.evaluate` and `when` steps, so it needs no model — which is why this proof was possible
before the Claude sign-in. A run's outputs: `onDashboard, flightFormReady, fromIsDelhi,
toIsMumbai, travellersClass, directOnly, directOnlyAfter`.

**The migrated Amigos credentials work.** From the step log of the first attempt's pair:

```
open-dashboard    [ok] https://amigosalliance.co.in/Home/Dashboard
read-signed-in    [ok] "no"
open-login-panel  [ok] button "Login"
fill-username     [ok] textbox "User Name" ← ••••••
fill-password     [ok] textbox "Password" ← ••••••
click-sign-in     [ok] button "Sign-in"
confirm-signed-in [ok] waited
```

That first pair was 1 ok / 1 failed — the failure was `open-flight-search: Error: browser
request timed out` at step 9, after a clean login, i.e. one slow navigation rather than a
parallelism fault. The retried pair was 2 ok / 2, recorded above.

### Update and snapshot paths

```
$ deploy/desk/roll.sh vasudev-desk-1 feat/hosted-desk
OpenClaw 2026.9.4 (12c94b1)
Desk "vasudev-desk-1" rolled to feat/hosted-desk and is healthy.          # 17 m 30 s

$ deploy/desk/snapshot.sh vasudev-desk
==> Snapshotting droplet 600383557 as "desk-vasudev-desk-20260914180320"
3407055615  completed  snapshot  …  blr1
==> Nothing to prune
Snapshot "desk-vasudev-desk-20260914180320" created.                      # 2 m 08 s
```

The brief's `roll.sh … --git-ref <ref>` is wrong: `--git-ref` is `new-desk.sh`'s flag; `roll.sh`
takes the ref positionally (`roll.sh <desk-name> [<git-ref>]`). After the roll the whole copy
was re-verified intact: healthz 200, `/tmp` still `1777 root:root`, `duties.cred.list` both
keys, `duties.mail.status` unchanged, all 5 Duties with their step counts, Telegram restarted as
`@SoCynicBot`.

## Owner actions outstanding

### 1. Sign Claude in on the desk

The proof agents run on the owner's Claude subscription through the `claude-cli` runtime: the
config maps every `anthropic/*` model to `agentRuntime: { id: "claude-cli" }` and holds no API
key. `extensions/anthropic/cli-constants.ts` is explicit that auth belongs to the installed CLI
— *"Non-secret marker telling OpenClaw that the installed Claude CLI owns auth"*, with
`ANTHROPIC_API_KEY` and every `CLAUDE_CODE_OAUTH_*` variable stripped per run and Claude's own
config directory deliberately inherited because "it owns the selected native login". No key or
token was copied.

`claude` 2.1.270 is installed at `/usr/bin/claude`, but there is no `/home/openclaw/.claude`:

```sh
$ sudo -H -u openclaw claude -p "reply with the single word OK"
Not logged in · Please run /login
```

```sh
ssh root@vasudev-desk-1
sudo -H -u openclaw claude setup-token        # or: sudo -H -u openclaw claude  → /login
systemctl restart openclaw-gateway
```

Until then: Telegram messages to `@SoCynicBot` reach the desk but get no reply, and
`book-flight-by-mail` cannot run (its LLM steps go through `tools.invoke` → `llm-task`,
`extensions/duties/src/adapters/ai.ts`). `amigos-search` is unaffected.

### 2. Decide how Gmail push reaches the desk

The Gmail watcher cannot claim its Funnel:

```
[gmail-watcher] tailscale setup failed: Error: tailscale funnel failed (code=1, termination=exit)
  stderr: sending serve config: updating config: foreground listener already exists for port 443
[hooks] gmail watcher not started: …
```

The Gateway claims its Serve route as a **foreground** listener on 443
(`src/infra/tailscale.ts` — `[bin, mode, "--yes", "--bg=false", target]`, and *"Foreground claims
require a free port"*), which owns the whole 443 listener; `tailscale serve status` as root
prints `No serve config` because the route is held by the process, not persisted. A background
Funnel path on the same port therefore cannot be added. The runbook's claim that *"Funnel is
scoped to the hook route; the Control UI stays tailnet-only via Serve"* is not achievable in
this configuration.

Tailscale is otherwise ready: `OperatorUser: openclaw` is set (so the unprivileged `tailscale
serve`/`funnel` path works) and the node carries the `funnel` and
`funnel-ports?ports=443,8443,10000` capabilities — **no admin-console change is needed**.

This was **not** resolved here because every fix changes the desk's public exposure, and
`src/gateway/server-tailscale.ts` is explicit that mixing Funnel with a token-auth Gateway is a
security-posture change wanting password auth first — *"external Tailscale Funnel for port 443
remains active only for plugin-authenticated webhook routes; Gateway-authenticated routes reject
its unattributable ingress… First configure a durable gateway password… then set
gateway.tailscale.mode funnel"*. Options, for the owner to pick:

0. **Put the Funnel on a different port.** The node's capability string is
   `funnel-ports?ports=443,8443,10000`, so a Funnel on **8443** avoids the 443 foreground
   listener entirely and leaves the Control UI tailnet-only on 443 — no Serve/Funnel conflict and
   no exposure change to the Gateway. The one thing to confirm before relying on it is whether
   Pub/Sub accepts a push endpoint on a non-default port: `PushConfig.push_endpoint` is
   documented only as "a URL locating the endpoint", with no port guidance either way, so this is
   unverified here. It is a cheap empirical check — `gcloud pubsub subscriptions update …`
   with `--push-endpoint="https://vasudev-desk-1.tail325f09.ts.net:8443/gmail-pubsub?token=<pushToken>"`
   either takes it or rejects it immediately. (A worker was setting this route up as this run
   finished; the desk state recorded above predates it.)
1. Move the Control UI to a **background** Serve route and add the Funnel path beside it:
   set `gateway.port` explicitly (it is currently the default 18789, and an unpinned port would
   break a persisted route), `gateway.tailscale.mode: "off"`, then as root
   `tailscale serve --bg --set-path / 18789` and
   `tailscale funnel --bg --set-path /gmail-pubsub 8788`. Needs confirming that Tailscale scopes
   Funnel per path and not per port — if it is per port, this publishes the Control UI too.
2. Follow `server-tailscale.ts`'s own migration: configure `gateway.auth.password`, set
   `gateway.auth.mode: password` and `gateway.tailscale.mode: funnel`.
3. Keep mail on the Mac for now (its Gateway would have to run again, and only one Gateway may
   poll `@SoCynicBot`).

Once an endpoint exists, the Pub/Sub repoint is one **Mac-side** command — the desk has no
`gcloud` and `openclaw webhooks gmail setup` demands it:

```sh
$ sudo -H -u openclaw node openclaw.mjs webhooks gmail setup \
    --account pulkit.works@gmail.com --tailscale funnel
gcloud not installed; install it and retry                                    # exit 1
```

The Mac's `gcloud` is authenticated (`pulkit.sub@gmail.com`) and the topic and subscription
already exist; the endpoint today is
`https://pulkits-macbook-pro.tail325f09.ts.net/gmail-pubsub?token=<redacted>`:

```sh
gcloud pubsub subscriptions update gog-gmail-watch-push --project tripin-studio-2026 \
  --push-endpoint="https://vasudev-desk-1.tail325f09.ts.net/gmail-pubsub?token=<pushToken>"
```

`pushToken` is unchanged by the migration, so the desk accepts the same pushes the Mac did.

### 3. Send the `book-flight-by-mail` test mail

The owner's action, after 1 and 2: a mail to `pulkit.works@gmail.com` matching the Duty. The
Hold? card should arrive on Telegram from `@SoCynicBot`, now served by the desk. The Duty, its
80 steps, the `duties-mail` agent, the hook mapping and `lastMailDispatchDutyId` are all in
place on the desk already.

## Defects found

| # | Defect | State |
| - | ------ | ----- |
| 1 | `new-desk.sh` default SSH key name matched no local key; README carried a personal key name | fixed `45c60d211f` |
| 2 | Rendered cloud-init was non-ASCII → DigitalOcean mangled it → `empty cloud config` | fixed `3085998470` |
| 3 | `users:` without `default` dropped `root`'s SSH key | fixed `8e47fea526` |
| 4 | `write_files` for `openclaw`-owned paths ran before the user existed | fixed `343a3740a0`, `6c6761a4dc` |
| 5 | cloud-init does not install `gog`, and `ensureDependency` cannot install it off macOS (`src/hooks/gmail-setup-utils.ts:154` just throws `gog not installed`), so the mail watcher refuses to start | **open** — installed by hand from the release tarball |
| 6 | The `gog` `file` keyring needs `GOG_KEYRING_PASSWORD` in the Gateway's environment; the unit has no `EnvironmentFile` | **open** — worked around with `/etc/openclaw/secrets/gateway.env` + a systemd drop-in |
| 7 | **`tar -C /tmp -xzf` as root resets `/tmp`.** The gogcli release tarball contains a `./` entry whose owner/mode are applied to the extraction directory, so `/tmp` went from `1777 root:root` to `0755 501:staff`. That silently broke everything needing a writable `/tmp`: the browser plugin (`setup-entry-load-failed … mkdtemp '/tmp/openclaw-plugin-build-XXXXXX'`), `claude` (`EACCES: mkdir '/tmp/claude-999'`) and plugin cleanup | **caused here, fixed here** — `chown root:root /tmp && chmod 1777 /tmp`; the install command must extract into a private `mktemp -d`, never `/tmp` itself |
| 8 | **Chromium cannot sandbox on Ubuntu 24.04.** `kernel.apparmor_restrict_unprivileged_userns=1` is the distro default, so every browser step died at `open-dashboard` with `FATAL … No usable sandbox!` and `Failed to start Chrome CDP on port 18800`. cloud-init installs Chromium but never addresses it | **open in the template, fixed on the desk** — `/etc/sysctl.d/60-openclaw-desk-chromium.conf` sets `kernel.apparmor_restrict_unprivileged_userns = 0`, which restores Chromium's *own* sandbox and is strictly safer than the `browser.noSandbox: true` that OpenClaw's error hint suggests |
| 9 | Gateway foreground Serve on 443 blocks the Gmail Funnel; the runbook claims they coexist | **open** — owner decision, above |
| 10 | `sudo -u openclaw` keeps `/root` as CWD, and esbuild's child spawn fails with `EACCES` when the CWD is unreadable — surfacing as a bogus `TransformError: The service is no longer running` from `--import scripts/tsx.mjs`. Same class of trap: files handed to the service user under `/root` (0700) are unreadable | **worked around** — `apply-on-desk.sh` does `cd /opt/openclaw` and stages every secret file into a directory the service user owns, shredding it after |
| 11 | `roll.sh` restarts the Gateway mid-roll before ownership is restored, producing a transient `[skills] Skipping invalid skill … EACCES … duties/skills/SKILL.md`. Self-heals on the final restart | **open**, cosmetic |
| 12 | `duties.desk.status`'s `chromium` chip can only be true while a run holds a browser, so "all chips green" is unreachable at idle | **open** — chip semantics |
| 13 | `openclaw gateway call` has a 10 s default transport timeout, so `duties.run.wait` on a longer run returns `gateway timeout after 10000ms` while the run is still fine. `--timeout 60000` is needed | **open**, usability |
| 14 | The brief's `roll.sh … --git-ref <ref>` is not a real flag (`--git-ref` belongs to `new-desk.sh`); `roll.sh` takes the ref positionally | doc-level |

## Reproducing the copy

The bundle and both scripts are in the scratchpad `desk-migration/`. The sequence, with secrets
only ever moving as mode-600 files:

```sh
ssh root@vasudev-desk-1 'systemctl stop openclaw-gateway'
ssh root@vasudev-desk-1 'cat /home/openclaw/.openclaw/openclaw.json' > <bundle>/desk-rendered.json
node <bundle>/merge-config.mjs ~/.openclaw-duties/openclaw.json \
  <bundle>/desk-rendered.json <bundle>/openclaw.json
ssh root@vasudev-desk-1 'install -d -m 700 /root/desk-migration /root/desk-migration/{creds,gog}'
scp <bundle>/{rest.tar.gz,media.tar,openclaw.json,apply-on-desk.sh} root@vasudev-desk-1:/root/desk-migration/
scp <bundle>/stage/state/openclaw.sqlite root@vasudev-desk-1:/root/desk-migration/openclaw.sqlite
for f in creds/amigos.json gog/refresh-token.json gog/client-credentials.json gog/keyring-password; do
  ssh root@vasudev-desk-1 "umask 177; cat > /root/desk-migration/$f" < "<bundle>/$f"
done
ssh root@vasudev-desk-1 'bash /root/desk-migration/apply-on-desk.sh'
ssh root@vasudev-desk-1 'install -d /etc/systemd/system/openclaw-gateway.service.d && \
  printf "[Service]\nEnvironmentFile=-/etc/openclaw/secrets/gateway.env\n" \
    > /etc/systemd/system/openclaw-gateway.service.d/desk-proof.conf && \
  systemctl daemon-reload && systemctl start openclaw-gateway'
```

`apply-on-desk.sh` refuses to run while `openclaw-gateway` is active, so the runbook's "never
hot-edit a running desk's config" rule is enforced rather than merely documented. It keeps the
rendered template at `openclaw.json.desk-template`, sets `openclaw:openclaw` with 700/600 across
the state dir, and shreds every secret file it consumed.
