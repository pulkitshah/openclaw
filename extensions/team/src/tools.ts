/**
 * The agent-facing Team tool. Same shape/registration-mode discipline as
 * `extensions/duties/src/tools.ts`: a thin client of this plugin's own Gateway method, owning no
 * runtime state, so the `tool-discovery` re-registration copy of this plugin never competes with the
 * full copy for anything.
 */
import { jsonResult } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { OpenClawPluginApi } from "../api.js";
import type { TeamMember } from "./team.js";

export function registerTeamTools(params: { api: OpenClawPluginApi }): void {
  const { api } = params;
  const call = <T = Record<string, unknown>>(method: string, args: Record<string, unknown>) =>
    api.runtime.gateway.request<T>(method, args, { scopes: ["operator.read"] });

  const team_list: AnyAgentTool = {
    name: "team_list",
    label: "List the Team",
    description:
      "The people Vasu takes instructions from, and which channels each of them is on. Use it to " +
      'pick a real `to: "team:<id>"` target for a deliver step instead of inventing an id. Read only.',
    parameters: Type.Object({}),
    execute: async () => {
      const { members } = await call<{ members: TeamMember[] }>("team.get", {});
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
  };
  api.registerTool(team_list, { name: "team_list" });
}
