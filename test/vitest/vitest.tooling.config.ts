// Vitest tooling config wires the tooling test shard.
import { gatewayPluginTestFiles } from "./vitest.gateway-server-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { toolingDockerTestFiles } from "./vitest.tooling-docker.config.ts";
import { toolingIsolatedTestFiles } from "./vitest.tooling-isolated-paths.mjs";
import { boundaryTestFiles } from "./vitest.unit-paths.mjs";

export function createToolingVitestConfig(env?: Record<string, string | undefined>) {
  // deploy/** holds the hosted-desk provisioning scripts and their tests. They
  // are script-shaped like the rest of this shard, and no other project claims
  // them, so the full-suite ownership audit fails without this entry.
  return createScopedVitestConfig(
    ["test/**/*.test.ts", "src/scripts/**/*.test.ts", "deploy/**/*.test.ts"],
    {
      env,
      exclude: [
        ...boundaryTestFiles,
        ...toolingDockerTestFiles,
        ...toolingIsolatedTestFiles,
        ...gatewayPluginTestFiles,
      ],
      fileParallelism: false,
      includeOpenClawRuntimeSetup: false,
      name: "tooling",
      passWithNoTests: true,
    },
  );
}

export default createToolingVitestConfig();
