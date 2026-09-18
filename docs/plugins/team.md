---
summary: "The desk's owner/member roster: who may give the agent instructions, on which channels"
read_when:
  - You want to add, remove, or restrict who can instruct the agent
  - You are setting the desk's owner for the first time
  - "A Duty's `deliver` step targeting a Team member is failing and you need real member ids"
title: "Team plugin"
---

The bundled `team` plugin is the desk's only people list. It answers exactly one question — who may give the agent instructions — and it answers it identically on every channel. It never decides who the agent may talk to: it can still message any WhatsApp number, Telegram id, or other contact it's told to reach, Team member or not.

Team appears as its own tab in the Control UI, directly below Duties, and the agent reads it through the read-only `team_list` tool. Every write — adding someone, removing them, changing their channels, transferring ownership — is enforced server-side at `operator.admin`; there is no client-side version of that gate to bypass. Two kinds of caller clear it: an operator on the Team page, and Team's own `team_add`/`team_remove`/`team_transfer_ownership` tools, so a roster change can also be asked for in chat.

## The model

There are two roles, `owner` and `member`, and no separate contact tier. Nothing lands on the roster on its own: a row exists only because someone called `team.add` for it, from the Team page or through the agent's `team_add` tool. If a channel's `dmPolicy` is `"pairing"` and a stranger writes in, that produces an ordinary pairing request in that channel's own store — it never turns into a roster row by itself.

There is no per-member agent, workspace, or memory. Every member — the owner included — talks to the same coordinator agent: whichever agent already answers the owner's own channel. `session.dmScope: "per-peer"` on each member's own binding is what still gives them an isolated conversation with that one agent, without a dedicated agent of their own.

## The owner

On a brand-new desk, the Team page shows "Tell Vasu where to reach you" instead of a roster. Filling in a channel and a target there creates the owner row directly — Team owns this outright, with no dependency on any other plugin's settings.

Transferring ownership moves the reporting line, not the person: the outgoing owner keeps their row, their channel identities, their sessions, and their admission — only which member holds `owner` changes.

## Adding and removing members

Adding someone writes their roster row immediately — there is no agent to create, no naming ceremony, nothing to wait for. Their access starts the moment the row and the config projection it triggers both land.

Removing a member revokes their admission and delivery routing everywhere, on every channel, immediately.

A `deliver` step naming a person must name the channel too: `{ to: "team:<memberId>", channel: "whatsapp" }`. If that member has no identity on that channel, the step fails and says so — it never falls back to another channel or to the owner. `team_list` is how the agent reads real member ids and which channels each person has, rather than inventing one.

Team never changes a channel's `dmPolicy`. If a channel is left `open`, the roster isn't a restriction there, and the Team page says so.

Mail accounts are workspace inboxes, not people: a `TeamMember` has no email field, and having a message land in one of the [Gmail mailboxes a hosted desk watches](/hosted-desk#more-than-one-inbox) never by itself grants that sender permission to instruct the agent.

## The coordinator cannot approve a pairing directly

Admitting a new person is a roster decision, so it runs through the roster. The coordinator's own
tool funnel cannot call `channels.pairing.approve` or `channels.pairing.dismiss` — the Gateway
refuses both to it, as below.

One sanctioned route still ends in an approval, and that is deliberate. `team_add` takes a name and
the channel identities that person uses, and `team.add` approves a pending pairing request only when
its sender is one of the identities that call named; a pending request nobody named is left waiting.
The same call writes the roster row, so an admission made this way is always attached to a named
member and visible on the Team page, instead of standing alone in the pairing store. `team_add`
carries no separate owner confirmation — what the route guarantees is provenance, not a second pair
of eyes.

The boundary that makes the direct refusal hold is **Gateway scope enforcement**, not the exec layer:
an agent-originated Gateway request is refused `channels.pairing.approve` and
`channels.pairing.dismiss` at the router's authorization fence, ahead of the `operator.admin`
wildcard, so no scope set the agent can mint reaches them. `channels.pairing.list` stays available,
so the coordinator can still tell the owner who is waiting. A request from a real operator — the
Team page, the Control UI, the owner's own CLI — is unaffected, and so is a plugin's own call, which
is what leaves the `team_add` route above open.

Team also sets `tools.exec.denySelfCli: true` on the coordinator agent by default (once a
coordinator can be resolved), which makes exec deny the `vasudev`/`openclaw` binary as a target for
any subcommand, direct or buried inside another command, regardless of the agent's exec mode. Every
other exec command is unaffected, and an operator who explicitly sets `denySelfCli` to `true` or
`false` for that agent is never overridden. **That setting is defense-in-depth, not the boundary**:
it guards an executable name, while the capability behind it is reachable through the Gateway by any
client holding an operator-scoped credential.

Two known open gaps, stated plainly. First, `exec` has no read-path restrictions, so the coordinator
can read the Gateway auth token off disk and then talk to the loopback Gateway as a genuine operator,
which carries none of the agent-origin markers the fence checks. Second, the pairing store itself is
writable without any Gateway method: `exec` runs as the same OS user that owns the state directory, so
a direct SQLite write reaches the same outcome that `channels.pairing.approve` would. Both are
deliberately deferred — the second needs OS-level isolation. See
[Exec approvals](/tools/exec-approvals#tools-exec-denyselfcli) for the full mechanism, both residuals,
and the other documented `denySelfCli` gaps.

## Migrating from an earlier install

Before this plugin existed, the roster lived inside the `duties` plugin's own storage, with a dedicated agent, workspace and memory per member. On first activation, Team copies any such rows over automatically, dropping the per-member agent fields — everyone lands on the shared coordinator agent described above. The agents/workspaces that used to be dedicated to a member are not deleted; they simply stop being referenced by the roster projection. Nothing needs to be run by hand for this — it happens once, the first time this plugin starts on a desk that still has the old rows.
