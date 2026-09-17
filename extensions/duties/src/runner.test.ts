import { describe, expect, it } from "vitest";
import type { Duty, Target } from "./duty.js";
import { runDuty } from "./runner.js";
import { duty, fakeDeps } from "./runner.test-helpers.js";

describe("runDuty", () => {
  // Regression: placeholders were resolved only when a param was a string at the top level, so an
  // `ai` step whose `params.input` is an object or array — the normal way to hand a model a
  // named payload — reached the model with the literal text "{{out:key}}". No error, no failed
  // step: the model just answered about the placeholder instead of the value.
  it("resolves placeholders inside object and array params, not only top-level strings", async () => {
    const seen: unknown[] = [];
    const deps = fakeDeps({
      ai: {
        extract: async ({ input }) => {
          seen.push(input);
          return { requester: "os.nagpur@licindia.com", matched: "true" };
        },
      },
    });

    const outcome = await runDuty(
      duty([
        {
          id: "s1",
          kind: "ai",
          label: "Read the requester",
          params: { instruction: "extract", input: "{{in:mail}}", schema: { type: "object" } },
          saveAs: ["requester"],
        },
        {
          id: "s2",
          kind: "ai",
          label: "Match the requester to a client",
          params: {
            instruction: "match {{out:requester}} against the register",
            input: {
              requester: "{{out:requester}}",
              register: [{ email: "os.nagpur@licindia.com", clientId: "91925" }],
              note: ["asked by {{out:requester}}", 7, null],
            },
            schema: { type: "object" },
          },
          saveAs: ["matched"],
        },
      ]),
      deps,
      { inputs: { mail: "From: os.nagpur@licindia.com" } },
    );

    expect(outcome.status).toBe("ok");
    expect(seen[1]).toEqual({
      requester: "os.nagpur@licindia.com",
      register: [{ email: "os.nagpur@licindia.com", clientId: "91925" }],
      note: ["asked by os.nagpur@licindia.com", 7, null],
    });
  });

  // Regression: a `saveAs` key the step's result did not carry was written as an explicit
  // `undefined`. The host's plugin state store rejects those (`isPluginJsonValue`), so persisting
  // the run failed — killing a 59-step live booking run at the very end with
  // "plugin state value at value.outputs.holdSummary must be JSON-serializable", a message that
  // names neither the step that produced it nor the key.
  it("omits a saveAs key the step did not return instead of storing an explicit undefined", async () => {
    const deps = fakeDeps({
      ai: { extract: async () => ({ present: "yes" }) },
    });

    const outcome = await runDuty(
      duty([
        {
          id: "s1",
          kind: "ai",
          label: "Read the hold summary",
          params: { instruction: "extract", input: "x", schema: { type: "object" } },
          saveAs: ["present", "holdSummary"],
        },
      ]),
      deps,
      { inputs: {} },
    );

    expect(outcome.status).toBe("ok");
    expect(outcome.outputs).toEqual({ present: "yes" });
    expect(Object.hasOwn(outcome.outputs, "holdSummary")).toBe(false);
    // The whole outputs object has to survive a JSON round-trip, which is what the store requires.
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- exercises the JSON round-trip the store performs, not an in-memory clone.
    expect(JSON.parse(JSON.stringify(outcome.outputs))).toEqual(outcome.outputs);
  });

  // Regression: `toStepId` was only checked after a regular step, so naming a `when` gate ran the
  // whole Duty instead of stopping at it. Authoring stages a flow by running up to a point and
  // inspecting the page; a stage that silently runs on reaches steps the author has not reviewed,
  // which on a booking flow means clicking past the point of no return.
  it("stops at toStepId when it names a when gate, not only a regular step", async () => {
    const deps = fakeDeps();
    const outcome = await runDuty(
      duty([
        {
          id: "s0",
          kind: "browser",
          label: "Open the search page",
          params: { action: "open", url: "https://portal.example.com" },
        },
        {
          id: "gate",
          kind: "when",
          label: "Untick the box if it is ticked",
          cond: { equals: ["a", "a"] },
          // oxlint-disable-next-line unicorn/no-thenable -- the Duty when/then/else branch, not a Promise thenable.
          then: [
            {
              id: "inside",
              kind: "browser",
              label: "Untick it",
              params: { action: "press", key: "Space" },
            },
          ],
        },
        {
          id: "after",
          kind: "browser",
          label: "Search",
          params: { action: "press", key: "Enter" },
        },
      ]),
      deps,
      { inputs: {}, toStepId: "gate" },
    );

    expect(outcome.status).toBe("ok");
    // The gate's own branch runs; the step after it does not.
    expect(deps.calls).toContain("press Space");
    expect(deps.calls).not.toContain("press Enter");
    expect(outcome.steps.map((s) => s.stepId)).not.toContain("after");
  });

  it("runs browser, ai and ask steps, resolves placeholders and records evidence", async () => {
    const deps = fakeDeps();
    const outcome = await runDuty(
      duty([
        {
          id: "s1",
          kind: "browser",
          label: "Open Amigos",
          params: { action: "open", url: "https://portal.example.com" },
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
          params: { action: "fill", value: "{{cred:acme-demo.username}}" },
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
    expect(deps.calls).toContain("fill #UserId cred(acme-demo.username)");
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
          // oxlint-disable-next-line unicorn/no-thenable -- the Duty when/then/else branch, not a Promise thenable.
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
        // oxlint-disable-next-line unicorn/no-thenable -- the Duty when/then/else branch, not a Promise thenable.
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
          // oxlint-disable-next-line unicorn/no-thenable -- the Duty when/then/else branch, not a Promise thenable.
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
  it("keeps the failure screenshot for an ask step, whose page state is the evidence", async () => {
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        { id: "s2", kind: "ask", label: "OTP?", params: { question: "Code?" } },
      ]),
      fakeDeps({
        ask: {
          ask: async () => {
            throw new Error("ask transport gone");
          },
        },
      }),
      { inputs: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.steps[1]).toMatchObject({ status: "failed", screenshotBlobId: "blob-1" });
  });
  // Team v2 Task 6: an `ask` step's `params.target` (parsed off "team:<id>") reaches the ask
  // adapter as `target`, so it can raise the question in that member's session instead of the
  // owner's; an ask with no target (or "owner") still passes none, unchanged.
  it('passes ask.target through to the ask adapter, parsed off "team:<id>"', async () => {
    const seen: Array<string | undefined> = [];
    const outcome = await runDuty(
      duty([
        {
          id: "s1",
          kind: "ask",
          label: "Confirm?",
          params: { question: "Ready?", options: ["Yes", "No"], target: "team:ramesh" },
        },
        {
          id: "s2",
          kind: "ask",
          label: "Confirm again?",
          params: { question: "Sure?", options: ["Yes", "No"], target: "owner" },
        },
      ]),
      fakeDeps({
        ask: {
          ask: async ({ target }) => {
            seen.push(target);
            return { status: "answered", answer: "Yes" };
          },
        },
      }),
      { inputs: {} },
    );
    expect(outcome.status).toBe("ok");
    expect(seen).toEqual(["ramesh", undefined]);
  });
  it("throws for a step kind it cannot run instead of recording a silent ok", async () => {
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "sms", label: "Text the client", params: {} },
      ] as unknown as Duty["steps"]),
      fakeDeps(),
      { inputs: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.report).toContain("sms");
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
            if (drained) {
              return [];
            }
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
    const secret = "cred(acme-demo.username)";
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
          params: { action: "fill", value: "{{cred:acme-demo.username}}" },
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
    const secret = "cred(acme-demo.token)";
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
          params: { action: "fill", value: "{{cred:acme-demo.token}}" },
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
          params: { instruction: "sign in with {{cred:acme-demo.password}}", input: "x" },
        },
      ]),
      deps,
      { inputs: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failedStep).toBe("s1");
    expect(outcome.report).toContain("no credential stored for acme-demo.password");
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
          params: { action: "navigate", url: "https://x/?t={{cred:acme-demo.token}}" },
        },
      },
      {
        what: "press",
        step: {
          id: "s2",
          kind: "browser",
          label: "Press the key",
          params: { action: "press", key: "{{cred:acme-demo.token}}" },
        },
      },
      {
        what: "evaluate",
        step: {
          id: "s2",
          kind: "browser.evaluate",
          label: "Read the token",
          params: { fn: "() => '{{cred:acme-demo.token}}'" },
        },
      },
      {
        what: "ask",
        step: {
          id: "s2",
          kind: "ask",
          label: "Confirm",
          params: { question: "Use {{cred:acme-demo.token}}?" },
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
      expect(outcome.report, what).toContain("no credential stored for acme-demo.token");
      expect(credCalls, what).toEqual([]);
    }
  });
});
