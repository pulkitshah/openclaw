// Shared apply double for guided-onboarding tests. Onboarding always creates the coordinator plus
// the preset's specialists, and its local receipt names that coordinator — so every setup-apply
// double has to leave a team-shaped roster behind or the receipt's own workspace check refuses to
// complete.
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GuidedOnboardingDeps } from "./onboard-guided.types.js";

export type PersistedConfigHolder = { config: OpenClawConfig | undefined };

export function setupApplyResult() {
  return {
    configPath: "/tmp/openclaw.json",
    configHashBefore: null,
    configHashAfter: null,
    bootstrapPending: false,
    workspaceReady: true,
    gateway: { status: "ready" as const, action: "installed" as const },
    lines: [],
  };
}

export function applyTeamRoster(
  persisted: PersistedConfigHolder,
  workspace: string,
  coordinatorId: string,
): void {
  const config = persisted.config;
  const specialists = ["researcher", "writer", "reviewer"];
  persisted.config = {
    ...config,
    agents: {
      ...config?.agents,
      ownership: "explicit",
      defaults: {
        ...config?.agents?.defaults,
        workspace,
        systemAgent: { agentId: coordinatorId },
      },
      entries: Object.fromEntries(
        [coordinatorId, ...specialists].map((id) => [
          id,
          {
            workspace: `${workspace}/${id}`,
            subagents:
              id === coordinatorId
                ? { allowAgents: specialists, delegationMode: "prefer" as const }
                : { allowAgents: [] },
          },
        ]),
      ),
    },
  };
}

/** Wrap a test's own apply so the roster it leaves behind is the one onboarding now always creates. */
export function withTeamRoster(
  persisted: PersistedConfigHolder,
  apply?: GuidedOnboardingDeps["applySetup"],
) {
  return vi.fn<NonNullable<GuidedOnboardingDeps["applySetup"]>>(async (params, hooks) => {
    applyTeamRoster(
      persisted,
      params.workspace,
      (params.firstAgent?.name ?? params.teamCoordinatorId ?? "coordinator").toLowerCase(),
    );
    return apply ? await apply(params, hooks) : setupApplyResult();
  });
}
