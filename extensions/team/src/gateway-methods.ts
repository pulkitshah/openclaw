import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
/**
 * The `team.*` Gateway RPC surface: this plugin's whole write path, plus the two read-only methods
 * (`team.member.get`, `team.owner.get`) other plugins (Duties' `adapters/deliver.ts`, its
 * `ownerTarget()`) call in-process instead of importing this plugin's private `src/` — the sanctioned
 * cross-plugin seam every plugin in this codebase uses (`src/plugin-sdk/gateway-method-runtime.ts`'s
 * own comment on `dispatchGatewayMethod` notwithstanding: that helper is reserved for plugin HTTP
 * routes, so `api.runtime.gateway.request` — the same in-process dispatch `extensions/duties`
 * already uses for `agents.create` and friends — is what a caller running outside an HTTP route
 * handler, like a Duty run, actually uses here).
 */
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../api.js";
import type { Ctx, Scope } from "./gateway-context.js";
import type { TeamStore } from "./store.js";
import { revokePairingEntries, writeTeamProjection } from "./team-write.js";
import {
  assertTeamProjectionSafe,
  normalizeTeamMemberId,
  teamPolicyWarnings,
  type TeamChannelIdentity,
  type TeamMember,
} from "./team.js";

export function registerTeamGatewayMethods(deps: {
  api: OpenClawPluginApi;
  store: TeamStore;
  currentConfig: () => OpenClawConfig;
  safeEmit: (name: "changed", payload: Record<string, unknown>) => void;
}): void {
  const { api, store, currentConfig, safeEmit } = deps;

  const register = (
    method: string,
    scope: Scope,
    handler: (params: Record<string, unknown>, ctx: Ctx) => Promise<unknown>,
  ) =>
    api.registerGatewayMethod(
      method,
      async (ctx: Ctx) => {
        try {
          ctx.respond(true, await handler(isRecord(ctx.params) ? ctx.params : {}, ctx));
        } catch (error) {
          ctx.respond(false, undefined, {
            code: "team_error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope },
    );

  /** Re-asserts that the admin connection that dispatched this request still holds its authority,
   *  synchronously, immediately before a durable effect. `authorizeGatewayMethod` checked the scope
   *  before the handler body ran, but the roster read and the projection both await in between — and
   *  `src/gateway/AGENTS.md` is explicit that a token or a matching id is not live authority. Absent
   *  on in-process callers, which is not a revocation. */
  const assertStillAuthorized = (ctx: Ctx): void => {
    if (ctx.hasCurrentClientAuthority?.() === false) {
      throw new Error("your session is no longer authorized — reconnect and try again");
    }
  };

  /** Whether the connection that dispatched this request holds `operator.admin`, read off the
   *  server-authenticated connection metadata the same way core's own handlers do. Used to decide
   *  what a READ method may answer, never to grant a write — the scope check `registerGatewayMethod`
   *  performs is still the authority for that. Absent scopes mean not admin: an in-process dispatch
   *  always carries the synthetic client's own scope list, so the only way to get here without one is
   *  a caller whose authority cannot be established, and the withheld field is PII. */
  const holdsAdminScope = (ctx: Ctx): boolean => {
    const scopes = ctx.client?.connect?.scopes;
    return Array.isArray(scopes) && scopes.includes("operator.admin");
  };

  const readMemberId = (params: Record<string, unknown>): string => {
    if (typeof params.memberId !== "string" || !params.memberId) {
      throw new Error("memberId is required");
    }
    return normalizeTeamMemberId(params.memberId);
  };

  /** Channel identities arrive as ordinary params, so only the known fields in the known shapes are
   *  kept. An identity with no channel or no sender id is rejected rather than stored half-formed —
   *  it would become an allowlist entry and a routing key. */
  const readIdentities = (value: unknown): TeamChannelIdentity[] => {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error("channels is required: at least one { channel, senderId }");
    }
    const now = Date.now();
    return value.map((raw, index) => {
      if (!isRecord(raw)) {
        throw new Error(`channels[${index}]: must be an object`);
      }
      const channel = typeof raw.channel === "string" ? raw.channel.trim() : "";
      const senderId = typeof raw.senderId === "string" ? raw.senderId.trim() : "";
      if (!channel) {
        throw new Error(`channels[${index}].channel is required`);
      }
      if (!senderId) {
        throw new Error(`channels[${index}].senderId is required`);
      }
      const accountId = typeof raw.accountId === "string" ? raw.accountId.trim() : "";
      return { channel, senderId, ...(accountId ? { accountId } : {}), addedAt: now };
    });
  };

  /** One shape for the roster answer, so the Team page never sees two different payloads.
   *  `warnings` is the non-throwing read: a warning is information, and `team.get` is
   *  `operator.read`, so it must never refuse.
   *
   *  A channel's `senderId` is a channel-ingress identity — PII — so it is withheld from a caller
   *  that does not hold admin. `channel`, `accountId` and `addedAt` stay: they are operator-chosen
   *  routing labels, not anybody's identity, and the Team page needs `accountId` to send a member's
   *  identity list back unchanged. */
  const teamView = (members: TeamMember[], canSeeIdentities: boolean) => ({
    members: members.map((member) => ({
      ...member,
      channels: member.channels.map(({ senderId, ...rest }) =>
        canSeeIdentities ? { ...rest, senderId } : rest,
      ),
    })),
    warnings: teamPolicyWarnings(currentConfig(), members),
  });

  register("team.get", "operator.read", async (_params, ctx) => {
    const members = await store.listMembers();
    return teamView(members, holdsAdminScope(ctx));
  });

  /** Read-only, admin-scoped: the full record (senderId included) for one member, by id. This is
   *  the contract `extensions/duties`'s `adapters/deliver.ts` calls in-process to resolve a
   *  `deliver: { to: "team:<id>" }` target, instead of importing this plugin's private store. */
  register("team.member.get", "operator.admin", async (params) => {
    const id =
      typeof params.id === "string" && params.id ? normalizeTeamMemberId(params.id) : undefined;
    if (!id) {
      throw new Error("id is required");
    }
    return { member: await store.getMember(id) };
  });

  /** Read-only, admin-scoped: the owner's own primary identity, as `{ channel, target }`. This is
   *  the contract Duties' `ownerTarget()` calls to know who its `ask`/`deliver`/notify traffic
   *  should reach, without importing this plugin's private store. */
  register("team.owner.get", "operator.admin", async () => {
    const owner = await store.ownerMember();
    const identity = owner?.channels[0];
    return {
      owner: identity ? { channel: identity.channel, target: identity.senderId } : undefined,
    };
  });

  /**
   * Sets or moves the owner's own channel identity. On an empty roster this is the bootstrap step —
   * "Tell Vasu where to reach you" — that creates the owner row; on an existing roster it moves the
   * current owner's first identity, keeping every other identity they already have. This is the one
   * method that can create a roster row from nothing, and it needs no other plugin's settings to do
   * it — Team owns "who the owner is" outright.
   */
  register("team.owner.set", "operator.admin", async (params, ctx) => {
    const channel = params.channel;
    const target = params.target;
    if (typeof channel !== "string" || !channel.trim()) {
      throw new Error("channel is required");
    }
    if (typeof target !== "string" || !target.trim()) {
      throw new Error("target is required");
    }
    const identity: TeamChannelIdentity = {
      channel: channel.trim(),
      senderId: target.trim(),
      addedAt: Date.now(),
    };
    const existingOwner = await store.ownerMember();
    assertStillAuthorized(ctx);
    const ownerRow = existingOwner
      ? await store.setMemberChannels(existingOwner.id, [
          identity,
          ...existingOwner.channels.filter((c) => c.channel !== identity.channel),
        ])
      : await store.seedOwner({
          id: "owner",
          name:
            typeof params.name === "string" && params.name.trim() ? params.name.trim() : "Owner",
          addedBy: "owner",
          channels: [identity],
        });
    if (!ownerRow) {
      // `existingOwner.id` was just read from the roster above, so `setMemberChannels` should
      // always find it; this only guards a concurrent delete of that same row mid-request.
      throw new Error("the owner row changed while updating it — try again");
    }
    let warnings: string[];
    try {
      ({ warnings } = await writeTeamProjection({
        members: await store.listMembers(),
        assertStillAuthorized: () => assertStillAuthorized(ctx),
      }));
    } catch (error) {
      // The move/seed above already landed durably; a rejected projection (lost authority, an
      // assertTeamProjectionSafe refusal, a failed config write) must not leave it standing.
      if (existingOwner) {
        await store.restoreMember(existingOwner).catch(() => undefined);
      } else {
        await store.removeSeededOwner(ownerRow.id).catch(() => undefined);
      }
      throw error;
    }
    safeEmit("changed", { team: true });
    return { ok: true, member: ownerRow, warnings };
  });

  register("team.add", "operator.admin", async (params, ctx) => {
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
    const owner = await store.ownerMember();
    if (!owner) {
      throw new Error("set the owner on the Team page before adding anyone else");
    }

    // The safety check needs only the config and the roster this add would produce — never any
    // agent — so it runs up front and free, before the durable write.
    const prospective: TeamMember[] = [
      ...(await store.listMembers()),
      {
        id: memberId,
        name,
        role: "member",
        channels,
        addedBy: owner.id,
        addedAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
    assertTeamProjectionSafe(currentConfig(), prospective);

    const member = await store.addMember({ id: memberId, name, channels, addedBy: owner.id });
    try {
      const { warnings } = await writeTeamProjection({
        members: await store.listMembers(),
        assertStillAuthorized: () => assertStillAuthorized(ctx),
      });
      safeEmit("changed", { team: true });
      return { ok: true, member, warnings };
    } catch (error) {
      // A rejected config write must not leave a roster row nothing enforces.
      await store.removeMember(memberId).catch(() => undefined);
      throw error;
    }
  });

  register("team.setChannels", "operator.admin", async (params, ctx) => {
    const memberId = readMemberId(params);
    const identities = readIdentities(params.channels);
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
      // assertTeamProjectionSafe refusal, a failed config write) must not leave it standing.
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

  register("team.remove", "operator.admin", async (params, ctx) => {
    const memberId = readMemberId(params);
    const member = await store.getMember(memberId);
    if (!member) {
      throw new Error(`no Team member "${memberId}"`);
    }
    // GC1: the row, the access-group entries, the links and the bindings go now.
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
      // standing, so the row goes back exactly as it was.
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

  register("team.transferOwnership", "operator.admin", async (params, ctx) => {
    const memberId = readMemberId(params);
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
      // leave a stuck ownership transfer standing.
      if (beforeOwner) {
        await store.restoreMember(beforeOwner).catch(() => undefined);
      }
      if (beforeTarget) {
        await store.restoreMember(beforeTarget).catch(() => undefined);
      }
      throw error;
    }
    safeEmit("changed", { team: true });
    return { ok: true, from, to, warnings };
  });
}
