---
summary: "Saved, replayable automations the agent authors from your instructions."
read_when:
  - You are installing, configuring, or auditing the duties plugin
title: "Duties plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

Saved, replayable automations the agent authors from your instructions.

## Distribution

- Package: `@openclaw/duties`
- Install route: included in Vasudev

## Surface

- Contracts: `tools`
- Skills

<!-- openclaw-plugin-reference:manual-start -->

## Team RPC surface

| Method                          | Scope            | Params                                                         |
| ------------------------------- | ---------------- | -------------------------------------------------------------- |
| `duties.team.get`               | `operator.read`  | —                                                              |
| `duties.team.add`               | `operator.admin` | `{ name, id?, channels: [{ channel, senderId, accountId? }] }` |
| `duties.team.setChannels`       | `operator.admin` | `{ memberId, channels }`                                       |
| `duties.team.remove`            | `operator.admin` | `{ memberId }`                                                 |
| `duties.team.transferOwnership` | `operator.admin` | `{ memberId }`                                                 |

The agent's own view of the roster is the `team_list` tool: read-only, returning each member's id, name, role, and which channels they have an identity on — never the sender ids themselves. There is deliberately no `team_add`, `team_remove`, or `team_transferOwnership` tool; those stay owner-only actions taken from the Control UI, not something the agent can do to itself or anyone else.

<!-- openclaw-plugin-reference:manual-end -->

## Related docs

- [duties](/plugins/duties)
