import { describe, expect, it, vi, type Mock } from "vitest";
import { deskFixtureConfig, harness } from "./gateway-methods.test-helpers.js";
import { revokePairingEntries, writeTeamProjection } from "./team-write.js";
import type { TeamMember } from "./team.js";

/** The tests in Tasks 2 and 3 call `writeTeamProjection`, which reads and writes the real config
 *  file. Stub it here so no test in this suite touches `~/.openclaw/openclaw.json`; the projection
 *  itself is proved directly, without mocks, in `team.test.ts` (and its own test file once added).
 *  The stub still invokes the caller's `assertStillAuthorized`, exactly where the real
 *  implementation calls it (synchronously, immediately before its config write) — so a test can
 *  prove the live-authority guard is wired into each `duties.team.*` handler without this suite
 *  ever touching a real config file. */
vi.mock("./team-write.js", () => ({
  writeTeamProjection: vi.fn(
    async (params: { members: unknown; assertStillAuthorized: () => void }) => {
      params.assertStillAuthorized();
      return { warnings: [], config: {} };
    },
  ),
  revokePairingEntries: vi.fn(async () => ({ warnings: [] })),
}));

describe("duties.team.get", () => {
  it("registers at operator.read", async () => {
    const { methods } = harness();
    expect(methods.get("duties.team.get")?.scope).toBe("operator.read");
  });

  it("returns an empty roster until the owner target is set", async () => {
    const { call } = harness();
    const result = await call("duties.team.get", {});
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ members: [], warnings: [] });
  });

  it("seeds one owner row from DutiesSettings.owner and is idempotent", async () => {
    const { call, asAdmin } = harness({ config: deskFixtureConfig() });
    await call("duties.settings.set", { owner: { channel: "telegram", target: "111" } }, asAdmin);

    const first = await call("duties.team.get", {}, asAdmin);
    expect(first.ok).toBe(true);
    const firstMembers = (first.result as { members: TeamMember[] }).members;
    expect(firstMembers).toHaveLength(1);
    expect(firstMembers[0]).toMatchObject({
      id: "owner",
      role: "owner",
      agentId: "krishna",
      channels: [{ channel: "telegram", senderId: "111" }],
    });

    const second = await call("duties.team.get", {}, asAdmin);
    const secondMembers = (second.result as { members: TeamMember[] }).members;
    expect(secondMembers).toHaveLength(1);
    expect(secondMembers[0]?.addedAt).toBe(firstMembers[0]?.addedAt);
  });

  it("writes no roster row on a read, and answers the seeded owner view anyway (I1)", async () => {
    // `duties.team.get` is registered `operator.read` and used to call `store.seedOwner` — a durable
    // write any read-scope caller (the `team_list` tool included) could trigger just by reading.
    // The owner row it composes for the answer is now in-memory only.
    const { call, store, asAdmin } = harness({ config: deskFixtureConfig() });
    await store.updateSettings({ owner: { channel: "telegram", target: "111" } });

    const read = await call("duties.team.get", {}, asAdmin);
    expect((read.result as { members: TeamMember[] }).members).toMatchObject([
      { id: "owner", role: "owner", agentId: "krishna" },
    ]);
    expect(await store.listMembers()).toEqual([]);

    // The first admin-scoped Team write is what persists it, so a member has a real owner row to
    // hang off.
    const request = vi.fn(async () => ({ ok: true, agentId: "ramesh", workspace: "/w/ramesh" }));
    const h = harness({ config: deskFixtureConfig(), request });
    await h.store.updateSettings({ owner: { channel: "telegram", target: "111" } });
    await h.call("duties.team.get", {}, h.asAdmin);
    expect(await h.store.listMembers()).toEqual([]);
    const added = await h.call(
      "duties.team.add",
      { name: "Ramesh", channels: [{ channel: "telegram", senderId: "5551234" }] },
      h.asAdmin,
    );
    expect(added.ok).toBe(true);
    expect((await h.store.listMembers()).map((m) => m.id)).toEqual(["owner", "ramesh"]);
  });

  it("withholds every sender id from a caller without operator.admin (I2)", async () => {
    const { call, store, asAdmin } = harness({ config: deskFixtureConfig() });
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      agentId: "krishna",
      addedBy: "owner",
      channels: [
        { channel: "telegram", senderId: "111", addedAt: 1 },
        { channel: "whatsapp", senderId: "+919800000000", accountId: "work", addedAt: 1 },
      ],
    });

    const read = await call("duties.team.get", {}, { scopes: ["operator.read"] });
    const readMembers = (read.result as { members: TeamMember[] }).members;
    // The channel and its account id stay — they are routing labels, not anybody's identity, and
    // nothing downstream can reconstruct a sender id from them.
    expect(readMembers[0]?.channels).toEqual([
      { channel: "telegram", addedAt: 1 },
      { channel: "whatsapp", accountId: "work", addedAt: 1 },
    ]);
    expect(JSON.stringify(read.result)).not.toContain("+919800000000");
    expect(JSON.stringify(read.result)).not.toContain('"111"');

    // Admin still gets them in full: `addTeamChannel` sends the whole identity list back.
    const admin = await call("duties.team.get", {}, asAdmin);
    expect((admin.result as { members: TeamMember[] }).members[0]?.channels).toEqual([
      { channel: "telegram", senderId: "111", addedAt: 1 },
      { channel: "whatsapp", senderId: "+919800000000", accountId: "work", addedAt: 1 },
    ]);
  });

  it("duties.settings.set { owner } moves the owner row's first identity", async () => {
    const { call, store } = harness({ config: deskFixtureConfig() });
    await call("duties.settings.set", { owner: { channel: "telegram", target: "111" } });
    await call("duties.team.get", {});

    await call("duties.settings.set", {
      owner: { channel: "whatsapp", target: "+919800000000" },
    });
    const owner = await store.ownerMember();
    expect(owner?.channels[0]).toMatchObject({ channel: "whatsapp", senderId: "+919800000000" });
    expect(owner?.role).toBe("owner");
  });
});

describe("duties.team.add", () => {
  it("creates the agent first, then writes the roster row with the id core chose", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "agents.create") {
        throw new Error(`unexpected ${method}`);
      }
      return { ok: true, agentId: "ramesh", name: "Ramesh", workspace: "/w/ramesh" };
    });
    const h = harness({ config: deskFixtureConfig(), request });
    await h.call("duties.settings.set", { owner: { channel: "telegram", target: "111" } });
    await h.call("duties.team.get", {});
    const added = await h.call("duties.team.add", {
      name: "Ramesh",
      channels: [{ channel: "telegram", senderId: "5551234" }],
    });
    expect(added.ok).toBe(true);
    expect(request).toHaveBeenCalledWith("agents.create", { name: "Ramesh" });
    expect((added.result as { member: TeamMember }).member).toMatchObject({
      id: "ramesh",
      role: "member",
      agentId: "ramesh",
      agentWorkspace: "/w/ramesh",
      addedBy: "owner",
    });
    expect((await h.store.listMembers()).map((m) => m.id)).toEqual(["owner", "ramesh"]);
  });

  it("writes no roster row when the agent could not be created", async () => {
    const request = vi.fn(async () => {
      throw new Error("agent already exists: ramesh");
    });
    const h = harness({ config: deskFixtureConfig(), request });
    await h.call("duties.settings.set", { owner: { channel: "telegram", target: "111" } });
    await h.call("duties.team.get", {});
    const result = await h.call("duties.team.add", {
      name: "Ramesh",
      channels: [{ channel: "telegram", senderId: "5551234" }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      message: expect.stringContaining('There is already an agent called "Ramesh"'),
    });
    expect((await h.store.listMembers()).map((m) => m.id)).toEqual(["owner"]);
  });

  it("refuses an unsafe channel config before provisioning anything, so the same name still works after the fix (I3)", async () => {
    // A desk whose whatsapp channel has no channel-wide binding: `assertTeamProjectionSafe` refuses
    // the projection. It used to refuse AFTER `agents.create` had already made the agent, so the
    // retry hit an agent-id collision and the owner had to rename a real person to work around a
    // channel-config problem.
    const config = deskFixtureConfig();
    config.bindings = [{ agentId: "krishna", match: { channel: "telegram", accountId: "*" } }];
    const request = vi.fn(async (method: string) => {
      if (method !== "agents.create") {
        throw new Error(`unexpected ${method}`);
      }
      return { ok: true, agentId: "ramesh", name: "Ramesh", workspace: "/w/ramesh" };
    });
    const h = harness({ config, request });
    await h.call(
      "duties.settings.set",
      { owner: { channel: "telegram", target: "111" } },
      h.asAdmin,
    );

    const refused = await h.call(
      "duties.team.add",
      { name: "Ramesh", channels: [{ channel: "whatsapp", senderId: "+919812345678" }] },
      h.asAdmin,
    );
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatchObject({
      message: expect.stringContaining("whatsapp has no channel-wide binding"),
    });
    // No agent was created, so nothing is stranded and no name is burned.
    expect(request).not.toHaveBeenCalled();
    expect((await h.store.listMembers()).map((m) => m.id)).toEqual(["owner"]);

    // With the channel fixed, the SAME name goes through.
    config.bindings = [
      ...(config.bindings ?? []),
      { agentId: "krishna", match: { channel: "whatsapp", accountId: "*" } },
    ];
    const retried = await h.call(
      "duties.team.add",
      { name: "Ramesh", channels: [{ channel: "whatsapp", senderId: "+919812345678" }] },
      h.asAdmin,
    );
    expect(retried.ok).toBe(true);
    expect(request).toHaveBeenCalledWith("agents.create", { name: "Ramesh" });
    expect((await h.store.listMembers()).map((m) => m.id)).toEqual(["owner", "ramesh"]);
  });

  it("refuses an add with no channel identity", async () => {
    const h = harness({ config: deskFixtureConfig(), request: vi.fn() });
    const result = await h.call("duties.team.add", { name: "Ramesh", channels: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      message: expect.stringContaining("channels is required"),
    });
  });
});

describe("duties.team.setChannels", () => {
  it("replaces a member's identities, projects the roster and revokes the dropped pairing entry", async () => {
    const { call, store } = harness();
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      agentId: "krishna",
      addedBy: "owner",
      channels: [],
    });
    await store.addMember({
      id: "ramesh",
      name: "Ramesh",
      agentId: "ramesh",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
    });
    (writeTeamProjection as Mock).mockClear();
    (revokePairingEntries as Mock).mockClear();

    const result = await call("duties.team.setChannels", {
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
    // A non-empty, otherwise-valid channels array, so this actually exercises the unknown-member
    // check rather than tripping the earlier "channels is required" validation.
    const unknown = await call("duties.team.setChannels", {
      memberId: "nobody",
      channels: [{ channel: "telegram", senderId: "111" }],
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatchObject({ message: 'no Team member "nobody"' });

    const missing = await call("duties.team.setChannels", { memberId: "owner" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatchObject({
      message: "channels is required: at least one { channel, senderId }",
    });
  });
});

describe("duties.team.remove", () => {
  it("removes a member, projects the roster, revokes their pairing entries and emits changed", async () => {
    const { call, store, emit } = harness();
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      agentId: "krishna",
      addedBy: "owner",
      channels: [],
    });
    await store.addMember({
      id: "ramesh",
      name: "Ramesh",
      agentId: "ramesh",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
    });
    (writeTeamProjection as Mock).mockClear();
    (revokePairingEntries as Mock).mockClear();
    emit.mockClear();

    const result = await call("duties.team.remove", { memberId: "ramesh" });

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

  it("reports a pairing-store cleanup that did not complete, and still commits the removal (I4)", async () => {
    const { call, store } = harness();
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      agentId: "krishna",
      addedBy: "owner",
      channels: [],
    });
    await store.addMember({
      id: "ramesh",
      name: "Ramesh",
      agentId: "ramesh",
      addedBy: "owner",
      channels: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
    });
    (revokePairingEntries as Mock).mockClear();
    (revokePairingEntries as Mock).mockResolvedValueOnce({
      warnings: ["Could not clear the telegram pairing approval for 5551234"],
    });

    const result = await call("duties.team.remove", { memberId: "ramesh" });

    // The config write landed, so this is a success with a warning — not a failure. A silently
    // swallowed cleanup failure used to report a clean `ok: true` while the removed member could
    // still reach Vasu through the pairing store.
    expect(result.ok).toBe(true);
    expect((result.result as { warnings: string[] }).warnings).toEqual([
      "Could not clear the telegram pairing approval for 5551234",
    ]);
    expect(await store.getMember("ramesh")).toBeUndefined();
  });

  it("refuses to remove an unknown member", async () => {
    const { call } = harness();
    const result = await call("duties.team.remove", { memberId: "nobody" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ message: 'no Team member "nobody"' });
  });
});

describe("duties.team.transferOwnership", () => {
  it("swaps the owner role, projects the roster and emits changed + settings", async () => {
    const { call, store, emit } = harness();
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      agentId: "krishna",
      addedBy: "owner",
      channels: [],
    });
    await store.addMember({
      id: "ramesh",
      name: "Ramesh",
      agentId: "ramesh",
      addedBy: "owner",
      channels: [],
    });
    emit.mockClear();

    const result = await call("duties.team.transferOwnership", { memberId: "ramesh" });

    expect(result.ok).toBe(true);
    expect((await store.ownerMember())?.id).toBe("ramesh");
    expect(emit).toHaveBeenCalledWith("changed", { team: true, settings: true });
  });
});

describe("duties.team.* authority", () => {
  it("registers every mutating method at operator.admin, and the read method at operator.read", () => {
    const { methods } = harness();
    for (const method of [
      "duties.team.add",
      "duties.team.setChannels",
      "duties.team.remove",
      "duties.team.transferOwnership",
    ]) {
      expect(methods.get(method)?.scope).toBe("operator.admin");
    }
    expect(methods.get("duties.team.get")?.scope).toBe("operator.read");
  });

  it("duties.team.add refuses before provisioning an agent when authority is already lost", async () => {
    const request = vi.fn(async () => ({ ok: true, agentId: "ramesh", workspace: "/w/ramesh" }));
    const h = harness({ config: deskFixtureConfig(), request });
    await h.call("duties.settings.set", { owner: { channel: "telegram", target: "111" } });
    await h.call("duties.team.get", {});

    const result = await h.call(
      "duties.team.add",
      { name: "Ramesh", channels: [{ channel: "telegram", senderId: "5551234" }] },
      { hasCurrentClientAuthority: () => false },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      message: "your session is no longer authorized — reconnect and try again",
    });
    // The guard fires before `agents.create` is dispatched, so a lost-authority request never
    // provisions an agent nobody will be able to reach through the roster.
    expect(request).not.toHaveBeenCalled();
    expect((await h.store.listMembers()).map((m) => m.id)).toEqual(["owner"]);
  });

  it("rolls back the roster row when authority is lost between provisioning the agent and writing the projection", async () => {
    // Authority is still live at the upfront `assertStillAuthorized(ctx)` check (the previous test
    // covers that guard), so this request gets past it, past `provisionMemberAgent`, and past
    // `store.addMember` — the roster row is written durably — before `writeTeamProjection`'s own
    // internal re-check sees it has been lost, exactly as `duties.team.transferOwnership`'s
    // "refuses the durable projection write..." test below does for that method. This proves the
    // `store.removeMember` rollback in the handler's `catch` block actually fires, not just that
    // its code shape looks right.
    let authorized = true;
    const request = vi.fn(async (method: string) => {
      if (method !== "agents.create") {
        throw new Error(`unexpected ${method}`);
      }
      authorized = false;
      return { ok: true, agentId: "ramesh", name: "Ramesh", workspace: "/w/ramesh" };
    });
    const h = harness({ config: deskFixtureConfig(), request });
    await h.call("duties.settings.set", { owner: { channel: "telegram", target: "111" } });
    await h.call("duties.team.get", {});

    const result = await h.call(
      "duties.team.add",
      { name: "Ramesh", channels: [{ channel: "telegram", senderId: "5551234" }] },
      { hasCurrentClientAuthority: () => authorized },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({
      message: "your session is no longer authorized — reconnect and try again",
    });
    // The roster row `store.addMember` wrote is gone — the rollback undid it, rather than leaving
    // a member nothing enforces because the config write that was supposed to admit them failed.
    expect((await h.store.listMembers()).map((m) => m.id)).toEqual(["owner"]);
  });

  it("refuses the durable projection write when the admin connection lost authority mid-request", async () => {
    const { call, store } = harness();
    await store.seedOwner({
      id: "owner",
      name: "Owner",
      agentId: "krishna",
      addedBy: "owner",
      channels: [],
    });
    await store.addMember({
      id: "ramesh",
      name: "Ramesh",
      agentId: "ramesh",
      addedBy: "owner",
      channels: [],
    });

    // Snapshotted before the rejected call so the roster row can be proved untouched afterward —
    // not just that the RPC reported an error. A stuck ownership transfer (the store write landing
    // durably while the RPC reports failure) is the worst-case outcome this guard exists to
    // prevent.
    const before = await store.listMembers();

    const result = await call(
      "duties.team.transferOwnership",
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
