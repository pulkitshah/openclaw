/**
 * The Team roster: the desk's only people list.
 *
 * It answers exactly one question — who may give Vasu instructions — and it answers it identically
 * on every channel, because it does not implement admission at all. `applyTeamProjection` turns this
 * roster into ordinary core config keys that `decideChannelIngress` and `resolveAgentRoute` already
 * read.
 *
 * There is no per-member agent. Every member — the owner included — talks to the SAME coordinator
 * agent: whichever agent already answers the owner's own channel before Team ever writes a binding
 * (`resolveCoordinatorAgentId` below). `session.dmScope: "per-peer"` on each member's own binding is
 * what still gives them an isolated conversation with that one agent, without a dedicated agent of
 * their own (moved here, whole, from `extensions/duties/src/team.ts` — Team v2 Task 1; per-member
 * agent provisioning is deleted, not deprecated).
 */
import {
  messageSenderGroupAccountKey,
  messageSenderGroupKeyChannelId,
} from "openclaw/plugin-sdk/allow-from";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { ACCESS_GROUP_ALLOW_FROM_PREFIX } from "openclaw/plugin-sdk/security-runtime";

/** Exactly one member holds "owner" at a time; `transferOwnership` is the only writer of this. */
type TeamRole = "owner" | "member";

export type TeamChannelIdentity = {
  /** Message-channel id as the channel plugins spell it: "telegram", "whatsapp", "signal", … */
  channel: string;
  /** The sender id in that channel's own allowlist syntax — a numeric Telegram user id, an E.164
   *  WhatsApp number. Never a display name. */
  senderId: string;
  /** Channel account this identity belongs to. Omitted means every account of that channel. */
  accountId?: string;
  addedAt: number;
};

/** One person Vasu takes instructions from. This is the whole people model: there is no contact
 *  tier, and nothing is ever added except by the owner. No agent id: everyone shares the one
 *  coordinator agent (`resolveCoordinatorAgentId`) — there is no dedicated agent, workspace or
 *  memory per member. */
export type TeamMember = {
  /** Slug. Same grammar as an agent id (it used to become one), and still a `session.identityLinks`
   *  canonical id and a Duty's `team:<id>` target. */
  id: string;
  name: string;
  role: TeamRole;
  /** How this person reaches Vasu. A member with no identity on a channel cannot instruct on it
   *  and cannot be named for delivery on it — both fail loudly rather than falling back. */
  channels: TeamChannelIdentity[];
  /** Member id of the owner who added them. The seeded owner row names itself. */
  addedBy: string;
  addedAt: number;
  updatedAt: number;
};

export type NewTeamMember = {
  id: string;
  name: string;
  channels: TeamChannelIdentity[];
  addedBy: string;
};

/** Same grammar as `AgentsSchema`'s entry key (`src/config/zod-schema.agents.ts:37`): a member id
 *  is still a `session.identityLinks` canonical id and a `team:<id>` delivery target, even though it
 *  no longer doubles as an agent id. */
export const TEAM_MEMBER_ID_RE = /^[a-z0-9_][a-z0-9_-]{0,63}$/;

export function normalizeTeamMemberId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!TEAM_MEMBER_ID_RE.test(id)) {
    throw new Error(
      `"${raw}" is not a usable member id — use letters, digits, - and _ only (for example "ramesh")`,
    );
  }
  return id;
}

/** Sorted for display and for every projection: the owner first, then members by name. */
export function sortTeamMembers(members: readonly TeamMember[]): TeamMember[] {
  return [...members].toSorted((a, b) => {
    if (a.role !== b.role) {
      return a.role === "owner" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

/** Core has no plugin-SDK export for these, so they are derived from the config type itself rather
 *  than importing `src/**` across the extensions boundary (`extensions/AGENTS.md`). */
type TeamAccessGroup = NonNullable<OpenClawConfig["accessGroups"]>[string];
type TeamBinding = NonNullable<OpenClawConfig["bindings"]>[number];
type TeamChannelEntry = NonNullable<OpenClawConfig["channels"]>[string];

const TEAM_ACCESS_GROUP_NAME = "team";
export const TEAM_ACCESS_GROUP_ENTRY = `${ACCESS_GROUP_ALLOW_FROM_PREFIX}${TEAM_ACCESS_GROUP_NAME}`;
/** Marks the bindings this projection owns so it can replace its own entries and nothing else. */
const TEAM_BINDING_COMMENT_PREFIX = "team roster: ";
/**
 * Channels whose own config schema rejects `accessGroup:<name>` in `allowFrom`.
 *
 * `voice-call` validates every entry as E.164 (`extensions/voice-call/src/config.ts`), and config
 * writes validate the WHOLE candidate — so projecting onto it fails the entire roster write, not
 * just that channel. Refuse with a reason instead.
 */
const CHANNELS_WITHOUT_ACCESS_GROUP_ALLOW_FROM = new Set(["voice-call"]);

/** Every channel any member has an identity on, in first-seen order. */
function teamChannels(members: readonly TeamMember[]): string[] {
  const seen: string[] = [];
  for (const member of sortTeamMembers(members)) {
    for (const identity of member.channels) {
      if (!seen.includes(identity.channel)) {
        seen.push(identity.channel);
      }
    }
  }
  return seen;
}

/** Roster -> the one access group every channel's allowlist points at. Never "*": the desk does not
 *  translate sender ids between channels, so an id is only meaningful under its own channel key
 *  (`docs/channels/access-groups.md:41`).
 *
 *  An identity that names an `accountId` is written under the account-scoped member key
 *  (`messageSenderGroupAccountKey`, e.g. "telegram:work") so it authorizes on that account only.
 *  Without the scope the roster row said "one account" while admission said "every account of that
 *  channel" — the identity's `accountId` reached only the binding's `match.accountId`, which routes
 *  an already-admitted sender and never decides admission. */
export function teamAccessGroup(members: readonly TeamMember[]): TeamAccessGroup {
  const byChannel: Record<string, string[]> = {};
  for (const member of sortTeamMembers(members)) {
    for (const identity of member.channels) {
      const key = identity.accountId
        ? messageSenderGroupAccountKey(identity.channel, identity.accountId)
        : identity.channel;
      const list = (byChannel[key] ??= []);
      if (!list.includes(identity.senderId)) {
        list.push(identity.senderId);
      }
    }
  }
  return { type: "message.senders", members: byChannel };
}

/**
 * What the PREVIOUS write projected, read off the incoming config.
 *
 * `accessGroups.team` is the only record Team keeps of its last projection, so it answers both
 * "which channels do I still own an `allowFrom` entry on" (for removal) and "which
 * `session.identityLinks` values did I write" (for link ownership). Account-scoped member keys are
 * collapsed to their channel: an identity link is `<channel>:<senderId>` with no account in it, and
 * a channel's `allowFrom` entry is per channel, not per account.
 */
function previousTeamProjection(cfg: OpenClawConfig): {
  channels: Set<string>;
  identities: Set<string>;
} {
  const group = cfg.accessGroups?.[TEAM_ACCESS_GROUP_NAME] as TeamAccessGroup | undefined;
  const channels = new Set<string>();
  const identities = new Set<string>();
  if (group?.type !== "message.senders") {
    return { channels, identities };
  }
  for (const [key, senderIds] of Object.entries(group.members)) {
    const channel = messageSenderGroupKeyChannelId(key);
    if (channel === "*") {
      continue;
    }
    channels.add(channel);
    for (const senderId of senderIds) {
      identities.add(`${channel}:${senderId}`);
    }
  }
  return { channels, identities };
}

/** Roster -> `session.identityLinks`. `resolveLinkedDirectPeerId` matches an id both bare and as
 *  `<channel>:<peerId>` (`src/routing/session-key.ts:266-305`); the scoped form is written because
 *  two channels can legitimately issue the same bare id. */
export function teamIdentityLinks(members: readonly TeamMember[]): Record<string, string[]> {
  const links: Record<string, string[]> = {};
  for (const member of sortTeamMembers(members)) {
    if (member.channels.length === 0) {
      continue;
    }
    links[member.id] = member.channels.map((c) => `${c.channel}:${c.senderId}`);
  }
  return links;
}

function channelHasWideBinding(cfg: OpenClawConfig, channel: string): boolean {
  return (cfg.bindings ?? []).some(
    (binding) =>
      binding.match?.channel === channel &&
      !binding.match?.peer &&
      !binding.comment?.startsWith(TEAM_BINDING_COMMENT_PREFIX),
  );
}

/** The one agent every Team member talks to: whichever agent already answers the owner's own
 *  channel, resolved through the SAME pre-Team-binding routing the owner already relies on (never
 *  through a binding Team itself wrote — that would be circular). Undefined when there is no owner
 *  yet, or the owner has no channel identity to resolve from.
 *
 *  Exported for `exec-self-cli-default.ts`, which needs the same coordinator identity to apply the
 *  Team v2 exec self-CLI-deny default (Task 5) — a separate, narrower write than
 *  `applyTeamProjection`, which deliberately never touches `tools` (see its doc comment above). */
export function resolveCoordinatorAgentId(
  cfg: OpenClawConfig,
  members: readonly TeamMember[],
): string | undefined {
  const owner = members.find((m) => m.role === "owner");
  const identity = owner?.channels[0];
  if (!owner || !identity) {
    return undefined;
  }
  return resolveAgentRoute({
    cfg,
    channel: identity.channel,
    peer: { kind: "direct", id: identity.senderId },
  }).agentId;
}

/**
 * What Team cannot protect against, said plainly, for the Team page to show.
 *
 * Never throws: it is read on every `team.get`, including for a read-level operator, and a warning
 * is information, not a refusal.
 */
export function teamPolicyWarnings(cfg: OpenClawConfig, members: readonly TeamMember[]): string[] {
  const warnings: string[] = [];
  for (const channel of teamChannels(members)) {
    const entry = channelPolicyView(cfg, channel);
    if (entry?.dmPolicy === "open") {
      // Referencing an access group is not the same as public access: with `"*"` in the effective
      // allowlist the roster is not a restriction at all (`docs/channels/access-groups.md`).
      warnings.push(
        `${channel} is set to dmPolicy "open", so anyone can instruct Vasu there — Team does not restrict it.`,
      );
    }
    // Per-chat and per-topic sender allowlists take precedence over the channel-level list Team
    // writes (Telegram: `groupAllowOverride = firstDefined(topicConfig?.allowFrom,
    // groupConfig?.allowFrom)`), so the roster simply does not apply inside those chats.
    const shadowingChats = chatsWithOwnAllowFrom(entry);
    if (shadowingChats.length > 0) {
      warnings.push(
        `${channel} has its own sender allowlist on ${shadowingChats.join(", ")}, which overrides ` +
          `the channel-level list Team writes — the roster does not apply in ${
            shadowingChats.length === 1 ? "that chat" : "those chats"
          }. Add "${TEAM_ACCESS_GROUP_ENTRY}" there too if Team should govern it.`,
      );
    }
  }
  return warnings;
}

/**
 * The channel-policy fields this guard reads.
 *
 * `OpenClawConfig["channels"][string]` is the union of every channel's own config, so these shared
 * keys are not reachable on the union type. Only the fields below are read, and each is re-checked
 * at runtime before use.
 */
type TeamChannelPolicyView = {
  dmPolicy?: string;
  allowFrom?: unknown;
  groupPolicy?: string;
  groupAllowFrom?: unknown;
  groups?: Record<string, unknown>;
  accounts?: Record<string, unknown>;
};

function channelPolicyView(
  cfg: OpenClawConfig,
  channel: string,
): TeamChannelPolicyView | undefined {
  // SAFETY: narrowing the channel-config union to the shared policy keys listed above; every read
  // below re-checks the runtime shape.
  return cfg.channels?.[channel] as TeamChannelPolicyView | undefined;
}

function configuredList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

/** Per-chat (and per-topic) ids on this channel that carry their own sender allowlist. */
function chatsWithOwnAllowFrom(entry: TeamChannelPolicyView | undefined): string[] {
  const shadowing: string[] = [];
  for (const [chatId, rawChat] of Object.entries(entry?.groups ?? {})) {
    if (!rawChat || typeof rawChat !== "object") {
      continue;
    }
    const chat = rawChat as { allowFrom?: unknown; topics?: Record<string, unknown> };
    if ((configuredList(chat.allowFrom)?.length ?? 0) > 0) {
      shadowing.push(chatId);
      continue;
    }
    for (const [topicId, rawTopic] of Object.entries(chat.topics ?? {})) {
      const topic = rawTopic as { allowFrom?: unknown } | null;
      if (
        topic &&
        typeof topic === "object" &&
        (configuredList(topic.allowFrom)?.length ?? 0) > 0
      ) {
        shadowing.push(`${chatId} topic ${topicId}`);
      }
    }
  }
  return shadowing;
}

/**
 * Refuses the write when applying the roster would break or narrow a channel, and returns the same
 * warnings `teamPolicyWarnings` reports. Nothing here changes config — callers run it before the
 * write so a refusal leaves both the roster row and the config untouched.
 */
export function assertTeamProjectionSafe(
  cfg: OpenClawConfig,
  members: readonly TeamMember[],
): string[] {
  for (const channel of teamChannels(members)) {
    // Under `agents.ownership: "explicit"` with more than one agent, a channel with no matching
    // binding fails closed with AgentSelectionRequiredError (src/routing/resolve-route.ts:784-792),
    // and adding the first member is exactly when a desk goes from one agent to two.
    if (cfg.agents?.ownership === "explicit" && !channelHasWideBinding(cfg, channel)) {
      throw new Error(
        `${channel} has no channel-wide binding, so adding a second agent would stop it answering. ` +
          `Add a binding for ${channel} in config first, then try again.`,
      );
    }
    const entry = channelPolicyView(cfg, channel);
    const allowFrom = configuredList(entry?.allowFrom) ?? [];
    const dmPolicy = entry?.dmPolicy;
    // A channel that already carries Team's entry is being re-projected, not newly restricted. The
    // narrowing checks below must not start refusing ordinary roster edits on a desk Team already
    // governs — only the FIRST write onto a channel can change who reaches Vasu there.
    const alreadyProjected = allowFrom.includes(TEAM_ACCESS_GROUP_ENTRY);

    // GC5: the channel's own config contract rejects the symbol, and config writes validate the
    // whole candidate — so this would fail the entire roster write, including the other channels.
    if (CHANNELS_WITHOUT_ACCESS_GROUP_ALLOW_FROM.has(channel)) {
      throw new Error(
        `${channel} cannot express "${TEAM_ACCESS_GROUP_ENTRY}" in its allowFrom, so Team cannot govern it. ` +
          `Remove the ${channel} identity from the member and list their id in channels.${channel}.allowFrom by hand.`,
      );
    }

    // GC6: Team writes the CHANNEL-level allowFrom. An account-level list replaces it for that
    // account, so the write would be a silent no-op there and the member could not instruct Vasu
    // at all — the exact failure mode Team exists to prevent.
    const shadowingAccounts = Object.entries(entry?.accounts ?? {})
      .filter(([, rawAccount]) => {
        if (!rawAccount || typeof rawAccount !== "object") {
          return false;
        }
        const list = configuredList((rawAccount as { allowFrom?: unknown }).allowFrom);
        return list !== undefined && !list.includes(TEAM_ACCESS_GROUP_ENTRY);
      })
      .map(([accountId]) => accountId);
    if (shadowingAccounts.length > 0) {
      throw new Error(
        `${channel} account${shadowingAccounts.length === 1 ? "" : "s"} ` +
          `${shadowingAccounts.join(", ")} have their own allowFrom list, which replaces the ` +
          `channel-level list Team writes — the roster would not apply there at all. ` +
          `Add "${TEAM_ACCESS_GROUP_ENTRY}" to channels.${channel}.accounts.<id>.allowFrom, or move ` +
          `those entries up to channels.${channel}.allowFrom, and try again.`,
      );
    }

    // GC4: group sender policy, which this guard used to know nothing about. With no explicit
    // `groupAllowFrom`, channels fall back to the DM `allowFrom` for GROUP sender authorization
    // (Telegram: `resolveTelegramMessageTurnSettings`'s `groupAllowFrom ?? allowFrom`). While that
    // list is empty, a chat listed under `groups` admits everyone in it; Team's first entry turns
    // the same chat into a roster-only chat and every other participant goes silent. That is the
    // same narrowing GC3 refuses for DMs, one policy over.
    const groupPolicy = entry?.groupPolicy;
    const groupsConfigured = Object.keys(entry?.groups ?? {}).length > 0;
    const explicitGroupAllowFrom = (configuredList(entry?.groupAllowFrom)?.length ?? 0) > 0;
    if (
      !alreadyProjected &&
      allowFrom.length === 0 &&
      !explicitGroupAllowFrom &&
      groupsConfigured &&
      groupPolicy !== "open" &&
      groupPolicy !== "disabled"
    ) {
      throw new Error(
        `${channel} has monitored group chats and no groupAllowFrom, so it currently accepts every ` +
          `sender in them. Adding Team to it would silently cut off everyone outside the roster there. ` +
          `Set channels.${channel}.groupAllowFrom explicitly (or channels.${channel}.groupPolicy to "open") and try again.`,
      );
    }
    // GC3: under dmPolicy "open", an empty allowlist admits everyone (`isSenderIdAllowed`,
    // src/channels/allow-from.ts:75), so writing the FIRST entry onto such a channel would
    // silently refuse people who are reaching Vasu today. Fail loudly instead of narrowing, and
    // never change dmPolicy to compensate.
    //
    // "pairing" (unset defaults to it — every dmPolicy resolver in src/security/dm-policy-shared.ts
    // and src/channels/direct-dm-access.ts falls back to "pairing", never to "open") is NOT the
    // same risk: an empty allowFrom there already admits no one — every sender not already listed
    // gets a pairing prompt instead (`resolveDmGroupAccessWithLists`'s pairing branch) — and
    // pairing-store approvals merge with, rather than get replaced by, whatever Team writes here
    // (`mergeDmAllowFromSources`, docs/channels/whatsapp.md's "pairings persist in the channel
    // allow-store and merge with configured allowFrom"). Refusing on the channel's own safe
    // default meant Team could never be used on a freshly set up channel at all.
    if (allowFrom.length === 0 && dmPolicy !== "allowlist" && dmPolicy !== "pairing" && dmPolicy) {
      throw new Error(
        `${channel} currently admits every sender because it has no allowFrom list. ` +
          `Adding Team to it would silently cut off anyone already talking to Vasu there. ` +
          `List the senders you want to keep in channels.${channel}.allowFrom (or add them to Team) and try again.`,
      );
    }
  }
  return teamPolicyWarnings(cfg, members);
}

/**
 * Which existing `session.identityLinks` keys this projection owns, and may therefore drop.
 *
 * A key is Team's when every id listed under it is one Team itself projected as
 * `<channel>:<senderId>` into its own access group on the PREVIOUS write. This is re-evaluated on
 * EVERY projection, not only when that key's own member is removed — so an operator-authored link
 * whose every value happens to coincide with a current member's own `<channel>:<senderId>` is
 * indistinguishable from one Team wrote, and is dropped on the next write of any kind, whichever
 * member it touches. An operator-authored entry that doesn't coincide with a projected id survives
 * untouched. `accessGroups.team` as it stands before this write is the only record of who Team had
 * projected, which is why it is read off the incoming `cfg` and not off the half-built next config.
 */
function teamOwnedIdentityLinkKeys(
  previousIdentities: ReadonlySet<string>,
  existing: Record<string, unknown>,
): Set<string> {
  const owned = new Set<string>();
  for (const [key, value] of Object.entries(existing)) {
    if (!Array.isArray(value) || value.length === 0) {
      continue;
    }
    const allProjectedByTeam = value.every(
      (entry) => typeof entry === "string" && previousIdentities.has(entry),
    );
    if (allProjectedByTeam) {
      owned.add(key);
    }
  }
  return owned;
}

/**
 * Roster -> every config key Team owns. The single place the roster becomes enforcement.
 *
 * Writes exactly four things and touches nothing else: `accessGroups.team`, each touched channel's
 * `allowFrom` (merged, never replaced), `session.identityLinks` (merged — see
 * `teamOwnedIdentityLinkKeys`), and the marked `bindings[]` entries — every one of them naming the
 * SAME coordinator agent (`resolveCoordinatorAgentId`), never a per-member agent. `dmPolicy` is
 * deliberately not written (GC3), and neither is any agent's `tools`: a member gets the ordinary
 * default tool access every other agent gets, and an owner who wants a member restricted writes
 * `agents.entries.<coordinatorId>.tools` by hand, which nothing here ever reads or overwrites. Pure:
 * the caller owns reading the snapshot and writing the file.
 */
export function applyTeamProjection(
  cfg: OpenClawConfig,
  members: readonly TeamMember[],
): OpenClawConfig {
  const next = structuredClone(cfg);
  const sorted = sortTeamMembers(members);

  const previous = previousTeamProjection(cfg);
  const existingLinks = { ...next.session?.identityLinks };
  const ownedLinkKeys = teamOwnedIdentityLinkKeys(previous.identities, existingLinks);

  next.accessGroups = { ...next.accessGroups, [TEAM_ACCESS_GROUP_NAME]: teamAccessGroup(sorted) };

  const memberLinks = teamIdentityLinks(sorted);
  const links = { ...existingLinks, ...memberLinks };
  for (const key of ownedLinkKeys) {
    if (!(key in memberLinks)) {
      delete links[key];
    }
  }
  next.session = { ...next.session, identityLinks: links };

  const nextChannels = teamChannels(sorted);
  for (const channel of nextChannels) {
    const entry = { ...next.channels?.[channel] } as TeamChannelEntry;
    const allowFrom = [...(entry.allowFrom ?? [])];
    if (!allowFrom.includes(TEAM_ACCESS_GROUP_ENTRY)) {
      allowFrom.push(TEAM_ACCESS_GROUP_ENTRY);
    }
    entry.allowFrom = allowFrom;
    next.channels = { ...next.channels, [channel]: entry };
  }

  // Add-only was a one-way door: the entry stayed on a channel Team no longer has any member on,
  // pointing at an access group that had emptied — a reference that authorizes nobody and that no
  // roster edit could ever clear. Drop it from exactly the channels the PREVIOUS projection owned
  // and this one does not, and leave the rest of that channel's allowFrom alone.
  for (const channel of previous.channels) {
    if (nextChannels.includes(channel)) {
      continue;
    }
    const existing = next.channels?.[channel];
    const allowFrom = configuredList(existing?.allowFrom);
    if (!allowFrom?.includes(TEAM_ACCESS_GROUP_ENTRY)) {
      continue;
    }
    next.channels = {
      ...next.channels,
      [channel]: {
        ...existing,
        allowFrom: allowFrom.filter((value) => value !== TEAM_ACCESS_GROUP_ENTRY),
      } as TeamChannelEntry,
    };
  }

  // One binding per (member, channel identity), all naming the coordinator agent. The owner's own
  // identity is the one exception: the owner already owns the channel-wide binding for their own
  // channels (that IS the coordinator, by construction — see `resolveCoordinatorAgentId`), so no
  // redundant peer binding is written for it. Every other member's identity — even on a channel the
  // coordinator already answers widely — still gets its own peer binding, because that binding is
  // what carries `session.dmScope: "per-peer"` for that one peer; without it a member's chat would
  // fall through to the coordinator's ordinary (non-isolated) session.
  const coordinatorAgentId = resolveCoordinatorAgentId(cfg, sorted);
  const kept = (next.bindings ?? []).filter(
    (binding) => !binding.comment?.startsWith(TEAM_BINDING_COMMENT_PREFIX),
  );
  const projected: TeamBinding[] = [];
  if (coordinatorAgentId) {
    for (const member of sorted) {
      for (const identity of member.channels) {
        const ownsChannelWide =
          member.role === "owner" &&
          kept.some(
            (binding) =>
              binding.agentId === coordinatorAgentId &&
              binding.match?.channel === identity.channel &&
              !binding.match?.peer,
          );
        if (ownsChannelWide) {
          continue;
        }
        projected.push({
          agentId: coordinatorAgentId,
          comment: `${TEAM_BINDING_COMMENT_PREFIX}${member.name} — managed by the Team page, edit it there, not here`,
          match: {
            channel: identity.channel,
            accountId: identity.accountId ?? "*",
            peer: { kind: "direct", id: identity.senderId },
          },
          // `resolveLinkedDirectPeerId` is consulted only when dmScope !== "main"
          // (src/routing/session-key.ts:223-230), so per-peer is what makes identityLinks apply.
          session: { dmScope: "per-peer" },
        });
      }
    }
  }
  next.bindings = [...kept, ...projected];
  return next;
}
