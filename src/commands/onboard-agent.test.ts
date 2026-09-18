import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgentTeam: vi.fn(),
  migrateLegacyMainSessionKeys: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../agents/agent-team.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-team.js")>()),
  createAgentTeam: mocks.createAgentTeam,
}));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));
vi.mock("../config/sessions/legacy-main-session-migration.js", () => ({
  migrateLegacyMainSessionKeys: mocks.migrateLegacyMainSessionKeys,
}));

const { ensureOnboardingAgent } = await import("./onboard-agent.js");

const teamResult = (coordinatorId: string) => ({
  status: "created" as const,
  coordinatorId,
  ambientOwnerId: coordinatorId,
  agents: [coordinatorId, "researcher", "writer", "reviewer"].map((agentId) => ({
    status: "created" as const,
    agentId,
    name: agentId,
    workspace: `/tmp/work/${agentId}`,
    agentDir: `/tmp/agent/${agentId}`,
    bootstrapPending: false,
  })),
  config: {},
  configHash: "hash-after-create",
});

describe("onboarding coordinator-team creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAgentTeam.mockResolvedValue(teamResult("coordinator"));
    mocks.migrateLegacyMainSessionKeys.mockResolvedValue({});
    mocks.readConfigFileSnapshot
      .mockResolvedValueOnce({
        exists: false,
        valid: true,
        sourceConfig: { agents: { list: [{ id: "main", default: true }] }, gateway: {} },
        config: { agents: { list: [{ id: "main", default: true }] }, gateway: {} },
      })
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        hash: "hash-after-create",
        sourceConfig: {
          agents: { list: [{ id: "main", default: true }] },
          gateway: { controlUi: { enabled: true } },
        },
        config: {
          agents: { list: [{ id: "main", default: true }] },
          gateway: { controlUi: { enabled: true } },
        },
      });
  });

  it("provisions the coordinator team on a fresh install", async () => {
    const result = await ensureOnboardingAgent({
      config: {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        gateway: { mode: "local" },
      },
      workspace: "/tmp/work",
    });

    expect(mocks.createAgentTeam).toHaveBeenCalledWith(
      expect.objectContaining({ bootstrapFirstAgent: true, workspaceRoot: "/tmp/work" }),
    );
    // No caller-supplied first agent: the preset's own coordinator id is used.
    expect(mocks.createAgentTeam.mock.calls[0]?.[0]).not.toHaveProperty("coordinator");
    expect(result).toMatchObject({
      agentId: "coordinator",
      createdAgentIds: ["coordinator", "researcher", "writer", "reviewer"],
      config: {
        agents: {
          defaults: { model: "openai/gpt-5.5" },
          entries: { main: { default: true } },
        },
        gateway: { mode: "local", controlUi: { enabled: true } },
      },
    });
  });

  it("stages a normalized named coordinator and runs legacy-session convergence", async () => {
    mocks.createAgentTeam.mockResolvedValueOnce(teamResult("robby"));

    await ensureOnboardingAgent({
      config: {},
      workspace: "/tmp/work",
      firstAgent: { name: "Robby!" },
    });

    expect(mocks.createAgentTeam).toHaveBeenCalledWith(
      expect.objectContaining({ coordinator: "Robby!", workspaceRoot: "/tmp/work" }),
    );
    expect(mocks.migrateLegacyMainSessionKeys).toHaveBeenCalledWith({
      cfg: expect.objectContaining({ agents: expect.any(Object) }),
      mode: "automatic",
    });
  });

  it("preserves an explicit imported candidate roster", async () => {
    const config = { agents: { entries: { main: {} } } };

    await expect(
      ensureOnboardingAgent({
        config,
        workspace: "/tmp/work",
        preserveCandidateRoster: true,
      }),
    ).resolves.toEqual({
      config,
      configBase: config,
      agentId: "main",
      bootstrapPending: false,
      createdAgent: false,
    });
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.createAgentTeam).not.toHaveBeenCalled();
  });
  it("reports the post-create config hash so callers can rebase their commit", async () => {
    // Regression (#112678): creating the first roster agent writes the config
    // file, so a caller holding a pre-create hash would fail its own optimistic
    // write with ConfigMutationConflictError and leave onboarding half-applied.
    const result = await ensureOnboardingAgent({
      config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
      workspace: "/tmp/work",
    });

    expect(result.configHash).toBe("hash-after-create");
  });

  it("omits the config hash when no agent had to be created", async () => {
    const config = { agents: { entries: { main: {} } } };

    const result = await ensureOnboardingAgent({
      config,
      workspace: "/tmp/work",
      preserveCandidateRoster: true,
    });

    expect(result.configHash).toBeUndefined();
    expect(mocks.createAgentTeam).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only explicit first-agent name instead of defaulting to main", async () => {
    await expect(
      ensureOnboardingAgent({
        config: {},
        workspace: "/tmp/work",
        firstAgent: { name: "   " },
      }),
    ).rejects.toThrow("Agent name is required");

    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.createAgentTeam).not.toHaveBeenCalled();
  });

  it("surfaces an incomplete legacy-session migration with a doctor recovery hint", async () => {
    mocks.migrateLegacyMainSessionKeys.mockResolvedValueOnce({
      armed: true,
      complete: false,
      warnings: ["database is locked"],
    });

    const result = await ensureOnboardingAgent({
      config: {},
      workspace: "/tmp/work",
      firstAgent: { name: "robby" },
    });

    expect(result.sessionMigrationWarnings).toEqual([
      expect.stringMatching(/database is locked.*vasudev doctor --fix/),
    ]);
  });

  it("rejects a roster written after the approved config revision", async () => {
    mocks.readConfigFileSnapshot.mockReset().mockResolvedValueOnce({
      exists: true,
      valid: true,
      hash: "concurrent",
      sourceConfigBeforeMigrations: { agents: { entries: { ops: {} } } },
      config: { agents: { entries: { ops: {} } } },
    });

    await expect(
      ensureOnboardingAgent({
        config: {},
        workspace: "/tmp/work",
        firstAgent: { name: "robby" },
        expectedConfigHash: "approved",
      }),
    ).rejects.toThrow("config changed before first-agent creation");

    expect(mocks.createAgentTeam).not.toHaveBeenCalled();
  });
});
