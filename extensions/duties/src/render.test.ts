// The extensions Vitest config excludes `extensions/*/browser/**` (owned by the Control UI test
// lane instead — see `test/vitest/vitest.ui-paths.mjs`'s `pluginControlUiPathGlob`), so this pure
// render-function test lives under `src/` and imports the browser module by relative path.
import { describe, expect, it } from "vitest";
import {
  renderBoard,
  renderDetail,
  renderLogins,
  renderPlaceholder,
  renderRun,
  renderTemplates,
} from "../browser/render.js";
import type { Duty } from "./duty.js";
import type { DutyRun } from "./store.js";
import type { Template } from "./template.js";

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

  it("board stops accusing a duty once a newer run succeeded", () => {
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
        report: "the site rejected the login",
      },
      {
        id: "r4",
        dutyId: "d1",
        status: "ok",
        startedAt: 6,
        trigger: "manual",
        inputs: {},
        outputs: {},
        steps: [],
      },
    ] as unknown as DutyRun[];
    const html = renderBoard([duty as unknown as Duty], runs);
    expect(html).not.toContain("the site rejected the login");
    expect(html).not.toContain('data-open-run="r3"');
  });

  it("logins panel lists keys with a masked add form and never renders a value", () => {
    const html = renderLogins({
      keys: ["amigos.password"],
      updatedAt: { "amigos.password": 1_700_000_000_000 },
    });
    expect(html).toContain("amigos.password");
    expect(html).toContain('type="password"');
    expect(html).toContain("data-cred-value");
    expect(html).toContain('data-cred-delete="amigos.password"');
    expect(html).toContain("data-cred-save");
    expect(html).not.toMatch(/value="[^"]/u);

    const empty = renderLogins({ keys: [], updatedAt: {} });
    expect(empty).toContain("No logins saved yet");
  });

  it("run view offers a screenshot toggle only for steps that have one", () => {
    const run = {
      id: "r1",
      dutyId: "d1",
      status: "ok",
      startedAt: 1,
      trigger: "manual",
      inputs: {},
      outputs: {},
      steps: [
        {
          stepId: "s1",
          label: "Open",
          kind: "browser",
          status: "ok",
          durationMs: 1,
          summary: "x",
          screenshotBlobId: "blob-1",
        },
        {
          stepId: "s2",
          label: "Confirm?",
          kind: "ask",
          status: "blocked",
          durationMs: 1,
          summary: "no answer",
        },
      ],
    } as unknown as DutyRun;
    const html = renderRun(run, duty as unknown as Duty);
    expect(html).toContain('data-shot="s1"');
    expect(html).toContain('data-shot-for="s1"');
    expect(html).not.toContain('data-shot="s2"');
    expect(html).not.toContain("blob-1");
    expect(html).toContain('class="st blocked"');
  });

  it("renders an inline error banner with a retry control when given one", () => {
    const board = renderBoard([duty as unknown as Duty], [], { error: "boom" });
    expect(board).toContain("boom");
    expect(board).toContain("data-retry");

    const detail = renderDetail(duty as unknown as Duty, [], { error: "detail boom" });
    expect(detail).toContain("detail boom");
    expect(detail).toContain("data-retry");

    const run = {
      id: "r1",
      dutyId: "d1",
      status: "ok",
      startedAt: 1,
      trigger: "manual",
      inputs: {},
      outputs: {},
      steps: [],
    } as unknown as DutyRun;
    const runHtml = renderRun(run, duty as unknown as Duty, { error: "run boom" });
    expect(runHtml).toContain("run boom");
    expect(runHtml).toContain("data-retry");
  });

  it("escapes a duty name containing markup and quotes everywhere it appears", () => {
    const hostile = {
      ...duty,
      name: `<script>&"`,
    } as unknown as Duty;
    const board = renderBoard([hostile], []);
    expect(board).not.toContain("<script>");
    expect(board).toContain("&lt;script&gt;&amp;&quot;");

    const detail = renderDetail(hostile, []);
    expect(detail).not.toContain("<script>");
    expect(detail).toContain("&lt;script&gt;&amp;&quot;");
  });

  it("trigger chips show the match text for mail and chat triggers, and Manual for manual", () => {
    const withTriggers = {
      ...duty,
      triggers: [
        { kind: "mail", match: "quote@vendor.com" },
        { kind: "chat", match: "book flight" },
        { kind: "manual" },
      ],
    } as unknown as Duty;
    const html = renderBoard([withTriggers], []);
    expect(html).toContain("Mail: quote@vendor.com");
    expect(html).toContain("Chat: book flight");
    expect(html).toMatch(/>Manual</u);
  });

  it("run view lists a PDF file with a Preview toggle and an Open PDF button, and shows a deliver step's channel:target summary", () => {
    const run = {
      id: "r1",
      dutyId: "d1",
      status: "ok",
      startedAt: 1,
      trigger: "manual",
      inputs: {},
      outputs: {},
      steps: [
        {
          stepId: "s1",
          label: "Send quote",
          kind: "deliver",
          status: "ok",
          durationMs: 1,
          summary: "→ telegram:12345",
        },
      ],
      files: [
        {
          stepId: "s1",
          name: "quote.pdf",
          path: "/tmp/quote.pdf",
          bytes: 2048,
          contentType: "application/pdf",
        },
      ],
    } as unknown as DutyRun;
    const html = renderRun(run, duty as unknown as Duty);
    expect(html).toContain('data-file-shot="s1"');
    expect(html).toContain('data-file-shot-for="s1"');
    expect(html).toContain('data-file-open="s1"');
    expect(html).toContain(">Open PDF<");
    expect(html).toContain("quote.pdf");
    expect(html).toContain("→ telegram:12345");
    expect(html).toContain('class="kind deliver"');
    expect(html).toContain(">Deliver<");
    expect(html).not.toMatch(/<iframe/u);
  });

  it("run view offers only Open (no Preview) for a non-PDF file", () => {
    const run = {
      id: "r1",
      dutyId: "d1",
      status: "ok",
      startedAt: 1,
      trigger: "manual",
      inputs: {},
      outputs: {},
      steps: [],
      files: [
        {
          stepId: "s1",
          name: "notes.txt",
          path: "/tmp/notes.txt",
          bytes: 12,
          contentType: "text/plain",
        },
      ],
    } as unknown as DutyRun;
    const html = renderRun(run, duty as unknown as Duty);
    expect(html).toContain('data-file-open="s1"');
    expect(html).toContain(">Open<");
    expect(html).not.toContain("data-file-shot");
    expect(html).not.toContain(">Open PDF<");
  });

  it("templates view renders a card per template with a preview toggle and the brand form", () => {
    const templates = [
      {
        id: "t1",
        name: "Rate quote",
        kind: "pdf",
        html: "<p>{{slot:x}}</p>",
        slots: [{ name: "x", kind: "text", description: "d" }],
        updatedAt: 10,
      },
      {
        id: "t2",
        name: "Confirmation",
        kind: "pdf",
        html: "<p>{{slot:y}}</p>",
        slots: [{ name: "y", kind: "text", description: "d" }],
        updatedAt: 20,
      },
    ] as unknown as Template[];
    const html = renderTemplates({ templates });
    expect(html).toContain('data-tpl-preview="t1"');
    expect(html).toContain('data-tpl-preview="t2"');
    expect(html).toContain('data-tpl-pdf="t1"');
    expect(html).toContain('data-tpl-pdf="t2"');
    expect(html).toContain(">Open PDF<");
    expect(html).toContain("Rate quote");
    expect(html).toContain("Confirmation");
    expect(html).toContain("data-brand-save");
  });

  it("offers Preview only for pdf templates; a message template shows its text inline instead, with no Gateway call", () => {
    const templates = [
      {
        id: "t1",
        name: "Rate quote",
        kind: "pdf",
        html: "<p>{{slot:x}}</p>",
        slots: [{ name: "x", kind: "text", description: "d" }],
        updatedAt: 10,
      },
      {
        id: "t2",
        name: "Confirmation",
        kind: "message",
        html: "Hi {{slot:y}}, thanks for booking!",
        slots: [{ name: "y", kind: "text", description: "d" }],
        updatedAt: 20,
      },
    ] as unknown as Template[];
    const html = renderTemplates({ templates });
    expect(html).toContain('data-tpl-preview="t1"');
    expect(html).not.toContain('data-tpl-preview="t2"');
    expect(html).toContain('data-tpl-pdf="t1"');
    expect(html).not.toContain('data-tpl-pdf="t2"');
    expect(html).toContain("Message text");
    expect(html).toContain("Hi {{slot:y}}, thanks for booking!");
  });

  it("triggerRow on the Duty detail page labels each kind and shows its match, with a dash for manual", () => {
    const withTriggers = {
      ...duty,
      triggers: [
        { kind: "mail", match: "quote@vendor.com" },
        { kind: "chat", match: "book flight" },
        { kind: "manual" },
      ],
    } as unknown as Duty;
    const html = renderDetail(withTriggers, []);
    expect(html).toContain("<dt>Mail</dt><dd>quote@vendor.com</dd>");
    expect(html).toContain("<dt>Chat</dt><dd>book flight</dd>");
    expect(html).toContain("<dt>Manual (chat or Run button)</dt><dd>—</dd>");
  });

  it("shows a Delivered-to note on the Duty page's successful runs and the run view header once a deliver step succeeded", () => {
    const run = {
      id: "r5",
      dutyId: "d1",
      status: "ok",
      startedAt: 1,
      trigger: "manual",
      inputs: {},
      outputs: {},
      steps: [
        {
          stepId: "s1",
          label: "Send quote",
          kind: "deliver",
          status: "ok",
          durationMs: 1,
          summary: "→ telegram:••••1234",
        },
      ],
    } as unknown as DutyRun;
    const detailHtml = renderDetail(duty as unknown as Duty, [run]);
    expect(detailHtml).toContain("Delivered to telegram:••••1234");

    const runHtml = renderRun(run, duty as unknown as Duty);
    expect(runHtml).toContain("Delivered to telegram:••••1234");

    const noDeliverRun = { ...run, id: "r6", steps: [] } as unknown as DutyRun;
    const noDeliverHtml = renderDetail(duty as unknown as Duty, [noDeliverRun]);
    expect(noDeliverHtml).not.toContain("Delivered to");
  });

  it("escapes a template name containing markup and quotes", () => {
    const hostile = [
      {
        id: "t1",
        name: `<script>&"`,
        kind: "pdf",
        html: "<p>{{slot:x}}</p>",
        slots: [],
        updatedAt: 1,
      },
    ] as unknown as Template[];
    const html = renderTemplates({ templates: hostile });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;&amp;&quot;");
  });

  it("board shows the owner settings form and the mail setup instruction when the mapping is missing", () => {
    const html = renderBoard([duty as unknown as Duty], [], {
      settings: { owner: { channel: "telegram", target: "12345" } },
      mailStatus: {
        hooksEnabled: true,
        gmailAccountSet: true,
        mappingPresent: false,
        agentPresent: true,
      },
    });
    expect(html).toContain("data-settings-save");
    expect(html).toContain("openclaw duties setup-mail");
    expect(html).toContain('value="12345"');
    expect(html).toContain('value="telegram" selected');
  });

  it("board's mail setup instruction disappears once every check passes", () => {
    const html = renderBoard([duty as unknown as Duty], [], {
      mailStatus: {
        hooksEnabled: true,
        gmailAccountSet: true,
        mappingPresent: true,
        agentPresent: true,
      },
    });
    expect(html).not.toContain("openclaw duties setup-mail");
  });

  it("board's Desk card shows health chips and the parallel-runs input when hosted", () => {
    const html = renderBoard([duty as unknown as Duty], [], {
      settings: { maxParallelRuns: 3 },
      deskStatus: {
        hosted: true,
        gateway: true,
        display: true,
        chromium: false,
        tailscale: true,
        mailWatcher: true,
        load1: 0.42,
        memFreeMb: 512,
        maxParallelRuns: 3,
        active: 1,
        queued: 0,
      },
    });
    expect(html).toContain("data-parallel-save");
    expect(html).toContain('value="3"');
    expect(html).toContain("Gateway");
    expect(html).toContain("mcheck ok");
    expect(html).toContain("mcheck bad");
  });

  it("board's Desk card hides the health chips (never the parallel input) when not hosted", () => {
    const html = renderBoard([duty as unknown as Duty], [], {
      deskStatus: { hosted: false, maxParallelRuns: 4, active: 0, queued: 0 },
    });
    expect(html).toContain("data-parallel-save");
    expect(html).toContain('value="4"');
    expect(html).not.toContain("mcheck");
  });

  it("board's Desk card falls back to a loading state before the first duties.desk.status reply", () => {
    const html = renderBoard([duty as unknown as Duty], []);
    expect(html).toContain("data-parallel-save");
    expect(html).not.toContain("mcheck");
  });

  it("renderPlaceholder shows an error banner with retry when a load failed, not a bare Loading forever", () => {
    const errored = renderPlaceholder({ error: "network down" });
    expect(errored).toContain("network down");
    expect(errored).toContain("data-retry");
    expect(errored).not.toContain("Loading");

    const loading = renderPlaceholder({});
    expect(loading).toContain("Loading");
    expect(loading).not.toContain("data-retry");
  });

  it("board's duty card links its last successful run straight to the run page", () => {
    const runs = [
      {
        id: "r7",
        dutyId: "d1",
        status: "ok",
        startedAt: 9,
        trigger: "manual",
        inputs: {},
        outputs: {},
        steps: [],
      },
    ] as unknown as DutyRun[];
    const html = renderBoard([duty as unknown as Duty], runs);
    expect(html).toContain('data-open-run="r7"');
    expect(html).toContain('data-duty-id="d1"');
  });

  it("board's waiting-on-you/failed banner links to the run page with both the run and duty id", () => {
    const runs = [
      {
        id: "r3",
        dutyId: "d1",
        status: "blocked",
        startedAt: 5,
        trigger: "manual",
        inputs: {},
        outputs: {},
        steps: [],
      },
    ] as unknown as DutyRun[];
    const html = renderBoard([duty as unknown as Duty], runs);
    expect(html).toContain('data-open-run="r3"');
    expect(html).toContain('data-duty-id="d1"');
  });

  it("run page has a Board crumb alongside the Duty crumb", () => {
    const run = {
      id: "r1",
      dutyId: "d1",
      status: "ok",
      startedAt: 1,
      trigger: "manual",
      inputs: {},
      outputs: {},
      steps: [],
    } as unknown as DutyRun;
    const html = renderRun(run, duty as unknown as Duty);
    expect(html).toContain('data-nav="board">← Board<');
    expect(html).toContain('data-open="d1">Book flight<');
  });

  it("the Now panel shows the newest step's label and screenshot while a run is running", () => {
    const run = {
      id: "r1",
      dutyId: "d1",
      status: "running",
      startedAt: 1,
      trigger: "manual",
      inputs: {},
      outputs: {},
      steps: [
        {
          stepId: "s1",
          label: "Open the booking site",
          kind: "browser",
          status: "ok",
          durationMs: 1,
          summary: "opened",
          screenshotBlobId: "blob-1",
        },
      ],
    } as unknown as DutyRun;
    const withoutShot = renderRun(run, duty as unknown as Duty);
    expect(withoutShot).toContain('class="panel now"');
    expect(withoutShot).toContain("Open the booking site");
    expect(withoutShot).toContain("Loading");
    expect(withoutShot).not.toContain("nowshot");

    const withShot = renderRun(run, duty as unknown as Duty, {
      now: { stepId: "s1", imageDataUrl: "data:image/png;base64,ZZZ" },
    });
    expect(withShot).toContain('<img class="nowshot"');
    expect(withShot).toContain("data:image/png;base64,ZZZ");
  });

  it("the Now panel falls back to a message instead of an image for a step with no screenshot", () => {
    const run = {
      id: "r1",
      dutyId: "d1",
      status: "queued",
      startedAt: 1,
      trigger: "manual",
      inputs: {},
      outputs: {},
      steps: [
        {
          stepId: "s1",
          label: "Confirm?",
          kind: "ask",
          status: "ok",
          durationMs: 1,
          summary: "sent",
        },
      ],
    } as unknown as DutyRun;
    const html = renderRun(run, duty as unknown as Duty);
    expect(html).toContain("No screenshot for this step.");
    expect(html).not.toContain("nowshot");
  });

  it("the Now panel does not render once a run has finished", () => {
    const run = {
      id: "r1",
      dutyId: "d1",
      status: "ok",
      startedAt: 1,
      trigger: "manual",
      inputs: {},
      outputs: {},
      steps: [
        {
          stepId: "s1",
          label: "Open the booking site",
          kind: "browser",
          status: "ok",
          durationMs: 1,
          summary: "opened",
          screenshotBlobId: "blob-1",
        },
      ],
    } as unknown as DutyRun;
    const html = renderRun(run, duty as unknown as Duty, {
      now: { stepId: "s1", imageDataUrl: "data:image/png;base64,ZZZ" },
    });
    expect(html).not.toContain('class="panel now"');
    expect(html).not.toContain("nowshot");
  });
});
