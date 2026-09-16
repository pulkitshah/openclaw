/**
 * The Team roster: the desk's only people list.
 *
 * It answers exactly one question — who may give Vasu instructions — and it answers it identically
 * on every channel, because it does not implement admission at all. `applyTeamProjection` (added in
 * Task 2) turns this roster into ordinary core config keys that `decideChannelIngress` and
 * `resolveAgentRoute` already read.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

/** Exactly one member holds "owner" at a time; `transferOwnership` is the only writer of this. */
export type TeamRole = "owner" | "member";

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
 *  tier, and nothing is ever added except by the owner. */
export type TeamMember = {
  /** Slug. Same grammar as an agent id, because it becomes one — and also a
   *  `session.identityLinks` canonical id and a Duty's `team:<id>` target. */
  id: string;
  name: string;
  role: TeamRole;
  /** How this person reaches Vasu. A member with no identity on a channel cannot instruct on it
   *  and cannot be named for delivery on it — both fail loudly rather than falling back. */
  channels: TeamChannelIdentity[];
  /** The member's own agent. For the owner this is the agent that already answers their channel;
   *  for everyone else it is created when they are added. */
  agentId: string;
  /** Recorded from `agents.create`'s reply so the Team card can tell whether BOOTSTRAP.md is still
   *  present without a second RPC. The RPC does not return `bootstrapPending`. */
  agentWorkspace?: string;
  /** Member id of the owner who added them. The seeded owner row names itself. */
  addedBy: string;
  addedAt: number;
  updatedAt: number;
};

export type NewTeamMember = {
  id: string;
  name: string;
  agentId: string;
  agentWorkspace?: string;
  channels: TeamChannelIdentity[];
  addedBy: string;
};

/** Same grammar as `AgentsSchema`'s entry key (`src/config/zod-schema.agents.ts:37`), because a
 *  member id becomes an agent id, an identityLinks canonical id and a `team:<id>` delivery target. */
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

export const TEAM_ACCESS_GROUP_NAME = "team";
/** `ACCESS_GROUP_ALLOW_FROM_PREFIX` is "accessGroup:" (`src/channels/allow-from.ts:11`); it is not
 *  exported from any plugin-SDK subpath, so the literal is spelled once here. */
export const TEAM_ACCESS_GROUP_ENTRY = `accessGroup:${TEAM_ACCESS_GROUP_NAME}`;
/** Marks the bindings this projection owns so it can replace its own entries and nothing else. */
export const TEAM_BINDING_COMMENT_PREFIX = "team roster: ";

/** Every channel any member has an identity on, in first-seen order. */
export function teamChannels(members: readonly TeamMember[]): string[] {
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
 *  (`docs/channels/access-groups.md:41`). */
export function teamAccessGroup(members: readonly TeamMember[]): TeamAccessGroup {
  const byChannel: Record<string, string[]> = {};
  for (const member of sortTeamMembers(members)) {
    for (const identity of member.channels) {
      const list = (byChannel[identity.channel] ??= []);
      if (!list.includes(identity.senderId)) {
        list.push(identity.senderId);
      }
    }
  }
  return { type: "message.senders", members: byChannel };
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

/**
 * What Team cannot protect against, said plainly, for the Team card to show.
 *
 * Never throws: it is read on every `duties.team.get`, including for a read-level operator, and a
 * warning is information, not a refusal.
 */
export function teamPolicyWarnings(cfg: OpenClawConfig, members: readonly TeamMember[]): string[] {
  const warnings: string[] = [];
  for (const channel of teamChannels(members)) {
    const entry = cfg.channels?.[channel] as TeamChannelEntry;
    if (entry?.dmPolicy === "open") {
      // Referencing an access group is not the same as public access: with `"*"` in the effective
      // allowlist the roster is not a restriction at all (`docs/channels/access-groups.md`).
      warnings.push(
        `${channel} is set to dmPolicy "open", so anyone can instruct Vasu there — Team does not restrict it.`,
      );
    }
  }
  return warnings;
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
    const entry = cfg.channels?.[channel] as TeamChannelEntry;
    const allowFrom = entry?.allowFrom ?? [];
    const dmPolicy = entry?.dmPolicy;
    // GC3: an empty allowlist admits everyone (`isSenderIdAllowed`, src/channels/allow-from.ts:75),
    // so writing the FIRST entry onto such a channel would silently refuse people who are reaching
    // Vasu today. Fail loudly instead of narrowing, and never change dmPolicy to compensate.
    if (allowFrom.length === 0 && dmPolicy !== "allowlist") {
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
 * member it touches (final review I5; this is strictly better than the pre-fix wholesale replace,
 * which dropped every operator-authored key on every write, but the imprecision is real). An
 * operator-authored entry that doesn't coincide with a projected id survives untouched.
 * `accessGroups.team` as it stands before this write is the only record of who Team had projected,
 * which is why it is read off the incoming `cfg` and not off the half-built next config.
 */
function teamOwnedIdentityLinkKeys(
  cfg: OpenClawConfig,
  existing: Record<string, unknown>,
): Set<string> {
  const group = cfg.accessGroups?.[TEAM_ACCESS_GROUP_NAME] as TeamAccessGroup | undefined;
  const projected = group?.type === "message.senders" ? group.members : {};
  const owned = new Set<string>();
  for (const [key, value] of Object.entries(existing)) {
    if (!Array.isArray(value) || value.length === 0) {
      continue;
    }
    const allProjectedByTeam = value.every((entry) => {
      if (typeof entry !== "string") {
        return false;
      }
      const split = entry.indexOf(":");
      if (split <= 0) {
        return false;
      }
      return (projected[entry.slice(0, split)] ?? []).includes(entry.slice(split + 1));
    });
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
 * `teamOwnedIdentityLinkKeys`), and the marked `bindings[]` entries. `dmPolicy` is deliberately not
 * written (GC3), and neither is any agent's `tools`: a member's agent gets the ordinary default tool
 * access every other agent gets, and an owner who wants a member restricted writes
 * `agents.entries.<id>.tools` by hand, which nothing here ever reads or overwrites (final review
 * I8 — the owner's decision to drop the Team-authored ceiling supersedes GC2 as planned). Pure: the
 * caller owns reading the snapshot and writing the file.
 */
export function applyTeamProjection(
  cfg: OpenClawConfig,
  members: readonly TeamMember[],
): OpenClawConfig {
  const next = structuredClone(cfg);
  const sorted = sortTeamMembers(members);

  const existingLinks = { ...next.session?.identityLinks };
  const ownedLinkKeys = teamOwnedIdentityLinkKeys(cfg, existingLinks);

  next.accessGroups = { ...next.accessGroups, [TEAM_ACCESS_GROUP_NAME]: teamAccessGroup(sorted) };

  const memberLinks = teamIdentityLinks(sorted);
  const links = { ...existingLinks, ...memberLinks };
  for (const key of ownedLinkKeys) {
    if (!(key in memberLinks)) {
      delete links[key];
    }
  }
  next.session = { ...next.session, identityLinks: links };

  for (const channel of teamChannels(sorted)) {
    const entry = { ...next.channels?.[channel] } as TeamChannelEntry;
    const allowFrom = [...(entry.allowFrom ?? [])];
    if (!allowFrom.includes(TEAM_ACCESS_GROUP_ENTRY)) {
      allowFrom.push(TEAM_ACCESS_GROUP_ENTRY);
    }
    entry.allowFrom = allowFrom;
    next.channels = { ...next.channels, [channel]: entry };
  }

  // One binding per (member, channel identity). `match.channel` is required by the schema, so N
  // identities produce N bindings, all naming the same agent. The owner's agent already owns the
  // channel-wide binding for their channels, so no redundant peer binding is written for them.
  const kept = (next.bindings ?? []).filter(
    (binding) => !binding.comment?.startsWith(TEAM_BINDING_COMMENT_PREFIX),
  );
  const projected: TeamBinding[] = [];
  for (const member of sorted) {
    for (const identity of member.channels) {
      const ownsChannelWide = kept.some(
        (binding) =>
          binding.agentId === member.agentId &&
          binding.match?.channel === identity.channel &&
          !binding.match?.peer,
      );
      if (ownsChannelWide) {
        continue;
      }
      projected.push({
        agentId: member.agentId,
        comment: `${TEAM_BINDING_COMMENT_PREFIX}${member.name} — managed by the Duties Team card, edit it there, not here`,
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
  next.bindings = [...kept, ...projected];
  return next;
}
