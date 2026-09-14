import { describe, expect, it, vi } from "vitest";
import { createAiAdapter } from "./ai.js";
import { createAskAdapter } from "./ask.js";
import { asRequest } from "./test-helpers.js";

describe("ai adapter", () => {
  it("invokes llm-task and returns its JSON object", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      toolName: "llm-task",
      output: { content: [{ type: "text", text: JSON.stringify({ origin: "IXU" }) }] },
    }));
    const ai = createAiAdapter({ request: asRequest(request), sessionKey: "main" });
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

  it("prefers output.details.json over content text", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      toolName: "llm-task",
      output: {
        content: [{ type: "text", text: "ignored" }],
        details: { json: { origin: "IXU" } },
      },
    }));
    const ai = createAiAdapter({ request: asRequest(request), sessionKey: "main" });
    await expect(
      ai.extract({ instruction: "x", input: "mail", schema: { type: "object" } }),
    ).resolves.toEqual({ origin: "IXU" });
  });

  it("keeps an extracted object that carries its own json field instead of unwrapping it again", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      toolName: "llm-task",
      output: { details: { json: { json: "the raw mail text", origin: "IXU" } } },
    }));
    const ai = createAiAdapter({ request: asRequest(request), sessionKey: "main" });
    await expect(
      ai.extract({ instruction: "x", input: "mail", schema: { type: "object" } }),
    ).resolves.toEqual({ json: "the raw mail text", origin: "IXU" });
  });

  it("rejects with the tool's error message when tools.invoke fails", async () => {
    const request = vi.fn(async () => ({
      ok: false,
      toolName: "llm-task",
      error: { type: "not_found", message: "tool llm-task not found" },
    }));
    const ai = createAiAdapter({ request: asRequest(request), sessionKey: "main" });
    await expect(
      ai.extract({ instruction: "x", input: "mail", schema: { type: "object" } }),
    ).rejects.toThrow("tool llm-task not found");
  });

  it("rejects with an approval-specific message when the call requires approval", async () => {
    const request = vi.fn(async () => ({
      ok: false,
      toolName: "llm-task",
      requiresApproval: true,
      error: { code: "requires_approval", message: "confirmation required" },
    }));
    const ai = createAiAdapter({ request: asRequest(request), sessionKey: "main" });
    await expect(
      ai.extract({ instruction: "x", input: "mail", schema: { type: "object" } }),
    ).rejects.toThrow(/approval/);
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
    const ask = createAskAdapter({ request: asRequest(request), sessionKey: "main", pollMs: 1 });
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

  // Regression: the step id was sent straight through as the question id. Duty step ids are
  // slugs (`^[a-z0-9][a-z0-9_-]{0,63}$` — hyphens and a leading digit allowed) but
  // `question.request` requires `^[a-z][a-z0-9_]*$`, so every ask step with a hyphen in its id —
  // which is how they are naturally named, `ask-hold` — failed with a raw schema error instead of
  // ever reaching the owner.
  it("sends a question id the Gateway accepts, and still reads back that answer", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) =>
      method === "question.request"
        ? { id: "q1", expiresAtMs: 1 }
        : { status: "answered", answers: { answers: { ask_hold: ["Approve"] } } },
    );
    const ask = createAskAdapter({ request: asRequest(request), sessionKey: "main", pollMs: 1 });

    await expect(
      ask.ask({ stepId: "ask-hold", question: "Hold?", header: "Hold?", options: ["Approve"] }),
    ).resolves.toEqual({
      status: "answered",
      answer: "Approve",
      // One option cannot carry a tap, so this ask went out as prose — recorded rather than
      // degraded silently.
      note: "sent without buttons: an ask needs 2–4 distinct options",
    });

    const sent = request.mock.calls.find((c) => c[0] === "question.request")?.[1];
    if (!sent) throw new Error("Expected question.request call");
    expect((sent as { questions: [{ questionId: string }] }).questions[0].questionId).toMatch(
      /^[a-z][a-z0-9_]*$/u,
    );
    expect((sent as { questions: [{ questionId: string }] }).questions[0].questionId).toBe(
      "ask_hold",
    );
  });

  it("keeps a leading digit out of the question id", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) =>
      method === "question.request"
        ? { id: "q1", expiresAtMs: 1 }
        : { status: "answered", answers: { answers: { q_2nd_leg: ["Yes"] } } },
    );
    const ask = createAskAdapter({ request: asRequest(request), sessionKey: "main", pollMs: 1 });
    await expect(
      ask.ask({ stepId: "2nd-leg", question: "Second leg?", header: "Leg", options: ["Yes"] }),
    ).resolves.toEqual({
      status: "answered",
      answer: "Yes",
      note: "sent without buttons: an ask needs 2–4 distinct options",
    });
    const sent = request.mock.calls.find((c) => c[0] === "question.request")?.[1];
    if (!sent) throw new Error("Expected question.request call");
    expect((sent as { questions: [{ questionId: string }] }).questions[0].questionId).toMatch(
      /^[a-z][a-z0-9_]*$/u,
    );
  });

  // Regression: the ask was announced as a paragraph of text, so the owner's tap had nowhere to
  // land and their reply went to the agent as ordinary chat instead of answering the question.
  // The channel can only build tappable choices from a record id of its own shape, so the adapter
  // has to mint one and hand it, with the options, to the announcement.
  it("asks under a record id the channel can build buttons from, and announces it as a card", async () => {
    const announced: Array<{
      text: string;
      question?: { id: string; options: readonly string[] };
    }> = [];
    // The Gateway echoes the id the caller supplied (question.ts), so the mock does too — and the
    // card is built from the id the Gateway actually recorded, never from the one we hoped for.
    const request = vi.fn(async (method: string, p: Record<string, unknown>) =>
      method === "question.request"
        ? { id: p.id, expiresAtMs: 1 }
        : { status: "answered", answers: { answers: { ask_hold: ["Approve"] } } },
    );
    const ask = createAskAdapter({
      request: asRequest(request),
      sessionKey: "main",
      pollMs: 1,
      announce: async (text, question) => {
        announced.push({ text, ...(question ? { question } : {}) });
      },
    });

    await expect(
      ask.ask({
        stepId: "ask-hold",
        question: "Hold this booking?",
        header: "Hold?",
        options: ["Approve", "Decline"],
      }),
    ).resolves.toEqual({ status: "answered", answer: "Approve" });

    const sent = request.mock.calls.find((c) => c[0] === "question.request")?.[1] as {
      id?: string;
    };
    // The record id must match the channel's callback pattern or no button can be built.
    expect(sent.id).toMatch(/^ask_[a-f0-9]{32}$/u);
    expect(announced).toHaveLength(1);
    expect(announced[0]?.text).toContain("Hold this booking?");
    expect(announced[0]?.question).toEqual({
      id: sent.id,
      options: ["Approve", "Decline"],
    });
  });

  it("reports the created question id so the run can park on it", async () => {
    const request = vi.fn(async (method: string) =>
      method === "question.request"
        ? { id: "q-42", expiresAtMs: 1 }
        : { status: "answered", answers: { answers: { otp: ["1234"] } } },
    );
    const ask = createAskAdapter({ request: asRequest(request), sessionKey: "main", pollMs: 1 });
    const asked: string[] = [];
    await ask.ask({
      stepId: "otp",
      question: "Code?",
      header: "OTP",
      options: [],
      onAsked: (questionId) => asked.push(questionId),
    });
    expect(asked).toEqual(["q-42"]);
  });

  // Regression: the ask session was resolved while building EVERY run's deps, so a fresh install
  // with no owner target failed every Duty — including ones with no `ask` — before step 1.
  it("resolves its session only when a question is actually raised", async () => {
    const resolved: string[] = [];
    const request = vi.fn(async (method: string, params: Record<string, unknown>) =>
      method === "question.request"
        ? { id: "q1", expiresAtMs: 1 }
        : { status: "answered", answers: { answers: { hold: ["Approve"] } } },
    );
    const ask = createAskAdapter({
      request: asRequest(request),
      sessionKey: async () => {
        resolved.push("resolved");
        return "agent:krishna:main";
      },
      pollMs: 1,
    });
    expect(resolved).toEqual([]);

    await ask.ask({
      stepId: "hold",
      question: "Hold?",
      header: "Hold?",
      options: ["Approve", "Decline"],
    });

    expect(resolved).toEqual(["resolved"]);
    const sent = request.mock.calls.find((c) => c[0] === "question.request")?.[1];
    if (!sent) throw new Error("Expected question.request call");
    expect((sent as { sessionKey?: string }).sessionKey).toBe("agent:krishna:main");
  });

  it("adds no note when the options do make a tappable card", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) =>
      method === "question.request"
        ? { id: "q1", expiresAtMs: 1 }
        : { status: "answered", answers: { answers: { hold: ["Approve"] } } },
    );
    const ask = createAskAdapter({ request: asRequest(request), sessionKey: "main", pollMs: 1 });
    await expect(
      ask.ask({
        stepId: "hold",
        question: "Hold?",
        header: "Hold?",
        options: ["Approve", "Decline"],
      }),
    ).resolves.toEqual({ status: "answered", answer: "Approve" });
  });

  it("returns timeout when the question expires", async () => {
    const request = vi.fn(async (method: string) =>
      method === "question.request" ? { id: "q1", expiresAtMs: 1 } : { status: "expired" },
    );
    const ask = createAskAdapter({ request: asRequest(request), sessionKey: "main", pollMs: 1 });
    await expect(
      ask.ask({ stepId: "otp", question: "Code?", header: "OTP", options: [] }),
    ).resolves.toEqual({ status: "timeout" });
  });
});
