import { describe, expect, it, vi } from "vitest";
import { adoptRuntimeTypedHookRegistrations } from "./hook-adoption.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
import type { PluginRegistry } from "./registry-types.js";

function discoveryRegistryFor(runtime: PluginRegistry, ownHooks: PluginRegistry["typedHooks"]) {
  const registry = createMockPluginRegistry([]);
  registry.plugins = runtime.plugins.map((plugin) => ({ ...plugin }));
  registry.typedHooks = [...ownHooks];
  return registry;
}

describe("adoptRuntimeTypedHookRegistrations", () => {
  it("adopts full-only hooks after the target's own hooks without mutating inputs", () => {
    const runtime = createMockPluginRegistry([
      { hookName: "before_prompt_build", pluginId: "memory-core", handler: vi.fn() },
      { hookName: "llm_output", pluginId: "wallet", handler: vi.fn() },
      { hookName: "before_agent_run", pluginId: "wallet", handler: vi.fn() },
    ]);
    const ownMemoryHook = { ...runtime.typedHooks[0], handler: vi.fn() };
    const target = discoveryRegistryFor(runtime, [ownMemoryHook]);
    const targetHooks = [...target.typedHooks];
    const runtimeHooks = [...runtime.typedHooks];

    const adopted = adoptRuntimeTypedHookRegistrations(target, runtime);

    expect(adopted).not.toBe(target);
    expect(adopted.typedHooks).toEqual([
      ownMemoryHook,
      runtime.typedHooks[1],
      runtime.typedHooks[2],
    ]);
    expect(adopted.plugins).toBe(target.plugins);
    expect(target.typedHooks).toEqual(targetHooks);
    expect(runtime.typedHooks).toEqual(runtimeHooks);
  });

  it("skips plugins the target did not load from the same source", () => {
    const runtime = createMockPluginRegistry([
      { hookName: "llm_output", pluginId: "wallet", handler: vi.fn() },
      { hookName: "llm_output", pluginId: "shadowed", handler: vi.fn() },
      { hookName: "llm_output", pluginId: "failed", handler: vi.fn() },
    ]);
    const target = discoveryRegistryFor(runtime, []);
    // discoveryRegistryFor copied the records, so editing them leaves the runtime intact.
    target.plugins = target.plugins.filter((plugin) => plugin.id !== "wallet");
    for (const plugin of target.plugins) {
      if (plugin.id === "shadowed") {
        plugin.source = "/workspace/shadowed";
      } else {
        plugin.status = "error";
      }
    }

    expect(adoptRuntimeTypedHookRegistrations(target, runtime)).toBe(target);
  });

  it("returns the target unchanged when it already owns every pair", () => {
    const runtime = createMockPluginRegistry([
      { hookName: "llm_output", pluginId: "wallet", handler: vi.fn() },
    ]);
    const target = discoveryRegistryFor(runtime, [{ ...runtime.typedHooks[0], handler: vi.fn() }]);

    expect(adoptRuntimeTypedHookRegistrations(target, runtime)).toBe(target);
  });
});
