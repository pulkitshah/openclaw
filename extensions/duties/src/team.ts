/**
 * The Team roster: the desk's only people list.
 *
 * It answers exactly one question — who may give Vasu instructions — and it answers it identically
 * on every channel, because it does not implement admission at all. `applyTeamProjection` (added in
 * Task 2) turns this roster into ordinary core config keys that `decideChannelIngress` and
 * `resolveAgentRoute` already read.
 */

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
    if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
