import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { RenderAdapter } from "./adapters/render.js";
import { DutyStore } from "./store.js";
import { registerDutyTools } from "./tools.js";

function memoryKeyed<T>() {
  const m = new Map<string, T>();
  return {
    register: async (k: string, v: T) => {
      m.set(k, v);
    },
    lookup: async (k: string) => m.get(k),
    entries: async () => [...m].map(([key, value]) => ({ key, value })),
    delete: async (k: string) => m.delete(k),
  };
}

function newStore(): DutyStore {
  return new DutyStore({
    duties: memoryKeyed() as never,
    runs: memoryKeyed() as never,
    creds: memoryKeyed() as never,
    templates: memoryKeyed() as never,
    brands: memoryKeyed() as never,
    settings: memoryKeyed() as never,
  });
}

type ExecutableTool = {
  execute: (
    id: string,
    input: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

/** Mirrors the host's own `registerTool`: a factory is invoked once with the turn's tool context
 *  (`src/plugins/registry-registrars-tools-hooks.ts:225`), a static tool is used as-is. */
function makeTools(ctx: OpenClawPluginToolContext = {}) {
  const tools = new Map<string, ExecutableTool>();
  const api = {
    registerTool: (tool: unknown, opts?: { name?: string }) => {
      // SAFETY: this harness only ever receives this plugin's own tools and factories, whose
      // `execute` matches ExecutableTool; `opts.name` is the factory's declared name.
      const resolved = (typeof tool === "function" ? tool(ctx) : tool) as
        | (ExecutableTool & { name?: string })
        | null;
      if (!resolved) return;
      tools.set(resolved.name ?? opts?.name ?? "", resolved);
    },
    // SAFETY: the tools under test only touch `registerTool`; every other api surface is unused.
  } as never;
  const run = async (name: string, input: unknown, signal?: AbortSignal) =>
    JSON.parse((await tools.get(name)!.execute("c1", input, signal)).content[0]!.text);
  return { api, run, tools };
}

/** Writes a stand-in PDF wherever the preview is asked for, so the path contract can be asserted
 *  without a browser. */
function fakeRender(written: string[]): RenderAdapter {
  return {
    toPdf: async (_html, dest) => {
      written.push(dest);
      return { bytes: 4 };
    },
  };
}

const noRender: RenderAdapter = {
  toPdf: async () => {
    throw new Error("render not expected");
  },
};

describe("duty tools", () => {
  it("drafts, sets steps, and refuses invalid steps with the validation errors", async () => {
    const { api, run } = makeTools();
    const store = newStore();
    registerDutyTools({
      api,
      store,
      runs: { start: vi.fn(), wait: vi.fn() } as never,
      credHas: async () => false,
      render: noRender,
      previewDir: async () => tmpdir(),
    });
    const drafted = await run("duty_draft", { id: "d1", name: "Book flight", summary: "books" });
    expect(drafted.duty.machine).toBe("gateway");
    expect((await run("duty_list", {})).duties[0]).toMatchObject({ id: "d1", status: "building" });
    const bad = await run("duty_set_steps", {
      id: "d1",
      steps: [{ id: "s1", kind: "browser", label: "#btnlogin", params: {} }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toContain("label");
    const good = await run("duty_set_steps", {
      id: "d1",
      steps: [
        {
          id: "s1",
          kind: "browser",
          label: "Open Amigos",
          params: { action: "open", url: "https://x" },
        },
      ],
    });
    expect(good.ok).toBe(true);
    expect((await run("cred_needed", { key: "amigos.password", reason: "login" })).stored).toBe(
      false,
    );
  });

  it("duty_get returns the duty plus its last successful runs", async () => {
    const { api, run } = makeTools();
    const store = newStore();
    registerDutyTools({
      api,
      store,
      runs: { start: vi.fn(), wait: vi.fn() } as never,
      credHas: async () => false,
      render: noRender,
      previewDir: async () => tmpdir(),
    });
    await run("duty_draft", { id: "d1", name: "Book flight", summary: "books" });
    const got = await run("duty_get", { id: "d1" });
    expect(got.duty).toMatchObject({ id: "d1", status: "building" });
    expect(got.runs).toEqual([]);
  });

  it("duty_run starts a run and waits for it, returning the awaited run's fields", async () => {
    const { api, run } = makeTools();
    const store = newStore();
    await store.saveDuty({
      id: "d1",
      name: "Book flight",
      summary: "books",
      status: "building",
      machine: "m",
      reportsTo: "owner",
      inputs: [],
      steps: [],
      triggers: [],
      updatedAt: 0,
    });
    const start = vi.fn().mockResolvedValue({ runId: "r1", queued: false });
    const wait = vi.fn().mockResolvedValue({
      id: "r1",
      dutyId: "d1",
      status: "ok",
      startedAt: 0,
      trigger: "manual",
      inputs: {},
      outputs: { foo: "bar" },
      steps: [
        { stepId: "s1", label: "Open", kind: "browser", status: "ok", durationMs: 1, summary: "x" },
      ],
      report: "done",
      targetId: "t1",
    });
    registerDutyTools({
      api,
      store,
      runs: { start, wait } as never,
      credHas: async () => false,
      render: noRender,
      previewDir: async () => tmpdir(),
    });
    const result = await run("duty_run", { id: "d1", toStepId: "s1", keepOpen: true });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ toStepId: "s1", keepOpen: true, trigger: "manual" }),
    );
    expect(wait).toHaveBeenCalledWith("r1");
    expect(result).toMatchObject({
      status: "ok",
      outputs: { foo: "bar" },
      report: "done",
      targetId: "t1",
    });
    expect(result.steps).toHaveLength(1);
  });

  it("duty_run cancels the run and returns cancelled when the tool call is aborted", async () => {
    const { api, tools } = makeTools();
    const store = newStore();
    await store.saveDuty({
      id: "d1",
      name: "Book flight",
      summary: "books",
      status: "building",
      machine: "gateway",
      reportsTo: "owner",
      inputs: [],
      steps: [],
      triggers: [],
      updatedAt: 0,
    });
    const start = vi.fn().mockResolvedValue({ runId: "r1", queued: false });
    const wait = vi.fn(() => new Promise(() => {})); // never resolves
    const cancel = vi.fn().mockResolvedValue(true);
    registerDutyTools({
      api,
      store,
      runs: { start, wait, cancel } as never,
      credHas: async () => false,
      render: noRender,
      previewDir: async () => tmpdir(),
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const raw = await tools.get("duty_run")!.execute("c1", { id: "d1" }, controller.signal);
    const result = JSON.parse(raw.content[0]!.text);
    expect(result).toMatchObject({ ok: false, runId: "r1", status: "cancelled" });
    expect(cancel).toHaveBeenCalledWith("r1");
  });

  it("duty_save sets the duty's status to active", async () => {
    const { api, run } = makeTools();
    const store = newStore();
    registerDutyTools({
      api,
      store,
      runs: { start: vi.fn(), wait: vi.fn() } as never,
      credHas: async () => false,
      render: noRender,
      previewDir: async () => tmpdir(),
    });
    await run("duty_draft", { id: "d1", name: "Book flight", summary: "books" });
    const saved = await run("duty_save", { id: "d1" });
    expect(saved.duty.status).toBe("active");
    const stored = await store.getDuty("d1");
    expect(stored?.status).toBe("active");
  });

  it("records where a duty_run came from: a chat, the mail agent, or neither", async () => {
    const mailDuty = {
      id: "d1",
      name: "Book flight",
      summary: "books",
      status: "active" as const,
      machine: "gateway",
      reportsTo: "owner",
      inputs: [],
      steps: [],
      triggers: [],
      updatedAt: 0,
    };
    const wait = vi.fn().mockResolvedValue({
      id: "r1",
      dutyId: "d1",
      status: "ok",
      startedAt: 0,
      trigger: "chat",
      inputs: {},
      outputs: {},
      steps: [],
    });

    const started = async (ctx: OpenClawPluginToolContext) => {
      const { api, run } = makeTools(ctx);
      const store = newStore();
      await store.saveDuty(mailDuty);
      const start = vi.fn().mockResolvedValue({ runId: "r1", queued: false });
      registerDutyTools({
        api,
        store,
        runs: { start, wait } as never,
        credHas: async () => false,
        render: noRender,
        previewDir: async () => tmpdir(),
      });
      await run("duty_run", { id: "d1" });
      return { start, store };
    };

    const chat = await started({
      sessionKey: "agent:main:telegram:1",
      messageChannel: "telegram",
      agentId: "main",
      agentAccountId: "acct-1",
    });
    expect(chat.start.mock.calls[0]?.[0]?.origin).toEqual({
      kind: "chat",
      sessionKey: "agent:main:telegram:1",
      agentId: "main",
      channel: "telegram",
      accountId: "acct-1",
    });

    const mail = await started({ sessionKey: "hook:1", agentId: "duties-mail" });
    expect(mail.start.mock.calls[0]?.[0]?.origin).toMatchObject({ kind: "mail" });
    expect(await mail.store.getSettings()).toMatchObject({ lastMailDispatchDutyId: "d1" });

    const manual = await started({});
    expect(manual.start.mock.calls[0]?.[0]?.origin).toEqual({ kind: "manual" });
    expect(await manual.store.getSettings()).toEqual({});
  });

  it("refuses a duty_run that is missing a required mail input before creating the run", async () => {
    const { api, run } = makeTools();
    const store = newStore();
    await store.saveDuty({
      id: "d1",
      name: "Book by mail",
      summary: "books",
      status: "active",
      machine: "gateway",
      reportsTo: "owner",
      inputs: [{ name: "mail", source: "mail" }],
      steps: [],
      triggers: [{ kind: "mail", match: "subject:book" }],
      updatedAt: 0,
    });
    const start = vi.fn();
    registerDutyTools({
      api,
      store,
      runs: { start, wait: vi.fn() } as never,
      credHas: async () => false,
      render: noRender,
      previewDir: async () => tmpdir(),
    });
    expect(await run("duty_run", { id: "d1" })).toEqual({
      ok: false,
      errors: ['input "mail" is required'],
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("template_set reports validation errors verbatim and saves a valid template", async () => {
    const { api, run } = makeTools();
    const store = newStore();
    registerDutyTools({
      api,
      store,
      runs: { start: vi.fn(), wait: vi.fn() } as never,
      credHas: async () => false,
      render: noRender,
      previewDir: async () => tmpdir(),
    });
    const bad = await run("template_set", {
      template: { id: "Note", name: "", kind: "pdf", html: "<p>{{slot:who}}</p>", slots: [] },
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors).toContain("id must be a kebab-case slug");
    expect(bad.errors).toContain("name is required");
    expect(bad.errors).toContain('html uses undeclared slot "who"');

    const good = await run("template_set", {
      template: {
        id: "note",
        name: "Note",
        kind: "pdf",
        html: "<p>{{slot:who}}</p>",
        slots: [{ name: "who", kind: "text", description: "Who" }],
      },
    });
    expect(good.ok).toBe(true);
    expect((await run("template_list", {})).templates).toEqual([
      { id: "note", name: "Note", kind: "pdf", slots: ["who"] },
    ]);
    expect((await run("template_get", { id: "note" })).template.updatedAt).toBeGreaterThan(0);

    const brand = await run("brand_set", { brand: { name: "Vasudev", logoDataUrl: "nope" } });
    expect(brand.ok).toBe(false);
    expect(brand.errors).toContain("logoDataUrl must be a data:image/... URL");
    expect((await run("brand_set", { brand: { name: "Vasudev" } })).ok).toBe(true);
    expect((await run("brand_get", {})).brand.name).toBe("Vasudev");
  });

  it("template_preview renders placeholders into the preview directory and returns that path", async () => {
    const { api, run } = makeTools();
    const store = newStore();
    const previews = await mkdtemp(path.join(tmpdir(), "duties-previews-"));
    const written: string[] = [];
    registerDutyTools({
      api,
      store,
      runs: { start: vi.fn(), wait: vi.fn() } as never,
      credHas: async () => false,
      render: fakeRender(written),
      previewDir: async () => previews,
    });
    await store.saveTemplate({
      id: "note",
      name: "Note",
      kind: "pdf",
      html: "<p>{{slot:who}}</p>",
      slots: [{ name: "who", kind: "text", description: "Who" }],
      updatedAt: 1,
    });

    const preview = await run("template_preview", { id: "note" });
    expect(path.dirname(preview.path)).toBe(previews);
    expect(path.basename(preview.path)).toMatch(/^note-\d+\.pdf$/u);
    expect(written).toEqual([preview.path]);

    expect((await run("template_preview", { id: "missing" }).catch((e: Error) => e)).message).toBe(
      'no template "missing"',
    );
  });
});
