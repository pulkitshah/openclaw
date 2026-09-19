// Covers the Team v2 Task 5 exec self-CLI-deny default: planned once for the resolved coordinator
// agent, and never overriding an operator's own explicit choice. The write side — including that a
// no-op plan opens no config write at all — is proved through the registered service in
// `startup-services.test.ts`, which is where the regression actually lived.
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { planExecSelfCliDenyDefault, withExecSelfCliDenyDefault } from "./exec-self-cli-default.js";
import type { TeamMember } from "./team.js";

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
  it("names the resolved coordinator when nothing is configured yet", () => {
    expect(planExecSelfCliDenyDefault({ cfg: deskConfig(), members: [OWNER, RAMESH] })).toEqual({
      agentId: "krishna",
    });
  });

  it("returns null when there is no owner identity to resolve a coordinator from", () => {
    expect(planExecSelfCliDenyDefault({ cfg: deskConfig(), members: [] })).toBeNull();
  });

  it.each([false, true])("leaves an operator's explicit `%s` alone", (choice) => {
    const cfg = deskConfig();
    cfg.agents = {
      ...cfg.agents,
      entries: {
        ...cfg.agents?.entries,
        krishna: { name: "Krishna", tools: { exec: { denySelfCli: choice } } },
      },
      // SAFETY: fixture narrowing; only the keys this assertion reads are set.
    } as OpenClawConfig["agents"];
    expect(planExecSelfCliDenyDefault({ cfg, members: [OWNER, RAMESH] })).toBeNull();
  });
});

describe("withExecSelfCliDenyDefault", () => {
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
    const krishna = withExecSelfCliDenyDefault(cfg, "krishna").agents?.entries?.krishna;
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
    expect(withExecSelfCliDenyDefault(cfg, "krishna").agents?.entries?.other).toEqual({
      name: "Other",
    });
  });
});
