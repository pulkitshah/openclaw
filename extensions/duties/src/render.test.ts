// The extensions Vitest config excludes `extensions/*/browser/**` (owned by the Control UI test
// lane instead — see `test/vitest/vitest.ui-paths.mjs`'s `pluginControlUiPathGlob`), so this pure
// render-function test lives under `src/` and imports the browser module by relative path.
import { describe, expect, it } from "vitest";
import { renderBoard, renderDetail, renderRun } from "../browser/render.js";
import type { Duty } from "./duty.js";
import type { DutyRun } from "./store.js";

const duty = {
  id: "d1",
  name: "Book flight",
  summary: "s",
  status: "active",
  machine: "gateway",
  reportsTo: "owner",
  inputs: [],
  triggers: [{ kind: "manual" }],
  updatedAt: 0,
  steps: [{ id: "s1", kind: "ask", label: "Confirm?", params: {} }],
} as const;

describe("render", () => {
  it("board shows the duty with its status and no Draft anywhere", () => {
    const html = renderBoard([duty as unknown as Duty], []);
    expect(html).toContain("Book flight");
    expect(html).toContain("Active");
    expect(html).not.toMatch(/draft/iu);
  });

  it("detail lists successful runs only and highlights ask steps", () => {
    const html = renderDetail(
      duty as unknown as Duty,
      [
        {
          id: "r1",
          dutyId: "d1",
          status: "ok",
          startedAt: 1,
          trigger: "manual",
          inputs: {},
          outputs: {},
          steps: [],
        },
        {
          id: "r2",
          dutyId: "d1",
          status: "failed",
          startedAt: 2,
          trigger: "manual",
          inputs: {},
          outputs: {},
          steps: [],
        },
      ] as unknown as DutyRun[],
    );
    expect(html).toContain("r1");
    expect(html).not.toContain("r2");
    expect(html).toContain('class="kind ask"');
  });

  it("board surfaces a banner for the newest failed run and counts it as waiting on you", () => {
    const runs = [
      {
        id: "r3",
        dutyId: "d1",
        status: "failed",
        startedAt: 5,
        trigger: "manual",
        inputs: {},
        outputs: {},
        steps: [],
        failedStep: "s1",
        report: "the site rejected the login",
      },
    ] as unknown as DutyRun[];
    const html = renderBoard([duty as unknown as Duty], runs);
    expect(html).toContain("Book flight");
    expect(html).toContain("the site rejected the login");
    expect(html).toContain('data-open-run="r3"');
  });

  it("credential inputs never show the value, only that it comes from the Keychain", () => {
    const withCred = {
      ...duty,
      inputs: [{ name: "site.password", source: "cred" }],
    } as unknown as Duty;
    const html = renderDetail(withCred, []);
    expect(html).toContain("from your Keychain, never shown");
    expect(html).not.toContain('site.password">');
  });

  it("a `when` node renders as a collapsible group instead of a numbered step", () => {
    const withWhen = {
      ...duty,
      steps: [
        {
          kind: "when",
          label: "Check if already signed in",
          cond: { visible: { text: "My Account" } },
          then: [],
          else: [{ id: "s2", kind: "browser", label: "Sign in", params: {} }],
        },
      ],
    } as unknown as Duty;
    const html = renderDetail(withWhen, []);
    expect(html).toContain("<details>");
    expect(html).toContain("Check if already signed in");
    expect(html).toContain("Sign in");
  });

  it("renders a run's step evidence and outputs", () => {
    const run = {
      id: "r1",
      dutyId: "d1",
      status: "ok",
      startedAt: 1,
      endedAt: 2,
      trigger: "manual",
      inputs: {},
      outputs: { pnr: "AMG-1" },
      steps: [
        {
          stepId: "s1",
          label: "Confirm?",
          kind: "ask",
          status: "ok",
          durationMs: 10,
          summary: "answered yes",
        },
      ],
    } as unknown as DutyRun;
    const html = renderRun(run, duty as unknown as Duty);
    expect(html).toContain("Succeeded");
    expect(html).toContain("answered yes");
    expect(html).toContain("AMG-1");
  });
});
