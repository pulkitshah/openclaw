import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Duty, DutyNode, Target } from "./duty.js";
import { runDuty, type RunnerDeps } from "./runner.js";
import type { Template } from "./template.js";

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
    screenshotPath: async () => "/tmp/fake.png",
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
    templates: over.templates ?? { get: async () => undefined, brand: async () => undefined },
    render: over.render ?? {
      toPdf: async (html, dest) => {
        calls.push(`render ${html}`);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, "%PDF");
        return { bytes: 4 };
      },
    },
    deliver: over.deliver ?? {
      send: async ({ route, text, files }) => {
        const names = (files ?? []).map((f) => path.basename(f)).join(", ");
        calls.push(`deliver ${route.channel}:${route.to} ${text ?? ""} [${names}]`);
        return { messageIds: ["m-1"] };
      },
    },
    resolveRoute:
      over.resolveRoute ??
      (async (_to, _channel, origin) => {
        if (origin?.kind === "chat") return { channel: "telegram", to: "222" };
        throw new Error("no owner target configured — set it on the Duties page");
      }),
    filesDir: over.filesDir ?? mkdtempSync(path.join(tmpdir(), "duties-runner-")),
    // Conditional so the default stays "no cancellation hook" rather than an explicit undefined.
    ...(over.isCancelled ? { isCancelled: over.isCancelled } : {}),
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

describe("template and deliver steps", () => {
  const flightTpl: Template = {
    id: "flight-options",
    name: "Flight options",
    kind: "pdf",
    updatedAt: 1,
    html: "<p>{{slot:route}}</p>{{#rows:flights}}<i>{{col:airline}}</i>{{/rows:flights}}<p>{{slot:notes}}</p>",
    slots: [
      { name: "route", kind: "text", description: "" },
      { name: "flights", kind: "rows", description: "", columns: ["airline"] },
      { name: "notes", kind: "prose", description: "" },
    ],
  };
  const noteTpl: Template = {
    id: "note",
    name: "Note",
    kind: "message",
    updatedAt: 1,
    html: "Route: {{slot:route}}",
    slots: [{ name: "route", kind: "text", description: "" }],
  };
  const slipTpl: Template = {
    id: "slip",
    name: "Slip",
    kind: "pdf",
    updatedAt: 1,
    html: "<p>{{slot:route}}</p>",
    slots: [{ name: "route", kind: "text", description: "" }],
  };

  /** One ai fake for every `extract` a template duty makes: the two seeding steps and the template
   *  step's own `{ ai }` fills all dispatch on the slot names their schema asks for, so a test can
   *  also assert how many extract calls the template step itself made. */
  const seedAi = (
    opts: { notes?: Record<string, unknown>; seen?: string[][]; aiName?: string } = {},
  ): RunnerDeps["ai"] => ({
    extract: async ({ schema }) => {
      const props = schema.properties;
      const keys = props && typeof props === "object" ? Object.keys(props) : [];
      opts.seen?.push(keys);
      if (keys.includes("notes"))
        return (
          opts.notes ?? { notes: "Book early", $filename: opts.aiName ?? "Flight options IXU COK" }
        );
      if (keys.includes("flights")) return { flights: [{ airline: "IndiGo" }] };
      if (keys.includes("route")) return { route: "IXU → COK" };
      return {};
    },
  });

  /** The two leading `ai` steps seed `outputs.route` and `outputs.flights` the template fills from;
   *  `saveAs: ["route"]` (not `"route"`) because the single-key form saves the whole result object. */
  const dutySteps = (): DutyNode[] => [
    {
      id: "a1",
      kind: "ai",
      label: "Read the route",
      params: {
        instruction: "the route",
        input: "{{in:mail}}",
        schema: { type: "object", properties: { route: { type: "string" } } },
      },
      saveAs: ["route"],
    },
    {
      id: "a2",
      kind: "ai",
      label: "Read the flights",
      params: {
        instruction: "the flights",
        input: "{{in:mail}}",
        schema: { type: "object", properties: { flights: { type: "array" } } },
      },
      saveAs: ["flights"],
    },
    {
      id: "t1",
      kind: "template",
      label: "Render the options",
      params: {
        template: "flight-options",
        fill: {
          route: { from: "{{out:route}}" },
          flights: { from: "{{out:flights}}" },
          notes: { ai: "One line of advice" },
        },
      },
    },
    {
      id: "d1",
      kind: "deliver",
      label: "Send to the requester",
      params: { to: "trigger", text: "Options for {{out:route}}", files: ["{{file:t1}}"] },
    },
  ];

  it("fills mapped and ai slots, renders a pdf into the run dir, and delivers it to the origin route", async () => {
    const seen: string[][] = [];
    const deps = fakeDeps({
      templates: {
        get: async () => flightTpl,
        brand: async () => ({ name: "Amigos", updatedAt: 1 }),
      },
      ai: seedAi({ seen }),
    });
    const outcome = await runDuty(duty(dutySteps()), deps, {
      inputs: {},
      origin: { kind: "chat", sessionKey: "agent:main:telegram:222" },
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.files).toEqual([
      expect.objectContaining({ stepId: "t1", contentType: "application/pdf" }),
    ]);
    // The document is named, not called after the step id, and `deliver` attaches it under that
    // same name because the attachment name comes from the path's basename.
    expect(outcome.files[0]!.name).toBe("Flight options IXU COK.pdf");
    expect(outcome.files[0]!.path).toBe(path.join(deps.filesDir, "Flight options IXU COK.pdf"));
    expect(existsSync(outcome.files[0]!.path)).toBe(true);
    expect(deps.calls).toContain("render <p>IXU → COK</p><i>IndiGo</i><p>Book early</p>");
    expect(deps.calls).toContain(
      "deliver telegram:222 Options for IXU → COK [Flight options IXU COK.pdf]",
    );
    expect(outcome.steps.map((s) => s.summary)).toEqual([
      "route",
      "flights",
      expect.stringContaining("Flight options IXU COK.pdf"),
      "→ telegram:222",
    ]);
    // One extract per seeding step, then exactly one for the template step — the document's name
    // is written in that same call rather than costing a second round trip.
    expect(seen).toEqual([["route"], ["flights"], ["notes", "$filename"]]);
    expect(outcome.steps.at(-1)?.screenshotBlobId).toBeUndefined();
  });

  // Regression: a `fill` key naming no declared slot was silently ignored, so a typo surfaced as a
  // DIFFERENT slot's `slot "x" could not be filled`.
  it("names the undeclared fill keys instead of reporting a different slot as unfillable", async () => {
    const deps = fakeDeps({
      templates: { get: async () => flightTpl, brand: async () => undefined },
      ai: seedAi(),
    });
    const steps = dutySteps();
    const params = (steps[2] as { params: Record<string, unknown> }).params;
    params.fill = { rout: { from: "IXU" }, flights: { from: "[]" }, notes: { ai: "x" } };

    const outcome = await runDuty(duty(steps), deps, { inputs: {} });

    expect(outcome.status).toBe("failed");
    expect(outcome.report).toMatch(/has no slot\(s\) rout/u);
    expect(outcome.files).toEqual([]);
  });

  // Regression: `{ ai }` on a rows slot can never succeed (the ai call answers one string per slot,
  // the renderer needs an array of row objects) and surfaced as the generic missing-slot error.
  it("rejects an ai fill on a rows slot with a message that names the real cause", async () => {
    const deps = fakeDeps({
      templates: { get: async () => flightTpl, brand: async () => undefined },
      ai: seedAi(),
    });
    const steps = dutySteps();
    const params = (steps[2] as { params: Record<string, unknown> }).params;
    params.fill = {
      route: { from: "IXU" },
      flights: { ai: "invent the flights" },
      notes: { ai: "x" },
    };

    const outcome = await runDuty(duty(steps), deps, { inputs: {} });

    expect(outcome.status).toBe("failed");
    expect(outcome.report).toMatch(/slot "flights" is a rows slot.*not \{ ai \}/su);
  });

  // Defence in depth behind validateDuty's `{{file:<stepId>}}` rule: a Duty saved before that rule
  // must still not be able to mail out an arbitrary readable file.
  it("refuses to deliver a path this run did not produce", async () => {
    const deps = fakeDeps({
      templates: { get: async () => flightTpl, brand: async () => undefined },
      ai: seedAi(),
    });
    const steps = dutySteps();
    (steps[3] as { params: Record<string, unknown> }).params.files = [
      "/Users/someone/.openclaw/openclaw.json",
    ];

    const outcome = await runDuty(duty(steps), deps, {
      inputs: {},
      origin: { kind: "chat", sessionKey: "agent:main:telegram:222" },
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.report).toMatch(/deliver can only attach a file this run produced/u);
    expect(deps.calls.some((c) => c.startsWith("deliver "))).toBe(false);
  });

  it("names the document from an authored filename, resolving placeholders and sanitising it", async () => {
    const deps = fakeDeps({
      templates: { get: async () => flightTpl, brand: async () => undefined },
      ai: seedAi(),
    });
    const steps = dutySteps();
    // A name that is legal to author and hostile on a filesystem: a placeholder, a path
    // separator, a control character, and a stray extension the step should not double up.
    (steps[2] as { params: Record<string, unknown> }).params.filename =
      "Flights/{{out:route}}\u0007  quote.pdf";

    const outcome = await runDuty(duty(steps), deps, {
      inputs: {},
      origin: { kind: "chat", sessionKey: "agent:main:telegram:222" },
    });

    expect(outcome.status).toBe("ok");
    expect(outcome.files[0]!.name).toBe("Flights IXU → COK quote.pdf");
    expect(outcome.files[0]!.path).toBe(
      path.dirname(outcome.files[0]!.path) + "/Flights IXU → COK quote.pdf",
    );
    expect(deps.calls).toContain(
      "deliver telegram:222 Options for IXU → COK [Flights IXU → COK quote.pdf]",
    );
  });

  it("asks for a name even when the template has no ai slots, and falls back when none is usable", async () => {
    const plainTpl: Template = {
      id: "plain",
      name: "Plain quote",
      kind: "pdf",
      updatedAt: 1,
      html: "<p>{{slot:route}}</p>",
      slots: [{ name: "route", kind: "text", description: "" }],
    };
    const askedFor: string[][] = [];
    const deps = fakeDeps({
      templates: { get: async () => plainTpl, brand: async () => undefined },
      ai: {
        extract: async ({ schema }) => {
          const props = schema.properties;
          askedFor.push(props && typeof props === "object" ? Object.keys(props) : []);
          // Nothing usable: the run must still produce a named file rather than fail.
          return { $filename: "   " };
        },
      },
    });

    const outcome = await runDuty(
      duty([
        {
          id: "t1",
          kind: "template",
          label: "Render the quote",
          params: { template: "plain", fill: { route: { from: "IXU → COK" } } },
        },
      ]),
      deps,
      { inputs: {}, now: undefined } as never,
    );

    expect(outcome.status).toBe("ok");
    // The only thing the model was asked for was the name.
    expect(askedFor).toEqual([["$filename"]]);
    // Falls back to the template's own name plus the date.
    expect(outcome.files[0]!.name).toMatch(/^Plain quote \d{4}-\d{2}-\d{2}\.pdf$/u);
  });

  it("does not let a second document overwrite the first when both want one name", async () => {
    const plainTpl: Template = {
      id: "plain",
      name: "Quote",
      kind: "pdf",
      updatedAt: 1,
      html: "<p>{{slot:route}}</p>",
      slots: [{ name: "route", kind: "text", description: "" }],
    };
    const deps = fakeDeps({
      templates: { get: async () => plainTpl, brand: async () => undefined },
      ai: { extract: async () => ({}) },
    });
    const templateStep = (id: string) => ({
      id,
      kind: "template" as const,
      label: "Render the quote",
      params: {
        template: "plain",
        filename: "Quote for LIC",
        fill: { route: { from: "IXU → COK" } },
      },
    });

    const outcome = await runDuty(duty([templateStep("t1"), templateStep("t2")]), deps, {
      inputs: {},
    });

    expect(outcome.status).toBe("ok");
    expect(outcome.files.map((f) => f.name)).toEqual([
      "Quote for LIC.pdf",
      "Quote for LIC (2).pdf",
    ]);
    // Both documents survive: an overwrite would have attached the wrong one.
    for (const file of outcome.files) expect(existsSync(file.path)).toBe(true);
  });

  it("fails the template step naming the unfilled slot", async () => {
    const deps = fakeDeps({
      templates: { get: async () => flightTpl, brand: async () => undefined },
      ai: seedAi({ notes: {} }),
    });
    const outcome = await runDuty(duty(dutySteps()), deps, { inputs: {} });
    expect(outcome.status).toBe("failed");
    expect(outcome.failedStep).toBe("t1");
    expect(outcome.report).toMatch(/slot "notes" could not be filled/u);
    expect(deps.calls.some((c) => c.startsWith("deliver"))).toBe(false);
  });

  it("renders a message template into an output without producing a file or calling ai", async () => {
    const seen: string[][] = [];
    const deps = fakeDeps({
      templates: { get: async () => noteTpl, brand: async () => undefined },
      ai: seedAi({ seen }),
    });
    const outcome = await runDuty(
      duty([
        {
          id: "t1",
          kind: "template",
          label: "Write the note",
          params: { template: "note", fill: { route: { from: "{{in:route}}" } } },
          saveAs: "note",
        },
        { id: "d1", kind: "deliver", label: "Send", params: { to: "owner", text: "{{out:note}}" } },
      ]),
      deps,
      { inputs: { route: "IXU → COK" }, origin: { kind: "chat" } },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.outputs.note).toBe("Route: IXU → COK");
    expect(outcome.files).toEqual([]);
    expect(seen).toEqual([]);
    expect(deps.calls.some((c) => c.startsWith("render"))).toBe(false);
    expect(deps.calls).toContain("deliver telegram:222 Route: IXU → COK []");
  });

  it("keeps a rendered document inside the run directory whatever names it", async () => {
    // Three ways a name reaches this step, all of them reduced to one path segment: an authored
    // `filename` (placeholders are resolved, so a run value lands in it), the model's answer, and
    // the step id. `validateDuty` rejects an escaping step id outright now; this pins the runner's
    // own belt-and-braces, which is what protects a Duty stored before that check — and stops
    // `duties.run.file` from being handed a path outside the run to serve over operator.read.
    const escaping = async (params: Record<string, unknown>, aiName?: string) => {
      const deps = fakeDeps({
        templates: { get: async () => slipTpl, brand: async () => undefined },
        ...(aiName ? { ai: { extract: async () => ({ $filename: aiName }) } } : {}),
      });
      const outcome = await runDuty(
        duty([
          {
            id: "../../../../tmp/evil",
            kind: "template",
            label: "Print the slip",
            params: { template: "slip", fill: { route: { from: "{{in:route}}" } }, ...params },
          },
        ]),
        deps,
        { inputs: { route: "IXU → COK" } },
      );
      expect(outcome.status).toBe("ok");
      const file = outcome.files[0]!;
      expect(path.dirname(file.path)).toBe(deps.filesDir);
      expect(path.join(deps.filesDir, file.name)).toBe(file.path);
      expect(existsSync(file.path)).toBe(true);
      return file.name;
    };

    // An authored filename that tries to climb out.
    expect(await escaping({ filename: "../../../../tmp/evil" })).toBe("tmp evil.pdf");
    // A model-written one that tries the same.
    expect(await escaping({}, "/etc/passwd")).toBe("etc passwd.pdf");
    // And with neither, the fallback still cannot inherit the step id's path.
    expect(await escaping({}, " ")).toMatch(/^Slip \d{4}-\d{2}-\d{2}\.pdf$/u);
  });

  it("refuses a format that is not the template's own kind, in either direction", async () => {
    const asPdf = fakeDeps({
      templates: { get: async () => noteTpl, brand: async () => undefined },
    });
    const printed = await runDuty(
      duty([
        {
          id: "t1",
          kind: "template",
          label: "Print the note",
          params: { template: "note", format: "pdf", fill: { route: { from: "{{in:route}}" } } },
        },
      ]),
      asPdf,
      { inputs: { route: "IXU → COK" } },
    );
    expect(printed.status).toBe("failed");
    expect(printed.report).toBe(
      'template "note" is a message template; format "pdf" is not allowed',
    );
    expect(printed.files).toEqual([]);
    expect(asPdf.calls.some((c) => c.startsWith("render"))).toBe(false);

    const asMessage = fakeDeps({
      templates: { get: async () => slipTpl, brand: async () => undefined },
    });
    const texted = await runDuty(
      duty([
        {
          id: "t1",
          kind: "template",
          label: "Text the slip",
          params: {
            template: "slip",
            format: "message",
            fill: { route: { from: "{{in:route}}" } },
          },
          saveAs: "slip",
        },
      ]),
      asMessage,
      { inputs: { route: "IXU → COK" } },
    );
    expect(texted.status).toBe("failed");
    expect(texted.report).toBe(
      'template "slip" is a pdf template; format "message" is not allowed',
    );
    expect(texted.outputs.slip).toBeUndefined();
  });

  it("resolves a produced file only in template and deliver params", async () => {
    const deps = fakeDeps({
      templates: { get: async () => slipTpl, brand: async () => undefined },
    });
    const outcome = await runDuty(
      duty([
        {
          id: "t1",
          kind: "template",
          label: "Render the slip",
          params: { template: "slip", fill: { route: { from: "{{in:route}}" } } },
        },
        {
          id: "a1",
          kind: "ai",
          label: "Summarize the attachment",
          params: { instruction: "read {{file:t1}}", input: "x" },
        },
      ]),
      deps,
      { inputs: { route: "IXU → COK" } },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failedStep).toBe("a1");
    expect(outcome.report).toContain('no file from step "t1"');
    // The template step itself did produce the file the ai step was not allowed to name.
    expect(outcome.files.map((f) => f.stepId)).toEqual(["t1"]);
  });

  it("a deliver with no chat origin and no owner target fails loudly", async () => {
    const deps = fakeDeps({
      resolveRoute: async () => {
        throw new Error("no owner target configured — set it on the Duties page");
      },
    });
    const outcome = await runDuty(
      duty([{ id: "d1", kind: "deliver", label: "Send", params: { to: "owner", text: "x" } }]),
      deps,
      { inputs: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.report).toMatch(/no owner target configured/u);
  });

  it("records no screenshot for a failed deliver step, even with a tab still open", async () => {
    const deps = fakeDeps({
      resolveRoute: async () => {
        throw new Error("no owner target configured — set it on the Duties page");
      },
    });
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        { id: "d1", kind: "deliver", label: "Send", params: { to: "owner", text: "x" } },
      ]),
      deps,
      { inputs: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.steps.map((s) => s.status)).toEqual(["ok", "failed"]);
    // The browser step's own evidence still carries one: the gate is the step's kind, not the tab
    // (a failed ai/ask step keeps its screenshot too — only template/deliver skip it).
    expect(outcome.steps[0]!.screenshotBlobId).toBe("blob-1");
    expect(outcome.steps[1]!.screenshotBlobId).toBeUndefined();
  });

  it("a cancelled run never delivers", async () => {
    let cancelled = false;
    const deps = fakeDeps({ isCancelled: () => cancelled });
    const steps: DutyNode[] = [
      {
        id: "a1",
        kind: "ai",
        label: "Think",
        params: { instruction: "x", input: "y" },
        saveAs: "route",
      },
      { id: "d1", kind: "deliver", label: "Send", params: { to: "owner", text: "x" } },
    ];
    deps.ai = {
      extract: async () => {
        cancelled = true;
        return { route: "r" };
      },
    };
    const outcome = await runDuty(duty(steps), deps, { inputs: {} });
    expect(outcome.status).toBe("cancelled");
    expect(deps.calls.some((c) => c.startsWith("deliver"))).toBe(false);
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
