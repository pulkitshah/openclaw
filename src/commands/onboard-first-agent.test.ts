import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  promptOnboardingOwnerName,
  resolveFirstOnboardingAgent,
  validateOnboardingOwnerName,
} from "./onboard-first-agent.js";

describe("onboarding's owner-identity step", () => {
  it("asks who the owner is, never what to call an agent", async () => {
    const prompter = createWizardPrompter({ text: vi.fn(async () => "  Prabhat  ") });

    await expect(promptOnboardingOwnerName(prompter)).resolves.toBe("Prabhat");

    const [params] = vi.mocked(prompter.text).mock.calls[0]!;
    expect(params.message).toBe("What's your name?");
    expect(params.validate?.("")).toBe("Your name is required.");
  });

  it("skips the prompt in an automated run instead of guessing a name", async () => {
    const prompter = createWizardPrompter({ text: vi.fn(async () => "unused") });

    await expect(promptOnboardingOwnerName(prompter, { nonInteractive: true })).resolves.toBe(
      undefined,
    );
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("rejects an empty or oversized owner name", () => {
    expect(validateOnboardingOwnerName("   ")).toBe("Your name is required.");
    expect(validateOnboardingOwnerName("x".repeat(61))).toBe("Use 60 characters or fewer.");
    expect(validateOnboardingOwnerName("Prabhat")).toBeUndefined();
  });
});

describe("onboarding's agent shape", () => {
  it("resolves the preset coordinator without asking anything", async () => {
    await expect(resolveFirstOnboardingAgent(false)).resolves.toEqual({ name: "coordinator" });
  });

  it("lets --agent-name rename only the coordinator", async () => {
    await expect(resolveFirstOnboardingAgent(false, "vasu-desk")).resolves.toEqual({
      name: "vasu-desk",
    });
  });

  it("refuses a coordinator name that collides with a specialist", async () => {
    await expect(resolveFirstOnboardingAgent(false, "writer")).rejects.toThrow(
      "Team member ids must be distinct",
    );
  });

  it("creates nothing when the install already has an authored roster", async () => {
    await expect(resolveFirstOnboardingAgent(true, "vasu-desk")).resolves.toBeUndefined();
  });
});
