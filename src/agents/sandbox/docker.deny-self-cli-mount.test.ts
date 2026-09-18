// Round 6 finding: `denySelfCli`'s PATH-shadow layer (see
// `../../infra/exec-self-cli-deny-path-shadow.ts`) prepends the stub directory's host-absolute
// path into the spawned command's PATH verbatim -- unchanged for every host type, including
// sandbox -- because it never translates that path for the container. So the container's own
// filesystem must actually contain a real directory at that identical literal path, or the PATH
// entry is a dangling no-op and self-CLI lookups fall through to whatever real `vasudev`/
// `openclaw` binary happens to live in a bind-mounted workspace. This file is split out from
// `docker.config-hash-recreate.test.ts` (rather than growing it) to stay under that file glob's
// `max-lines` lint ceiling; its Docker CLI spawn/registry mock harness intentionally mirrors that
// file's, matching this codebase's existing convention of each docker test file owning its own
// self-contained mock (see `docker.test.ts` for another independent copy of the same pattern).
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearSelfCliDenyPathShadowForTest } from "../../infra/exec-self-cli-deny-path-shadow.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { computeSandboxConfigHash } from "./config-hash.js";
import { SANDBOX_DOCKER_CREATE_ARGS_EPOCH } from "./constants.js";
import { collectDockerFlagValues } from "./test-args.js";
import type { SandboxConfig } from "./types.js";
import { SANDBOX_MOUNT_FORMAT_VERSION } from "./workspace-mounts.js";

type SpawnCall = {
  command: string;
  args: string[];
  globalArgs: string[];
  envFileContents?: string;
};

const spawnState = vi.hoisted(() => ({
  calls: [] as SpawnCall[],
  containerExists: true,
  inspectRunning: true,
  labelHash: "",
}));

const registryMocks = vi.hoisted(() => ({
  readRegistryEntry: vi.fn(),
  removeRegistryEntry: vi.fn(),
  updateRegistry: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("./registry.js", () => ({
  readRegistryEntry: registryMocks.readRegistryEntry,
  removeRegistryEntry: registryMocks.removeRegistryEntry,
  updateRegistry: registryMocks.updateRegistry,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtimeMocks,
}));

async function spawnDockerProcess(commandAndArgs: string[]) {
  const [command = "", ...args] = commandAndArgs;
  const call: SpawnCall = { command, args, globalArgs: [] };
  const envFileIndex = args.indexOf("--env-file");
  const envFile = envFileIndex === -1 ? undefined : args[envFileIndex + 1];
  if (args[0] === "create" && envFile) {
    call.envFileContents = fs.readFileSync(envFile, "utf8");
  }
  spawnState.calls.push(call);

  let code = 0;
  let stdout = "";
  let stderr = "";
  if (command !== "docker") {
    code = 1;
    stderr = `unexpected command: ${command}`;
  } else if (args[0] === "inspect" && args[1] === "-f" && args[2] === "{{.State.Running}}") {
    if (!spawnState.containerExists) {
      code = 1;
      stderr = "No such object";
    } else {
      stdout = spawnState.inspectRunning ? "true\n" : "false\n";
    }
  } else if (
    args[0] === "inspect" &&
    args[1] === "-f" &&
    args[2]?.includes('index .Config.Labels "openclaw.configHash"')
  ) {
    if (!spawnState.containerExists) {
      code = 1;
      stderr = "No such object";
    } else {
      stdout = `${spawnState.labelHash}\n`;
    }
  } else if (args[0] === "rm" && args[1] === "-f") {
    spawnState.containerExists = false;
    spawnState.inspectRunning = false;
  } else if (args[0] === "image" && args[1] === "inspect") {
    code = 0;
  } else if (args[0] === "create") {
    if (spawnState.containerExists) {
      code = 1;
      stderr = "container name is already in use";
    } else {
      spawnState.containerExists = true;
      spawnState.inspectRunning = false;
      spawnState.labelHash =
        args
          .find((arg) => arg.startsWith("openclaw.configHash="))
          ?.slice("openclaw.configHash=".length) ?? "";
    }
  } else if (args[0] === "start") {
    spawnState.inspectRunning = true;
  } else if (args[0] === "exec") {
    code = 0;
  } else {
    code = 1;
    stderr = `unexpected docker args: ${args.join(" ")}`;
  }
  return {
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: spawnDockerProcess,
}));

let ensureSandboxContainer: typeof import("./docker.js").ensureSandboxContainer;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("./registry.js", () => ({
    readRegistryEntry: registryMocks.readRegistryEntry,
    removeRegistryEntry: registryMocks.removeRegistryEntry,
    updateRegistry: registryMocks.updateRegistry,
  }));
  vi.doMock("../../process/exec.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../process/exec.js")>()),
    spawnCommand: spawnDockerProcess,
  }));
  ({ ensureSandboxContainer } = await import("./docker.js"));
});

function createSandboxConfig(binds?: string[]): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "shared",
    workspaceAccess: "rw",
    workspaceRoot: "~/.openclaw/sandboxes",
    dockerTmpfsSource: "default",
    docker: {
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-test-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
      dns: [],
      extraHosts: ["host.docker.internal:host-gateway"],
      binds: binds ?? ["/tmp/workspace:/workspace:rw"],
      dangerouslyAllowReservedContainerTargets: true,
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "openclaw-browser:test",
      containerPrefix: "oc-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      noVncEnabled: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 5000,
    },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 24, maxAgeDays: 7 },
  };
}

async function ensureSandboxCreateCallForTest(params: {
  cfg: SandboxConfig;
  workspaceDir: string;
}): Promise<SpawnCall> {
  await ensureSandboxContainer({
    scopeKey: "shared",
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });

  const createCall = spawnState.calls.find(
    (call) => call.command === "docker" && call.args[0] === "create",
  );
  if (!createCall) {
    throw new Error("expected docker create call");
  }
  return createCall;
}

describe("ensureSandboxContainer denySelfCli PATH-shadow bind mount", () => {
  beforeEach(() => {
    spawnState.calls.length = 0;
    spawnState.containerExists = true;
    spawnState.inspectRunning = true;
    spawnState.labelHash = "";
    registryMocks.readRegistryEntry.mockClear();
    registryMocks.removeRegistryEntry.mockClear();
    registryMocks.removeRegistryEntry.mockResolvedValue(undefined);
    registryMocks.updateRegistry.mockClear();
    registryMocks.updateRegistry.mockResolvedValue(undefined);
    runtimeMocks.log.mockClear();
  });

  afterEach(() => {
    clearSelfCliDenyPathShadowForTest();
  });

  it("bind-mounts the PATH-shadow stub directory read-only when denySelfCli is active", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const stateDir = tempDirs.make("openclaw-docker-denyselfcli-state-");
    const cfg = createSandboxConfig([`${workspaceDir}:/workspace:rw`]);
    cfg.denySelfCli = true;
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      clearSelfCliDenyPathShadowForTest();
      const createCall = await ensureSandboxCreateCallForTest({ cfg, workspaceDir });

      const stubDir = path.join(stateDir, "tmp", "exec-self-cli-deny-stub");
      const bindArgs = collectDockerFlagValues(createCall.args, "-v");
      expect(bindArgs).toContain(`${stubDir}:${stubDir}:ro,z`);
      // A dangling bind mount pointing at an empty directory would be a no-op: prove the
      // deny stub the container's PATH lookup is meant to find is really on the host side.
      expect(fs.existsSync(path.join(stubDir, "vasudev"))).toBe(true);
    });
  });

  it("does not add the PATH-shadow bind mount when denySelfCli is inactive", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const stateDir = tempDirs.make("openclaw-docker-denyselfcli-state-");
    const cfg = createSandboxConfig([`${workspaceDir}:/workspace:rw`]);
    spawnState.inspectRunning = false;
    registryMocks.readRegistryEntry.mockResolvedValue(null);

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      clearSelfCliDenyPathShadowForTest();
      const createCall = await ensureSandboxCreateCallForTest({ cfg, workspaceDir });

      const bindArgs = collectDockerFlagValues(createCall.args, "-v");
      expect(bindArgs.some((bind) => bind.includes("exec-self-cli-deny-stub"))).toBe(false);
    });
  });

  it("recreates an existing shared container to add the bind mount once denySelfCli turns on", async () => {
    const workspaceDir = tempDirs.make("openclaw-docker-mounts-");
    const stateDir = tempDirs.make("openclaw-docker-denyselfcli-state-");
    const oldCfg = createSandboxConfig([`${workspaceDir}:/workspace:rw`]);
    const newCfg = createSandboxConfig([`${workspaceDir}:/workspace:rw`]);
    newCfg.denySelfCli = true;

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      clearSelfCliDenyPathShadowForTest();
      const oldHash = computeSandboxConfigHash({
        docker: oldCfg.docker,
        workspaceAccess: oldCfg.workspaceAccess,
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        mountFormatVersion: SANDBOX_MOUNT_FORMAT_VERSION,
        createArgsEpoch: SANDBOX_DOCKER_CREATE_ARGS_EPOCH,
        readOnlyWorkspaceSkillMounts: [],
      });
      spawnState.labelHash = oldHash;
      registryMocks.readRegistryEntry.mockResolvedValue({
        containerName: "oc-test-shared",
        sessionKey: "shared",
        createdAtMs: 1,
        lastUsedAtMs: 0,
        image: newCfg.docker.image,
        configHash: oldHash,
      });

      const createCall = await ensureSandboxCreateCallForTest({ cfg: newCfg, workspaceDir });

      const stubDir = path.join(stateDir, "tmp", "exec-self-cli-deny-stub");
      const bindArgs = collectDockerFlagValues(createCall.args, "-v");
      expect(bindArgs).toContain(`${stubDir}:${stubDir}:ro,z`);
      expect(
        spawnState.calls.some(
          (call) =>
            call.args[0] === "rm" && call.args[1] === "-f" && call.args[2] === "oc-test-shared",
        ),
      ).toBe(true);
    });
  });
});
