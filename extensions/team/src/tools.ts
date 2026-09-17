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
 */
import { jsonResult } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
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

export function registerTeamTools(params: { api: OpenClawPluginApi }): void {
  const { api } = params;
  const call = <T = Record<string, unknown>>(
    method: string,
    args: Record<string, unknown>,
    scope: "operator.read" | "operator.admin",
  ) => api.runtime.gateway.request<T>(method, args, { scopes: [scope] });

  const register = (tool: AnyAgentTool) => api.registerTool(tool, { name: tool.name });

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

  register({
    name: "team_add",
    label: "Add a Team member",
    description:
      "Add a person to the Team with the channel identity/identities they'll use to reach Vasu " +
      "(e.g. their WhatsApp number or Telegram user id). If one of those identities already has a " +
      "pending pairing request, it is approved as part of this same call. This is the correct way " +
      "to add someone to the Team — do not try to reach the same result by editing channel " +
      "allowlists, config, or pairing state directly.",
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
            Type.String({ description: "Which of this desk's accounts on that channel, if more than one." }),
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

  register({
    name: "team_remove",
    label: "Remove a Team member",
    description:
      "Remove a person from the Team: drops their roster row and channel bindings, and revokes " +
      "any pairing-store admission tied to their channel identities. This is the correct way to " +
      "remove someone from the Team — do not try to reach the same result by editing channel " +
      "allowlists or config directly. Use `team_list` first to find their id.",
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

  register({
    name: "team_transfer_ownership",
    label: "Transfer Team ownership",
    description:
      "Make an existing Team member the owner, demoting the current owner to an ordinary member. " +
      "This is the correct way to change who owns the Team — do not try to reach the same result " +
      "by editing config directly. Use `team_list` first to find the target member's id.",
    parameters: Type.Object({
      memberId: Type.String({ description: "Team member id to make the new owner, from team_list." }),
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
