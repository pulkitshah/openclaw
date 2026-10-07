// Plugin-runtime completions must surface to llm_output hooks so metering plugins see them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "../hook-runner-global.js";
import { createMockPluginRegistry } from "../hooks.test-fixtures.js";
import { resetPluginRuntimeStateForTest } from "../runtime.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";

const hoisted = vi.hoisted(() => ({
  acquireSimpleCompletionModelForAgent: vi.fn(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: hoisted.acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel: hoisted.completeWithPreparedSimpleCompletionModel,
  resolveSimpleCompletionSelectionForAgent: hoisted.resolveSimpleCompletionSelectionForAgent,
}));

const cfg = { agents: { defaults: { model: "openai/gpt-5.5" } } } satisfies OpenClawConfig;

function primeDirectCompletion(usage: Record<string, number>) {
  hoisted.acquireSimpleCompletionModelForAgent.mockResolvedValue({
    async [Symbol.asyncDispose]() {},
    selection: { provider: "openai", modelId: "gpt-5.5", agentDir: "/tmp/openclaw-agent" },
    model: {
      provider: "openai",
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai",
      baseUrl: "https://fixture.invalid/v1",
      input: ["text"],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 4096,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    },
    auth: { apiKey: "test-api-key", source: "test", mode: "api-key" },
  });
  hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
    (params: { agentId: string }) => ({
      provider: "openai",
      modelId: "gpt-5.5",
      agentDir: `/tmp/${params.agentId}`,
    }),
  );
  hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
    usage,
  });
}

function registerLlmOutputHook() {
  const handler = vi.fn();
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "llm_output", pluginId: "meter", handler }]),
  );
  return handler;
}

describe("runtime.llm.complete llm_output hook", () => {
  beforeEach(() => {
    hoisted.acquireSimpleCompletionModelForAgent.mockReset();
    hoisted.completeWithPreparedSimpleCompletionModel.mockReset();
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReset();
  });

  afterEach(() => {
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
  });

  it("emits usage with the caller's session, agent, and attribution", async () => {
    primeDirectCompletion({ input: 10, output: 5 });
    const handler = registerLlmOutputHook();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: { agentId: "main" },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await llm.complete({
      messages: [{ role: "user", content: "hi" }],
      sessionKey: "agent:main:direct:asha",
      attribution: { kind: "duty", ref: "run-1", label: "x" },
      purpose: "llm-task",
    });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const [event, ctx] = handler.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      resolvedRef: "openai/gpt-5.5",
      assistantTexts: ["done"],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    });
    expect(ctx).toMatchObject({
      sessionKey: "agent:main:direct:asha",
      agentId: "main",
      trigger: "tool",
      attribution: { kind: "duty", ref: "run-1", label: "x" },
    });
  });

  it("emits nothing when the completion reports no usage", async () => {
    primeDirectCompletion({});
    const handler = registerLlmOutputHook();
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: { agentId: "main" },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await llm.complete({ messages: [{ role: "user", content: "hi" }] });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(handler).not.toHaveBeenCalled();
  });
});
