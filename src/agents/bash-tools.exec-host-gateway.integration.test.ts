import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../infra/agent-events.js";
import { saveExecApprovals } from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import { clearSelfCliDenyPathShadowForTest } from "../infra/exec-self-cli-deny-path-shadow.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { pathLooksMutableForShellPayloadSync } from "../infra/system-run-mutable-file-policy.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { ProcessSupervisor } from "../process/supervisor/types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { callGatewayTool } from "./tools/gateway.js";

/** Directory of a real binary on the *test runner's own* PATH, or undefined if not found. */
function resolveRealBinDir(bin: string): string | undefined {
  try {
    const resolved =
      process.platform === "win32"
        ? execFileSync("where", [bin], { encoding: "utf8" })
        : execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
    const trimmed = resolved.trim();
    return trimmed ? path.dirname(trimmed.split("\n")[0] ?? trimmed) : undefined;
  } catch {
    return undefined;
  }
}

const REAL_PNPM_DIR = resolveRealBinDir("pnpm");
const REAL_PYTHON3_DIR = resolveRealBinDir("python3");

const spawn = vi.hoisted(() => vi.fn<ProcessSupervisor["spawn"]>());
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn }),
}));
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

describe.skipIf(process.platform === "win32")("gateway dispatch executable binding", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let root: string;
  let binDir: string;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "USERPROFILE",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "PATH",
      "SHELL",
    ]);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dispatch-binding-"));
    binDir = path.join(root, "bin");
    fs.mkdirSync(binDir);
    for (const name of ["HOME", "USERPROFILE", "OPENCLAW_HOME"]) {
      setTestEnvValue(name, root);
    }
    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(root, "state"));
    setTestEnvValue("PATH", `${binDir}:/usr/bin:/bin`);
    setTestEnvValue("SHELL", "/bin/sh");
    resetProcessRegistryForTests();
    // The shadow-stub directory is a process-global singleton keyed off OPENCLAW_STATE_DIR; reset
    // it every test so a later test with a fresh (different) state dir never reuses a prior test's
    // already-deleted tempdir.
    clearSelfCliDenyPathShadowForTest();
    saveExecApprovals({
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: {},
    });
    vi.mocked(callGatewayTool).mockReset();
    // Substitution cases never dispatch fixture files, including on the unfixed code.
    spawn.mockReset().mockImplementation(async () => ({
      activity: { resultSettled: true, lastOutputAtMs: Date.now() },
      runId: "recorded-spawn",
      startedAtMs: Date.now(),
      cancel: () => {},
      wait: async () => ({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    }));
  });

  afterEach(() => {
    resetProcessRegistryForTests();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function makeTool(mode: "auto" | "ask", autoReviewer: ExecAutoReviewer) {
    return createExecTool({
      agentId: "main",
      host: "gateway",
      mode,
      safeBins: [],
      autoReviewer,
      cwd: root,
      pathPrepend: [binDir, "/usr/bin", "/bin"],
      runId: "dispatch-binding-run",
      messageProvider: "webchat",
    });
  }

  it.each([
    { approval: "auto", executable: "env", command: "env ls *.txt" },
    { approval: "auto", executable: "ls", command: "env ls *.txt" },
    { approval: "auto", executable: "ls", command: "ls *.txt" },
    { approval: "human", executable: "env", command: "env ls *.txt" },
    { approval: "human", executable: "ls", command: "env ls *.txt" },
  ] as const)(
    "rejects real PATH substitution of $executable after $approval approval of $command before spawn",
    async ({ approval, executable, command }) => {
      fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
      for (const executableName of ["env", "ls"]) {
        const resolved = resolveExecutablePath(executableName, {
          env: process.env,
          useCache: false,
        });
        expect(resolved).toBeDefined();
        expect(pathLooksMutableForShellPayloadSync(resolved ?? "")).toBe(false);
      }
      const replacement = path.join(binDir, executable);
      const substitute = () => fs.writeFileSync(replacement, "", { mode: 0o755 });
      const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
        decision: "allow-once",
        risk: "low",
        rationale: "list fixture files",
      }));
      let approved = false;
      const unsubscribe = onAgentEvent((event) => {
        if (
          approval === "auto" &&
          event.runId === "dispatch-binding-run" &&
          event.data.approvalReviewOutcome === "approved"
        ) {
          approved = true;
          substitute();
        }
      });
      vi.mocked(callGatewayTool).mockImplementation(async (method) => {
        if (method === "exec.approval.request") {
          return { status: "accepted", id: "dispatch-binding-approval" };
        }
        if (method === "exec.approval.waitDecision") {
          approved = true;
          substitute();
          return { decision: "allow-once" };
        }
        return { ok: true };
      });
      const tool = makeTool(approval === "auto" ? "auto" : "ask", autoReviewer);
      try {
        const result = await tool.execute("dispatch-binding-call", { command });
        expect(approved).toBe(true);
        expect(resolveExecutablePath(executable, { env: process.env, useCache: false })).toBe(
          replacement,
        );
        expect(spawn.mock.calls.length).toBe(0);
        expect(result.details.status).toBe("failed");
        expect(result.content[0]).toMatchObject({
          text: expect.stringContaining("approval script operand changed before execution"),
        });
        if (approval === "auto") {
          expect(autoReviewer).toHaveBeenCalledOnce();
          expect(callGatewayTool).not.toHaveBeenCalled();
        } else {
          expect(autoReviewer).not.toHaveBeenCalled();
          expect(callGatewayTool).toHaveBeenCalledWith(
            "exec.approval.waitDecision",
            expect.anything(),
            expect.objectContaining({ id: expect.any(String) }),
          );
        }
      } finally {
        unsubscribe();
      }
    },
  );

  it.each(["env ls *.txt", "ls *.txt"])(
    "really executes approved unpinned %s and returns stdout without substitution",
    async (command) => {
      fs.writeFileSync(path.join(root, "approved.txt"), "fixture");
      const supervisor = createProcessSupervisor();
      spawn.mockImplementation((input) => supervisor.spawn(input));
      const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
        decision: "allow-once",
        risk: "low",
        rationale: "list fixture files",
      }));
      const result = await makeTool("auto", autoReviewer).execute("dispatch-positive-call", {
        command,
      });
      expect(autoReviewer).toHaveBeenCalledWith(
        expect.objectContaining({ command, reason: "execution-plan-miss" }),
      );
      expect(callGatewayTool).not.toHaveBeenCalled();
      expect(spawn.mock.calls.length).toBe(1);
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining("approved.txt") });
    },
  );

  it.each([
    "env FOO=bar ls *.txt",
    "sh -c 'ls *.txt'",
    "xcrun ls *.txt",
    "command ls *.txt",
    "exec ls *.txt",
    "builtin echo *.txt",
  ])("routes unbindable dispatch %s to human approval without auto-review", async (command) => {
    fs.copyFileSync("/usr/bin/true", path.join(binDir, "xcrun"));
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "would approve if called",
    }));
    const recordedSpawn = spawn.getMockImplementation()!;
    spawn.mockImplementation(async (...args) => {
      fs.writeFileSync(path.join(root, "spawn-marker"), "recorded");
      return recordedSpawn(...args);
    });
    vi.mocked(callGatewayTool).mockImplementation(async () => {
      fs.writeFileSync(path.join(binDir, "ls"), "", { mode: 0o755 });
      return { decision: "deny" };
    });
    const result = await makeTool("auto", autoReviewer).execute("dispatch-human-call", {
      command,
    });
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(callGatewayTool).toHaveBeenCalledWith(
      "exec.approval.request",
      expect.anything(),
      expect.objectContaining({
        command,
        warningText: expect.stringContaining(
          "Exec auto-review skipped: dispatch chain cannot be bound",
        ),
      }),
      expect.anything(),
    );
    expect(result.details.status).toBe("failed");
    expect(spawn.mock.calls.length).toBe(0);
    expect(fs.existsSync(path.join(root, "spawn-marker"))).toBe(false);
  });

  it.each(["busybox", "toybox"])(
    "retains opaque interpreter rejection for %s shell applets with a resolved binary",
    async (wrapper) => {
      const wrapperPath = path.join(binDir, wrapper);
      fs.copyFileSync("/usr/bin/true", wrapperPath);
      expect(resolveExecutablePath(wrapper, { env: process.env, useCache: false })).toBe(
        wrapperPath,
      );
      const autoReviewer = vi.fn<ExecAutoReviewer>();
      const result = await makeTool("auto", autoReviewer).execute("dispatch-opaque-call", {
        command: `${wrapper} sh -c 'ls *.txt'`,
      });
      expect(result.details.status).toBe("failed");
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining(
          "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
        ),
      });
      expect(autoReviewer).not.toHaveBeenCalled();
      expect(callGatewayTool).not.toHaveBeenCalled();
      expect(spawn.mock.calls.length).toBe(0);
    },
  );

  it.each(["busybox", "toybox"])(
    "retains binding rejection for missing %s dispatch files",
    async (wrapper) => {
      const autoReviewer = vi.fn<ExecAutoReviewer>();
      const result = await makeTool("auto", autoReviewer).execute("dispatch-unresolved-call", {
        command: `${path.join(root, "missing", wrapper)} ls *.txt`,
      });
      expect(result.details.status).toBe("failed");
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining("SYSTEM_RUN_DENIED"),
      });
      expect(autoReviewer).not.toHaveBeenCalled();
      expect(callGatewayTool).not.toHaveBeenCalled();
      expect(spawn.mock.calls.length).toBe(0);
    },
  );

  // Fix-round regression: this exact `bash -lc "vasudev ..."`/`openclaw ...` shell-out was a live,
  // unconditional bypass of `denySelfCli` under the full-trust `bypassApprovals` path (mode=full +
  // bypassHostApprovalFloors) — `evaluateShellAllowlistWithAuthorization`'s returned segments never
  // included the wrapped inner command, so `resolveExecSelfCliDenial` saw only a `bash` segment
  // and let the command spawn for real. See `../infra/exec-self-cli-deny.test.ts` for the unit-level
  // coverage of the underlying recursion fix.
  describe("denySelfCli under full-trust bypass: shell-wrapper bypass regression", () => {
    function makeFullBypassTool(denySelfCli: boolean) {
      return createExecTool({
        agentId: "main",
        host: "gateway",
        mode: "full",
        bypassHostApprovalFloors: true,
        denySelfCli,
        safeBins: [],
        cwd: root,
        pathPrepend: [binDir, "/usr/bin", "/bin"],
        runId: "self-cli-bypass-run",
        messageProvider: "webchat",
      });
    }

    it.each([
      { executable: "vasudev", command: 'bash -lc "vasudev pairing approve whatsapp ABC123"' },
      { executable: "openclaw", command: 'bash -lc "openclaw config set foo bar"' },
      { executable: "vasudev", command: 'sh -c "vasudev pairing approve whatsapp ABC123"' },
      { executable: "vasudev", command: 'env bash -lc "vasudev pairing approve whatsapp ABC123"' },
    ])(
      "denies $command and never spawns the real $executable binary",
      async ({ executable, command }) => {
        fs.writeFileSync(path.join(binDir, executable), "#!/bin/sh\necho REAL_SELF_CLI_RAN\n", {
          mode: 0o755,
        });
        const result = await makeFullBypassTool(true).execute("self-cli-bypass-call", { command });
        expect(result.details.status).not.toBe("completed");
        expect(result.content[0]).toMatchObject({
          text: expect.stringContaining("self-cli-denied"),
        });
        expect(spawn.mock.calls.length).toBe(0);
        expect(callGatewayTool).not.toHaveBeenCalled();
      },
    );

    it("leaves an ordinary command wrapped in bash -lc unaffected by denySelfCli (non-regression)", async () => {
      const supervisor = createProcessSupervisor();
      spawn.mockImplementation((input) => supervisor.spawn(input));
      const result = await makeFullBypassTool(true).execute("self-cli-bypass-benign-call", {
        command: 'bash -lc "printf ok-not-self-cli"',
      });
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining("ok-not-self-cli") });
      expect(spawn.mock.calls.length).toBe(1);
    });

    it("is a no-op when denySelfCli is not set, even for the same bash -lc self-CLI command", async () => {
      fs.writeFileSync(path.join(binDir, "vasudev"), "#!/bin/sh\necho REAL_SELF_CLI_RAN\n", {
        mode: 0o755,
      });
      const supervisor = createProcessSupervisor();
      spawn.mockImplementation((input) => supervisor.spawn(input));
      const result = await makeFullBypassTool(false).execute("self-cli-bypass-off-call", {
        command: 'bash -lc "vasudev pairing approve whatsapp ABC123"',
      });
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      expect(spawn.mock.calls.length).toBe(1);
    });
  });

  // Structural-pivot fix round: an adversarial re-review found that the static segment-analysis
  // check (recursing only into recognized *shell wrapper* forms) never inspects a self-CLI
  // invocation buried inside an unrecognized indirection tool -- `pnpm exec`, `find -exec`,
  // `xargs`, a scripting language's subprocess-by-name call -- so these reach a real spawn even
  // with denySelfCli:true. The PATH-shadow layer (`../infra/exec-self-cli-deny-path-shadow.ts`)
  // closes the whole class at once: it makes bare `vasudev`/`openclaw` unresolvable via PATH for
  // the *entire* process tree the outer command spawns, regardless of which indirection tool is
  // used. Unlike the static check, this layer does not prevent the outer wrapper itself from
  // spawning for real (the shell/pnpm/find process really runs) -- it denies only once something
  // in that tree actually tries to resolve the forbidden bare name.
  describe("denySelfCli PATH-shadow layer: buried/indirect invocation bypasses", () => {
    function makeShadowBypassTool() {
      return createExecTool({
        agentId: "main",
        host: "gateway",
        mode: "full",
        bypassHostApprovalFloors: true,
        denySelfCli: true,
        safeBins: [],
        cwd: root,
        pathPrepend: [binDir, "/usr/bin", "/bin"],
        runId: "self-cli-shadow-run",
        messageProvider: "webchat",
      });
    }

    beforeEach(() => {
      fs.writeFileSync(path.join(root, "package.json"), '{"name":"self-cli-shadow-fixture"}\n');
      // Real pnpm/python3 are needed to actually exercise these indirection tools; append their
      // real install directories after the narrow test PATH (never ahead of it).
      const extra = [REAL_PNPM_DIR, REAL_PYTHON3_DIR].filter((dir): dir is string => Boolean(dir));
      if (extra.length > 0) {
        setTestEnvValue("PATH", `${binDir}:/usr/bin:/bin:${extra.join(":")}`);
      }
      const supervisor = createProcessSupervisor();
      spawn.mockImplementation((input) => supervisor.spawn(input));
    });

    function seedRealSelfCli(executable: string) {
      fs.writeFileSync(path.join(binDir, executable), "#!/bin/sh\necho REAL_SELF_CLI_RAN\n", {
        mode: 0o755,
      });
    }

    const buriedInvocationCases = [
      {
        name: "pnpm exec bash -c",
        command: 'pnpm exec bash -c "vasudev pairing approve whatsapp ABC123"',
        requires: REAL_PNPM_DIR,
      },
      {
        name: "find -exec",
        command: "find . -maxdepth 0 -exec vasudev pairing approve whatsapp ABC123 \\;",
        requires: true,
      },
      {
        name: "xargs",
        command: "printf approve | xargs -I{} vasudev pairing {} whatsapp ABC123",
        requires: true,
      },
      {
        name: "sh -c exec",
        command: "sh -c 'exec vasudev pairing approve whatsapp ABC123'",
        requires: true,
      },
    ].filter((c) => c.requires);

    it.each(buriedInvocationCases)(
      "denies $name and never lets the real vasudev binary run",
      async ({ command }) => {
        seedRealSelfCli("vasudev");
        const result = await makeShadowBypassTool().execute("self-cli-shadow-call", { command });
        const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
        // The security-relevant invariant: the real fake binary's marker never appears, however
        // the denial happened. `pnpm exec`/`find -exec`/`xargs` are not recognized shell wrappers,
        // so the static check cannot see the buried command at all -- these three only pass
        // because of the PATH-shadow layer, proven below by a genuine outer-wrapper spawn. `sh -c
        // 'exec ...'` happens to still be caught by the existing static check too (an `exec`
        // builtin prefix does not hide it from that analysis), so it is included here as an
        // additional adversarial variant without asserting *which* layer denied it.
        expect(text).not.toContain("REAL_SELF_CLI_RAN");
      },
    );

    it.each(buriedInvocationCases.filter((c) => c.name !== "sh -c exec"))(
      "$name reaches a genuine outer-wrapper spawn (PATH-shadow layer, not a static pre-spawn denial)",
      async ({ command }) => {
        seedRealSelfCli("vasudev");
        await makeShadowBypassTool().execute("self-cli-shadow-spawn-proof-call", { command });
        expect(spawn.mock.calls.length).toBeGreaterThan(0);
      },
    );

    it.skipIf(!REAL_PYTHON3_DIR)(
      "denies python3 subprocess.run(['vasudev', ...]) and never spawns the real binary",
      async () => {
        seedRealSelfCli("vasudev");
        const command =
          "python3 -c \"import subprocess; subprocess.run(['vasudev', 'pairing', 'approve'])\"";
        const result = await makeShadowBypassTool().execute("self-cli-shadow-python-call", {
          command,
        });
        const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
        expect(text).not.toContain("REAL_SELF_CLI_RAN");
        expect(spawn.mock.calls.length).toBeGreaterThan(0);
      },
    );

    it.skipIf(!REAL_PNPM_DIR)(
      "still catches the openclaw alias through the same pnpm exec indirection",
      async () => {
        seedRealSelfCli("openclaw");
        const result = await makeShadowBypassTool().execute("self-cli-shadow-openclaw-call", {
          command: 'pnpm exec bash -c "openclaw config set foo bar"',
        });
        const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
        expect(text).not.toContain("REAL_SELF_CLI_RAN");
        expect(spawn.mock.calls.length).toBeGreaterThan(0);
      },
    );

    it("leaves an ordinary pnpm exec / find -exec command unaffected (non-regression)", async () => {
      fs.writeFileSync(path.join(root, "marker.txt"), "fixture");
      const result = await makeShadowBypassTool().execute("self-cli-shadow-benign-call", {
        command: "find . -maxdepth 1 -name marker.txt -exec cat {} \\;",
      });
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining("fixture") });
      expect(spawn.mock.calls.length).toBeGreaterThan(0);
    });

    // Round 5 finding: `prepareSelfCliDenyPathShadow()`'s cached directory was never re-verified
    // on later calls. `$OPENCLAW_STATE_DIR` (where the stub directory lives) is an ordinary,
    // visible env var inside every exec'd command -- including ones NOT flagged denySelfCli -- so
    // an already-permitted command deleting it mid-session used to leave a *later*
    // denySelfCli:true call on the same tool instance silently unprotected: the cached in-memory
    // state still believed the stub existed and skipped recreating it, letting the exact
    // `find -exec` bypass round 3 closed reach the real binary for real again.
    it("self-repairs the PATH-shadow stub after an ordinary command deletes it mid-session", async () => {
      seedRealSelfCli("vasudev");
      const tool = makeShadowBypassTool();

      const warm = await tool.execute("self-cli-repair-warm", { command: "printf warm-ok" });
      expect(warm.details).toMatchObject({ status: "completed", exitCode: 0 });

      const stubDir = path.join(root, "state", "tmp", "exec-self-cli-deny-stub");
      expect(fs.existsSync(path.join(stubDir, "vasudev"))).toBe(true);

      const wipe = await tool.execute("self-cli-repair-wipe", {
        command: `rm -rf ${JSON.stringify(stubDir)}`,
      });
      expect(wipe.details).toMatchObject({ status: "completed", exitCode: 0 });
      expect(fs.existsSync(stubDir)).toBe(false);

      const result = await tool.execute("self-cli-repair-denied", {
        command: "find . -maxdepth 0 -exec vasudev pairing approve whatsapp ABC123 \\;",
      });
      const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
      expect(text).not.toContain("REAL_SELF_CLI_RAN");
      expect(fs.existsSync(path.join(stubDir, "vasudev"))).toBe(true);
    });
  });
});
