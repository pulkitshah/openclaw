import { describe, expect, it, vi } from "vitest";
import { createAiAdapter } from "./ai.js";
import { asRequest } from "./test-helpers.js";

const okResult = {
  ok: true,
  toolName: "llm-task",
  output: { details: { json: { origin: "IXU" } } },
};

describe("ai adapter attribution", () => {
  it("sends the run's attribution on tools.invoke when given", async () => {
    const request = vi.fn(async () => okResult);
    const attribution = { kind: "duty", ref: "run-1", label: "Book by mail — Re: invoice" };
    const ai = createAiAdapter({ request: asRequest(request), sessionKey: "main", attribution });
    await ai.extract({ instruction: "x", input: "mail", schema: { type: "object" } });
    expect(request).toHaveBeenCalledWith(
      "tools.invoke",
      expect.objectContaining({ name: "llm-task", sessionKey: "main", attribution }),
    );
  });

  it("resolves a lazy session key per call and omits it when none resolves", async () => {
    const request = vi.fn(async () => okResult);
    const ai = createAiAdapter({
      request: asRequest(request),
      sessionKey: async () => "agent:main:direct:owner",
    });
    await ai.extract({ instruction: "x", input: "mail", schema: { type: "object" } });
    expect(request).toHaveBeenCalledWith(
      "tools.invoke",
      expect.objectContaining({ name: "llm-task", sessionKey: "agent:main:direct:owner" }),
    );

    const unowned = vi.fn(async () => okResult);
    const noSession = createAiAdapter({ request: asRequest(unowned), sessionKey: undefined });
    await noSession.extract({ instruction: "x", input: "mail", schema: { type: "object" } });
    const params = (unowned.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(params).not.toHaveProperty("sessionKey");
  });

  it("omits the attribution key when none is given", async () => {
    const request = vi.fn(async () => okResult);
    const ai = createAiAdapter({ request: asRequest(request), sessionKey: "main" });
    await ai.extract({ instruction: "x", input: "mail", schema: { type: "object" } });
    const params = (request.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(params).not.toHaveProperty("attribution");
  });
});
