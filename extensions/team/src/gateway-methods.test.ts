import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi, type Mock } from "vitest";
import { registerTeamGatewayMethods } from "./gateway-methods.js";
import { TeamStore } from "./store.js";

/** The tests below call `writeTeamProjection`, which reads and writes the real config file. Stub it
 *  here so no test in this suite touches `~/.openclaw/openclaw.json`; the projection itself is
 *  proved directly, without mocks, in `team.test.ts`. The stub still invokes the caller's
 *  `assertStillAuthorized`, exactly where the real implementation calls it (synchronously,
 *  immediately before its config write) — so a test can prove the live-authority guard is wired into
 *  each `team.*` handler without this suite ever touching a real config file. */
vi.mock("./team-write.js", () => ({
  writeTeamProjection: vi.fn(
    async (params: { members: unknown; assertStillAuthorized: () => void }) => {
      params.assertStillAuthorized();
      return { warnings: [], config: {} };
    },
  ),
  revokePairingEntries: vi.fn(async () => ({ warnings: [] })),
  approvePendingPairingRequests: vi.fn(async () => ({ approved: [] })),
}));

import {
  approvePendingPairingRequests,
  revokePairingEntries,
  writeTeamProjection,
} from "./team-write.js";

/** The smallest config that satisfies `assertTeamProjectionSafe`: explicit ownership, one agent, a
 *  channel-wide binding per channel, and a non-empty allowlist on each channel Team will touch. */
function deskFixtureConfig(): OpenClawConfig {
  return {
    agents: { ownership: "explicit", entries: { krishna: { name: "Krishna" } } },
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

type Handler = (ctx: {
  params: Record<string, unknown>;
  respond: (ok: boolean, result?: unknown, error?: unknown) => void;
  hasCurrentClientAuthority?: () => boolean;
  client?: { connect: { scopes?: string[] } };
}) => Promise<void>;

function harness(params?: { config?: OpenClawConfig }) {
  const methods = new Map<string, { handler: Handler; scope: string }>();
  const api = {
    registerGatewayMethod: (name: string, handler: never, opts: { scope: string }) =>
      methods.set(name, { handler, scope: opts.scope }),
    runtime: {},
    // SAFETY: the Gateway methods under test only touch `registerGatewayMethod`; `runtime` is read
    // only by `revokePairingEntries`, which is mocked above.
  } as never;
  const store = new TeamStore({ team: memoryKeyed() });
  const emit = vi.fn();
  registerTeamGatewayMethods({
    api,
    store,
    currentConfig: () => params?.config ?? {},
    safeEmit: emit,
  });

  const call = async (
    name: string,
    callParams: Record<string, unknown>,
    callOpts?: { hasCurrentClientAuthority?: () => boolean; scopes?: string[] },
  ) =>
    new Promise<{ ok: boolean; result?: unknown; error?: unknown }>((resolve) => {
      void methods.get(name)!.handler({
        params: callParams,
        respond: (ok, result, error) => resolve({ ok, result, error }),
        ...(callOpts?.hasCurrentClientAuthority
          ? { hasCurrentClientAuthority: callOpts.hasCurrentClientAuthority }
          : {}),
        ...(callOpts?.scopes ? { client: { connect: { scopes: callOpts.scopes } } } : {}),
      });
    });
  const asAdmin = { scopes: ["operator.admin"] };

  return { methods, store, emit, call, asAdmin };
}

describe("team.get", () => {
  it("registers at operator.read", () => {
    const { methods } = harness();
    expect(methods.get("team.get")?.scope).toBe("operator.read");
  });

  it("returns an empty roster until an owner is set — no seeding from anywhere else", async () => {
    const { call } = harness();
    const result = await call("team.get", {});
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ members: [], warnings: [] });
  });

  it("withholds every sender id from a caller without operator.admin", async () => {
    const { call, store } = harness({ config: deskFixtureConfig() });
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      addedBy: "owner",
      channels: [
        { channel: "telegram", senderId: "111", addedAt: 1 },
        { channel: "whatsapp", senderId: "+919800000000", accountId: "work", addedAt: 1 },
      ],
    });

    const read = await call("team.get", {}, { scopes: ["operator.read"] });
    const readMembers = (read.result as { members: Array<{ channels: unknown[] }> }).members;
    expect(readMembers[0]?.channels).toEqual([
      { channel: "telegram", addedAt: 1 },
      { channel: "whatsapp", accountId: "work", addedAt: 1 },
    ]);
    expect(JSON.stringify(read.result)).not.toContain("+919800000000");
    expect(JSON.stringify(read.result)).not.toContain('"111"');

    const admin = await call(
      "team.get",
      {},
      { scopes: ["operator.admin"], hasCurrentClientAuthority: () => true },
    );
    expect(
      (admin.result as { members: Array<{ channels: unknown[] }> }).members[0]?.channels,
    ).toEqual([
      { channel: "telegram", senderId: "111", addedAt: 1 },
      { channel: "whatsapp", senderId: "+919800000000", accountId: "work", addedAt: 1 },
    ]);
  });
});

describe("team.member.get / team.owner.get", () => {
  it("team.member.get returns the full record, including senderId", async () => {
    const { call, store } = harness();
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "111", addedAt: 1 }],
    });
    const result = await call("team.member.get", { id: "owner" });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      member: { id: "owner", channels: [{ channel: "telegram", senderId: "111" }] },
    });
  });

  it("team.member.get answers undefined for an unknown id", async () => {
    const { call } = harness();
    const result = await call("team.member.get", { id: "nobody" });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ member: undefined });
  });

  it("team.owner.get answers the owner's first identity as { channel, target }", async () => {
    const { call, store } = harness();
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "111", addedAt: 1 }],
    });
    const result = await call("team.owner.get", {});
    expect(result.result).toEqual({ owner: { channel: "telegram", target: "111" } });
  });

  it("team.owner.get answers undefined on an empty roster", async () => {
    const { call } = harness();
    const result = await call("team.owner.get", {});
    expect(result.result).toEqual({ owner: undefined });
  });
});

describe("team.owner.set", () => {
  it("seeds the owner row on an empty roster and projects config", async () => {
    const { call, store } = harness({ config: deskFixtureConfig() });
    const result = await call("team.owner.set", { channel: "telegram", target: "111" });
    expect(result.ok).toBe(true);
    expect((await store.ownerMember())?.channels[0]).toMatchObject({
      channel: "telegram",
      senderId: "111",
    });
    expect(writeTeamProjection).toHaveBeenCalledOnce();
  });

  it("moves the existing owner's first identity, keeping the rest", async () => {
    const { call, store } = harness({ config: deskFixtureConfig() });
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "111", addedAt: 1 }],
    });
    await call("team.owner.set", { channel: "whatsapp", target: "+919800000000" });
    const owner = await store.ownerMember();
    expect(owner?.channels[0]).toMatchObject({ channel: "whatsapp", senderId: "+919800000000" });
    expect(owner?.channels).toHaveLength(2);
  });

  it("removes the seeded owner row when the projection write is rejected on an empty roster", async () => {
    const { call, store } = harness({ config: deskFixtureConfig() });
    (writeTeamProjection as Mock).mockRejectedValueOnce(new Error("config write rejected"));

    const result = await call("team.owner.set", { channel: "telegram", target: "111" });

    expect(result.ok).toBe(false);
    expect(await store.ownerMember()).toBeUndefined();
    expect(await store.listMembers()).toEqual([]);
  });

  it("restores the prior owner identity when the projection write is rejected on a move", async () => {
    const { call, store } = harness({ config: deskFixtureConfig() });
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "111", addedAt: 1 }],
    });
    (writeTeamProjection as Mock).mockRejectedValueOnce(new Error("config write rejected"));

    const result = await call("team.owner.set", {
      channel: "whatsapp",
      target: "+919800000000",
    });

    expect(result.ok).toBe(false);
    const owner = await store.ownerMember();
    expect(owner?.channels).toEqual([{ channel: "telegram", senderId: "111", addedAt: 1 }]);
  });
});

describe("team.add", () => {
  it("writes the roster row directly, with no agent to create", async () => {
    const { call, store } = harness({ config: deskFixtureConfig() });
    await call("team.owner.set", { channel: "telegram", target: "111" });
    const added = await call("team.add", {
      name: "Ramesh",
      channels: [{ channel: "telegram", senderId: "5551234" }],
    });
    expect(added.ok).toBe(true);
    expect((added.result as { member: { id: string } }).member).toMatchObject({
      id: "ramesh",
      role: "member",
      addedBy: "owner",
    });
    expect((added.result as { member: object }).member).not.toHaveProperty("agentId");
    expect((await store.listMembers()).map((m) => m.id)).toEqual(["owner", "ramesh"]);
  });

  it("refuses when no owner is set yet", async () => {
    const { call } = harness({ config: deskFixtureConfig() });
    const result = await call("team.add", {
      name: "Ramesh",
      channels: [{ channel: "telegram", senderId: "5551234" }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      message: "set the owner on the Team page before adding anyone else",
    });
  });

  it("refuses an unsafe channel config, leaving the roster untouched", async () => {
    const config = deskFixtureConfig();
    config.bindings = [{ agentId: "krishna", match: { channel: "telegram", accountId: "*" } }];
    const { call, store } = harness({ config });
    await call("team.owner.set", { channel: "telegram", target: "111" });

    const refused = await call("team.add", {
      name: "Ramesh",
      channels: [{ channel: "whatsapp", senderId: "+919812345678" }],
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatchObject({
      message: expect.stringContaining("whatsapp has no channel-wide binding"),
    });
    expect((await store.listMembers()).map((m) => m.id)).toEqual(["owner"]);
  });

  it("refuses an add with no channel identity", async () => {
    const { call } = harness({ config: deskFixtureConfig() });
    const result = await call("team.add", { name: "Ramesh", channels: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      message: expect.stringContaining("channels is required"),
    });
  });

  it("rolls back the roster row when the projection write is rejected", async () => {
    const { call, store } = harness({ config: deskFixtureConfig() });
    await call("team.owner.set", { channel: "telegram", target: "111" });
    (writeTeamProjection as Mock).mockRejectedValueOnce(new Error("config write rejected"));

    const result = await call("team.add", {
      name: "Ramesh",
      channels: [{ channel: "telegram", senderId: "5551234" }],
    });
    expect(result.ok).toBe(false);
    expect((await store.listMembers()).map((m) => m.id)).toEqual(["owner"]);
  });

  it("approves a matching pending pairing request as part of the same call, before the roster write", async () => {
    const { call, store } = harness({ config: deskFixtureConfig() });
    await call("team.owner.set", { channel: "telegram", target: "111" });
    (approvePendingPairingRequests as Mock).mockResolvedValueOnce({
      approved: [{ channel: "telegram", senderId: "5551234", accountId: "default", addedAt: 1 }],
    });

    const added = await call("team.add", {
      name: "Ramesh",
      channels: [{ channel: "telegram", senderId: "5551234" }],
    });

    expect(added.ok).toBe(true);
    expect(approvePendingPairingRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        identities: [expect.objectContaining({ channel: "telegram", senderId: "5551234" })],
      }),
    );
    expect((added.result as { pairingApproved: unknown[] }).pairingApproved).toEqual([
      { channel: "telegram", senderId: "5551234", accountId: "default", addedAt: 1 },
    ]);
    expect((await store.listMembers()).map((m) => m.id)).toEqual(["owner", "ramesh"]);
  });

  it("revokes an approval already made this call when the projection write is rejected afterward", async () => {
    const { call, store } = harness({ config: deskFixtureConfig() });
    await call("team.owner.set", { channel: "telegram", target: "111" });
    const approvedIdentity = {
      channel: "telegram",
      senderId: "5551234",
      accountId: "default",
      addedAt: 1,
    };
    (approvePendingPairingRequests as Mock).mockResolvedValueOnce({ approved: [approvedIdentity] });
    (writeTeamProjection as Mock).mockRejectedValueOnce(new Error("config write rejected"));
    (revokePairingEntries as Mock).mockClear();

    const result = await call("team.add", {
      name: "Ramesh",
      channels: [{ channel: "telegram", senderId: "5551234" }],
    });

    expect(result.ok).toBe(false);
    // The roster row a rejected projection must not leave standing (existing guarantee) AND the
    // pairing-store approval this call already committed above — leaving only the roster row
    // reverted would still admit this sender through the pairing store alone.
    expect((await store.listMembers()).map((m) => m.id)).toEqual(["owner"]);
    expect(revokePairingEntries).toHaveBeenCalledWith(
      expect.objectContaining({ identities: [approvedIdentity] }),
    );
  });

  it("does not call revokePairingEntries on a rejected projection when nothing was approved", async () => {
    const { call } = harness({ config: deskFixtureConfig() });
    await call("team.owner.set", { channel: "telegram", target: "111" });
    (writeTeamProjection as Mock).mockRejectedValueOnce(new Error("config write rejected"));
    (revokePairingEntries as Mock).mockClear();

    await call("team.add", {
      name: "Ramesh",
      channels: [{ channel: "telegram", senderId: "5551234" }],
    });

    expect(revokePairingEntries).not.toHaveBeenCalled();
  });
});

describe("team.setChannels", () => {
  it("replaces a member's identities, projects the roster and revokes the dropped pairing entry", async () => {
    const { call, store } = harness();
    await store.seedOwner({ id: "owner", name: "Owner", addedBy: "owner", channels: [] });
    await store.addMember({
      id: "ramesh",
      name: "Ramesh",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
    });
    (writeTeamProjection as Mock).mockClear();
    (revokePairingEntries as Mock).mockClear();

    const result = await call("team.setChannels", {
      memberId: "ramesh",
      channels: [{ channel: "whatsapp", senderId: "+919812345678" }],
    });

    expect(result.ok).toBe(true);
    const member = (await store.getMember("ramesh"))!;
    expect(member.channels).toEqual([
      expect.objectContaining({ channel: "whatsapp", senderId: "+919812345678" }),
    ]);
    expect(writeTeamProjection).toHaveBeenCalledOnce();
    expect(revokePairingEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        identities: [expect.objectContaining({ channel: "telegram", senderId: "5551234" })],
      }),
    );
  });

  it("rejects an unknown member and a missing channels array", async () => {
    const { call } = harness();
    const unknown = await call("team.setChannels", {
      memberId: "nobody",
      channels: [{ channel: "telegram", senderId: "111" }],
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatchObject({ message: 'no Team member "nobody"' });

    const missing = await call("team.setChannels", { memberId: "owner" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatchObject({
      message: "channels is required: at least one { channel, senderId }",
    });
  });

  it("restores the prior identities when the projection write is rejected", async () => {
    const { call, store } = harness();
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "111", addedAt: 1 }],
    });
    (writeTeamProjection as Mock).mockRejectedValueOnce(new Error("rejected"));
    const result = await call("team.setChannels", {
      memberId: "owner",
      channels: [{ channel: "whatsapp", senderId: "+919800000000" }],
    });
    expect(result.ok).toBe(false);
    expect((await store.getMember("owner"))?.channels).toEqual([
      { channel: "telegram", senderId: "111", addedAt: 1 },
    ]);
  });
});

describe("team.remove", () => {
  it("removes a member, projects the roster, revokes their pairing entries and emits changed", async () => {
    const { call, store, emit } = harness();
    await store.seedOwner({ id: "owner", name: "Owner", addedBy: "owner", channels: [] });
    await store.addMember({
      id: "ramesh",
      name: "Ramesh",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
    });
    (writeTeamProjection as Mock).mockClear();
    (revokePairingEntries as Mock).mockClear();
    emit.mockClear();

    const result = await call("team.remove", { memberId: "ramesh" });

    expect(result.ok).toBe(true);
    expect(await store.getMember("ramesh")).toBeUndefined();
    expect(writeTeamProjection).toHaveBeenCalledOnce();
    expect(revokePairingEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        identities: [expect.objectContaining({ channel: "telegram", senderId: "5551234" })],
      }),
    );
    expect(emit).toHaveBeenCalledWith("changed", { team: true });
  });

  it("reports a pairing-store cleanup that did not complete, and still commits the removal", async () => {
    const { call, store } = harness();
    await store.seedOwner({ id: "owner", name: "Owner", addedBy: "owner", channels: [] });
    await store.addMember({
      id: "ramesh",
      name: "Ramesh",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
    });
    (revokePairingEntries as Mock).mockClear();
    (revokePairingEntries as Mock).mockResolvedValueOnce({
      warnings: ["Could not clear the telegram pairing approval for 5551234"],
    });

    const result = await call("team.remove", { memberId: "ramesh" });

    expect(result.ok).toBe(true);
    expect((result.result as { warnings: string[] }).warnings).toEqual([
      "Could not clear the telegram pairing approval for 5551234",
    ]);
    expect(await store.getMember("ramesh")).toBeUndefined();
  });

  it("refuses to remove an unknown member", async () => {
    const { call } = harness();
    const result = await call("team.remove", { memberId: "nobody" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ message: 'no Team member "nobody"' });
  });

  it("rolls back the removed member when the projection write is rejected", async () => {
    const { call, store } = harness();
    await store.seedOwner({ id: "owner", name: "Owner", addedBy: "owner", channels: [] });
    const ramesh = await store.addMember({
      id: "ramesh",
      name: "Ramesh",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
    });
    (writeTeamProjection as Mock).mockRejectedValueOnce(new Error("config write rejected"));

    const result = await call("team.remove", { memberId: "ramesh" });

    expect(result.ok).toBe(false);
    expect(await store.getMember("ramesh")).toEqual(ramesh);
  });
});

describe("team.transferOwnership", () => {
  it("swaps the owner role and projects the roster", async () => {
    const { call, store, emit } = harness();
    await store.seedOwner({ id: "owner", name: "Owner", addedBy: "owner", channels: [] });
    await store.addMember({ id: "ramesh", name: "Ramesh", addedBy: "owner", channels: [] });
    emit.mockClear();

    const result = await call("team.transferOwnership", { memberId: "ramesh" });

    expect(result.ok).toBe(true);
    expect((await store.ownerMember())?.id).toBe("ramesh");
    expect(emit).toHaveBeenCalledWith("changed", { team: true });
  });

  it("restores both roles when the projection write is rejected", async () => {
    const { call, store } = harness();
    await store.seedOwner({ id: "owner", name: "Owner", addedBy: "owner", channels: [] });
    await store.addMember({ id: "ramesh", name: "Ramesh", addedBy: "owner", channels: [] });
    (writeTeamProjection as Mock).mockRejectedValueOnce(new Error("config write rejected"));

    const result = await call("team.transferOwnership", { memberId: "ramesh" });

    expect(result.ok).toBe(false);
    expect((await store.ownerMember())?.id).toBe("owner");
    expect((await store.getMember("ramesh"))?.role).toBe("member");
  });
});

describe("team.* authority", () => {
  it("registers every mutating method at operator.admin, and the read methods at operator.read/admin", () => {
    const { methods } = harness();
    for (const method of [
      "team.add",
      "team.setChannels",
      "team.remove",
      "team.transferOwnership",
      "team.owner.set",
    ]) {
      expect(methods.get(method)?.scope).toBe("operator.admin");
    }
    expect(methods.get("team.get")?.scope).toBe("operator.read");
    expect(methods.get("team.member.get")?.scope).toBe("operator.admin");
    expect(methods.get("team.owner.get")?.scope).toBe("operator.admin");
  });

  it("team.add refuses before writing anything when authority is already lost", async () => {
    const { call, store } = harness({ config: deskFixtureConfig() });
    await call("team.owner.set", { channel: "telegram", target: "111" });

    const result = await call(
      "team.add",
      { name: "Ramesh", channels: [{ channel: "telegram", senderId: "5551234" }] },
      { hasCurrentClientAuthority: () => false },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      message: "your session is no longer authorized — reconnect and try again",
    });
    expect((await store.listMembers()).map((m) => m.id)).toEqual(["owner"]);
  });

  it("refuses the durable projection write when the admin connection lost authority mid-request", async () => {
    const { call, store } = harness();
    await store.seedOwner({ id: "owner", name: "Owner", addedBy: "owner", channels: [] });
    await store.addMember({ id: "ramesh", name: "Ramesh", addedBy: "owner", channels: [] });

    const before = await store.listMembers();

    const result = await call(
      "team.transferOwnership",
      { memberId: "ramesh" },
      { hasCurrentClientAuthority: () => false },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      message: "your session is no longer authorized — reconnect and try again",
    });
    expect(await store.listMembers()).toEqual(before);
    expect((await store.ownerMember())?.id).toBe("owner");
  });
});
