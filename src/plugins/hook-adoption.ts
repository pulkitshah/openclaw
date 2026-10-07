import type { PluginRegistry } from "./registry-types.js";

function typedHookKey(hook: { pluginId: string; hookName: string }): string {
  return `${hook.pluginId}\0${hook.hookName}`;
}

/**
 * Agent-run registries can be discovery-mode loads, so hooks a plugin registers only in
 * `"full"` mode are missing there, and generation-scoped dispatch reads that registry alone.
 * Carry those hooks over from the composition-root registry, copy-on-write, for plugins the
 * target loaded from the same source; a pair the target registered itself is never duplicated.
 */
export function adoptRuntimeTypedHookRegistrations(
  targetRegistry: PluginRegistry,
  runtimeRegistry: PluginRegistry,
): PluginRegistry {
  const ownPairs = new Set(targetRegistry.typedHooks.map(typedHookKey));
  const adopted = runtimeRegistry.typedHooks.filter((hook) => {
    if (ownPairs.has(typedHookKey(hook))) {
      return false;
    }
    const target = targetRegistry.plugins.find((plugin) => plugin.id === hook.pluginId);
    const runtime = runtimeRegistry.plugins.find((plugin) => plugin.id === hook.pluginId);
    return (
      target?.status === "loaded" &&
      runtime?.status === "loaded" &&
      target.source === runtime.source &&
      hook.source === runtime.source
    );
  });
  return adopted.length === 0
    ? targetRegistry
    : { ...targetRegistry, typedHooks: [...targetRegistry.typedHooks, ...adopted] };
}
