// The config write owner's own half of the C1 guard, without the prepared-model machinery: while a
// Gateway lifecycle holds runtime activation, a committed write must not replace the published
// runtime config snapshot with a fresh file read. The "no activation owner" case is kept alongside
// it because it is exactly what the published snapshot used to be replaced with — an overlay-free
// file config that no published prepared-model catalog owner hash-matches.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { readConfigFileSnapshot } from "./io.js";
import { materializeLegacyDefaultAgentRoles } from "./legacy.default-agent-roles.js";
import { mutateConfigFile } from "./mutate.js";
import {
  getRuntimeConfigSnapshot,
  hashRuntimeConfigValue,
  registerLifecycleRuntimeConfigActivationOwner,
  setAppliedRuntimeConfigSnapshot,
} from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.openclaw.js";

let state: OpenClawTestState;

async function publishStartupRuntimeSnapshot(): Promise<{
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
}> {
  const snapshot = await readConfigFileSnapshot();
  const sourceConfig = snapshot.sourceConfig;
  // Built by the real producer of the runtime-only startup overlay
  // (`src/gateway/server-startup-config-helpers.ts`): channel-wide bindings and
  // `agents.defaults` that exist for the running Gateway and never reach the file.
  const runtimeConfig = materializeLegacyDefaultAgentRoles(sourceConfig, "main").config;
  expect(runtimeConfig.bindings?.length).toBeGreaterThan(0);
  expect(sourceConfig.bindings).toBeUndefined();
  setAppliedRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
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

describe("runtime activation ownership during a config write", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "pre-ready-overlay" });
    await state.writeConfig({
      agents: { entries: { main: { name: "Prasthan" } } },
      channels: { telegram: { enabled: true } },
    });
  });

  afterEach(async () => {
    await state.cleanup();
  });

  it("keeps the published runtime config while a lifecycle owner holds activation", async () => {
    const { runtimeConfig } = await publishStartupRuntimeSnapshot();
    const expectedFingerprint = hashRuntimeConfigValue(runtimeConfig);
    const releaseActivationOwner = registerLifecycleRuntimeConfigActivationOwner(state.configPath);
    try {
      await writeDuringStartup();

      expect(
        (await readConfigFileSnapshot()).sourceConfig.agents?.entries?.main?.tools?.exec
          ?.denySelfCli,
      ).toBe(true);
      expect(getRuntimeConfigSnapshot()).toBe(runtimeConfig);
      expect(hashRuntimeConfigValue(runtimeConfig)).toBe(expectedFingerprint);
    } finally {
      releaseActivationOwner();
    }
  });

  it("republishes an overlay-free file read when nothing owns activation", async () => {
    const { runtimeConfig } = await publishStartupRuntimeSnapshot();

    await writeDuringStartup();

    const republished = getRuntimeConfigSnapshot();
    expect(republished).not.toBe(runtimeConfig);
    expect(republished?.bindings).toBeUndefined();
    expect(hashRuntimeConfigValue(republished!)).not.toBe(hashRuntimeConfigValue(runtimeConfig));
  });
});
