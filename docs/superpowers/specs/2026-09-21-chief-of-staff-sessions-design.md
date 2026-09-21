# Chief-of-staff sessions — design

One operator-facing agent per desk, one session per person, specialists reached by delegation.
Written 2026-09-21 from the Amigos desk (`vasudev-amigos`), where every constraint below was
observed rather than assumed.

## Problem

A desk accumulates sessions that have nothing to do with the people using it. On Amigos the
sidebar showed three workspace groups and eight `Job ID: …` rows — one per incoming email —
against a roster of two people.

Sessions come from four places today:

| Source         | Key                                                                              | Count                |
| -------------- | -------------------------------------------------------------------------------- | -------------------- |
| Team member DM | `agent:<id>:direct:<peer>` (`src/routing/session-key.ts:245`)                    | one per person ✅    |
| Control UI     | `agent:<id>:dashboard:<uuid>` (`src/gateway/session-create-service.ts:238-244`)  | one per conversation |
| IMAP mail      | `hook:imap:<account>:<uidValidity>:<uid>` (`extensions/imap/src/watcher.ts:354`) | **one per email**    |
| Gmail hook     | `hook:gmail:<messageId>` (`src/gateway/hooks-mapping.ts:160-161`)                | one per email        |

Only the first is what an operator expects. The mail rows dominate.

## Requirements

From the owner, 2026-09-21:

1. Every team member gets their own session.
2. A reply from that person on any channel lands in the same session.
3. A Duty run triggered by mail runs in the **owner's** session unless told otherwise.
4. Everything lands in one of those sessions — the session count matches the roster.
5. Approval questions go to WhatsApp first, falling back to the next available channel.
6. Target architecture: a **chief of staff** receives everything and delegates to specialists
   (a flight-ticket agent that books tickets is planned).
7. Capabilities stay **open** for now; restriction is a later, deliberate step.

Requirements 1 and 2 already work once `dmScope: "per-peer"` is set — `identityLinks` collapse a
person's channels onto one key, proven by `extensions/team/src/team.test.ts:566`. Requirement 3
already works: `extensions/duties/src/adapters/deliver.ts:197` sends a non-chat origin's ask to
the owner's own session. Requirement 5 shipped as `e19d87eafc`.

## Constraints

These are load-bearing. Each was learned the expensive way.

**The Amigos portal allows one session.** Two concurrent booking runs log each other out
mid-booking. Serialisation is therefore a _requirement_, not a cost — and it rules out the
parallel-specialist shape a chief-of-staff architecture would otherwise invite. Enforced
2026-09-21 by `duties.settings.maxParallelRuns: 1`, which is desk-wide and so also covers a
second browser-driving Duty added later; `exclusive` on a single Duty would not.

**Adding an agent forks its workspace as well as its sessions.** With no explicit `workspace`,
the runtime derives one per agent. Adding `duties-mail` silently moved `main` from
`.openclaw/workspace` to `.openclaw/workspace-main`, stranding the `IDENTITY.md` the naming
ritual had written; the agent ran for four hours with a blank identity. Any design that adds an
agent must pin its workspace.

**Pending questions are in-memory.** `src/gateway/question-manager.ts:109` is a `Map`; nothing is
persisted. A Gateway restart loses every approval a Duty is parked on.

**WhatsApp cannot edit or delete a sent message.** Its question finalizer only flips a local flag
(`src/plugin-sdk/question-gateway-runtime.ts:80-87`); Telegram really edits
(`extensions/telegram/src/question-finalization.ts:22-33`). A question fanned to both and answered
on Telegram would leave a live, tappable WhatsApp card for good. This is why asks use an ordered
fallback, not fan-out.

**The IMAP session key doubles as the idempotency key** (`extensions/imap/src/watcher.ts:354-366`).
Collapsing sessions separates them, so the change must keep dedupe keyed on the mail.

## Design

```
Azhar  ──┐
Anuj   ──┼──▶  chief of staff (main / "Vasu")  ──delegates──▶  duties, flight booking, …
mail   ──┘       one session per person                         no conversation of their own
```

**One operator-facing agent.** `main` is the chief of staff. It holds every channel binding and
receives mail. With `dmScope: "per-peer"` the session count equals the roster automatically —
the earlier tension between "one session per member" and "several agents" dissolves, because the
count follows the _operator-facing_ agent, not the agent total.

**Specialists do not own conversations.** They are invoked and report back into the person's
session. `duty_run` with typed inputs is already this shape and is the model to follow.

**Mail lands in the owner's session.** A client who mails `ticketing@` is not a team member; for
the POC the Duty's own register gate decides what to do about the sender, so mail does not need a
session of its own.

**Serialised by design.** One session per person plus `maxParallelRuns: 1` means mail queues
behind mail, which matches the portal.

### Changes

1. **IMAP `sessionKey`** → resolve the owner's session (`resolveAgentRoute` with the owner's
   channel/peer, as the Duty ask path already does) instead of `hook:imap:${key}`.
2. **IMAP `idempotencyKey`** → stays derived from `key` (`<account>:<uidValidity>:<uid>`). Dedupe
   does not weaken: the message-id ring and the durable per-uid claim
   (`watcher.ts:340-352`) both key off `key`, which does not move.
3. **`account.agentId`** → the chief of staff.
4. **Retire `duties-mail`** — move its instructions (loop guard, gog reply path, escalation) into
   the chief of staff's `AGENTS.md`; drop the agent, its workspace and the bindings added for it.
   **Keep `dmScope: "per-peer"`** on the remaining bindings.

### Non-goals

- **Restricting tools.** Deferred by explicit decision (requirement 7). The structure is built so
  that tightening later is a config edit, not a re-architecture.
- **Fan-out of replies or asks.** Rejected: WhatsApp cannot settle a stale card. Superseded by the
  WhatsApp-first ordered fallback already shipped.
- **Persisting questions.** Out of scope; the restart consequence is documented instead.

## Proof

- One session per member: a message from the same person on WhatsApp and on Telegram resolves to
  one `agent:main:direct:<person>` key. Covered by `team.test.ts:566`; verify live on the desk.
- Dedupe survives: the same mail delivered twice dispatches once, with `sessionKey` no longer
  equal to `idempotencyKey`. Needs a watcher test.
- Serialisation: two runs started together — one from chat, one from mail — execute one after the
  other rather than concurrently.
- Identity: the chief of staff reports its configured name after the change, not a blank template.

## Open questions

- Whether a specialist can run without creating a listed session, or whether "no conversation of
  their own" is achieved purely by routing its output into the person's session.
- What the Control UI's per-conversation `dashboard:<uuid>` sessions should do — they are the
  other source of sidebar growth and this design does not address them.
- Whether the sidebar's "Claude Code" catalog heading should be renamed or hidden; it is a
  branding leak through the `anthropic` plugin, unrelated to routing.
