// Guided onboarding's mandatory Team step: the same `team.*` Gateway methods the Team Control UI
// page calls, driven from the wizard over the Gateway this run just brought up.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TeamOnboardingOutcome, runTeamOnboardingStep } from "../flows/team-onboarding.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/** Bound on each Gateway call the mandatory Team step makes, so a Gateway that is not answering
 *  reports the remaining work instead of holding the wizard open. */
const TEAM_STEP_GATEWAY_TIMEOUT_MS = 15_000;

/**
 * Runs the step and reports what is still outstanding. Guided onboarding connects channels in the
 * dashboard rather than in the wizard, so on a desk with no channel yet this names the remaining
 * work instead of asking for a teammate who could not be reached.
 */
export async function runGuidedTeamStep(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  ownerName?: string;
  nonInteractive: boolean;
  incompleteTitle: string;
  runTeamStep?: typeof runTeamOnboardingStep;
}): Promise<TeamOnboardingOutcome> {
  const run =
    params.runTeamStep ?? (await import("../flows/team-onboarding.js")).runTeamOnboardingStep;
  const { callGateway } = await import("../gateway/call.js");
  const { ADMIN_SCOPE } = await import("../gateway/operator-scopes.js");
  const outcome = await run({
    config: params.config,
    prompter: params.prompter,
    nonInteractive: params.nonInteractive,
    ...(params.ownerName ? { ownerName: params.ownerName } : {}),
    request: async <T>(method: string, requestParams: Record<string, unknown>): Promise<T> =>
      (await callGateway({
        config: params.config,
        method,
        params: requestParams,
        scopes: [ADMIN_SCOPE],
        timeoutMs: TEAM_STEP_GATEWAY_TIMEOUT_MS,
      })) as T,
  });
  if (outcome.status === "incomplete") {
    await params.prompter.note(outcome.reason, params.incompleteTitle);
  }
  return outcome;
}
