/**
 * The `duties.team.*` Gateway RPC surface, split out of `gateway-methods.ts` to keep both files
 * under the extensions max-lines budget — the same split `runner-template-deliver.test.ts` got from
 * `runner.test.ts`: one cohesive block moved whole, no behavior change.
 *
 * `gateway-methods.ts` stays the owner of the `register` closure, the live-authority re-check and
 * the shared param readers — the Duty methods use them too — and hands them in. The one helper that
 * crosses back the other way is `persistSeededOwner`, which `duties.settings.set` also calls, so it
 * is returned rather than duplicated.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { OpenClawPluginApi } from "../api.js";
import type { Ctx, Scope } from "./gateway-methods.js";
import type { DutyStore } from "./store.js";
import { provisionMemberAgent, readBootstrapPending, type GatewayRequest } from "./team-agent.js";
import { revokePairingEntries, writeTeamProjection } from "./team-write.js";
import {
  assertTeamProjectionSafe,
  normalizeTeamMemberId,
  teamPolicyWarnings,
  type TeamChannelIdentity,
  type TeamMember,
} from "./team.js";

/** `gateway-methods.ts`'s own `register` closure, as it is handed to this module. */
type RegisterMethod = (
  method: string,
  scope: Scope,
  handler: (params: Record<string, unknown>, ctx: Ctx) => Promise<unknown>,
) => void;

export function registerTeamGatewayMethods(deps: {
  register: RegisterMethod;
  store: DutyStore;
  /** Trusted in-process Gateway dispatch, used here only to provision a member's agent. */
  request: GatewayRequest;
  api: OpenClawPluginApi;
  currentConfig: () => OpenClawConfig;
  assertStillAuthorized: (ctx: Ctx) => void;
  holdsAdminScope: (ctx: Ctx) => boolean;
  readMemberId: (params: Record<string, unknown>) => string;
  readIdentities: (value: unknown) => TeamChannelIdentity[];
  safeEmit: (name: "changed" | "run", payload: Record<string, unknown>) => void;
}): {
  persistSeededOwner: (
    ctx: Ctx,
    owner?: { channel: string; target: string },
  ) => Promise<TeamMember | undefined>;
} {
  const {
    register,
    store,
    request,
    api,
    currentConfig,
    assertStillAuthorized,
    holdsAdminScope,
    readMemberId,
    readIdentities,
    safeEmit,
  } = deps;

  /** One shape for both the seeded and the already-populated answer, so the Team card never sees
   *  two different payloads. `warnings` is the non-throwing read: a warning is information, and
   *  `duties.team.get` is `operator.read`, so it must never refuse.
   *
   *  A channel's `senderId` is a channel-ingress identity — PII, and exactly what `team_list`'s own
   *  contract says "stays with operator.admin" — so it is withheld from a caller that does not hold
   *  admin (final review I2). `channel`, `accountId` and `addedAt` stay: they are operator-chosen
   *  routing labels, not anybody's identity, and the Control UI needs `accountId` to send a member's
   *  identity list back unchanged. */
  const teamView = async (members: TeamMember[], canSeeIdentities: boolean) => ({
    members: await Promise.all(
      members.map(async (member) => ({
        ...member,
        channels: member.channels.map(({ senderId, ...rest }) =>
          canSeeIdentities ? { ...rest, senderId } : rest,
        ),
        bootstrapPending: await readBootstrapPending(member.agentWorkspace),
      })),
    ),
    warnings: teamPolicyWarnings(currentConfig(), members),
  });

  /** The owner row as it WOULD be seeded from `settings.owner`, without writing anything.
   *
   *  The owner is a Team member from the start: the Duties owner target already names a channel and
   *  a target, and that IS an owner identity, so it is promoted rather than asked for twice. Undefined
   *  when no owner target is set (a brand-new desk) — there is nothing to promote yet. */
  const seedOwnerCandidate = async (owner?: { channel: string; target: string }) => {
    const target = owner ?? (await store.getSettings()).owner;
    if (!target) {
      return undefined;
    }
    const agentId = resolveAgentRoute({
      cfg: currentConfig(),
      channel: target.channel,
      peer: { kind: "direct", id: target.target },
    }).agentId;
    return {
      id: "owner",
      name: "Owner",
      agentId,
      addedBy: "owner",
      channels: [{ channel: target.channel, senderId: target.target, addedAt: Date.now() }],
    };
  };

  /**
   * Writes the owner row when the roster is still empty, and nothing otherwise.
   *
   * Reachable ONLY from `operator.admin` handlers, which is the point: the plan's invariant is that
   * nothing creates a roster row except an owner action, and `duties.team.get` — a read — used to
   * create one just by being called (final review I1). So the read now composes the same row in
   * memory and this helper is what persists it, on the first owner action that needs a real row to
   * hang a member, an identity or an ownership transfer off.
   */
  const persistSeededOwner = async (
    ctx: Ctx,
    owner?: { channel: string; target: string },
  ): Promise<TeamMember | undefined> => {
    if ((await store.listMembers()).length > 0) {
      return await store.ownerMember();
    }
    const candidate = await seedOwnerCandidate(owner);
    if (!candidate) {
      return undefined;
    }
    // A seed is a durable effect: re-check live authority immediately before it, the same as any
    // other write this module performs.
    assertStillAuthorized(ctx);
    return await store.seedOwner(candidate);
  };

  register("duties.team.get", "operator.read", async (_params, ctx) => {
    const canSeeIdentities = holdsAdminScope(ctx);
    const existing = await store.listMembers();
    if (existing.length > 0) {
      return await teamView(existing, canSeeIdentities);
    }
    const candidate = await seedOwnerCandidate();
    if (!candidate) {
      return { members: [], warnings: [] };
    }
    // Seeded for this answer only: the caller sees the single-owner roster it will get, and a read
    // at any scope leaves the store exactly as it found it. The row is written the first time an
    // admin-scoped Team write needs it (`persistSeededOwner`).
    const now = Date.now();
    return await teamView(
      [{ ...candidate, role: "owner", addedAt: now, updatedAt: now }],
      canSeeIdentities,
    );
  });

  register("duties.team.add", "operator.admin", async (params, ctx) => {
    if (typeof params.name !== "string" || !params.name.trim()) {
      throw new Error("name is required");
    }
    const name = params.name.trim();
    const memberId =
      typeof params.id === "string" && params.id.trim()
        ? normalizeTeamMemberId(params.id)
        : normalizeTeamMemberId(name.replace(/\s+/g, "-"));
    const channels = readIdentities(params.channels);
    if (await store.getMember(memberId)) {
      throw new Error(`Team already has a member "${memberId}"`);
    }
    assertStillAuthorized(ctx);
    const owner = (await store.ownerMember()) ?? (await persistSeededOwner(ctx));
    if (!owner) {
      throw new Error("set the owner on the Duties page before adding anyone else");
    }

    // The safety check runs BEFORE the agent is provisioned, even though `writeTeamProjection` runs
    // it again against the snapshot it is about to write: it is pure and free, while provisioning is
    // neither, and a refusal after provisioning left a stranded agent whose name the owner could
    // then never reuse for the same real person (final review I3). It needs only the config and the
    // roster this add would produce — never the agent — so nothing about it has to wait.
    const prospective: TeamMember[] = [
      ...(await store.listMembers()),
      {
        id: memberId,
        name,
        role: "member",
        // Placeholder: core chooses the real agent id in `provisionMemberAgent` below, and the
        // safety check never reads this field (only `channels`, and `role` for ordering).
        agentId: memberId,
        channels,
        addedBy: owner.id,
        addedAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
    assertTeamProjectionSafe(currentConfig(), prospective);

    // Ordering matters: `pickFirstExistingAgentId` (src/routing/resolve-route.ts:147-173) throws
    // AgentSelectionRequiredError when a binding names an agent that is absent from
    // `agents.entries`, so the agent is created and read back BEFORE the projection runs.
    const agent = await provisionMemberAgent({ request, name });

    const member = await store.addMember({
      id: memberId,
      name,
      agentId: agent.agentId,
      ...(agent.workspace ? { agentWorkspace: agent.workspace } : {}),
      channels,
      addedBy: owner.id,
    });
    try {
      const { warnings } = await writeTeamProjection({
        members: await store.listMembers(),
        assertStillAuthorized: () => assertStillAuthorized(ctx),
      });
      safeEmit("changed", { team: true });
      return { ok: true, member, warnings };
    } catch (error) {
      // A rejected config write must not leave a roster row nothing enforces. The agent stays —
      // it is already created, and deleting it here would be the data loss GC1 rules out.
      await store.removeMember(memberId).catch(() => undefined);
      throw error;
    }
  });

  register("duties.team.setChannels", "operator.admin", async (params, ctx) => {
    const memberId = readMemberId(params);
    const identities = readIdentities(params.channels);
    // The owner row may still be the read path's in-memory seed (final review I1) — an owner adding
    // their own second channel is the first write that needs it to be real.
    await persistSeededOwner(ctx);
    const before = await store.getMember(memberId);
    if (!before) {
      throw new Error(`no Team member "${memberId}"`);
    }
    const member = await store.setMemberChannels(memberId, identities);
    const members = await store.listMembers();
    let warnings: string[];
    try {
      ({ warnings } = await writeTeamProjection({
        members,
        assertStillAuthorized: () => assertStillAuthorized(ctx),
      }));
    } catch (error) {
      // The channel write above already landed durably; a rejected projection (lost authority, an
      // assertTeamProjectionSafe refusal, a failed config write) must not leave it standing — a
      // config write is all-or-nothing, and so is this row. Same rollback shape as
      // `duties.team.add`'s own `store.removeMember(memberId).catch(() => undefined)`.
      await store.restoreMember(before).catch(() => undefined);
      throw error;
    }
    // An identity the member no longer has must lose its pairing-store approval too, or the
    // channel would keep admitting it independently of the allowlist.
    const dropped = before.channels.filter(
      (old) =>
        !identities.some((next) => next.channel === old.channel && next.senderId === old.senderId),
    );
    const revoked = await revokePairingEntries({
      runtime: api.runtime,
      cfg: currentConfig(),
      identities: dropped,
    });
    safeEmit("changed", { team: true });
    return { ok: true, member, warnings: [...warnings, ...revoked.warnings] };
  });

  register("duties.team.remove", "operator.admin", async (params, ctx) => {
    const memberId = readMemberId(params);
    await persistSeededOwner(ctx);
    const member = await store.getMember(memberId);
    if (!member) {
      throw new Error(`no Team member "${memberId}"`);
    }
    // GC1: the row, the access-group entries, the links and the bindings go now. The agent and its
    // workspace stay — removal revokes access, it does not destroy a conversation.
    await store.removeMember(memberId);
    const members = await store.listMembers();
    let warnings: string[];
    try {
      ({ warnings } = await writeTeamProjection({
        members,
        assertStillAuthorized: () => assertStillAuthorized(ctx),
      }));
    } catch (error) {
      // The removal above already landed durably; a rejected projection must not leave it
      // standing, so the row goes back exactly as it was. Same rollback shape as
      // `duties.team.add`'s own `store.removeMember(memberId).catch(() => undefined)`.
      await store.restoreMember(member).catch(() => undefined);
      throw error;
    }
    const revoked = await revokePairingEntries({
      runtime: api.runtime,
      cfg: currentConfig(),
      identities: member.channels,
    });
    safeEmit("changed", { team: true });
    return { ok: true, removed: member, warnings: [...warnings, ...revoked.warnings] };
  });

  register("duties.team.transferOwnership", "operator.admin", async (params, ctx) => {
    const memberId = readMemberId(params);
    await persistSeededOwner(ctx);
    // Snapshotted before the role swap below so a rejected projection can put both rows back
    // exactly as they were, not just report failure while the swap stands.
    const beforeOwner = await store.ownerMember();
    const beforeTarget = await store.getMember(memberId);
    const { from, to } = await store.transferOwnership(memberId);
    const members = await store.listMembers();
    let warnings: string[];
    try {
      ({ warnings } = await writeTeamProjection({
        members,
        assertStillAuthorized: () => assertStillAuthorized(ctx),
      }));
    } catch (error) {
      // The role swap above already landed durably on both rows; a rejected projection must not
      // leave a stuck ownership transfer standing — the worst-case outcome this guard exists to
      // prevent. Same rollback shape as `duties.team.add`'s own
      // `store.removeMember(memberId).catch(() => undefined)`.
      if (beforeOwner) {
        await store.restoreMember(beforeOwner).catch(() => undefined);
      }
      if (beforeTarget) {
        await store.restoreMember(beforeTarget).catch(() => undefined);
      }
      throw error;
    }
    // Approvals, questions and `to: "owner"` now resolve to the new owner, because `ownerTarget`
    // reads the owner row. Nothing else moves: the outgoing owner keeps their identities, their
    // access-group entries, their agent and their sessions.
    safeEmit("changed", { team: true, settings: true });
    return { ok: true, from, to, warnings };
  });

  return { persistSeededOwner };
}
