/**
 * The two Team services that run from `start()` — before the Gateway reaches `ready` — driven
 * through the REGISTERED entry point, not through their helpers. A helper that declines to write is
 * worth nothing if `index.ts` never routes through it.
 *
 * Why the window matters: a config write committed before the Gateway arms its managed config
 * reloader used to republish the runtime config snapshot from a fresh file read, dropping the
 * runtime-only startup overlay and desynchronising the already-published prepared-model catalog
 * owner — every agent run then failed `PreparedModelCatalogConfigReplacedError`. That hole is closed
 * at the config write owner (`registerLifecycleRuntimeConfigActivationOwner`,
 * `src/config/runtime-snapshot.ts`, proved in
 * `src/config/runtime-activation-before-gateway-ready.test.ts`). These tests hold the second line:
 * neither service opens a write cycle it has nothing to write.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamMember } from "./team.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshotForWrite: vi.fn(),
  replaceConfigFile: vi.fn(),
  mutateConfigFile: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/config-mutation", () => ({
  readConfigFileSnapshotForWrite: mocks.readConfigFileSnapshotForWrite,
  replaceConfigFile: mocks.replaceConfigFile,
  mutateConfigFile: mocks.mutateConfigFile,
}));

const teamPlugin = (await import("../index.js")).default;

const OWNER: TeamMember = {
  id: "owner",
  name: "Pulkit",
  role: "owner",
  addedBy: "owner",
  addedAt: 1,
  updatedAt: 1,
  channels: [{ channel: "telegram", senderId: "111", addedAt: 1 }],
};

/** A desk whose coordinator is resolvable only from the runtime overlay: no `bindings` and no
 *  `agents.defaults` in the file, both materialized into the runtime config at startup
 *  (`materializeLegacyDefaultAgentRoles`). This divergence is what made the old two-config plan
 *  take the write lock and then change nothing. */
function fileConfig(): OpenClawConfig {
  return {
    agents: { entries: { krishna: { name: "Krishna" } } },
    channels: { telegram: { enabled: true, dmPolicy: "allowlist", allowFrom: ["111"] } },
    // SAFETY: a hand-built config fixture is a partial OpenClawConfig by construction.
  } as OpenClawConfig;
}

function runtimeConfig(): OpenClawConfig {
  return {
    ...fileConfig(),
    bindings: [{ agentId: "krishna", match: { channel: "telegram", accountId: "*" } }],
    // SAFETY: fixture narrowing; only the keys the coordinator route reads are set.
  } as OpenClawConfig;
}

function memoryKeyed<T>() {
  const entries = new Map<string, T>();
  return {
    register: async (key: string, value: T) => {
      entries.set(key, value);
    },
    lookup: async (key: string) => entries.get(key),
    entries: async () => [...entries].map(([key, value]) => ({ key, value })),
    delete: async (key: string) => entries.delete(key),
  };
}

type RegisteredService = {
  id: string;
  start?: (ctx: {
    logger: { info: (msg: string) => void; warn: (msg: string) => void };
  }) => Promise<void> | void;
};

function registerTeam(params: {
  config: OpenClawConfig;
  members?: readonly TeamMember[];
  gatewayRequest?: (method: string) => Promise<unknown>;
}) {
  const services: RegisteredService[] = [];
  const logs: string[] = [];
  const seeded = memoryKeyed<TeamMember>();
  const api = {
    registrationMode: "full",
    config: params.config,
    registerService: (service: RegisteredService) => services.push(service),
    registerGatewayMethod: () => {},
    registerTool: () => {},
    session: { controls: { registerControlUiDescriptor: () => {} } },
    runtime: {
      config: { current: () => params.config },
      state: { openKeyedStore: () => seeded },
      gateway: {
        request:
          params.gatewayRequest ??
          (async (method: string) => {
            throw new Error(`unexpected gateway request ${method}`);
          }),
      },
    },
    // SAFETY: the registration path under test reads only these members of the plugin API.
  } as never;
  return {
    services,
    logs,
    seeded,
    register: async () => {
      teamPlugin.register?.(api);
      for (const member of params.members ?? []) {
        await seeded.register(member.id, member);
      }
    },
    start: async (id: string) => {
      const service = services.find((candidate) => candidate.id === id);
      expect(service, `service ${id} was never registered`).toBeDefined();
      await service?.start?.({
        logger: {
          info: (msg: string) => logs.push(msg),
          warn: (msg: string) => logs.push(msg),
        },
      });
    },
  };
}

describe("Team services that run before the Gateway is ready", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshotForWrite.mockReset();
    mocks.replaceConfigFile.mockReset().mockResolvedValue({});
    mocks.mutateConfigFile.mockReset().mockResolvedValue({});
  });

  it("team:exec-self-cli-default opens no write when the roster is empty", async () => {
    const harness = registerTeam({ config: runtimeConfig() });
    await harness.register();

    await harness.start("team:exec-self-cli-default");

    expect(mocks.readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("team:exec-self-cli-default opens no write when the coordinator already has the key on disk", async () => {
    const settledFile = fileConfig();
    settledFile.agents = {
      ...settledFile.agents,
      entries: {
        krishna: { name: "Krishna", tools: { exec: { denySelfCli: false } } },
      },
      // SAFETY: fixture narrowing; only the keys this assertion reads are set.
    } as OpenClawConfig["agents"];
    mocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: { path: "/tmp/openclaw.json", config: settledFile },
      writeOptions: {},
    });
    const harness = registerTeam({ config: runtimeConfig(), members: [OWNER] });
    await harness.register();

    await harness.start("team:exec-self-cli-default");

    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("team:exec-self-cli-default writes the one key it planned, against the file draft", async () => {
    mocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: { path: "/tmp/openclaw.json", config: fileConfig() },
      writeOptions: {},
    });
    const harness = registerTeam({ config: runtimeConfig(), members: [OWNER] });
    await harness.register();

    await harness.start("team:exec-self-cli-default");

    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
    const written = mocks.replaceConfigFile.mock.calls[0]?.[0] as { nextConfig: OpenClawConfig };
    expect(written.nextConfig.agents?.entries?.krishna?.tools?.exec?.denySelfCli).toBe(true);
    // The runtime-only overlay resolved the coordinator; it must not be persisted with the key.
    expect(written.nextConfig.bindings).toBeUndefined();
    expect(harness.logs.join("\n")).toContain("krishna");
  });

  it("team:legacy-import opens no write when there are no legacy rows", async () => {
    const harness = registerTeam({
      config: runtimeConfig(),
      gatewayRequest: async (method) => {
        if (method === "duties.legacyTeam.export") {
          return { members: [] };
        }
        throw new Error(`unexpected gateway request ${method}`);
      },
    });
    await harness.register();

    await harness.start("team:legacy-import");

    expect(mocks.readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("team:legacy-import opens no write when the projection of the imported roster changes nothing", async () => {
    // Already-projected config: importing the same roster yields the identical config.
    const projected = runtimeConfig();
    const harness = registerTeam({
      config: projected,
      gatewayRequest: async (method) => {
        if (method === "duties.legacyTeam.export") {
          return { members: [{ ...OWNER, agentId: "krishna" }] };
        }
        if (method === "duties.legacyTeam.clear") {
          return { cleared: 1 };
        }
        throw new Error(`unexpected gateway request ${method}`);
      },
    });
    await harness.register();
    mocks.readConfigFileSnapshotForWrite.mockImplementation(async () => {
      const { applyTeamProjection } = await import("./team.js");
      return {
        snapshot: {
          path: "/tmp/openclaw.json",
          config: applyTeamProjection(projected, [OWNER]),
        },
        writeOptions: {},
      };
    });

    await harness.start("team:legacy-import");

    expect(mocks.readConfigFileSnapshotForWrite).toHaveBeenCalledTimes(1);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("team:legacy-import still projects config when the import actually changes it", async () => {
    mocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: { path: "/tmp/openclaw.json", config: runtimeConfig() },
      writeOptions: {},
    });
    const harness = registerTeam({
      config: runtimeConfig(),
      gatewayRequest: async (method) => {
        if (method === "duties.legacyTeam.export") {
          return { members: [{ ...OWNER, agentId: "krishna" }] };
        }
        if (method === "duties.legacyTeam.clear") {
          return { cleared: 1 };
        }
        throw new Error(`unexpected gateway request ${method}`);
      },
    });
    await harness.register();

    await harness.start("team:legacy-import");

    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
  });
});
