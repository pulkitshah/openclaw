---
summary: "Reusable sender allowlists for message channels"
read_when:
  - Configuring the same allowlist across multiple message channels
  - Sharing DM and group sender access rules
  - Reviewing message-channel access control
title: "Access groups"
---

Access groups are named sender lists you define once under `accessGroups` and reference from channel allowlists with `accessGroup:<name>`.

Use them when the same people should be allowed across several message channels, or when one trusted set should apply to both DMs and group sender authorization.

A group grants nothing by itself. It only matters where an allowlist field references it.

## Static message sender groups

Static sender groups use `type: "message.senders"`. `members` is keyed by message-channel id, plus `"*"` for entries shared by every channel:

```json5
{
  accessGroups: {
    operators: {
      type: "message.senders",
      members: {
        "*": ["global-owner-id"],
        discord: ["discord:123456789012345678"],
        telegram: ["987654321"],
        whatsapp: ["+15551234567"],
      },
    },
  },
}
```

| Key                        | Meaning                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `"*"`                      | Shared entries checked for every message channel that references the group. |
| `discord`, `telegram`, ... | Entries checked for that channel's allowlist matching, on every account.    |
| `telegram:work`            | Entries checked only for the `work` account of that channel.                |

Add `:<accountId>` to a channel key to scope its entries to one channel account. On a
multi-account channel a bare channel key authorizes the sender on **every** account, so use the
scoped form when a person should only reach one of them:

```json5
{
  accessGroups: {
    contractors: {
      type: "message.senders",
      // Reaches the "work" Telegram account only, not "personal".
      members: { "telegram:work": ["987654321"] },
    },
  },
}
```

Both forms can appear in the same group, and the wider ones still apply: a channel account's
effective entries are `"*"` plus `<channel>` plus `<channel>:<accountId>`.

Entries are matched with the destination channel's normal `allowFrom` rules. Vasudev does not translate sender ids between channels: if Alice has a Telegram id and a Discord id, list both ids under the matching channel keys.

The Duties plugin's Team roster is one maintained consumer of this mechanism: adding, removing, or re-channeling a Team member keeps `accessGroups.team` and each touched channel's `accessGroup:team` allowlist entry in sync for you. It merges its entry into whatever else that channel's `allowFrom` already lists rather than replacing the list, and it removes that entry again from a channel the roster no longer touches. A member identity that names a channel account is written under the scoped `<channel>:<accountId>` key, so it authorizes on that account only. Team never writes `dmPolicy` — a channel's open-or-restricted setting is left exactly as configured — and it refuses the write outright rather than narrowing a channel it cannot safely add itself to.

## Reference groups from allowlists

Reference a group with `accessGroup:<name>` anywhere the message channel path supports sender allowlists.

DM allowlist example:

```json5
{
  accessGroups: {
    operators: {
      type: "message.senders",
      members: {
        discord: ["discord:123456789012345678"],
        telegram: ["987654321"],
      },
    },
  },
  channels: {
    discord: {
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:operators"],
    },
    telegram: {
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:operators"],
    },
  },
}
```

Group sender allowlist example:

```json5
{
  accessGroups: {
    oncall: {
      type: "message.senders",
      members: {
        whatsapp: ["+15551234567"],
        googlechat: ["users/1234567890"],
      },
    },
  },
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["accessGroup:oncall"],
    },
    googlechat: {
      groups: {
        "spaces/AAA": {
          users: ["accessGroup:oncall"],
        },
      },
    },
  },
}
```

You can mix groups and direct entries:

```json5
{
  channels: {
    discord: {
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:operators", "discord:123456789012345678"],
    },
  },
}
```

## Supported message-channel paths

Access groups work in the shared message-channel authorization paths:

- DM sender allowlists such as `channels.<channel>.allowFrom`
- group sender allowlists such as `channels.<channel>.groupAllowFrom`
- channel-specific per-room sender allowlists that use the same sender matching rules (for example Google Chat `groups.<space>.users`)
- command authorization paths that reuse message-channel sender allowlists

Channel support depends on whether that channel is wired through the shared Vasudev sender-authorization helpers. Static `message.senders` groups are channel-agnostic, so a message channel gets them by using the shared plugin SDK ingress helpers instead of custom allowlist expansion. `createChannelIngressResolver` requires `cfg`, so a channel cannot omit access-group support by accident.

A channel does have to keep group references out of its own sender-id normalization: the shared resolver separates `accessGroup:<name>` entries from concrete sender entries itself, so lowercasing, phone-normalizing, or id-validating an allowlist **before** handing it over corrupts the reference into an entry that matches nobody while still counting as a configured allowlist. Normalize through `identity.normalize`/`normalizeEntry` on the identity descriptor, which the resolver applies only to direct entries.

One channel cannot express these groups: `voice-call` validates every `allowFrom` entry as E.164. List its callers' numbers directly.

## Discord channel audiences

Discord also supports a dynamic access group type:

```json5
{
  accessGroups: {
    maintainers: {
      type: "discord.channelAudience",
      guildId: "1456350064065904867",
      channelId: "1456744319972282449",
      membership: "canViewChannel",
    },
  },
  channels: {
    discord: {
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:maintainers"],
    },
  },
}
```

`discord.channelAudience` means "allow Discord DM senders who can currently view this guild channel." Vasudev resolves the sender through Discord at authorization time and applies Discord `ViewChannel` permission rules. `membership` is optional and defaults to `canViewChannel`.

Use this when a Discord channel is already the source of truth for a team, such as `#maintainers` or `#on-call`.

Requirements and failure behavior:

- The bot needs access to the guild and channel.
- The bot needs the Discord Developer Portal **Server Members Intent**.
- The access group fails closed when Discord returns `Missing Access`, the sender cannot be resolved as a guild member, or the channel belongs to another guild.

More Discord-specific examples: [Discord access control](/channels/discord/access-control#access-control-and-routing)

## Plugin diagnostics

Plugin authors can inspect structured access-group state without expanding it back into a flat allowlist:

```typescript
import { resolveAccessGroupAllowFromState } from "openclaw/plugin-sdk/access-groups";

const state = await resolveAccessGroupAllowFromState({
  accessGroups: cfg.accessGroups,
  allowFrom: channelConfig.allowFrom,
  channel: "my-channel",
  accountId: "default",
  senderId,
  isSenderAllowed,
});
```

The result reports referenced, matched, missing, unsupported, and failed groups. Use it for diagnostics or conformance tests. Use `expandAllowFromWithAccessGroups(...)` only for compatibility paths that still expect a flat `allowFrom` array.

## Security notes

- Access groups are allowlist aliases, not roles. They do not create owners, approve pairing requests, or grant tool permissions by themselves.
- `dmPolicy: "open"` still requires `"*"` in the effective DM allowlist. Referencing an access group is not the same as public access.
- Missing group names fail closed. If `allowFrom` contains `accessGroup:operators` and `accessGroups.operators` is absent, that entry authorizes nobody.
- Keep channel ids stable. Prefer numeric/user ids over display names when the channel supports both.

## Troubleshooting

If a sender should match but is blocked:

1. Confirm the allowlist field contains the exact `accessGroup:<name>` reference.
2. Confirm `accessGroups.<name>.type` is correct.
3. Confirm the sender id is listed under the matching channel key, or under `"*"`.
4. Confirm the entry uses that channel's normal allowlist syntax.
5. For Discord channel audiences, confirm the bot can see the guild channel and has Server Members Intent enabled.

Run `openclaw doctor` after editing access-control config. It catches many invalid allowlist and policy combinations before runtime.

## Related

- [Groups](/channels/groups) — group chat behavior and mention gating
- [Pairing](/channels/pairing) — the separate DM pairing flow for channel senders
- [Channels overview](/channels) — the channels these groups apply to
