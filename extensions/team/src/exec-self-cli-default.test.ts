// Covers the Team v2 Task 5 exec self-CLI-deny default: applied once for the resolved coordinator
// agent, and never overriding an operator's own explicit choice.
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamMember } from "./team.js";

const mocks = vi.hoisted(() => ({
  mutateConfigFile: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/config-mutation", () => ({
  mutateConfigFile: mocks.mutateConfigFile,
}));

const { applyExecSelfCliDenyDefault, planExecSelfCliDenyDefault } =
  await import("./exec-self-cli-default.js");

const OWNER: TeamMember = {
  id: "owner",
  name: "Pulkit",
  role: "owner",
  addedBy: "owner",
  addedAt: 1,
  updatedAt: 1,
  channels: [{ channel: "telegram", senderId: "111", addedAt: 1 }],
};

const RAMESH: TeamMember = {
  id: "ramesh",
  name: "Ramesh",
  role: "member",
  addedBy: "owner",
  addedAt: 2,
  updatedAt: 2,
  channels: [{ channel: "telegram", senderId: "5551234", addedAt: 2 }],
};

function deskConfig(): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: { krishna: { name: "Krishna" } },
    },
    channels: {
      telegram: { enabled: true, dmPolicy: "allowlist", allowFrom: ["111"] },
    },
    bindings: [{ agentId: "krishna", match: { channel: "telegram", accountId: "*" } }],
    // SAFETY: a hand-built config fixture is a partial OpenClawConfig by construction.
  } as OpenClawConfig;
}

describe("planExecSelfCliDenyDefault", () => {
  it("sets denySelfCli: true on the resolved coordinator when nothing is configured yet", () => {
    const plan = planExecSelfCliDenyDefault({ cfg: deskConfig(), members: [OWNER, RAMESH] });
    expect(plan?.agentId).toBe("krishna");
    expect(plan?.nextConfig.agents?.entries?.krishna?.tools?.exec?.denySelfCli).toBe(true);
  });

  it("returns null when there is no owner identity to resolve a coordinator from", () => {
    expect(planExecSelfCliDenyDefault({ cfg: deskConfig(), members: [] })).toBeNull();
  });

  it("leaves an operator's explicit `false` alone", () => {
    const cfg = deskConfig();
    cfg.agents = {
      ...cfg.agents,
      entries: {
        ...cfg.agents?.entries,
        krishna: { name: "Krishna", tools: { exec: { denySelfCli: false } } },
      },
      // SAFETY: fixture narrowing; only the keys this assertion reads are set.
    } as OpenClawConfig["agents"];
    expect(planExecSelfCliDenyDefault({ cfg, members: [OWNER, RAMESH] })).toBeNull();
  });

  it("leaves an operator's explicit `true` alone (no redundant patch)", () => {
    const cfg = deskConfig();
    cfg.agents = {
      ...cfg.agents,
      entries: {
        ...cfg.agents?.entries,
        krishna: { name: "Krishna", tools: { exec: { denySelfCli: true } } },
      },
      // SAFETY: fixture narrowing; only the keys this assertion reads are set.
    } as OpenClawConfig["agents"];
    expect(planExecSelfCliDenyDefault({ cfg, members: [OWNER, RAMESH] })).toBeNull();
  });

  it("merges into existing tools/exec config instead of replacing it", () => {
    const cfg = deskConfig();
    cfg.agents = {
      ...cfg.agents,
      entries: {
        ...cfg.agents?.entries,
        krishna: { name: "Krishna", tools: { exec: { safeBins: ["cut"] }, profile: "full" } },
      },
      // SAFETY: fixture narrowing; only the keys this assertion reads are set.
    } as OpenClawConfig["agents"];
    const plan = planExecSelfCliDenyDefault({ cfg, members: [OWNER, RAMESH] });
    const krishna = plan?.nextConfig.agents?.entries?.krishna;
    expect(krishna?.tools?.exec).toEqual({ safeBins: ["cut"], denySelfCli: true });
    expect(krishna?.tools?.profile).toBe("full");
  });

  it("does not touch any other agent's entry", () => {
    const cfg = deskConfig();
    cfg.agents = {
      ...cfg.agents,
      entries: { ...cfg.agents?.entries, other: { name: "Other" } },
      // SAFETY: fixture narrowing; only the keys this assertion reads are set.
    } as OpenClawConfig["agents"];
    const plan = planExecSelfCliDenyDefault({ cfg, members: [OWNER, RAMESH] });
    expect(plan?.nextConfig.agents?.entries?.other).toEqual({ name: "Other" });
  });
});

// The regression these guard (staging/team-v2-test @ 886c1631f7, culprit 3cf1939d52): this service
// used to call `mutateConfigFile` on every Gateway start and decide inside the mutator. A write
// whose mutator changes nothing is not free — it still republishes the runtime config snapshot from
// a fresh file read, which during plugin `start()` (before the Gateway arms its managed config
// reloader) drops the startup-only plugin auto-enable overlay and leaves the already-published
// prepared-model catalog owner holding a config nothing hash-matches. Every agent run on the desk
// then failed with `PreparedModelCatalogConfigReplacedError`.
describe("applyExecSelfCliDenyDefault", () => {
  beforeEach(() => {
    mocks.mutateConfigFile.mockReset();
    mocks.mutateConfigFile.mockImplementation(
      async (params: { mutate: (draft: OpenClawConfig, context: unknown) => unknown }) => {
        await params.mutate(deskConfig(), {});
        return {};
      },
    );
  });

  // The broken desk's shape: one legacy-implicit `main` agent with an explicit agentDir, no
  // `agents.defaults.systemAgent`, no `agents.entries.main.tools`, and an empty Team roster.
  function legacyMainDeskConfig(): OpenClawConfig {
    return {
      agents: {
        entries: {
          main: {
            name: "Prasthan",
            agentDir: "/home/openclaw/.openclaw/agents/main/agent",
          },
        },
      },
      channels: { telegram: { enabled: true } },
      // SAFETY: a hand-built config fixture is a partial OpenClawConfig by construction.
    } as OpenClawConfig;
  }

  it("opens no config write when the roster is empty and no coordinator resolves", async () => {
    await expect(
      applyExecSelfCliDenyDefault({ cfg: legacyMainDeskConfig(), members: [] }),
    ).resolves.toEqual({ applied: false });
    expect(mocks.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("opens no config write when the operator already chose explicitly", async () => {
    const cfg = deskConfig();
    cfg.agents = {
      ...cfg.agents,
      entries: {
        ...cfg.agents?.entries,
        krishna: { name: "Krishna", tools: { exec: { denySelfCli: false } } },
      },
      // SAFETY: fixture narrowing; only the keys this assertion reads are set.
    } as OpenClawConfig["agents"];

    await expect(applyExecSelfCliDenyDefault({ cfg, members: [OWNER, RAMESH] })).resolves.toEqual({
      applied: false,
    });
    expect(mocks.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("still writes the default when a coordinator resolves and nothing is configured yet", async () => {
    await expect(
      applyExecSelfCliDenyDefault({ cfg: deskConfig(), members: [OWNER, RAMESH] }),
    ).resolves.toEqual({ applied: true, agentId: "krishna" });
    expect(mocks.mutateConfigFile).toHaveBeenCalledTimes(1);
  });
});
