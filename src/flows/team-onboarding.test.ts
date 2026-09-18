import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { runTeamOnboardingStep, type TeamOnboardingRequest } from "./team-onboarding.js";

const configWithChannel: OpenClawConfig = {
  channels: { whatsapp: { enabled: true } },
} as OpenClawConfig;

type Call = { method: string; params: Record<string, unknown> };

function recordingRequest(responses: Record<string, unknown>): {
  request: TeamOnboardingRequest;
  calls: Call[];
} {
  const calls: Call[] = [];
  const request = (async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    calls.push({ method, params });
    const answer = responses[method];
    const value = typeof answer === "function" ? (answer as () => unknown)() : answer;
    if (value instanceof Error) {
      throw value;
    }
    return (value ?? {}) as T;
  }) as TeamOnboardingRequest;
  return { request, calls };
}

describe("onboarding's mandatory Team step", () => {
  it("records the owner and adds a member through Team's own methods", async () => {
    const prompter = createWizardPrompter({
      text: vi
        .fn()
        .mockResolvedValueOnce("+919000000001") // owner's id on the channel
        .mockResolvedValueOnce("Ashu") // new member's name
        .mockResolvedValueOnce("+919000000002"), // member's id on the channel
      confirm: vi.fn(async () => false),
    });
    const { request, calls } = recordingRequest({
      "team.get": { members: [] },
      "channels.pairing.list": { requests: [] },
      "team.add": { ok: true, member: { name: "Ashu" } },
    });

    const outcome = await runTeamOnboardingStep({
      config: configWithChannel,
      prompter,
      request,
      ownerName: "Prabhat",
    });

    expect(outcome).toEqual({ status: "complete", memberCount: 1 });
    // The owner row comes first: `team.add` refuses without one.
    expect(calls.map(({ method }) => method)).toEqual([
      "team.get",
      "team.owner.set",
      "channels.pairing.list",
      "team.add",
    ]);
    expect(calls[1]?.params).toEqual({
      channel: "whatsapp",
      target: "+919000000001",
      name: "Prabhat",
    });
    expect(calls[3]?.params).toEqual({
      name: "Ashu",
      channels: [{ channel: "whatsapp", senderId: "+919000000002" }],
    });
  });

  it("adds a waiting pairing requester through the same team.add call", async () => {
    const prompter = createWizardPrompter({
      select: (async () => "0") as WizardPrompter["select"],
      confirm: vi.fn(async () => false),
    });
    const { request, calls } = recordingRequest({
      "team.get": { members: [{ id: "owner", name: "Prabhat", role: "owner", channels: [] }] },
      "channels.pairing.list": {
        requests: [
          {
            requestId: "r1",
            channel: "whatsapp",
            channelLabel: "WhatsApp",
            accountId: "default",
            senderId: "+919000000002",
            metadata: { firstName: "Ashu" },
          },
        ],
      },
      "team.add": { ok: true, member: { name: "Ashu" } },
    });

    const outcome = await runTeamOnboardingStep({
      config: configWithChannel,
      prompter,
      request,
    });

    expect(outcome).toEqual({ status: "complete", memberCount: 1 });
    expect(calls.find(({ method }) => method === "team.add")?.params).toEqual({
      name: "Ashu",
      channels: [{ channel: "whatsapp", senderId: "+919000000002", accountId: "default" }],
    });
    // The owner already exists, so the step never re-runs the bootstrap write.
    expect(calls.some(({ method }) => method === "team.owner.set")).toBe(false);
  });

  it("keeps asking until one member is added and never reports done with none", async () => {
    const prompter = createWizardPrompter({
      text: vi
        .fn()
        .mockResolvedValueOnce("Ashu")
        .mockResolvedValueOnce("+919000000002")
        .mockResolvedValueOnce("Ashu")
        .mockResolvedValueOnce("+919000000003"),
      confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
    });
    let attempt = 0;
    const { request, calls } = recordingRequest({
      "team.get": { members: [{ id: "owner", name: "Prabhat", role: "owner", channels: [] }] },
      "channels.pairing.list": { requests: [] },
      "team.add": () =>
        (attempt += 1) === 1 ? new Error("no channel-wide binding for whatsapp") : { ok: true },
    });

    const outcome = await runTeamOnboardingStep({
      config: configWithChannel,
      prompter,
      request,
    });

    expect(outcome).toEqual({ status: "complete", memberCount: 1 });
    expect(calls.filter(({ method }) => method === "team.add")).toHaveLength(2);
    // Team's own refusal is what the owner is shown, not a generic failure.
    expect(vi.mocked(prompter.note).mock.calls.map(([message]) => message)).toContain(
      "no channel-wide binding for whatsapp",
    );
  });

  it("reports the remaining work instead of done when the owner gives up with no members", async () => {
    const prompter = createWizardPrompter({
      text: vi.fn().mockResolvedValueOnce("Ashu").mockResolvedValueOnce("+919000000002"),
      confirm: vi.fn(async () => false),
    });
    const { request } = recordingRequest({
      "team.get": { members: [{ id: "owner", name: "Prabhat", role: "owner", channels: [] }] },
      "channels.pairing.list": { requests: [] },
      "team.add": new Error('Team already has a member "ashu"'),
    });

    const outcome = await runTeamOnboardingStep({
      config: configWithChannel,
      prompter,
      request,
    });

    expect(outcome.status).toBe("incomplete");
    expect(outcome).toMatchObject({ reason: expect.stringContaining("Nobody is on your team") });
  });

  it("names the missing channel instead of asking for an unreachable teammate", async () => {
    const prompter = createWizardPrompter();
    const { request, calls } = recordingRequest({});

    const outcome = await runTeamOnboardingStep({ config: {}, prompter, request });

    expect(outcome).toMatchObject({
      status: "incomplete",
      reason: expect.stringContaining("No channel is connected yet"),
    });
    expect(calls).toEqual([]);
  });

  it("does not report done from an automated run with an empty roster", async () => {
    const prompter = createWizardPrompter();
    const { request } = recordingRequest({
      "team.get": { members: [{ id: "owner", name: "Prabhat", role: "owner", channels: [] }] },
    });

    await expect(
      runTeamOnboardingStep({
        config: configWithChannel,
        prompter,
        request,
        nonInteractive: true,
      }),
    ).resolves.toMatchObject({
      status: "incomplete",
      reason: expect.stringContaining("Nobody is on your team"),
    });
  });

  it("reports an unreachable roster rather than failing onboarding", async () => {
    const prompter = createWizardPrompter();
    const { request } = recordingRequest({ "team.get": new Error("gateway timed out") });

    await expect(
      runTeamOnboardingStep({ config: configWithChannel, prompter, request }),
    ).resolves.toMatchObject({
      status: "incomplete",
      reason: expect.stringContaining("gateway timed out"),
    });
  });
});
