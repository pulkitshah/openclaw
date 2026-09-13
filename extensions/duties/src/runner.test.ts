import { describe, expect, it, vi } from "vitest";
import type { Duty, Target } from "./duty.js";
import { runDuty, type RunnerDeps } from "./runner.js";

function fakeDeps(over: Partial<RunnerDeps> = {}): RunnerDeps & { calls: string[] } {
  const calls: string[] = [];
  const browser: RunnerDeps["browser"] = {
    open: async (url) => {
      calls.push(`open ${url}`);
      return { targetId: "t1" };
    },
    navigate: async (_t, url) => {
      calls.push(`navigate ${url}`);
    },
    isVisible: async () => false,
    click: async (_t, target) => {
      calls.push(`click ${JSON.stringify(target)}`);
    },
    fill: async (_t, target, value) => {
      calls.push(`fill ${target.css} ${value}`);
    },
    select: async () => {},
    press: async () => {},
    waitFor: async () => {},
    text: async () => "Welcome Ask !",
    url: async () => "https://x/Home/Dashboard",
    evaluate: async () => 42,
    screenshot: async () => "blob-1",
    close: async () => {
      calls.push("close");
    },
  };
  return {
    calls,
    browser: { ...browser, ...over.browser },
    ai: over.ai ?? { extract: async () => ({ origin: "IXU", destination: "COK" }) },
    ask: over.ask ?? { ask: async () => ({ status: "answered", answer: "LIC Nagpur" }) },
    cred: over.cred ?? (async (key) => `cred(${key})`),
    now: (() => {
      let t = 0;
      return () => (t += 10);
    })(),
  };
}

const duty = (steps: Duty["steps"]): Duty => ({
  id: "d",
  name: "D",
  summary: "",
  status: "active",
  machine: "gateway",
  reportsTo: "owner",
  inputs: [{ name: "mail", source: "trigger" }],
  triggers: [{ kind: "manual" }],
  updatedAt: 1,
  steps,
});

describe("runDuty", () => {
  it("runs browser, ai and ask steps, resolves placeholders and records evidence", async () => {
    const deps = fakeDeps();
    const outcome = await runDuty(
      duty([
        {
          id: "s1",
          kind: "browser",
          label: "Open Amigos",
          params: { action: "open", url: "https://amigosalliance.co.in" },
        },
        {
          id: "s2",
          kind: "ai",
          label: "Read the mail",
          params: { instruction: "extract", input: "{{in:mail}}", schema: { type: "object" } },
          saveAs: ["origin", "destination"],
        },
        {
          id: "s3",
          kind: "ask",
          label: "Which account?",
          params: {
            question: "Which corporate account for {{out:origin}}?",
            options: ["LIC Nagpur", "LIC Aurangabad"],
          },
          saveAs: "account",
        },
        {
          id: "s4",
          kind: "browser",
          label: "Fill username",
          params: { action: "fill", value: "{{cred:amigos.username}}" },
          target: { css: "#UserId" },
        },
        {
          id: "s5",
          kind: "browser",
          label: "Check dashboard",
          params: { action: "wait" },
          check: { url_matches: "/Home/Dashboard" },
        },
      ]),
      deps,
      { inputs: { mail: "hello" } },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.outputs).toEqual({ origin: "IXU", destination: "COK", account: "LIC Nagpur" });
    expect(deps.calls).toContain("fill #UserId cred(amigos.username)");
    expect(outcome.steps.map((s) => s.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(outcome.steps[3]!.summary).not.toContain("cred(");
    expect(deps.calls.at(-1)).toBe("close");
  });
  it("skips a when-group whose probe is visible and stops with the resolved reason", async () => {
    const deps = fakeDeps({ browser: { isVisible: async () => true } as never });
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        {
          kind: "when",
          label: "If signed out, sign in",
          cond: { visible: { text: "Welcome" } },
          then: [],
          else: [
            {
              id: "s2",
              kind: "browser",
              label: "Click login",
              params: { action: "click" },
              target: { role: "button", name: "Login" },
            },
          ],
        },
        { kind: "stop", label: "Nothing to book", reason: "No booking in {{in:mail}}" },
        {
          id: "s9",
          kind: "browser",
          label: "Never runs",
          params: { action: "click" },
          target: { css: "#x" },
        },
      ]),
      deps,
      { inputs: { mail: "mail-1" } },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.report).toBe("No booking in mail-1");
    expect(deps.calls.some((c) => c.startsWith("click"))).toBe(false);
    expect(outcome.steps.map((s) => s.stepId)).not.toContain("s9");
  });
  it("fails loudly on a failed check and names the step", async () => {
    const deps = fakeDeps({ browser: { url: async () => "https://x/login" } as never });
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        {
          id: "s2",
          kind: "browser",
          label: "Sign in landed",
          params: { action: "wait" },
          check: { url_matches: "/Home/Dashboard" },
        },
      ]),
      deps,
      { inputs: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failedStep).toBe("s2");
    expect(outcome.steps[1]!.status).toBe("failed");
  });
  it("blocks when an ask times out and stops early at toStepId keeping the tab", async () => {
    const blocked = await runDuty(
      duty([
        { id: "s1", kind: "ask", label: "OTP?", params: { question: "Code?" }, saveAs: "otp" },
      ]),
      fakeDeps({ ask: { ask: async () => ({ status: "timeout" }) } }),
      { inputs: {} },
    );
    expect(blocked.status).toBe("blocked");
    const deps = fakeDeps();
    const partial = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        {
          id: "s2",
          kind: "browser",
          label: "Later",
          params: { action: "click" },
          target: { css: "#y" },
        },
      ]),
      deps,
      { inputs: {}, toStepId: "s1", keepOpen: true },
    );
    expect(partial.status).toBe("ok");
    expect(partial.targetId).toBe("t1");
    expect(deps.calls).not.toContain("close");
  });
  it("resumes an open step in the tab it was handed instead of opening a new one", async () => {
    const deps = fakeDeps();
    const resumed = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
      ]),
      deps,
      { inputs: {}, keepOpen: true, targetId: "handed-tab" },
    );
    expect(resumed.status).toBe("ok");
    expect(resumed.targetId).toBe("handed-tab");
    expect(deps.calls).toEqual(["navigate https://x"]);
  });
});

// Matches runner.ts's private MASK constant; kept local since the runner does not
// (and should not) export it as part of its public surface.
const MASK = "••••••";

describe("runDuty credential redaction", () => {
  it("masks a resolved credential that leaks into a failed step's summary and the outer report", async () => {
    const secret = "cred(amigos.username)";
    const deps = fakeDeps({
      browser: {
        fill: async (_t: string, target: Target, value: string) => {
          throw new Error(`could not locate ${target.css}: got value "${value}"`);
        },
      } as never,
    });
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        {
          id: "s2",
          kind: "browser",
          label: "Fill username",
          params: { action: "fill", value: "{{cred:amigos.username}}" },
          target: { css: "#UserId" },
        },
      ]),
      deps,
      { inputs: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.steps[1]!.summary).toContain(MASK);
    expect(outcome.steps[1]!.summary).not.toContain(secret);
    expect(outcome.report).toContain(MASK);
    expect(outcome.report).not.toContain(secret);
  });

  it("masks a resolved credential inside a navigate step's url summary", async () => {
    const secret = "cred(amigos.token)";
    const deps = fakeDeps();
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        {
          id: "s2",
          kind: "browser",
          label: "Navigate with token",
          params: { action: "navigate", url: "https://x/reset?token={{cred:amigos.token}}" },
        },
      ]),
      deps,
      { inputs: {} },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.steps[1]!.summary).toContain(MASK);
    expect(outcome.steps[1]!.summary).not.toContain(secret);
  });

  it("masks a resolved credential that echoes back through an ask answer", async () => {
    const secret = "cred(amigos.token)";
    const deps = fakeDeps({
      ask: { ask: async (params) => ({ status: "answered", answer: params.question }) },
    });
    const outcome = await runDuty(
      duty([
        {
          id: "s1",
          kind: "ask",
          label: "Confirm",
          params: { question: "Use {{cred:amigos.token}} to confirm?" },
          saveAs: "confirmed",
        },
      ]),
      deps,
      { inputs: {} },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.steps[0]!.summary).toContain(MASK);
    expect(outcome.steps[0]!.summary).not.toContain(secret);
  });
});
