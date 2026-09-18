/**
 * The agent-facing Team tools. Same shape/registration-mode discipline as
 * `extensions/duties/src/tools.ts`: each is a thin client of this plugin's own Gateway method,
 * owning no runtime state, so the `tool-discovery` re-registration copy of this plugin never
 * competes with the full copy for anything.
 *
 * `team_add`/`team_remove`/`team_transfer_ownership` call the exact same `team.*` Gateway methods
 * the Team page's own buttons call (`gateway-methods.ts`) — no parallel roster-mutation logic here.
 * That file's `assertStillAuthorized` + rollback-on-failure wrapping around `writeTeamProjection`
 * already covers this call path unchanged: a tool's `execute` reaches the Gateway method through
 * the same in-process dispatch every other in-process plugin caller uses
 * (`PluginRuntime.gateway.request` → `dispatchTrustedPluginGatewayMethod`), so a rejected write
 * rolls back the durable roster row exactly as it does for a Team-page caller. See
 * `tools.test.ts`'s "rejected write" cases for the regression proof.
 *
 * Those same three are owner-only, enforced by `assertOwnerTurn` below — real code on the execution
 * path, resolved from the turn's admission facts, not a rule written into a tool description.
 * `team_list` stays readable by every member (the owner's explicit "let everybody see everything"
 * decision), and the Control UI path is untouched: it is separately operator-authenticated.
 */
import { jsonResult } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import type { OpenClawPluginApi } from "../api.js";
import type { TeamMember } from "./team.js";

/** Never echo a channel identity's sender id back to the agent — same PII line `team_list` and
 *  `gateway-methods.ts`'s `teamView` already draw. The agent supplied the sender id itself on
 *  `team_add`, but a pairing-store approval or a later read could hand one back that it did not
 *  type in, so every tool result is scrubbed the same way regardless of which call produced it. */
function scrubMember(member: TeamMember) {
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    channels: member.channels.map((c) => ({
      channel: c.channel,
      ...(c.accountId ? { accountId: c.accountId } : {}),
    })),
  };
}

/** The turn's own admission facts, as the host resolved them for this run — never anything the
 *  model typed. `requesterSenderId` and `messageChannel` are the same inbound sender id and channel
 *  the channel's allowlist check already ran against (`direct-dm.ts` passes one `senderId` to both
 *  `direct-dm-access` and the agent turn's `SenderId`), which is why they can be compared against a
 *  roster identity at all.
 *
 *  Undefined means unknown, and unknown is never inferred from the session key, the delivery route,
 *  or anything else: a run with no inbound sender (a Duty/cron run, a local CLI turn, a spawned
 *  subagent, a heartbeat) genuinely has no person behind it, and `assertOwnerTurn` refuses rather
 *  than guessing one. Same rule core states on `AgentRuntimeIdentity.turnSourceLocal`
 *  (`src/gateway/agent-runtime-identity-token.ts`): "Explicit admission fact; omission is unknown,
 *  never inferred from session routing." */
function turnIdentity(
  ctx: OpenClawPluginToolContext,
): { channel: string; senderId: string; accountId?: string } | undefined {
  const channel = ctx.messageChannel?.trim().toLowerCase();
  const senderId = ctx.requesterSenderId?.trim();
  if (!channel || !senderId) {
    return undefined;
  }
  const accountId = ctx.agentAccountId?.trim();
  return { channel, senderId, ...(accountId ? { accountId } : {}) };
}

/** Refusals say what to do next and name nobody's sender id. The owner's NAME is fair game: every
 *  member already sees every name and role through `team_list`. */
function ownerOnlyRefusal(ownerName: string | undefined): string {
  return ownerName
    ? `Only the Team owner can change who is on the Team. Ask ${ownerName} to make this change — ` +
        `they can do it from their own chat with Vasu, or on the Team page.`
    : `Only the Team owner can change who is on the Team, and this desk has no owner on the roster ` +
        `yet. Set the owner on the Team page first.`;
}

const UNKNOWN_CALLER_REFUSAL =
  "Vasu cannot tell who is asking on this run, so it will not change who is on the Team. " +
  "The Team owner can make this change from their own chat with Vasu, or on the Team page.";

export function registerTeamTools(params: { api: OpenClawPluginApi }): void {
  const { api } = params;
  const call = <T = Record<string, unknown>>(
    method: string,
    args: Record<string, unknown>,
    scope: "operator.read" | "operator.admin",
  ) => api.runtime.gateway.request<T>(method, args, { scopes: [scope] });

  const register = (tool: AnyAgentTool) => api.registerTool(tool, { name: tool.name });

  /**
   * The owner gate for every roster-mutating tool, and the reason those three are registered as
   * tool FACTORIES rather than plain tool objects: a factory is handed the host-built
   * `OpenClawPluginToolContext` for the run it is being assembled for, which is the only place a
   * tool can read the current turn's admission facts. The gate is therefore code on the execution
   * path, not a sentence in a tool description a model can talk itself past — a non-owner turn
   * cannot reach `team.add`/`team.remove`/`team.transferOwnership` at all, whatever the model
   * decides to do with the refusal.
   *
   * Two separate facts, resolved at two separate times, on purpose:
   * - WHO is asking is captured from the turn (`turnIdentity`), fixed for the whole run, and comes
   *   from the host — not from `rawInput`, which is model-authored and must never be trusted here.
   * - WHETHER that person is the owner is read LIVE from the roster on every call, immediately
   *   before the mutating request, with no other await in between. A role read from earlier in the
   *   run is not live authority (`src/gateway/AGENTS.md`).
   *
   * This is an ADDITIONAL gate at the agent-tool surface. The `operator.admin` scope the `team.*`
   * methods themselves require is untouched and still the authority for the Control UI path, which
   * is separately operator-authenticated and deliberately not affected by this.
   */
  const assertOwnerTurn = async (ctx: OpenClawPluginToolContext): Promise<void> => {
    const identity = turnIdentity(ctx);
    if (!identity) {
      throw new Error(UNKNOWN_CALLER_REFUSAL);
    }
    const { member, ownerName } = await call<{
      member?: { id: string; name: string; role: string };
      ownerName?: string;
    }>("team.identity.resolve", identity, "operator.admin");
    if (member?.role !== "owner") {
      // A turn that matches no roster row at all lands here too: not on the roster is not the
      // owner, and the refusal must not say which of the two it was.
      throw new Error(ownerOnlyRefusal(ownerName));
    }
  };

  /** Registers one owner-gated tool. The tool itself is written exactly like an ungated one; the
   *  factory here is what binds it to the run it is assembled for, and its `execute` reaches the
   *  wrapped body only once `assertOwnerTurn` has passed. */
  const registerOwnerOnly = (tool: AnyAgentTool) =>
    api.registerTool(
      (ctx: OpenClawPluginToolContext): AnyAgentTool => ({
        ...tool,
        execute: async (toolCallId, rawInput, signal, onUpdate) => {
          await assertOwnerTurn(ctx);
          return await tool.execute(toolCallId, rawInput, signal, onUpdate);
        },
      }),
      { name: tool.name },
    );

  // Any future tool that mutates the roster must go through `registerOwnerOnly`, not `register`.
  // `team.setChannels` and `team.owner.set` have no agent tool today and are the ones to watch:
  // `setChannels` writes `allowFrom` entries exactly as `team.add` does, so exposing either through
  // plain `register` would reopen the member-admits-a-stranger hole this gate closes.
  register({
    name: "team_list",
    label: "List the Team",
    description:
      "The people Vasu takes instructions from, and which channels each of them is on. Use it to " +
      'pick a real `to: "team:<id>"` target for a deliver step instead of inventing an id. Read only.',
    parameters: Type.Object({}),
    execute: async () => {
      const { members } = await call<{ members: TeamMember[] }>("team.get", {}, "operator.read");
      // Names, ids, roles and which channels each person has — never the sender ids themselves.
      // Those are declared PII by the channel ingress identities and stay with operator.admin.
      return jsonResult(
        members.map((member) => ({
          id: member.id,
          name: member.name,
          role: member.role,
          channels: member.channels.map((c) => ({ channel: c.channel })),
        })),
      );
    },
  });

  registerOwnerOnly({
    name: "team_add",
    label: "Add a Team member",
    description:
      "Add a person to the Team with the channel identity/identities they'll use to reach Vasu " +
      "(e.g. their WhatsApp number or Telegram user id). If one of those identities already has a " +
      "pending pairing request, it is approved as part of this same call. This is the correct way " +
      "to add someone to the Team — do not try to reach the same result by editing channel " +
      "allowlists, config, or pairing state directly. Only the Team owner may call it; for anyone " +
      "else it refuses, and the answer is to ask the owner rather than to try another route.",
    parameters: Type.Object({
      name: Type.String({ description: "The person's display name." }),
      id: Type.Optional(
        Type.String({ description: "Roster id. Defaults to a kebab-case slug of name." }),
      ),
      channels: Type.Array(
        Type.Object({
          channel: Type.String({ description: 'Channel id, e.g. "whatsapp" or "telegram".' }),
          senderId: Type.String({
            description: "Their identifier on that channel (phone number, user id, etc.).",
          }),
          accountId: Type.Optional(
            Type.String({
              description: "Which of this desk's accounts on that channel, if more than one.",
            }),
          ),
        }),
        { description: "At least one channel identity this person can reach Vasu on." },
      ),
    }),
    execute: async (_toolCallId, rawInput) => {
      if (!isRecord(rawInput)) {
        throw new Error("name and channels are required");
      }
      const result = await call<{
        member: TeamMember;
        warnings: string[];
        pairingApproved: Array<{ channel: string }>;
      }>("team.add", rawInput, "operator.admin");
      return jsonResult({
        member: scrubMember(result.member),
        warnings: result.warnings,
        pairingApproved: result.pairingApproved.map((p) => p.channel),
      });
    },
  });

  registerOwnerOnly({
    name: "team_remove",
    label: "Remove a Team member",
    description:
      "Remove a person from the Team: drops their roster row and channel bindings, and revokes " +
      "any pairing-store admission tied to their channel identities. This is the correct way to " +
      "remove someone from the Team — do not try to reach the same result by editing channel " +
      "allowlists or config directly. Use `team_list` first to find their id. Only the Team owner " +
      "may call it; for anyone else it refuses, and the answer is to ask the owner.",
    parameters: Type.Object({
      memberId: Type.String({ description: "Team member id, from team_list." }),
    }),
    execute: async (_toolCallId, rawInput) => {
      if (!isRecord(rawInput)) {
        throw new Error("memberId is required");
      }
      const result = await call<{ removed: TeamMember; warnings: string[] }>(
        "team.remove",
        rawInput,
        "operator.admin",
      );
      return jsonResult({ removed: scrubMember(result.removed), warnings: result.warnings });
    },
  });

  registerOwnerOnly({
    name: "team_transfer_ownership",
    label: "Transfer Team ownership",
    description:
      "Make an existing Team member the owner, demoting the current owner to an ordinary member. " +
      "This is the correct way to change who owns the Team — do not try to reach the same result " +
      "by editing config directly. Use `team_list` first to find the target member's id. Only the " +
      "current Team owner may call it; for anyone else it refuses.",
    parameters: Type.Object({
      memberId: Type.String({
        description: "Team member id to make the new owner, from team_list.",
      }),
    }),
    execute: async (_toolCallId, rawInput) => {
      if (!isRecord(rawInput)) {
        throw new Error("memberId is required");
      }
      const result = await call<{ from: TeamMember; to: TeamMember; warnings: string[] }>(
        "team.transferOwnership",
        rawInput,
        "operator.admin",
      );
      return jsonResult({
        from: scrubMember(result.from),
        to: scrubMember(result.to),
        warnings: result.warnings,
      });
    },
  });
}
