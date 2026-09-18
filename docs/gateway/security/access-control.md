---
summary: "Who can reach the agent: DM policy, allowlists, DM session isolation, context visibility, and command authorization"
read_when:
  - Deciding who can DM or trigger the bot
  - Isolating DM sessions for a shared or multi-user inbox
  - Limiting which supplemental context reaches the model
title: "Access control and allowlists"
sidebarTitle: "Access control"
---

## DM access: pairing, allowlist, open, disabled

Every DM-capable channel supports `dmPolicy` (or `*.dm.policy`), which gates inbound DMs before the message is processed:

| Policy      | Behavior                                                                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pairing`   | Default. Unknown senders get a pairing code; bot ignores them until approved. Codes expire after 1 hour; repeated DMs do not resend a code until a new request is created. Pending requests capped at 3 per channel. |
| `allowlist` | Unknown senders blocked, no pairing handshake.                                                                                                                                                                       |
| `open`      | Anyone can DM (public). Requires the channel allowlist to include `"*"` (explicit opt-in).                                                                                                                           |
| `disabled`  | Inbound DMs ignored entirely.                                                                                                                                                                                        |

```bash
openclaw pairing list <channel>
openclaw pairing approve <channel> <code>
```

Details + files on disk: [Pairing](/channels/pairing)

Prefer pairing + allowlists for DMs. For groups, decide by membership, not by channel type: a private room whose members you trust - your team, family, or friends - is a normal deployment for `groupPolicy: "open"` (any member can trigger the bot). Keep sender allowlists or mention gating on rooms where strangers can join or post, and treat `dmPolicy="open"` as a deliberate opt-in.

### Allowlists (two layers)

- **DM allowlist** (`allowFrom` / `channels.discord.allowFrom` / `channels.slack.allowFrom`; legacy: `channels.discord.dm.allowFrom`, `channels.slack.dm.allowFrom`): who can DM the bot. When `dmPolicy="pairing"`, approvals write to `~/.openclaw/credentials/<channel>-allowFrom.json` (default account) or `<channel>-<accountId>-allowFrom.json` (non-default accounts), merged with config allowlists.
- **Group allowlist** (channel-specific): which groups/channels/guilds the bot accepts at all.
  - `channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`: per-group defaults like `requireMention`; when set, also acts as a group allowlist (include `"*"` to keep allow-all behavior). Customize mention triggers with `agents.entries.*.groupChat.mentionPatterns` (for example `["@openclaw", "@mybot"]`) so `requireMention` gates on your own bot names.
  - `groupPolicy="allowlist"` + `groupAllowFrom`: restrict who can trigger the bot inside a group session (WhatsApp/Telegram/Signal/iMessage/Microsoft Teams).
  - `channels.discord.guilds` / `channels.slack.channels`: per-surface allowlists + mention defaults.
  - Check order: `groupPolicy`/group allowlists first, then mention/reply activation. Replying to a bot message (implicit mention) does **not** bypass `groupAllowFrom`.

Details: [Configuration](/gateway/configuration) and [Groups](/channels/groups)

### DM session isolation (multi-user mode)

By default, Vasudev routes all DMs into the main session for cross-device continuity. If multiple people can DM the bot (open DMs or a multi-person allowlist), isolate DM sessions:

```json5
{ session: { dmScope: "per-channel-peer" } }
```

`session.dmScope` values:

| Value                      | Scope                                                                  |
| -------------------------- | ---------------------------------------------------------------------- |
| `main` (config default)    | All DMs share one session.                                             |
| `per-channel-peer`         | Each channel+sender pair gets an isolated DM context (secure DM mode). |
| `per-account-channel-peer` | Like above, split further by account (multi-account channels).         |
| `per-peer`                 | Each sender gets one session across all channels of the same type.     |

Local CLI onboarding preserves an explicit `session.dmScope` and otherwise leaves it unset, so the `"main"` default applies: all direct messages across channels share the agent's rolling main session (the personal-agent default). For shared or multi-user inboxes, set `session.dmScope: "per-channel-peer"`; `openclaw security audit` recommends isolation when it detects multi-user DM traffic.

This is a messaging-context boundary, not a host-admin boundary. If users are mutually adversarial and share the same Gateway host/config, run separate gateways per trust boundary instead.

If the same person contacts you on multiple channels, use `session.identityLinks` to collapse those DM sessions into one canonical identity. See [Session Management](/concepts/session) and [Configuration](/gateway/configuration).

## Context visibility vs trigger authorization

Two separate concepts:

- **Trigger authorization**: who can trigger the agent (`dmPolicy`, `groupPolicy`, allowlists, mention gates).
- **Context visibility**: what supplemental context reaches the model (reply body, quoted text, thread history, forwarded metadata).

`contextVisibility` controls the second:

- `"all"` (default): supplemental context kept as received.
- `"allowlist"`: supplemental context filtered to senders allowed by active allowlist checks.
- `"allowlist_quote"`: like `allowlist`, but still keeps one explicit quoted reply.

Set per channel or per room/conversation - see [Groups](/channels/groups#context-visibility-and-allowlists). Reports that only show "model can see quoted/historical text from non-allowlisted senders" are hardening findings addressable with `contextVisibility`, not auth or sandbox bypasses by themselves; a security-impacting report still needs a demonstrated trust-boundary bypass.

## Command authorization

Slash commands and directives are honored only for authorized senders. Configure an explicit per-provider `commands.allowFrom` list, or let command authorization follow channel allowlists and pairing state. Access-group entries referenced by channel allowlists are resolved automatically; there is no opt-in toggle. If a channel allowlist is empty or includes `"*"`, commands are effectively open for that channel. See [Access groups](/channels/access-groups) and [Slash commands](/tools/slash-commands).

`/exec` is a session-only convenience for authorized operators - it does not write config or change other sessions.

## The agent cannot approve a pairing directly

Approving a channel pairing admits a new person to instruct the agent, so the agent's own tool funnel
does not get to do it. The Gateway refuses `channels.pairing.approve` and `channels.pairing.dismiss`
to any **agent-originated** request at its authorization fence, ahead of the `operator.admin`
wildcard, so no scope set the agent can present reaches them. `channels.pairing.list` stays
available, so the agent can still tell you who is waiting.

"Agent-originated" means either of two host-attested markers, never anything read from wire params:
a built-in agent tool dispatching in process, or a connection authenticated with a verified agent
runtime identity token (a worker or subagent). Requests from a real operator — the Control UI, the
Team page, your own CLI, an admin HTTP client — are unaffected.

A bundled plugin's own Gateway call is also not marked, and stays allowed: a plugin hard-codes which
method it calls and with which scopes, while the agent's dispatch mints whatever the method asks for.

One bundled plugin does use that: Team's `team.add` calls `channels.pairing.list` and then
`channels.pairing.approve` for a pending request whose sender the same call is adding to the roster.
The agent can start it through the `team_add` tool, so there is an agent-reachable route to an
approval, and it is the intended one — [Team](/plugins/team#the-coordinator-cannot-approve-a-pairing-directly)
describes it. What the route cannot produce is a bare approval: `team.add` only ever approves an
identity it is putting on the roster, a pending request nobody named is left waiting, and the roster
row lands with it, so the admitted person is named and auditable rather than anonymous. The fence
still holds for what it covers — no agent-originated request reaches either method.

Device and node pairing (`node.pair.approve`, `device.pair.approve`) are deliberately **not** covered.
They share the `operator.pairing` scope but attach hardware you already hold, and the `nodes` agent
tool approves them today. That is a separate decision from admitting a person.

### Known open gaps

Two routes are deliberately **not** closed this round. Both are stated here so the fence is not read
as an absolute guarantee.

**1. The agent can read the operator's credential.** The fence distinguishes origin, not credentials.
`exec` has no read-path restrictions, so an agent with a broad `security` setting can read
`gateway.auth.token` (or the file a `SecretRef` points at), and `OPENCLAW_GATEWAY_TOKEN` stays in its
environment. Presenting that token to the loopback Gateway produces an ordinary operator connection
carrying neither agent-origin marker, and the fence does not stop it. Locking down token readability
from the exec context is deferred and not implemented.

**2. The pairing store can be written without any Gateway method.** `openclaw pairing approve` on the
CLI does not go through the Gateway at all — it writes the shared pairing store directly. This is
broader than the CLI: the agent's `exec` runs as the same OS user that owns the state directory, so
any direct write to that SQLite file (a `sqlite3` invocation, a few lines of Node) reaches the same
outcome. Neither this fence nor `tools.exec.denySelfCli` touches that class. Closing it needs
OS-level isolation — running exec as a different, unprivileged user, or without the state directory
reachable — which is explicitly out of scope for this round.

If either matters on your deployment, narrow that agent's exec `security` and allowlists rather than
relying on the fence alone. See [Exec approvals](/tools/exec-approvals#tools-exec-denyselfcli).
