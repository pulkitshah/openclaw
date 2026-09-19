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
import {
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "openclaw/plugin-sdk/config-mutation";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveCoordinatorAgentId, type TeamMember } from "./team.js";

export type ExecSelfCliDenyDefaultPlan = {
  agentId: string;
};

function readExecSelfCliDeny(cfg: OpenClawConfig, agentId: string): boolean | undefined {
  return cfg.agents?.entries?.[agentId]?.tools?.exec?.denySelfCli;
}

/** The one key this module owns, merged into `cfg` without disturbing anything else. */
export function withExecSelfCliDenyDefault(cfg: OpenClawConfig, agentId: string): OpenClawConfig {
  const nextConfig = structuredClone(cfg);
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
  return nextConfig;
}

/**
 * The whole decision, taken once against one config: who the coordinator is, and whether the
 * operator has already recorded a choice for it. Null means there is nothing to apply.
 *
 * `resolveCoordinatorAgentId` routes through `bindings` and `agents.defaults`, which on a desk
 * rolling forward from a single-agent build exist only in the Gateway's runtime config
 * (`materializeLegacyDefaultAgentRoles`, `src/config/legacy.default-agent-roles.ts`). So this is
 * planned against the runtime config the Gateway is actually routing with — never once against the
 * runtime config and again against the file draft, which can name different coordinators and leave
 * a committed write that changes nothing.
 */
export function planExecSelfCliDenyDefault(params: {
  cfg: OpenClawConfig;
  members: readonly TeamMember[];
}): ExecSelfCliDenyDefaultPlan | null {
  const agentId = resolveCoordinatorAgentId(params.cfg, params.members);
  if (!agentId) {
    return null;
  }
  if (readExecSelfCliDeny(params.cfg, agentId) !== undefined) {
    // An operator already made an explicit choice (on or off); never override it.
    return null;
  }
  return { agentId };
}

/**
 * Commits the planned default, or nothing at all.
 *
 * A no-op plan opens no config write. `replaceConfigFile` commits a write cycle whether or not the
 * payload differs from what is on disk: it rewrites the file, rereads it, and republishes the
 * runtime config snapshot from that reread. This service runs from a plugin `start()`, before the
 * Gateway reaches `ready`, which is the window that took a live desk down — see
 * `registerLifecycleRuntimeConfigActivationOwner` (`src/config/runtime-snapshot.ts`) for the
 * owner-level guard that now keeps that republication from desynchronising the published
 * prepared-model catalog owner. Not writing at all is still the right answer here: most desks plan
 * to "nothing to do" (an empty roster, or an operator choice already recorded), and a pointless
 * write costs a disk rewrite and a hot-reload cycle.
 *
 * The plan is not recomputed against the file: the only thing rechecked before committing is the
 * single precondition it rests on — that this exact key is still unset — so the recheck can cancel
 * the write but never retarget it.
 */
export async function applyExecSelfCliDenyDefault(params: {
  cfg: OpenClawConfig;
  members: readonly TeamMember[];
}): Promise<{ applied: boolean; agentId?: string }> {
  const plan = planExecSelfCliDenyDefault({ cfg: params.cfg, members: params.members });
  if (!plan) {
    return { applied: false };
  }
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  const current = structuredClone(snapshot.config ?? {}) as OpenClawConfig;
  if (readExecSelfCliDeny(current, plan.agentId) !== undefined) {
    return { applied: false };
  }
  await replaceConfigFile({
    nextConfig: withExecSelfCliDenyDefault(current, plan.agentId),
    snapshot,
    writeOptions,
    afterWrite: { mode: "auto" },
  });
  return { applied: true, agentId: plan.agentId };
}
