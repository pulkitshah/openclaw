import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionHandle,
  CliBackendPreparedExecution,
} from "openclaw/plugin-sdk/cli-backend";
import { formatErrorMessageForDisplay } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { type ClaudeCliSecretInput, resolveClaudeCliSpawnInvocation } from "./cli-process.js";
import { executeClaudeCli } from "./cli.runtime.js";

const roots: string[] = [];
const sessions = new Set<CliBackendLiveSessionHandle>();

const PROTOCOL_CHILD = `
  import { createInterface } from "node:readline";
  import { readFileSync, writeSync } from "node:fs";
  const credential = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
    ? readFileSync(3, "utf8") : "";
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  let delayedDiagnostic = "";
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "control_request") {
      send({ type: "control_response", response: {
        subtype: "success", request_id: message.request_id, response: {},
      } });
    } else if (message.type === "user") {
      const text = message.message.content;
      if (delayedDiagnostic) {
        writeSync(2, delayedDiagnostic);
        delayedDiagnostic = "";
      }
      if (text === "fail silently") process.exit(1);
      if (text === "fail noisily" || text === "exit without result") {
        writeSync(2, "PermissionError: current turn failed " + credential + "\\n");
        writeSync(2, "process environment: " + process.env.OPENCLAW_MCP_TOKEN + "\\n");
        process.exit(text === "exit without result" ? 0 : 1);
      }
      if (text === "success with stderr") writeSync(2, "previous turn diagnostic\\n");
      if (text === "success with delayed stderr") {
        delayedDiagnostic = "previous turn diagnostic " + credential + "\\n";
      }
      send({ type: "result", subtype: "success", is_error: false, result: "ok",
        session_id: "synthetic-session", duration_ms: 1, duration_api_ms: 1,
        num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
      });
    }
  });
`;

afterEach(async () => {
  for (const session of sessions) {
    session.close("restart");
    await session.waitForExit();
  }
  sessions.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function contextForChild(source: string): Promise<CliBackendExecuteContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-stderr-"));
  roots.push(root);
  const command = path.join(root, "claude.mjs");
  await writeFile(command, source);
  return {
    command: process.execPath,
    args: [command],
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: root, CLAUDE_CONFIG_DIR: root },
    prompt: "Synthetic subprocess diagnostic probe.",
    systemPrompt: "Synthetic subprocess diagnostic probe.",
    modelId: "claude-sonnet-4-6",
    useResume: false,
    timeoutMs: 10_000,
    abortSignal: AbortSignal.timeout(10_000),
    requestToolPermission: async () => ({ behavior: "deny", message: "No tools in this probe." }),
    requestUserInput: async () => ({ status: "cancelled", message: "No input in this probe." }),
  };
}

async function collect(
  context: CliBackendExecuteContext,
  secretInput?: Parameters<typeof executeClaudeCli>[1],
  execute = executeClaudeCli,
) {
  const events: Record<string, unknown>[] = [];
  for await (const event of execute(context, secretInput)) {
    events.push(event);
  }
  return events;
}

function attachLiveSession(context: CliBackendExecuteContext) {
  let current: CliBackendLiveSessionHandle | undefined;
  context.liveSession = {
    fingerprint: "synthetic-process-policy",
    current: () => current,
    restart: async () => {
      const previous = current;
      previous?.close("restart");
      await previous?.waitForExit();
    },
    register: (handle) => {
      current = handle;
      sessions.add(handle);
    },
    activate: () => {},
    remove: (handle) => {
      if (current === handle) {
        current = undefined;
      }
    },
  };
  return () => current;
}

describe("resolveClaudeCliSpawnInvocation", () => {
  // On Windows the npm-installed CLI is a `claude.cmd` shim around bin\claude.exe; Node's raw
  // spawn("claude") cannot run it, the spawn fails asynchronously and the first prompt write
  // dies with EPIPE (live 2026-10-16 on the Azure desk: every turn failed, no claude.exe ever
  // started). The plugin resolves the shim to its executable the way the Gateway's own child
  // adapter does.
  it("resolves the Windows npm shim to the executable it forwards to", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-shim-"));
    roots.push(root);
    const exeDir = path.join(root, "node_modules", "@anthropic-ai", "claude-code", "bin");
    await mkdir(exeDir, { recursive: true });
    const exePath = path.join(exeDir, "claude.exe");
    await writeFile(exePath, "");
    await writeFile(
      path.join(root, "claude.cmd"),
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
        "",
      ].join("\r\n"),
    );

    const invocation = resolveClaudeCliSpawnInvocation({
      command: "claude",
      args: ["-p", "--output-format", "stream-json"],
      env: { PATH: root, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      platform: "win32",
      execPath: "C:\\node\\node.exe",
    });

    expect(invocation).toEqual({
      command: exePath,
      args: ["-p", "--output-format", "stream-json"],
      shell: undefined,
      windowsHide: true,
    });
  });

  it("leaves the command alone off Windows", () => {
    expect(
      resolveClaudeCliSpawnInvocation({
        command: "claude",
        args: ["-p"],
        env: { PATH: "/usr/local/bin" },
        platform: "linux",
      }),
    ).toEqual({ command: "claude", args: ["-p"], shell: undefined, windowsHide: undefined });
  });
});

describe("Claude subprocess diagnostics through the direct CLI transport", () => {
  it("drains pipe-sized stderr and reports a bounded redacted fatal diagnostic", async () => {
    const secret = "sk-ant-api03-synthetic-diagnostic-credential-123456789";
    const context = await contextForChild(`
      import { writeSync } from "node:fs";
      writeSync(2, "discarded noise".repeat(100_000) + "\\n");
      writeSync(2, "Authorization: Bear");
      writeSync(2, "er ${secret}\\n");
      writeSync(2, "PermissionError: [Errno 1] Operation not permitted: '/bin/ps' 🦞");
      process.exit(1);
    `);
    const error = await collect(context).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Claude Code process exited with code 1");
    expect(formatErrorMessageForDisplay(error)).toContain("exited with code 1");
    expect(formatErrorMessageForDisplay(error)).toContain("PermissionError: [Errno 1]");
    expect(formatErrorMessageForDisplay(error)).toContain("'/bin/ps' 🦞");
    expect(formatErrorMessageForDisplay(error)).not.toContain(secret);
    expect(formatErrorMessageForDisplay(error)).not.toContain("discarded noise");
    expect(formatErrorMessageForDisplay(error).length).toBeLessThan(2_200);
  });

  it("preserves a silent child's exit error without inventing stderr", async () => {
    const context = await contextForChild("process.exit(1);");
    await expect(collect(context)).rejects.toThrow(/^Claude Code process exited with code 1$/);
  });

  it("masks opaque descriptor and environment credentials without copying native stdout", async () => {
    const context = await contextForChild(`
      import { readFileSync, writeSync } from "node:fs";
      writeSync(1, "native stdout must stay private\\n");
      writeSync(2, "credential: " + readFileSync(3, "utf8") + "\\n");
      writeSync(2, "environment: " + process.env.OPENCLAW_MCP_TOKEN + "\\n");
      writeSync(2, "PermissionError: denied resource 3\\n");
      process.exit(1);
    `);
    const credential = "opaque-descriptor-fixture-value";
    const grant = "opaque-mcp-fixture-value";
    context.env.OPENCLAW_MCP_TOKEN = grant;
    context.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = "3";
    const buffers: Buffer[] = [];
    const running = collect(context, {
      fd: 3,
      createData: () => {
        const bytes = Buffer.from(credential);
        buffers.push(bytes);
        return bytes;
      },
    });
    const error = await running.catch((failure: unknown) => failure);
    expect(formatErrorMessageForDisplay(error)).toContain("PermissionError: denied resource 3");
    expect(formatErrorMessageForDisplay(error)).toContain("[REDACTED]");
    for (const privateText of [
      credential,
      grant,
      "native stdout must stay private",
      context.prompt,
    ]) {
      expect(formatErrorMessageForDisplay(error)).not.toContain(privateText);
    }
    expect(buffers.length).toBeGreaterThan(0);
    expect(buffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  });

  // POSIX process groups survive root exit; Windows cannot enumerate a spontaneously exited root.
  it.skipIf(process.platform === "win32")(
    "reports failure and reaps a descendant that inherited stderr",
    async () => {
      const context = await contextForChild(`
      import { spawn } from "node:child_process";
      import { writeFileSync, writeSync } from "node:fs";
      const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"],
        { stdio: ["ignore", "ignore", 2] });
      writeFileSync("descendant.pid", String(descendant.pid));
      writeSync(2, "PermissionError: parent exited\\n");
      process.exit(1);
    `);
      try {
        const error = await collect(context).catch((failure: unknown) => failure);
        expect(formatErrorMessageForDisplay(error)).toContain("PermissionError: parent exited");
        const pid = Number(await readFile(path.join(context.cwd, "descendant.pid"), "utf8"));
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          })
          .toBe(true);
      } finally {
        const pid = Number(await readFile(path.join(context.cwd, "descendant.pid"), "utf8"));
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    },
  );

  it.each(["success", "success with stderr"])("keeps %s quiet", async (prompt) => {
    const context = await contextForChild(PROTOCOL_CHILD);
    const stderr = vi.spyOn(process.stderr, "write");
    const events = await collect({ ...context, prompt });
    expect(events).toContainEqual(expect.objectContaining({ type: "result", result: "ok" }));
    expect(stderr).not.toHaveBeenCalled();
  });

  it("keeps diagnostics isolated between live processes", async () => {
    const warm = await contextForChild(PROTOCOL_CHILD);
    attachLiveSession(warm);
    await collect({ ...warm, prompt: "success with stderr" });
    const other = await contextForChild("process.exit(1);");
    attachLiveSession(other);
    await expect(collect(other)).rejects.toThrow(/^Claude Code process exited with code 1$/);
    const error = await collect({ ...warm, prompt: "fail silently" }).catch(
      (failure: unknown) => failure,
    );
    expect(formatErrorMessageForDisplay(error)).toContain(
      "stderr (process-wide; may include earlier turns): previous turn diagnostic",
    );
  });

  it.each([
    { firstPrompt: "success with stderr", prompt: "fail silently" },
    { firstPrompt: "success with stderr", prompt: "fail noisily" },
    { firstPrompt: "success with stderr", prompt: "close idle" },
    { firstPrompt: "success with delayed stderr", prompt: "fail silently" },
    { firstPrompt: "success with stderr", prompt: "exit without result" },
  ])(
    "retains process diagnostics after credential cleanup: $firstPrompt then $prompt",
    async ({ firstPrompt, prompt }) => {
      const context = await contextForChild(PROTOCOL_CHILD);
      const credential = "opaque-warm-credential-fixture";
      const processGrant = "opaque-first-process-grant-fixture";
      const backend = buildAnthropicCliBackend();
      const prepare = async () => {
        // The descriptor is a provider-private field, outside the public SDK result type.
        const prepared = (await backend.prepareExecution?.({
          workspaceDir: context.cwd,
          provider: "claude-cli",
          modelId: context.modelId,
          executionMode: "agent",
          authCredential: { type: "token", token: credential },
        } as Parameters<NonNullable<typeof backend.prepareExecution>>[0])) as
          | (CliBackendPreparedExecution & { secretInput?: ClaudeCliSecretInput })
          | undefined;
        if (!prepared?.execute || !prepared.secretInput || !prepared.cleanup) {
          throw new Error("Expected a managed Claude CLI execution.");
        }
        return {
          ...prepared,
          execute: prepared.execute,
          secretInput: prepared.secretInput,
          cleanup: prepared.cleanup,
        };
      };
      const current = attachLiveSession(context);
      const stderr = vi.spyOn(process.stderr, "write");
      const first = await prepare();
      const buffers: Buffer[] = [];
      const createData = first.secretInput.createData;
      vi.spyOn(first.secretInput, "createData").mockImplementation(() => {
        const bytes = createData();
        buffers.push(bytes);
        return bytes;
      });
      await expect(
        collect(
          {
            ...context,
            env: { ...context.env, ...first.env, OPENCLAW_MCP_TOKEN: processGrant },
            prompt: firstPrompt,
          },
          undefined,
          first.execute,
        ),
      ).resolves.toContainEqual(expect.objectContaining({ result: "ok" }));
      await first.cleanup();
      expect(() => first.secretInput.createData()).toThrow("no longer available");
      expect(current()?.isIdle()).toBe(true);
      if (prompt === "close idle") {
        const closing = current();
        closing?.close("idle");
        await closing?.waitForExit();
      } else {
        const second = await prepare();
        const error = await collect(
          {
            ...context,
            env: { ...context.env, ...second.env, OPENCLAW_MCP_TOKEN: "opaque-next-grant-fixture" },
            prompt,
            useResume: true,
          },
          undefined,
          second.execute,
        ).catch((failure: unknown) => failure);
        await second.cleanup();
        expect(formatErrorMessageForDisplay(error)).toContain(
          prompt === "exit without result"
            ? "live session exited unexpectedly"
            : "exited with code 1",
        );
        expect(formatErrorMessageForDisplay(error)).toContain(
          "stderr (process-wide; may include earlier turns):",
        );
        expect(formatErrorMessageForDisplay(error)).toContain("previous turn diagnostic");
        expect(formatErrorMessageForDisplay(error)).not.toContain(credential);
        expect(formatErrorMessageForDisplay(error)).not.toContain(processGrant);
        expect(
          formatErrorMessageForDisplay(error).includes("PermissionError: current turn failed"),
        ).toBe(prompt === "fail noisily" || prompt === "exit without result");
      }
      expect(buffers.length).toBeGreaterThan(0);
      expect(buffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
      expect(stderr).not.toHaveBeenCalled();
    },
  );
});
