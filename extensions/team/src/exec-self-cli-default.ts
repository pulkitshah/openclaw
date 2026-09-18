/**
 * Applies the Team v2 plan's exec self-CLI restriction (Task 5) to the coordinator agent by
 * default: once `team_add`/`team_remove`/`team_transfer_ownership` exist as agent-callable tools,
 * there is no legitimate reason for the coordinator to shell out to its own CLI. See
 * `src/infra/exec-self-cli-deny.ts` for the mechanism this configures.
 *
 * A separate, narrower write than `applyTeamProjection` (`team.ts`), which deliberately never
 * touches `tools` — see that function's doc comment. This module owns exactly one key:
 * `agents.entries.<coordinatorId>.tools.exec.denySelfCli`.
 *
 * Idempotent and non-destructive: applied once per Gateway start when a coordinator can be
 * resolved and `denySelfCli` is not already explicitly configured for that agent. An operator's
 * explicit `true` or `false` is left untouched, forever — this only fills in an unset default.
 */
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveCoordinatorAgentId, type TeamMember } from "./team.js";

export type ExecSelfCliDenyDefaultPlan = {
  agentId: string;
  nextConfig: OpenClawConfig;
};

/** Pure planning step (exported for tests): null when there is nothing to change. */
export function planExecSelfCliDenyDefault(params: {
  cfg: OpenClawConfig;
  members: readonly TeamMember[];
}): ExecSelfCliDenyDefaultPlan | null {
  const agentId = resolveCoordinatorAgentId(params.cfg, params.members);
  if (!agentId) {
    return null;
  }
  const existing = params.cfg.agents?.entries?.[agentId]?.tools?.exec?.denySelfCli;
  if (existing !== undefined) {
    // An operator already made an explicit choice (on or off); never override it.
    return null;
  }
  const nextConfig = structuredClone(params.cfg);
  const entries = { ...nextConfig.agents?.entries };
  const entry = entries[agentId] ?? {};
  entries[agentId] = {
    ...entry,
    tools: {
      ...entry.tools,
      exec: {
        ...entry.tools?.exec,
        denySelfCli: true,
      },
    },
  };
  nextConfig.agents = { ...nextConfig.agents, entries };
  return { agentId, nextConfig };
}

/** Applies the default under the config mutation lock. A no-op plan returns `applied: false`. */
export async function applyExecSelfCliDenyDefault(params: {
  members: readonly TeamMember[];
}): Promise<{ applied: boolean; agentId?: string }> {
  let outcome: { applied: boolean; agentId?: string } = { applied: false };
  await mutateConfigFile({
    mutate: (draft) => {
      const plan = planExecSelfCliDenyDefault({ cfg: draft, members: params.members });
      if (!plan) {
        return;
      }
      draft.agents = plan.nextConfig.agents;
      outcome = { applied: true, agentId: plan.agentId };
    },
  });
  return outcome;
}
