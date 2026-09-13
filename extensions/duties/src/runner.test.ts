import { describe, expect, it } from "vitest";
import type { Duty, Target } from "./duty.js";
import { runDuty, type RunnerDeps } from "./runner.js";

function fakeDeps(over: Partial<RunnerDeps> = {}): RunnerDeps & { calls: string[] } {
  const calls: string[] = [];
  const browser: RunnerDeps["browser"] = {
    open: async (url) => {
      calls.push(`open ${url}`);
      return { targetId: `t${calls.filter((c) => c.startsWith("open ")).length}` };
    },
    navigate: async (targetId, url) => {
      calls.push(`navigate ${targetId} ${url}`);
    },
    isVisible: async () => false,
    click: async (_t, target) => {
      calls.push(`click ${JSON.stringify(target)}`);
    },
    fill: async (_t, target, value) => {
      calls.push(`fill ${target.css} ${value}`);
    },
    select: async () => {},
    press: async (_t, key) => {
      calls.push(`press ${key}`);
    },
    waitFor: async () => {},
    text: async () => "Welcome Ask !",
    url: async () => "https://x/Home/Dashboard",
    evaluate: async (_t, fn) => {
      calls.push(`evaluate ${fn}`);
      return 42;
    },
    screenshot: async () => "blob-1",
    close: async (id) => {
      calls.push(`close ${id}`);
    },
    pdf: async () => "/tmp/fake.pdf",
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
    expect(deps.calls.at(-1)).toBe("close t1");
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
    expect(deps.calls.some((c) => c.startsWith("close"))).toBe(false);
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
    expect(deps.calls).toEqual(["navigate handed-tab https://x"]);
  });
  it("resumes only the first open of a run; a later open still gets its own tab", async () => {
    const deps = fakeDeps();
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://a" } },
        {
          id: "s2",
          kind: "browser",
          label: "Open a second tab",
          params: { action: "open", url: "https://b" },
        },
      ]),
      deps,
      { inputs: {}, keepOpen: true, targetId: "handed-tab" },
    );
    expect(outcome.status).toBe("ok");
    // The handed-in tab is no longer the run's tab, so it is closed rather than leaked.
    expect(deps.calls).toEqual([
      "navigate handed-tab https://a",
      "open https://b",
      "close handed-tab",
    ]);
    expect(outcome.targetId).toBe("t1");
  });
  it("resolves placeholders in a press key and an evaluate body", async () => {
    const deps = fakeDeps();
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        {
          id: "s2",
          kind: "browser",
          label: "Press the key the owner named",
          params: { action: "press", key: "{{in:key}}" },
        },
        {
          id: "s3",
          kind: "browser.evaluate",
          label: "Count the rows",
          params: { fn: "() => document.querySelectorAll('{{in:rows}}').length" },
        },
      ]),
      deps,
      { inputs: { key: "Enter", rows: ".row" } },
    );
    expect(outcome.status).toBe("ok");
    expect(deps.calls).toContain("press Enter");
    expect(deps.calls).toContain("evaluate () => document.querySelectorAll('.row').length");
  });
  it("evaluates a url_matches condition through the browser's url read", async () => {
    const steps: Duty["steps"] = [
      { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
      {
        kind: "when",
        label: "Already on the dashboard",
        cond: { url_matches: "/Home/Dashboard" },
        then: [{ kind: "stop", label: "Nothing to do", reason: "already there" }],
        else: [
          {
            id: "s2",
            kind: "browser",
            label: "Sign in",
            params: { action: "click" },
            target: { css: "#signin" },
          },
        ],
      },
    ];

    const onDashboard = fakeDeps();
    const matched = await runDuty(duty(steps), onDashboard, { inputs: {} });
    expect(matched.report).toBe("already there");
    expect(onDashboard.calls.some((c) => c.startsWith("click"))).toBe(false);

    const onLogin = fakeDeps({ browser: { url: async () => "https://x/Account/Login" } as never });
    const missed = await runDuty(duty(steps), onLogin, { inputs: {} });
    expect(missed.report).toBeUndefined();
    expect(onLogin.calls.some((c) => c.startsWith("click"))).toBe(true);
  });
  it("records an evidence row naming the gate when a when-probe fails", async () => {
    const deps = fakeDeps({
      browser: {
        isVisible: async () => {
          throw new Error("cdp gone");
        },
      } as never,
    });
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        {
          kind: "when",
          label: "Check if already signed in",
          cond: { visible: { text: "My Account" } },
          then: [],
        },
      ]),
      deps,
      { inputs: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failedStep).toBe("when:Check if already signed in");
    expect(outcome.steps.at(-1)).toMatchObject({
      kind: "when",
      status: "failed",
      label: "Check if already signed in",
      summary: "cdp gone",
    });
  });
  it("records a blocked ask as blocked evidence, not as a failure", async () => {
    const outcome = await runDuty(
      duty([{ id: "s1", kind: "ask", label: "OTP?", params: { question: "Code?" } }]),
      fakeDeps({ ask: { ask: async () => ({ status: "timeout" }) } }),
      { inputs: {} },
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.steps[0]!.status).toBe("blocked");
  });
  it("throws for a step kind it cannot run instead of recording a silent ok", async () => {
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "template", label: "Render the quote", params: {} },
      ] as unknown as Duty["steps"]),
      fakeDeps(),
      { inputs: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.report).toContain("template");
    expect(outcome.steps[0]!.status).toBe("failed");
  });
  it("stops before the next browser call once the run is cancelled", async () => {
    const deps = fakeDeps();
    let cancelled = false;
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        {
          id: "s2",
          kind: "browser",
          label: "Click after cancel",
          params: { action: "click" },
          target: { css: "#late" },
        },
      ]),
      {
        ...deps,
        isCancelled: () => cancelled,
        onStep: () => {
          cancelled = true;
        },
      },
      { inputs: {} },
    );
    expect(outcome.status).toBe("cancelled");
    expect(deps.calls.some((c) => c.startsWith("click"))).toBe(false);
    expect(outcome.steps.map((s) => s.stepId)).toEqual(["s1"]);
  });
  it("notes a transport retry the adapter reports in the step's summary", async () => {
    const deps = fakeDeps();
    let drained = false;
    const outcome = await runDuty(
      duty([
        {
          id: "s1",
          kind: "browser",
          label: "Open",
          params: { action: "open", url: "https://x" },
        },
        {
          id: "s2",
          kind: "browser",
          label: "Read the page",
          params: { action: "read" },
        },
      ]),
      {
        ...deps,
        browser: {
          ...deps.browser,
          drainRetryNotes: () => {
            if (drained) return [];
            drained = true;
            return ["retried snapshot once"];
          },
        },
      },
      { inputs: {} },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.steps.map((s) => s.summary).join(" | ")).toContain("retried snapshot once");
  });
  it("parks and unparks around an ask through onWaiting", async () => {
    const seen: Array<{ questionId: string; stepId: string } | undefined> = [];
    const outcome = await runDuty(
      duty([{ id: "s1", kind: "ask", label: "Which?", params: { question: "Which?" } }]),
      {
        ...fakeDeps(),
        ask: {
          ask: async ({ onAsked }) => {
            onAsked?.("q-1");
            return { status: "answered", answer: "a" };
          },
        },
        onWaiting: (waitingOn) => seen.push(waitingOn),
      },
      { inputs: {} },
    );
    expect(outcome.status).toBe("ok");
    expect(seen).toEqual([{ questionId: "q-1", stepId: "s1" }, undefined]);
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

  it("masks a credential a later step echoes back, once a fill has resolved it", async () => {
    const secret = "cred(amigos.token)";
    const deps = fakeDeps({
      ask: { ask: async () => ({ status: "answered", answer: `saw ${secret}` }) },
    });
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        {
          id: "s2",
          kind: "browser",
          label: "Fill the token",
          params: { action: "fill", value: "{{cred:amigos.token}}" },
          target: { css: "#token" },
        },
        { id: "s3", kind: "ask", label: "Confirm", params: { question: "All good?" } },
      ]),
      deps,
      { inputs: {} },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.steps[2]!.summary).toContain(MASK);
    expect(outcome.steps[2]!.summary).not.toContain(secret);
  });
});

describe("runDuty credential confinement", () => {
  const credFor = (calls: string[]) => async (key: string) => {
    calls.push(key);
    return `cred(${key})`;
  };

  it("fails an ai step whose instruction carries a credential placeholder", async () => {
    const credCalls: string[] = [];
    const deps = fakeDeps({ cred: credFor(credCalls) });
    const outcome = await runDuty(
      duty([
        {
          id: "s1",
          kind: "ai",
          label: "Read the mail",
          params: { instruction: "sign in with {{cred:amigos.password}}", input: "x" },
        },
      ]),
      deps,
      { inputs: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failedStep).toBe("s1");
    expect(outcome.report).toContain("no credential stored for amigos.password");
    expect(credCalls).toEqual([]);
  });

  it("fails a navigate, press, evaluate and ask step that reference a credential", async () => {
    const cases: Array<{ what: string; step: Duty["steps"][number] }> = [
      {
        what: "navigate",
        step: {
          id: "s2",
          kind: "browser",
          label: "Open the reset link",
          params: { action: "navigate", url: "https://x/?t={{cred:amigos.token}}" },
        },
      },
      {
        what: "press",
        step: {
          id: "s2",
          kind: "browser",
          label: "Press the key",
          params: { action: "press", key: "{{cred:amigos.token}}" },
        },
      },
      {
        what: "evaluate",
        step: {
          id: "s2",
          kind: "browser.evaluate",
          label: "Read the token",
          params: { fn: "() => '{{cred:amigos.token}}'" },
        },
      },
      {
        what: "ask",
        step: {
          id: "s2",
          kind: "ask",
          label: "Confirm",
          params: { question: "Use {{cred:amigos.token}}?" },
        },
      },
    ];
    for (const { what, step } of cases) {
      const credCalls: string[] = [];
      const deps = fakeDeps({ cred: credFor(credCalls) });
      const outcome = await runDuty(
        duty([
          {
            id: "s1",
            kind: "browser",
            label: "Open",
            params: { action: "open", url: "https://x" },
          },
          step,
        ]),
        deps,
        { inputs: {} },
      );
      expect(outcome.status, what).toBe("failed");
      expect(outcome.report, what).toContain("no credential stored for amigos.token");
      expect(credCalls, what).toEqual([]);
    }
  });
});
