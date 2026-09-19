// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../agents/prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPreparedModelCatalogSnapshot } from "../agents/prepared-model-catalog.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { getRuntimeConfig, readConfigFileSnapshot } from "./io.js";
import { materializeLegacyDefaultAgentRoles } from "./legacy.default-agent-roles.js";
import { mutateConfigFile } from "./mutate.js";
import {
  getRuntimeConfigSnapshot,
  registerLifecycleRuntimeConfigActivationOwner,
  setAppliedRuntimeConfigSnapshot,
} from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/**
 * C1: a config write committed before the Gateway reaches `ready` used to republish the runtime
 * config snapshot from a fresh file read. That read carries none of the runtime-only startup overlay
 * (`src/gateway/server-startup-config-helpers.ts`), and nothing pre-`ready` re-stamps the
 * prepared-model runtime owners that were already published from the overlay-bearing config, so
 * every later agent run failed `PreparedModelCatalogConfigReplacedError`. It took a live desk down.
 *
 * Both callers that hit this window are plugin services: `team:exec-self-cli-default` and
 * `team:legacy-import`. The guard lives with the config write owner, not with them.
 */
const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

async function publishStartupRuntimeSnapshot(): Promise<{
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
}> {
  const snapshot = await readConfigFileSnapshot();
  const sourceConfig = snapshot.sourceConfig;
  // The roles half of the real startup overlay, from its real producer. Runtime-only by design:
  // these bindings and `agents.defaults` never reach the file.
  const runtimeConfig = materializeLegacyDefaultAgentRoles(sourceConfig, "main").config;
  expect(runtimeConfig).not.toEqual(sourceConfig);
  setAppliedRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
  await refreshPreparedModelRuntimeSnapshots(runtimeConfig, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  return { sourceConfig, runtimeConfig };
}

async function writeDuringStartup(): Promise<void> {
  await mutateConfigFile({
    mutate: (draft) => {
      const entries = { ...draft.agents?.entries };
      entries.main = { ...entries.main, tools: { exec: { denySelfCli: true } } };
      draft.agents = { ...draft.agents, entries };
    },
  });
}

describe("config writes before the Gateway arms its managed reloader", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "pre-ready-config-write" });
    await resetPreparedModelRuntimeHarness(state);
    mocks.configuredAgentIds = ["main"];
    await state.writeConfig({ agents: { entries: { main: { name: "Prasthan" } } } });
  });

  afterEach(async (context) => {
    await cleanupPreparedModelRuntimeHarness(state, context.task.result?.state === "fail");
  });

  it("commits the file without replacing the published runtime config or its catalog owner", async () => {
    const { runtimeConfig } = await publishStartupRuntimeSnapshot();
    const releaseActivationOwner = registerLifecycleRuntimeConfigActivationOwner(state.configPath);
    try {
      await writeDuringStartup();

      // Asserted first: this is the production symptom, and it must be what a regression trips on.
      await expect(
        loadPreparedModelCatalogSnapshot({
          config: getRuntimeConfig(),
          agentId: "main",
          agentDir: state.agentDir("main"),
          readOnly: true,
        }),
      ).resolves.toBeDefined();
      const committed = await readConfigFileSnapshot();
      expect(committed.sourceConfig.agents?.entries?.main?.tools?.exec?.denySelfCli).toBe(true);
      // The write is deferred, not lost: the reloader's initial watch reconcile picks the committed
      // bytes up when hot reload arms (`src/gateway/config-reload.ts`).
      expect(getRuntimeConfigSnapshot()).toBe(runtimeConfig);
    } finally {
      releaseActivationOwner();
    }
  });
});
