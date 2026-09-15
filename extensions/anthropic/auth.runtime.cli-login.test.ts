import type { ChildProcess } from "node:child_process";
// The wizard already owns a real terminal, so a missing Claude CLI login must
// be recoverable in place instead of sending the operator back to a shell.
import { EventEmitter } from "node:events";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { createTestWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";

const { probeClaudeCliAuthStatus } = vi.hoisted(() => ({
  probeClaudeCliAuthStatus: vi.fn(),
}));
const { resolveClaudeTerminalExecutable } = vi.hoisted(() => ({
  resolveClaudeTerminalExecutable: vi.fn(),
}));
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("./cli-auth-seam.js", async (importActual) => {
  const actual = await importActual<typeof import("./cli-auth-seam.js")>();
  return { ...actual, probeClaudeCliAuthStatus };
});

vi.mock("./session-catalog-executable.js", async (importActual) => {
  const actual = await importActual<typeof import("./session-catalog-executable.js")>();
  return { ...actual, resolveClaudeTerminalExecutable };
});

vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return { ...actual, spawn };
});

const { runAnthropicCliMigration, runAnthropicCliMigrationNonInteractive } =
  await import("./auth.runtime.js");
const { buildAnthropicCliMigrationResult } = await import("./cli-migration.js");

const MANUAL_LOGIN_ERROR = [
  "Claude CLI is not authenticated on this host.",
  "Run claude auth login first, then re-run this setup.",
].join("\n");

class FakeClaudeLogin extends EventEmitter {
  readonly kill = vi.fn((signal?: NodeJS.Signals) => {
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  });
}

const restoreTty: Array<() => void> = [];

function stubTty(value: boolean): void {
  for (const stream of [process.stdin, process.stdout]) {
    const previous = Object.getOwnPropertyDescriptor(stream, "isTTY");
    restoreTty.push(() => {
      if (previous) {
        Object.defineProperty(stream, "isTTY", previous);
        return;
      }
      delete (stream as { isTTY?: boolean }).isTTY;
    });
    Object.defineProperty(stream, "isTTY", { value, configurable: true, writable: true });
  }
}

function createContext(overrides: Partial<ProviderAuthContext> = {}): ProviderAuthContext {
  return {
    config: {},
    opts: {},
    env: {},
    agentDir: "/tmp/openclaw/agents/main",
    workspaceDir: "/tmp/openclaw/workspace",
    prompter: createTestWizardPrompter({ confirm: vi.fn(async () => true) }),
    runtime: createRuntimeSpies(),
    allowSecretRefPrompt: false,
    isRemote: false,
    openUrl: vi.fn(),
    oauth: { createVpsAwareHandlers: vi.fn() },
    ...overrides,
  } as ProviderAuthContext;
}

/** Resolve the login child only after the runtime attached its exit listeners. */
function spawnExitingLogin(exitCode: number): FakeClaudeLogin {
  const child = new FakeClaudeLogin();
  spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit("exit", exitCode, null));
    return child as unknown as ChildProcess;
  });
  return child;
}

beforeEach(() => {
  probeClaudeCliAuthStatus.mockReset();
  resolveClaudeTerminalExecutable.mockReset();
  spawn.mockReset();
  resolveClaudeTerminalExecutable.mockReturnValue({ executable: "/test/bin/claude" });
  stubTty(true);
});

afterEach(() => {
  while (restoreTty.length > 0) {
    restoreTty.pop()?.();
  }
});

afterAll(() => {
  vi.doUnmock("./cli-auth-seam.js");
  vi.doUnmock("./session-catalog-executable.js");
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

it("runs claude auth login in the wizard terminal and continues once the login lands", async () => {
  probeClaudeCliAuthStatus
    .mockResolvedValueOnce({ status: "missing" })
    .mockResolvedValueOnce({ status: "available" });
  spawnExitingLogin(0);
  const config = { agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } } };
  const ctx = createContext({ config, env: { CLAUDE_CONFIG_DIR: "/tmp/claude-work" } });

  await expect(runAnthropicCliMigration(ctx)).resolves.toEqual(
    buildAnthropicCliMigrationResult(config),
  );

  expect(ctx.prompter.confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Claude Code is not signed in on this computer. Sign in here now?",
    }),
  );
  expect(spawn).toHaveBeenCalledWith(
    "/test/bin/claude",
    ["auth", "login"],
    expect.objectContaining({
      stdio: "inherit",
      env: expect.objectContaining({ CLAUDE_CONFIG_DIR: "/tmp/claude-work" }),
    }),
  );
  expect(probeClaudeCliAuthStatus).toHaveBeenCalledTimes(2);
});

it("uses the resolved Claude shell PATH for the login process", async () => {
  probeClaudeCliAuthStatus
    .mockResolvedValueOnce({ status: "missing" })
    .mockResolvedValueOnce({ status: "available" });
  resolveClaudeTerminalExecutable.mockReturnValue({
    executable: "/test/bin/claude",
    pathEnv: "/test/bin:/usr/bin",
  });
  spawnExitingLogin(0);

  await runAnthropicCliMigration(createContext());

  expect(spawn).toHaveBeenCalledWith(
    "/test/bin/claude",
    ["auth", "login"],
    expect.objectContaining({ env: expect.objectContaining({ PATH: "/test/bin:/usr/bin" }) }),
  );
});

it("keeps the manual instructions when the operator declines the sign-in offer", async () => {
  probeClaudeCliAuthStatus.mockResolvedValue({ status: "missing" });
  const ctx = createContext({
    prompter: createTestWizardPrompter({ confirm: vi.fn(async () => false) }),
  });

  await expect(runAnthropicCliMigration(ctx)).rejects.toThrow(MANUAL_LOGIN_ERROR);

  expect(ctx.prompter.confirm).toHaveBeenCalledTimes(1);
  expect(spawn).not.toHaveBeenCalled();
  expect(probeClaudeCliAuthStatus).toHaveBeenCalledTimes(1);
});

it("keeps the manual instructions without prompting when no Claude executable resolves", async () => {
  probeClaudeCliAuthStatus.mockResolvedValue({ status: "missing" });
  resolveClaudeTerminalExecutable.mockReturnValue(undefined);
  const ctx = createContext();

  await expect(runAnthropicCliMigration(ctx)).rejects.toThrow(MANUAL_LOGIN_ERROR);

  expect(ctx.prompter.confirm).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it("keeps the manual instructions without prompting when the wizard has no terminal", async () => {
  probeClaudeCliAuthStatus.mockResolvedValue({ status: "unreadable" });
  stubTty(false);
  const ctx = createContext();

  await expect(runAnthropicCliMigration(ctx)).rejects.toThrow(MANUAL_LOGIN_ERROR);

  expect(ctx.prompter.confirm).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it("keeps the manual instructions when the login exits without authenticating", async () => {
  probeClaudeCliAuthStatus.mockResolvedValue({ status: "missing" });
  spawnExitingLogin(1);

  await expect(runAnthropicCliMigration(createContext())).rejects.toThrow(MANUAL_LOGIN_ERROR);

  expect(spawn).toHaveBeenCalledTimes(1);
  expect(probeClaudeCliAuthStatus).toHaveBeenCalledTimes(2);
});

it("kills the login process when the caller aborts the wizard", async () => {
  probeClaudeCliAuthStatus.mockResolvedValue({ status: "missing" });
  const controller = new AbortController();
  const child = new FakeClaudeLogin();
  spawn.mockImplementation(() => {
    queueMicrotask(() => controller.abort());
    return child as unknown as ChildProcess;
  });

  await expect(
    runAnthropicCliMigration(createContext({ signal: controller.signal })),
  ).rejects.toThrow(MANUAL_LOGIN_ERROR);

  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});

it("never offers a terminal sign-in from the non-interactive onboarding path", async () => {
  probeClaudeCliAuthStatus.mockResolvedValue({ status: "missing" });
  const runtime = createRuntimeSpies();

  await expect(runAnthropicCliMigrationNonInteractive({ config: {}, runtime })).resolves.toBeNull();

  expect(spawn).not.toHaveBeenCalled();
  expect(runtime.exit).toHaveBeenCalledWith(1);
});
