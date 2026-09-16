import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { DutyStore } from "./store.js";
import {
  applyTeamProjection,
  assertTeamProjectionSafe,
  normalizeTeamMemberId,
  teamAccessGroup,
  teamIdentityLinks,
  TEAM_ACCESS_GROUP_ENTRY,
  TEAM_MEMBER_ID_RE,
  TEAM_MEMBER_TOOLS,
  type TeamMember,
} from "./team.js";

function memoryKeyed<T>() {
  const m = new Map<string, T>();
  return {
    register: async (k: string, v: T) => {
      m.set(k, v);
    },
    lookup: async (k: string) => m.get(k),
    entries: async () => [...m].map(([key, value]) => ({ key, value })),
    delete: async (k: string) => m.delete(k),
  };
}

function store(): DutyStore {
  return new DutyStore({
    duties: memoryKeyed() as never,
    runs: memoryKeyed() as never,
    creds: memoryKeyed() as never,
    templates: memoryKeyed() as never,
    brands: memoryKeyed() as never,
    settings: memoryKeyed() as never,
    team: memoryKeyed<TeamMember>() as never,
  });
}

async function seeded(): Promise<DutyStore> {
  const s = store();
  await s.seedOwner({
    id: "owner",
    name: "Pulkit",
    agentId: "krishna",
    addedBy: "owner",
    channels: [{ channel: "telegram", senderId: "111", addedAt: 1 }],
  });
  return s;
}

describe("team member ids", () => {
  it("accepts an agent-id-shaped slug and rejects anything else", () => {
    expect(TEAM_MEMBER_ID_RE.test("ramesh")).toBe(true);
    expect(normalizeTeamMemberId("  Ramesh  ")).toBe("ramesh");
    expect(() => normalizeTeamMemberId("Ramesh Kumar")).toThrow(/letters, digits/);
    expect(() => normalizeTeamMemberId("")).toThrow(/letters, digits/);
  });
});

describe("team roster invariants", () => {
  it("seeds exactly one owner and is idempotent", async () => {
    const s = await seeded();
    await s.seedOwner({
      id: "owner",
      name: "Someone else",
      agentId: "other",
      addedBy: "owner",
      channels: [],
    });
    const members = await s.listMembers();
    expect(members).toHaveLength(1);
    expect(members[0]?.name).toBe("Pulkit");
    expect((await s.ownerMember())?.id).toBe("owner");
  });

  it("addMember always writes role member, never owner", async () => {
    const s = await seeded();
    const added = await s.addMember({
      id: "ramesh",
      name: "Ramesh",
      agentId: "ramesh",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "5551234", addedAt: 2 }],
    });
    expect(added.role).toBe("member");
    expect((await s.listMembers()).filter((m) => m.role === "owner")).toHaveLength(1);
  });

  it("lists the owner first, then members by name", async () => {
    const s = await seeded();
    await s.addMember({
      id: "zara",
      name: "Zara",
      agentId: "zara",
      addedBy: "owner",
      channels: [],
    });
    await s.addMember({
      id: "amit",
      name: "Amit",
      agentId: "amit",
      addedBy: "owner",
      channels: [],
    });
    expect((await s.listMembers()).map((m) => m.id)).toEqual(["owner", "amit", "zara"]);
  });

  it("refuses to remove the owner and says what to do instead", async () => {
    const s = await seeded();
    await expect(s.removeMember("owner")).rejects.toThrow(
      "transfer ownership before removing the owner",
    );
    expect(await s.removeMember("ramesh")).toBe(false);
  });

  it("transferOwnership swaps both roles in one pass and keeps the old owner a member", async () => {
    const s = await seeded();
    await s.addMember({
      id: "ramesh",
      name: "Ramesh",
      agentId: "ramesh",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "5551234", addedAt: 2 }],
    });
    const { from, to } = await s.transferOwnership("ramesh");
    expect(from.id).toBe("owner");
    expect(from.role).toBe("member");
    expect(to.role).toBe("owner");
    const after = await s.listMembers();
    expect(after.filter((m) => m.role === "owner").map((m) => m.id)).toEqual(["ramesh"]);
    expect(after.find((m) => m.id === "owner")?.channels).toHaveLength(1);
    expect(after.find((m) => m.id === "owner")?.agentId).toBe("krishna");
  });

  it("transferOwnership rejects an unknown member", async () => {
    const s = await seeded();
    await expect(s.transferOwnership("nobody")).rejects.toThrow('no Team member "nobody"');
  });

  it("setMemberChannels replaces the identity list and bumps updatedAt", async () => {
    const s = await seeded();
    const before = await s.getMember("owner");
    const next = await s.setMemberChannels("owner", [
      { channel: "telegram", senderId: "111", addedAt: 1 },
      { channel: "whatsapp", senderId: "+919812345678", addedAt: 3 },
    ]);
    expect(next?.channels.map((c) => c.channel)).toEqual(["telegram", "whatsapp"]);
    expect(next?.updatedAt).toBeGreaterThanOrEqual(before?.updatedAt ?? 0);
  });
});

const OWNER: TeamMember = {
  id: "owner",
  name: "Pulkit",
  role: "owner",
  agentId: "krishna",
  addedBy: "owner",
  addedAt: 1,
  updatedAt: 1,
  channels: [{ channel: "telegram", senderId: "111", addedAt: 1 }],
};

const RAMESH: TeamMember = {
  id: "ramesh",
  name: "Ramesh",
  role: "member",
  agentId: "ramesh",
  addedBy: "owner",
  addedAt: 2,
  updatedAt: 2,
  channels: [
    { channel: "telegram", senderId: "5551234", addedAt: 2 },
    { channel: "whatsapp", senderId: "+919812345678", addedAt: 3 },
  ],
};

function deskConfig(): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: { krishna: { name: "Krishna" }, ramesh: { name: "Ramesh" } },
    },
    channels: {
      telegram: { enabled: true, dmPolicy: "allowlist", allowFrom: ["111"] },
      whatsapp: { enabled: true, dmPolicy: "allowlist", allowFrom: ["+919800000000"] },
    },
    bindings: [
      { agentId: "krishna", match: { channel: "telegram", accountId: "*" } },
      { agentId: "krishna", match: { channel: "whatsapp", accountId: "*" } },
    ],
    // SAFETY: a hand-built config fixture is a partial OpenClawConfig by construction.
  } as OpenClawConfig;
}

describe("teamAccessGroup", () => {
  it("buckets sender ids by channel and never emits a wildcard", () => {
    const group = teamAccessGroup([OWNER, RAMESH]);
    expect(group).toEqual({
      type: "message.senders",
      members: { telegram: ["111", "5551234"], whatsapp: ["+919812345678"] },
    });
    expect(Object.keys(group.members)).not.toContain("*");
  });

  it("an empty roster authorizes nobody", () => {
    expect(teamAccessGroup([])).toEqual({ type: "message.senders", members: {} });
  });
});

describe("teamIdentityLinks", () => {
  it("lists every identity as <channel>:<senderId> under the member id", () => {
    expect(teamIdentityLinks([OWNER, RAMESH])).toEqual({
      owner: ["telegram:111"],
      ramesh: ["telegram:5551234", "whatsapp:+919812345678"],
    });
  });
});

describe("applyTeamProjection", () => {
  it("merges accessGroup:team into an existing allowFrom instead of replacing it", () => {
    const next = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);
    expect(next.channels?.telegram?.allowFrom).toEqual(["111", TEAM_ACCESS_GROUP_ENTRY]);
    expect(next.channels?.whatsapp?.allowFrom).toEqual(["+919800000000", TEAM_ACCESS_GROUP_ENTRY]);
  });

  it("is idempotent — a second run adds no duplicate entry and no duplicate binding", () => {
    const once = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);
    const twice = applyTeamProjection(once, [OWNER, RAMESH]);
    expect(twice.channels?.telegram?.allowFrom).toEqual(["111", TEAM_ACCESS_GROUP_ENTRY]);
    expect(twice.bindings).toEqual(once.bindings);
  });

  it("never writes dmPolicy", () => {
    const next = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);
    expect(next.channels?.telegram?.dmPolicy).toBe("allowlist");
    expect(next.channels?.whatsapp?.dmPolicy).toBe("allowlist");
  });

  it("removing a member drops their access-group entries, links and bindings in one write", () => {
    const withBoth = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);
    const afterRemoval = applyTeamProjection(withBoth, [OWNER]);
    expect(afterRemoval.accessGroups?.team).toEqual({
      type: "message.senders",
      members: { telegram: ["111"] },
    });
    expect(afterRemoval.session?.identityLinks).toEqual({ owner: ["telegram:111"] });
    expect(afterRemoval.bindings?.some((b) => b.agentId === "ramesh")).toBe(false);
    // GC1: the agent entry and its workspace stay.
    expect(afterRemoval.agents?.entries?.ramesh).toBeDefined();
  });

  it("never stamps a tools ceiling onto the owner's own agent, even with no tools block configured", () => {
    // krishna is OWNER's agentId, and deskConfig() gives it no `tools` override — exactly the
    // shape that would trigger the ceiling if the owner were not skipped in that part of the loop.
    const next = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);
    expect(next.agents?.entries?.krishna?.tools).toBeUndefined();
    // The owner's other projections still apply as normal.
    expect(next.session?.identityLinks?.owner).toEqual(["telegram:111"]);
    // A member's own agent still gets the ceiling.
    expect(next.agents?.entries?.ramesh?.tools).toEqual(TEAM_MEMBER_TOOLS);
  });

  it("never overwrites tools the owner already widened for a member", () => {
    const cfg = deskConfig();
    cfg.agents = {
      ...cfg.agents,
      entries: {
        ...cfg.agents?.entries,
        ramesh: { name: "Ramesh", tools: { profile: "full" } },
      },
      // SAFETY: fixture narrowing; only the keys this assertion reads are set.
    } as OpenClawConfig["agents"];
    const next = applyTeamProjection(cfg, [OWNER, RAMESH]);
    expect(next.agents?.entries?.ramesh?.tools).toEqual({ profile: "full" });
  });

  it("leaves an operator-authored binding untouched and replaces only its own marked entries", () => {
    const cfg = deskConfig();
    cfg.bindings = [
      ...(cfg.bindings ?? []),
      { agentId: "krishna", comment: "operator wrote this", match: { channel: "signal" } },
    ];
    const next = applyTeamProjection(cfg, [OWNER, RAMESH]);
    expect(next.bindings?.filter((b) => b.comment === "operator wrote this")).toHaveLength(1);
  });
});

describe("assertTeamProjectionSafe", () => {
  it("refuses a channel with no channel-wide binding under explicit ownership", () => {
    const cfg = deskConfig();
    cfg.bindings = [{ agentId: "krishna", match: { channel: "telegram", accountId: "*" } }];
    expect(() => assertTeamProjectionSafe(cfg, [OWNER, RAMESH])).toThrow(
      /whatsapp has no channel-wide binding/,
    );
  });

  it("refuses to narrow a channel whose allowFrom is empty and whose dmPolicy is not allowlist", () => {
    const cfg = deskConfig();
    cfg.channels = {
      ...cfg.channels,
      whatsapp: { enabled: true, dmPolicy: "pairing" },
      // SAFETY: fixture narrowing; only the two keys this assertion reads are set.
    } as OpenClawConfig["channels"];
    expect(() => assertTeamProjectionSafe(cfg, [OWNER, RAMESH])).toThrow(
      /whatsapp currently admits every sender/,
    );
  });

  it("keeps pairing-approved senders: a pairing channel with an explicit allowFrom is fine", () => {
    const cfg = deskConfig();
    cfg.channels = {
      ...cfg.channels,
      whatsapp: { enabled: true, dmPolicy: "pairing", allowFrom: ["+919800000000"] },
      // SAFETY: fixture narrowing; only the keys this assertion reads are set.
    } as OpenClawConfig["channels"];
    expect(assertTeamProjectionSafe(cfg, [OWNER, RAMESH])).toEqual([]);
  });

  it("warns, but does not throw, when a touched channel is dmPolicy open", () => {
    const cfg = deskConfig();
    cfg.channels = {
      ...cfg.channels,
      whatsapp: { enabled: true, dmPolicy: "open", allowFrom: ["*"] },
      // SAFETY: fixture narrowing; only the keys this assertion reads are set.
    } as OpenClawConfig["channels"];
    expect(assertTeamProjectionSafe(cfg, [OWNER, RAMESH])).toEqual([
      'whatsapp is set to dmPolicy "open", so anyone can instruct Vasu there — Team does not restrict it.',
    ]);
  });
});

describe("one roster change admits a member on two channels", () => {
  /** What every channel's ingress resolver ends up comparing a sender against: the channel's
   *  `allowFrom` with each `accessGroup:<name>` entry replaced by that group's members for THIS
   *  channel (`src/channels/message-access/runtime-access-groups.ts:32-58` partitions the symbolic
   *  entries; `src/channels/message-access/state.ts:155,362` expands message.senders). */
  function effectiveAllowFrom(cfg: OpenClawConfig, channel: string): string[] {
    const entries = cfg.channels?.[channel]?.allowFrom ?? [];
    return entries.flatMap((entry) => {
      if (typeof entry !== "string" || !entry.startsWith("accessGroup:")) return [String(entry)];
      const group = cfg.accessGroups?.[entry.slice("accessGroup:".length)];
      if (!group || group.type !== "message.senders") return [];
      return [...(group.members[channel] ?? []), ...(group.members["*"] ?? [])];
    });
  }

  it("promotes one member onto telegram and whatsapp from a single projection", () => {
    const before = deskConfig();
    expect(effectiveAllowFrom(before, "telegram")).not.toContain("5551234");
    expect(effectiveAllowFrom(before, "whatsapp")).not.toContain("+919812345678");

    const after = applyTeamProjection(before, [OWNER, RAMESH]);

    expect(effectiveAllowFrom(after, "telegram")).toContain("5551234");
    expect(effectiveAllowFrom(after, "whatsapp")).toContain("+919812345678");
    // The owner's original entries survive on both channels.
    expect(effectiveAllowFrom(after, "telegram")).toContain("111");
    expect(effectiveAllowFrom(after, "whatsapp")).toContain("+919800000000");
    // A non-member is on neither.
    expect(effectiveAllowFrom(after, "telegram")).not.toContain("9999999");
    expect(effectiveAllowFrom(after, "whatsapp")).not.toContain("+919700000000");
  });

  it("removing the member revokes both channels in the same single projection", () => {
    const after = applyTeamProjection(applyTeamProjection(deskConfig(), [OWNER, RAMESH]), [OWNER]);
    expect(effectiveAllowFrom(after, "telegram")).not.toContain("5551234");
    expect(effectiveAllowFrom(after, "whatsapp")).not.toContain("+919812345678");
    expect(effectiveAllowFrom(after, "telegram")).toContain("111");
  });
});

import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";

describe("cross-channel routing through the real routing owner", () => {
  /** What the channels actually pass: for a DM, `peer.id` IS the sender — WhatsApp's `resolvePeerId`
   *  returns the sender's normalized E.164 and Telegram's `resolveTelegramDirectPeerId` returns the
   *  sender's user id. So the ids Team stores for admission are the same strings the router matches. */
  function routeFor(cfg: OpenClawConfig, channel: string, senderId: string) {
    return resolveAgentRoute({ cfg, channel, peer: { kind: "direct", id: senderId } });
  }

  // Live-proof note: `src/auto-reply/reply/runtime-policy-session-key.ts:135-146` hardcodes
  // `dmScope: "per-account-channel-peer"` for one DM-policy reply path. If a real turn reaches THAT
  // path, two channels split into two keys despite the link. This unit test drives the routing owner
  // directly and cannot see it — Task 9 step 5 checks `openclaw sessions list --agent <id>` instead
  // of the reply text, for exactly that reason.
  it("sends two channel identities of one member to the same agent and the same session", () => {
    const cfg = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);

    const fromTelegram = routeFor(cfg, "telegram", "5551234");
    const fromWhatsApp = routeFor(cfg, "whatsapp", "+919812345678");

    expect(fromTelegram.agentId).toBe("ramesh");
    expect(fromWhatsApp.agentId).toBe("ramesh");
    expect(fromTelegram.matchedBy).toBe("binding.peer");
    expect(fromWhatsApp.matchedBy).toBe("binding.peer");
    // identityLinks collapses both onto the canonical member id, and dmScope "per-peer" is what
    // makes the links apply at all (src/routing/session-key.ts:223-230).
    expect(fromTelegram.sessionKey).toBe("agent:ramesh:direct:ramesh");
    expect(fromWhatsApp.sessionKey).toBe(fromTelegram.sessionKey);
  });

  it("leaves everyone else on the channel-wide binding, including the owner", () => {
    const cfg = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);
    const owner = routeFor(cfg, "telegram", "111");
    expect(owner.agentId).toBe("krishna");
    const stranger = routeFor(cfg, "telegram", "9999999");
    expect(stranger.agentId).toBe("krishna");
    // A stranger never gets here anyway — decideChannelIngress refuses them first — but if they
    // did, they would land on the desk's own agent, never on a member's.
    expect(stranger.agentId).not.toBe("ramesh");
  });

  it("keeps the member's chat off their agent's main session", () => {
    const cfg = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);
    // `agent:<id>:main` is also cron's, heartbeat's and runSessionKey's fallback session
    // (extensions/duties/src/store.ts:45); the member's conversation must stay separate.
    expect(routeFor(cfg, "telegram", "5551234").sessionKey).not.toBe("agent:ramesh:main");
  });

  it("removing the member sends their next message back to the desk agent immediately", () => {
    const withMember = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);
    expect(routeFor(withMember, "telegram", "5551234").agentId).toBe("ramesh");
    const afterRemoval = applyTeamProjection(withMember, [OWNER]);
    expect(routeFor(afterRemoval, "telegram", "5551234").agentId).toBe("krishna");
  });
});
