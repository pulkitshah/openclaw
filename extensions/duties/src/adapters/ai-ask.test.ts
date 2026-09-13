import { describe, expect, it, vi } from "vitest";
import { createAiAdapter } from "./ai.js";
import { createAskAdapter } from "./ask.js";

describe("ai adapter", () => {
  it("invokes llm-task and returns its JSON object", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      toolName: "llm-task",
      output: { content: [{ type: "text", text: JSON.stringify({ origin: "IXU" }) }] },
    }));
    const ai = createAiAdapter({ request, sessionKey: "main" });
    await expect(
      ai.extract({ instruction: "x", input: "mail", schema: { type: "object" } }),
    ).resolves.toEqual({ origin: "IXU" });
    expect(request).toHaveBeenCalledWith(
      "tools.invoke",
      expect.objectContaining({
        name: "llm-task",
        sessionKey: "main",
        args: expect.objectContaining({ prompt: "x", input: "mail" }),
      }),
    );
  });
});

describe("ask adapter", () => {
  it("requests a question and returns the first answer", async () => {
    let polls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "question.request") return { id: "q1", expiresAtMs: 1 };
      polls += 1;
      return polls < 2
        ? { status: "pending" }
        : { status: "answered", answers: { answers: { account: ["LIC Nagpur"] } } };
    });
    const ask = createAskAdapter({ request, sessionKey: "main", pollMs: 1 });
    await expect(
      ask.ask({
        stepId: "account",
        question: "Which?",
        header: "Account",
        options: ["LIC Nagpur", "LIC Aurangabad"],
      }),
    ).resolves.toEqual({ status: "answered", answer: "LIC Nagpur" });
    expect(request).toHaveBeenCalledWith(
      "question.request",
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            questionId: "account",
            options: [{ label: "LIC Nagpur" }, { label: "LIC Aurangabad" }],
          }),
        ],
      }),
    );
  });

  it("returns timeout when the question expires", async () => {
    const request = vi.fn(async (method: string) =>
      method === "question.request" ? { id: "q1", expiresAtMs: 1 } : { status: "expired" },
    );
    const ask = createAskAdapter({ request, sessionKey: "main", pollMs: 1 });
    await expect(
      ask.ask({ stepId: "otp", question: "Code?", header: "OTP", options: [] }),
    ).resolves.toEqual({ status: "timeout" });
  });
});
