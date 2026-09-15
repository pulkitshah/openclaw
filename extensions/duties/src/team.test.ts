import { describe, expect, it } from "vitest";
import { DutyStore } from "./store.js";
import { normalizeTeamMemberId, TEAM_MEMBER_ID_RE, type TeamMember } from "./team.js";

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
