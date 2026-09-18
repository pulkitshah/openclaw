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

/**
 * Applies the default under the config mutation lock. A no-op plan returns `applied: false`
 * WITHOUT opening a config write at all.
 *
 * The pre-check on `params.cfg` is load-bearing, not an optimization. `mutateConfigFile` commits a
 * write cycle whether or not the mutator changed the draft: it rewrites the file, rereads it, and
 * republishes the runtime config snapshot from that reread. This service runs from a plugin
 * `start()`, i.e. before the Gateway reaches `ready` and arms its managed config reloader, so that
 * republished snapshot (a) loses the startup-only plugin auto-enable overlay
 * (`src/gateway/server-startup-config-helpers.ts`) and (b) reaches no reload owner that would
 * re-stamp the already-published prepared-model catalog owner. The owner then holds a config that
 * no longer hash-matches what every later reader passes, and every agent run fails with
 * `PreparedModelCatalogConfigReplacedError`. Most desks land here — an empty roster or an operator
 * choice already recorded both plan to "nothing to do".
 *
 * The draft is still re-planned inside the lock: `params.cfg` only decides whether to take the
 * lock, never what to write.
 */
export async function applyExecSelfCliDenyDefault(params: {
  cfg: OpenClawConfig;
  members: readonly TeamMember[];
}): Promise<{ applied: boolean; agentId?: string }> {
  if (!planExecSelfCliDenyDefault({ cfg: params.cfg, members: params.members })) {
    return { applied: false };
  }
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
