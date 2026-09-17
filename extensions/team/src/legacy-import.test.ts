import { describe, expect, it, vi } from "vitest";
import { importLegacyTeamRows } from "./legacy-import.js";
import { TeamStore } from "./store.js";

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
  return new TeamStore({ team: memoryKeyed() });
}

const LEGACY_OWNER = {
  id: "owner",
  name: "Pulkit",
  role: "owner",
  agentId: "krishna",
  agentWorkspace: "/w/krishna",
  addedBy: "owner",
  addedAt: 1,
  updatedAt: 1,
  channels: [{ channel: "telegram", senderId: "111", addedAt: 1 }],
};

const LEGACY_MEMBER = {
  id: "ramesh",
  name: "Ramesh",
  role: "member",
  agentId: "ramesh",
  agentWorkspace: "/w/ramesh",
  addedBy: "owner",
  addedAt: 2,
  updatedAt: 2,
  channels: [{ channel: "whatsapp", senderId: "+919812345678", addedAt: 2 }],
};

describe("importLegacyTeamRows", () => {
  it("copies legacy rows in, dropping agentId/agentWorkspace, and clears the old copy", async () => {
    const s = store();
    const request = vi.fn(async (method: string) => {
      if (method === "duties.legacyTeam.export") {
        return { members: [LEGACY_OWNER, LEGACY_MEMBER] };
      }
      if (method === "duties.legacyTeam.clear") {
        return { cleared: 2 };
      }
      throw new Error(`unexpected ${method}`);
    });

    const { imported, warnings } = await importLegacyTeamRows({
      store: s,
      request,
      assertStillAuthorized: () => {},
    });

    expect(imported.toSorted()).toEqual(["owner", "ramesh"]);
    expect(warnings).toEqual([]);
    const members = await s.listMembers();
    expect(members.map((m) => m.id)).toEqual(["owner", "ramesh"]);
    expect(members.every((m) => !("agentId" in m))).toBe(true);
    expect(members.every((m) => !("agentWorkspace" in m))).toBe(true);
    expect(request).toHaveBeenCalledWith("duties.legacyTeam.clear", { ids: ["owner", "ramesh"] });
  });

  it("does nothing when the local roster already has rows", async () => {
    const s = store();
    await s.seedOwner({ id: "owner", name: "Owner", addedBy: "owner", channels: [] });
    const request = vi.fn(async () => ({ members: [LEGACY_OWNER] }));

    const { imported } = await importLegacyTeamRows({
      store: s,
      request,
      assertStillAuthorized: () => {},
    });

    expect(imported).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("treats a missing legacy bridge (Duties not installed, or already removed) as nothing to migrate", async () => {
    const s = store();
    const request = vi.fn(async () => {
      throw new Error("unknown method: duties.legacyTeam.export");
    });

    const { imported, warnings } = await importLegacyTeamRows({
      store: s,
      request,
      assertStillAuthorized: () => {},
    });

    expect(imported).toEqual([]);
    expect(warnings).toEqual([]);
    expect(await s.listMembers()).toEqual([]);
  });

  it("keeps readable rows and reports the ones it could not read", async () => {
    const s = store();
    const request = vi.fn(async (method: string) => {
      if (method === "duties.legacyTeam.export") {
        return { members: [LEGACY_OWNER, { name: "no id or role" }] };
      }
      return { cleared: 0 };
    });

    const { imported, warnings } = await importLegacyTeamRows({
      store: s,
      request,
      assertStillAuthorized: () => {},
    });

    expect(imported).toEqual(["owner"]);
    expect(warnings).toEqual([
      "1 legacy Team row could not be read (missing id/role) and was left in place — check them by hand.",
    ]);
  });
});
