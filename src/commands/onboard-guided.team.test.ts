import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { setupGuidedCustodianTestSuite } from "./onboard-guided.custodian.test-support.js";
import type { GuidedOnboardingDeps } from "./onboard-guided.js";

describe("guided onboarding owner identity and Team step", () => {
  const { makeRuntime, runGuidedOnboardingImpl, setupDeps } = setupGuidedCustodianTestSuite();

  it("captures the owner's own name and creates the coordinator, never naming an agent", async () => {
    const prompter = createWizardPrompter({ text: vi.fn(async () => "Prabhat") });
    const runTeamStep = vi.fn<NonNullable<GuidedOnboardingDeps["runTeamStep"]>>(async () => ({
      status: "complete",
      memberCount: 1,
    }));
    const deps = setupDeps({ prompter, runTeamStep });

    await runGuidedOnboardingImpl(
      { acceptRisk: true, workspace: "/tmp/work", skipUi: true },
      makeRuntime(),
      deps,
    );

    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "What's your name?" }),
    );
    const prompted = vi.mocked(prompter.text).mock.calls.map(([params]) => params.message);
    expect(prompted).not.toContain("What should we call your first agent?");
    // The coordinator comes from the team preset, not from the owner's answer.
    expect(deps.applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ firstAgent: { name: "coordinator" } }),
      { beforePersistentApply: expect.any(Function) },
    );
    expect(runTeamStep).toHaveBeenCalledWith(expect.objectContaining({ ownerName: "Prabhat" }));
  });

  it.each([
    {
      label: "reports done once someone is on the team",
      outcome: { status: "complete" as const, memberCount: 1 },
      outro: "Vasudev is ready.",
    },
    {
      label: "never reports done with nobody on the team",
      outcome: { status: "incomplete" as const, reason: "Nobody is on your team yet." },
      outro:
        "Almost there — Vasu still needs a team. Open the Team tab in the dashboard to finish.",
    },
  ])("$label", async ({ outcome, outro }) => {
    const prompter = createWizardPrompter({ text: vi.fn(async () => "Prabhat") });
    const runTeamStep = vi.fn<NonNullable<GuidedOnboardingDeps["runTeamStep"]>>(
      async () => outcome,
    );

    await runGuidedOnboardingImpl(
      { acceptRisk: true, workspace: "/tmp/work", skipUi: true },
      makeRuntime(),
      setupDeps({ prompter, runTeamStep }),
    );

    expect(runTeamStep).toHaveBeenCalledOnce();
    expect(prompter.outro).toHaveBeenCalledWith(outro);
  });
});
