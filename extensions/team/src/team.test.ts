import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import { TeamStore } from "./store.js";
import {
  applyTeamProjection,
  assertTeamProjectionSafe,
  normalizeTeamMemberId,
  teamAccessGroup,
  teamIdentityLinks,
  TEAM_ACCESS_GROUP_ENTRY,
  TEAM_MEMBER_ID_RE,
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

function store(): TeamStore {
  return new TeamStore({ team: memoryKeyed<TeamMember>() });
}

async function seeded(): Promise<TeamStore> {
  const s = store();
  await s.seedOwner({
    id: "owner",
    name: "Pulkit",
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
    await s.seedOwner({ id: "owner", name: "Someone else", addedBy: "owner", channels: [] });
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
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "5551234", addedAt: 2 }],
    });
    expect(added.role).toBe("member");
    expect((await s.listMembers()).filter((m) => m.role === "owner")).toHaveLength(1);
  });

  it("lists the owner first, then members by name", async () => {
    const s = await seeded();
    await s.addMember({ id: "zara", name: "Zara", addedBy: "owner", channels: [] });
    await s.addMember({ id: "amit", name: "Amit", addedBy: "owner", channels: [] });
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
  addedBy: "owner",
  addedAt: 1,
  updatedAt: 1,
  channels: [{ channel: "telegram", senderId: "111", addedAt: 1 }],
};

const RAMESH: TeamMember = {
  id: "ramesh",
  name: "Ramesh",
  role: "member",
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
      entries: { krishna: { name: "Krishna" } },
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
    if (group.type !== "message.senders") {
      throw new Error("expected a message.senders access group");
    }
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
    expect(
      afterRemoval.bindings?.some((b) => b.match?.peer && b.match.channel === "whatsapp"),
    ).toBe(false);
  });

  it("every member's binding names the same coordinator agent — there is no per-member agent", () => {
    const next = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);
    const memberBindings = next.bindings?.filter((b) => b.match?.peer) ?? [];
    expect(memberBindings.length).toBeGreaterThan(0);
    expect(memberBindings.every((b) => b.agentId === "krishna")).toBe(true);
  });

  it("writes no tools block onto anyone's agent", () => {
    const next = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);
    expect(next.agents?.entries?.krishna?.tools).toBeUndefined();
    // The entries themselves survive untouched, and the rest of the projection still applies.
    expect(next.agents?.entries).toEqual(deskConfig().agents?.entries);
    expect(next.session?.identityLinks?.owner).toEqual(["telegram:111"]);
  });

  it("leaves tools the owner set for the coordinator agent by hand exactly as they wrote them", () => {
    const cfg = deskConfig();
    cfg.agents = {
      ...cfg.agents,
      entries: {
        ...cfg.agents?.entries,
        krishna: { name: "Krishna", tools: { profile: "full" } },
      },
      // SAFETY: fixture narrowing; only the keys this assertion reads are set.
    } as OpenClawConfig["agents"];
    const next = applyTeamProjection(cfg, [OWNER, RAMESH]);
    expect(next.agents?.entries?.krishna?.tools).toEqual({ profile: "full" });
  });

  it("keeps an operator-authored identityLink that is not a Team member's", () => {
    const cfg = deskConfig();
    cfg.session = {
      identityLinks: {
        // An operator's own link, for ids Team has never projected. Replacing `identityLinks`
        // wholesale used to delete it silently.
        "pulkit-desk": ["slack:U123", "discord:456"],
      },
      // SAFETY: fixture narrowing; only the key this assertion reads is set.
    } as OpenClawConfig["session"];
    const next = applyTeamProjection(cfg, [OWNER, RAMESH]);
    expect(next.session?.identityLinks?.["pulkit-desk"]).toEqual(["slack:U123", "discord:456"]);
    expect(next.session?.identityLinks?.ramesh).toEqual([
      "telegram:5551234",
      "whatsapp:+919812345678",
    ]);

    // …and removing a member still drops THAT link, because the previous projection's own access
    // group is the record of which keys Team owns.
    const afterRemoval = applyTeamProjection(next, [OWNER]);
    expect(afterRemoval.session?.identityLinks).toEqual({
      "pulkit-desk": ["slack:U123", "discord:456"],
      owner: ["telegram:111"],
    });
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

  it("projects nothing when there is no owner identity to resolve a coordinator from", () => {
    const next = applyTeamProjection(deskConfig(), []);
    expect(next.bindings).toEqual(deskConfig().bindings);
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

  it("refuses to narrow a channel whose allowFrom is empty under dmPolicy open", () => {
    const cfg = deskConfig();
    cfg.channels = {
      ...cfg.channels,
      whatsapp: { enabled: true, dmPolicy: "open" },
      // SAFETY: fixture narrowing; only the two keys this assertion reads are set.
    } as OpenClawConfig["channels"];
    expect(() => assertTeamProjectionSafe(cfg, [OWNER, RAMESH])).toThrow(
      /whatsapp currently admits every sender/,
    );
  });

  it("does not refuse a channel left on its own pairing default, allowFrom empty or unset", () => {
    const cfg = deskConfig();
    cfg.channels = {
      ...cfg.channels,
      whatsapp: { enabled: true, dmPolicy: "pairing" },
      // SAFETY: fixture narrowing; only the two keys this assertion reads are set.
    } as OpenClawConfig["channels"];
    expect(assertTeamProjectionSafe(cfg, [OWNER, RAMESH])).toEqual([]);
    cfg.channels = {
      ...cfg.channels,
      whatsapp: { enabled: true },
      // SAFETY: fixture narrowing; only the key this assertion reads is set.
    } as OpenClawConfig["channels"];
    expect(assertTeamProjectionSafe(cfg, [OWNER, RAMESH])).toEqual([]);
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
  function effectiveAllowFrom(cfg: OpenClawConfig, channel: string): string[] {
    const entries: unknown[] = cfg.channels?.[channel]?.allowFrom ?? [];
    return entries.flatMap((entry) => {
      if (typeof entry !== "string" || !entry.startsWith("accessGroup:")) {
        return [String(entry)];
      }
      const group = cfg.accessGroups?.[entry.slice("accessGroup:".length)];
      if (!group || group.type !== "message.senders") {
        return [];
      }
      return (group.members[channel] ?? []).concat(group.members["*"] ?? []);
    });
  }

  it("promotes one member onto telegram and whatsapp from a single projection", () => {
    const before = deskConfig();
    expect(effectiveAllowFrom(before, "telegram")).not.toContain("5551234");
    expect(effectiveAllowFrom(before, "whatsapp")).not.toContain("+919812345678");

    const after = applyTeamProjection(before, [OWNER, RAMESH]);

    expect(effectiveAllowFrom(after, "telegram")).toContain("5551234");
    expect(effectiveAllowFrom(after, "whatsapp")).toContain("+919812345678");
    expect(effectiveAllowFrom(after, "telegram")).toContain("111");
    expect(effectiveAllowFrom(after, "whatsapp")).toContain("+919800000000");
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

describe("cross-channel routing through the real routing owner", () => {
  /** What the channels actually pass: for a DM, `peer.id` IS the sender — WhatsApp's `resolvePeerId`
   *  returns the sender's normalized E.164 and Telegram's `resolveTelegramDirectPeerId` returns the
   *  sender's user id. So the ids Team stores for admission are the same strings the router matches. */
  function routeFor(cfg: OpenClawConfig, channel: string, senderId: string) {
    return resolveAgentRoute({ cfg, channel, peer: { kind: "direct", id: senderId } });
  }

  it("sends both of a member's channel identities to the coordinator agent, in the same session", () => {
    const cfg = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);

    const fromTelegram = routeFor(cfg, "telegram", "5551234");
    const fromWhatsApp = routeFor(cfg, "whatsapp", "+919812345678");

    // No per-member agent: everyone — the owner included — talks to the same coordinator.
    expect(fromTelegram.agentId).toBe("krishna");
    expect(fromWhatsApp.agentId).toBe("krishna");
    expect(fromTelegram.matchedBy).toBe("binding.peer");
    expect(fromWhatsApp.matchedBy).toBe("binding.peer");
    // identityLinks collapses both onto the canonical member id, and dmScope "per-peer" is what
    // makes the links apply at all (src/routing/session-key.ts:223-230).
    expect(fromTelegram.sessionKey).toBe("agent:krishna:direct:ramesh");
    expect(fromWhatsApp.sessionKey).toBe(fromTelegram.sessionKey);
  });

  it("keeps the member's session isolated from the coordinator's own wide/main session", () => {
    const cfg = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);
    const owner = routeFor(cfg, "telegram", "111");
    const member = routeFor(cfg, "telegram", "5551234");
    const stranger = routeFor(cfg, "telegram", "9999999");
    // Same agent for everyone reachable at all…
    expect(owner.agentId).toBe("krishna");
    expect(member.agentId).toBe("krishna");
    expect(stranger.agentId).toBe("krishna");
    // …but the member's own peer-scoped session is distinct from the owner's/a stranger's, which
    // both fall through to the coordinator's ordinary wide-binding session.
    expect(member.sessionKey).not.toBe(owner.sessionKey);
    expect(member.sessionKey).not.toBe(stranger.sessionKey);
    expect(owner.sessionKey).toBe(stranger.sessionKey);
  });

  it("keeps the member's chat off the coordinator agent's main session", () => {
    const cfg = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);
    expect(routeFor(cfg, "telegram", "5551234").sessionKey).not.toBe("agent:krishna:main");
  });

  it("removing the member folds their next message onto the coordinator's ordinary session", () => {
    const withMember = applyTeamProjection(deskConfig(), [OWNER, RAMESH]);
    const before = routeFor(withMember, "telegram", "5551234");
    expect(before.agentId).toBe("krishna");
    expect(before.sessionKey).toBe("agent:krishna:direct:ramesh");

    const afterRemoval = applyTeamProjection(withMember, [OWNER]);
    const after = routeFor(afterRemoval, "telegram", "5551234");
    // Still the same agent (there never was a different one) — but no longer their own isolated
    // session, because removal drops their binding, their identity link and their access-group
    // entry in one write.
    expect(after.agentId).toBe("krishna");
    expect(after.sessionKey).not.toBe(before.sessionKey);
  });
});
