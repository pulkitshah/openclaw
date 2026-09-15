// Runner behavior for template and deliver steps, split from runner.test.ts to stay under
// the extensions max-lines budget. Shares fixtures with runner.test.ts via runner.test-helpers.ts.
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DutyNode } from "./duty.js";
import { runDuty } from "./runner.js";
import { duty, fakeDeps } from "./runner.test-helpers.js";
import type { Template } from "./template.js";

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
      if (keys.includes("notes")) {
        return (
          opts.notes ?? { notes: "Book early", $filename: opts.aiName ?? "Flight options IXU COK" }
        );
      }
      if (keys.includes("flights")) {
        return { flights: [{ airline: "IndiGo" }] };
      }
      if (keys.includes("route")) {
        return { route: "IXU → COK" };
      }
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
    for (const file of outcome.files) {
      expect(existsSync(file.path)).toBe(true);
    }
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
