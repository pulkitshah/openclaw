// Guided onboarding's injectable collaborators. Split from the flow itself so the flow module
// stays within its line budget; the flow re-exports this type as its public shape.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { GuidedAccessMode } from "./onboard-guided-consent.js";

export type GuidedOnboardingDeps = {
  runSystemAgentChat?: (
    workspace: string,
    runtime: RuntimeEnv,
    acceptRisk: boolean,
    agentName?: string,
  ) => Promise<void>;
  launchHatchTui?: (workspace: string) => Promise<void>;
  runForegroundGateway?: typeof import("./onboard-quickstart-host.js").runQuickstartForegroundGateway;
  detect?: typeof import("../system-agent/setup-inference.js").detectSetupInference;
  activate?: typeof import("../system-agent/setup-inference.js").activateSetupInference;
  createPrompter?: () => WizardPrompter | Promise<WizardPrompter>;
  persistRiskAcknowledgement?: (config: OpenClawConfig) => Promise<string | void>;
  persistAccessMode?: (mode: GuidedAccessMode) => Promise<void>;
  listManualOptions?: typeof import("../system-agent/setup-inference.js").listManualSetupInferenceOptions;
  /**
   * "hatch" (default) runs the local custodian flow: discovery consent,
   * explicit provider selection, deterministic setup apply, then the agent TUI.
   * "chat" preserves the legacy handoff into the Vasudev system-agent chat —
   * remote-gateway onboarding requires it because setup must apply remotely.
   */
  handoffMode?: "hatch" | "chat";
  applySetup?: typeof import("../system-agent/setup-apply.js").applySystemAgentSetup;
  runSetupMemoryImportStep?: typeof import("../wizard/setup.memory-import.js").runSetupMemoryImportStep;
  runAppRecommendations?: typeof import("../wizard/setup.app-recommendations.js").setupAppRecommendations;
  /** Browser-first local hatch handoff. Tests inject this to avoid real browser/Gateway work. */
  runBrowserHandoff?: typeof import("./onboard-browser-handoff.js").runBrowserHatchHandoff;
  /** Mandatory Team step. Tests inject this to avoid real Gateway work. */
  runTeamStep?: typeof import("../flows/team-onboarding.js").runTeamOnboardingStep;
  platform?: NodeJS.Platform;
};
