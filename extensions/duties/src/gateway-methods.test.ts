import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { RenderAdapter } from "./adapters/render.js";
import type { Duty } from "./duty.js";
import { registerDutiesGatewayMethods } from "./gateway-methods.js";
import { DutyStore } from "./store.js";

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

type Handler = (ctx: {
  params: Record<string, unknown>;
  respond: (ok: boolean, result?: unknown, error?: unknown) => void;
}) => Promise<void>;

type EmitFn = (name: "changed" | "run", payload: Record<string, unknown>) => void;

function harness(params?: {
  emit?: Mock<EmitFn>;
  runs?: {
    start: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    waitFor: ReturnType<typeof vi.fn>;
  };
  blob?: { bytes: Uint8Array; metadata: { contentType: string } };
  config?: OpenClawConfig;
  render?: RenderAdapter;
  previewDir?: string;
  notifyOwner?: (text: string) => Promise<void>;
}) {
  const methods = new Map<string, { handler: Handler; scope: string }>();
  const api = {
    registerGatewayMethod: (name: string, handler: never, opts: { scope: string }) =>
      methods.set(name, { handler, scope: opts.scope }),
    config: params?.config ?? {},
    // SAFETY: the Gateway methods under test only touch `registerGatewayMethod` and `config`.
  } as never;
  const store = new DutyStore({
    duties: memoryKeyed() as never,
    runs: memoryKeyed() as never,
    creds: memoryKeyed() as never,
    templates: memoryKeyed() as never,
    brands: memoryKeyed() as never,
    settings: memoryKeyed() as never,
  });
  const emit = params?.emit ?? vi.fn<EmitFn>();
  const runs = params?.runs ?? { start: vi.fn(), cancel: vi.fn(), waitFor: vi.fn() };
  const creds = {
    set: vi.fn<(key: string, value: string) => Promise<void>>(async () => {}),
    delete: vi.fn<(key: string) => Promise<boolean>>(async () => true),
    has: vi.fn<(key: string) => Promise<boolean>>(async (key) => key === "amigos.password"),
  };
  registerDutiesGatewayMethods({
    api,
    store,
    runs: runs as never,
    emit,
    creds,
    evidence: () => ({ lookup: async () => params?.blob }),
    render: params?.render ?? {
      toPdf: async () => {
        throw new Error("render not expected");
      },
    },
    previewDir: async () => params?.previewDir ?? tmpdir(),
    ...(params?.notifyOwner ? { notifyOwner: params.notifyOwner } : {}),
  });

  const call = async (name: string, callParams: Record<string, unknown>) =>
    new Promise<{ ok: boolean; result?: unknown; error?: unknown }>((resolve) =>
      methods.get(name)!.handler({
        params: callParams,
        respond: (ok, result, error) => resolve({ ok, result, error }),
      }),
    );

  return { methods, store, emit, runs, creds, call };
}

const baseDuty = {
  id: "d1",
  name: "D",
  summary: "",
  status: "building",
  machine: "gateway",
  reportsTo: "owner",
  inputs: [],
  steps: [],
  triggers: [{ kind: "manual" }],
  updatedAt: 0,
} satisfies Duty;

describe("duties gateway methods", () => {
  it("saves a valid duty, lists it, and rejects an invalid one", async () => {
    const { methods, emit, call } = harness();

    expect(methods.get("duties.delete")?.scope).toBe("operator.admin");

    expect((await call("duties.save", { duty: baseDuty })).ok).toBe(true);
    expect(emit).toHaveBeenCalledWith("changed", { dutyId: "d1" });
    expect(((await call("duties.list", {})).result as { duties: unknown[] }).duties).toHaveLength(
      1,
    );

    const bad = await call("duties.save", { duty: { ...baseDuty, status: "draft" } });
    expect(bad.ok).toBe(false);
  });

  it("still responds ok:true for duties.save when the emitter throws", async () => {
    const emit = vi.fn<EmitFn>(() => {
      throw new Error("boom");
    });
    const { call } = harness({ emit });

    const result = await call("duties.save", { duty: baseDuty });

    expect(result.ok).toBe(true);
    expect(emit).toHaveBeenCalledOnce();
  });

  it("duties.delete returns ok:false and does not emit when nothing was deleted", async () => {
    const { emit, call } = harness();

    const result = await call("duties.delete", { id: "does-not-exist" });

    expect(result).toEqual({ ok: true, result: { ok: false }, error: undefined });
    expect(emit).not.toHaveBeenCalled();
  });

  it("duties.delete returns ok:true and emits changed when a duty was deleted", async () => {
    const { emit, call } = harness();
    await call("duties.save", { duty: baseDuty });
    emit.mockClear();

    const result = await call("duties.delete", { id: "d1" });

    expect(result).toEqual({ ok: true, result: { ok: true }, error: undefined });
    expect(emit).toHaveBeenCalledWith("changed", { dutyId: "d1" });
  });

  it("duties.runs.recent lists newest-first across duties, clamped between 1 and 100", async () => {
    const { call, store } = harness();
    await store.saveDuty({ ...baseDuty, id: "d1" });
    await store.createRun({
      id: "r1",
      dutyId: "d1",
      status: "ok",
      startedAt: 1,
      trigger: "manual",
      inputs: {},
      outputs: {},
      steps: [],
    });
    await store.createRun({
      id: "r2",
      dutyId: "d1",
      status: "failed",
      startedAt: 2,
      trigger: "manual",
      inputs: {},
      outputs: {},
      steps: [],
    });

    const defaultLimit = await call("duties.runs.recent", {});
    expect(defaultLimit.ok).toBe(true);
    expect((defaultLimit.result as { runs: Array<{ id: string }> }).runs.map((r) => r.id)).toEqual([
      "r2",
      "r1",
    ]);

    const clamped = await call("duties.runs.recent", { limit: 1 });
    expect((clamped.result as { runs: Array<{ id: string }> }).runs.map((r) => r.id)).toEqual([
      "r2",
    ]);

    const rejected = await call("duties.runs.recent", { limit: "nope" });
    expect(rejected.ok).toBe(false);
  });

  it("stores, lists and deletes a login without ever echoing its value", async () => {
    const { call, creds, methods } = harness();

    expect(methods.get("duties.cred.set")?.scope).toBe("operator.admin");
    expect(methods.get("duties.cred.list")?.scope).toBe("operator.read");
    expect(methods.get("duties.cred.delete")?.scope).toBe("operator.admin");

    const saved = await call("duties.cred.set", { key: "amigos.password", value: "s3cret" });
    expect(saved).toEqual({ ok: true, result: { ok: true }, error: undefined });
    expect(JSON.stringify(saved)).not.toContain("s3cret");
    expect(creds.set).toHaveBeenCalledWith("amigos.password", "s3cret");

    const empty = await call("duties.cred.set", { key: "amigos.password", value: "" });
    expect(empty.ok).toBe(false);

    const listed = await call("duties.cred.list", {});
    expect((listed.result as { keys: string[] }).keys).toEqual(["amigos.password"]);
    expect(JSON.stringify(listed)).not.toContain("s3cret");

    const deleted = await call("duties.cred.delete", { key: "amigos.password" });
    expect(deleted).toEqual({ ok: true, result: { ok: true }, error: undefined });
    expect(creds.delete).toHaveBeenCalledWith("amigos.password");
    expect((await call("duties.cred.list", {})).result).toMatchObject({ keys: [] });
  });

  it("serves a step's screenshot as base64 and refuses a step that has none", async () => {
    const { call, store, methods } = harness({
      blob: { bytes: new Uint8Array([1, 2, 3]), metadata: { contentType: "image/png" } },
    });
    expect(methods.get("duties.run.evidence")?.scope).toBe("operator.read");
    await store.createRun({
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
        { stepId: "s2", label: "Ask", kind: "ask", status: "ok", durationMs: 1, summary: "y" },
      ],
    });

    const shot = await call("duties.run.evidence", { runId: "r1", stepId: "s1" });
    expect(shot.result).toEqual({ contentType: "image/png", base64: "AQID" });

    expect((await call("duties.run.evidence", { runId: "r1", stepId: "s2" })).ok).toBe(false);
    expect((await call("duties.run.evidence", { runId: "nope", stepId: "s1" })).ok).toBe(false);
  });

  it("rejects duties.status transitions to building and runs/cancels via the RunManager", async () => {
    const start = vi.fn().mockResolvedValue({ runId: "r1", queued: false });
    const cancel = vi.fn().mockResolvedValue(true);
    const { emit, call } = harness({ runs: { start, cancel } });

    const duty = { ...baseDuty, status: "active" };
    await call("duties.save", { duty });

    const badStatus = await call("duties.status", { id: "d1", status: "building" });
    expect(badStatus.ok).toBe(false);

    const paused = await call("duties.status", { id: "d1", status: "paused" });
    expect(paused.ok).toBe(true);
    expect(emit).toHaveBeenCalledWith("changed", { dutyId: "d1" });

    const run = await call("duties.run", { id: "d1" });
    expect(run.ok).toBe(true);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        duty: expect.objectContaining({ id: "d1" }),
        trigger: "manual",
        // A UI or CLI run records an origin of its own rather than none, so `run.origin` is always
        // present and means what the spec says it means.
        origin: { kind: "manual" },
      }),
    );

    const cancelled = await call("duties.run.cancel", { runId: "r1" });
    expect(cancelled).toEqual({ ok: true, result: { ok: true }, error: undefined });
    expect(cancel).toHaveBeenCalledWith("r1");

    const missingRun = await call("duties.run.get", { runId: "does-not-exist" });
    expect(missingRun.ok).toBe(false);
  });

  // Off by default: the agent repairing a Duty the moment it breaks is wanted behaviour, so the
  // gate is something an owner turns on, not something they have to turn off.
  describe("edits to an active Duty", () => {
    const activeDuty = { ...baseDuty, status: "active" as const, name: "Book flight" };
    const newSteps = [
      {
        id: "s1",
        kind: "ask",
        label: "Approve?",
        params: { question: "Go?", options: ["Yes", "No"] },
      },
    ];

    it("applies directly when approval is not required", async () => {
      const { call, store } = harness();
      await store.saveDuty(activeDuty);

      const saved = await call("duties.steps", { id: "d1", steps: newSteps });

      expect(saved.result).toMatchObject({ ok: true });
      expect((await store.getDuty("d1"))?.steps).toHaveLength(1);
      expect((await store.getDuty("d1"))?.pendingChange).toBeUndefined();
    });

    it("parks the change, leaves the live Duty running, and tells the owner", async () => {
      const notifyOwner = vi.fn(async () => {});
      const { call, store } = harness({ notifyOwner });
      await store.saveDuty(activeDuty);
      await store.updateSettings({ requireApprovalForEdits: true });

      const parked = await call("duties.steps", { id: "d1", steps: newSteps });

      expect(parked.result).toMatchObject({ ok: true, pending: true });
      const changeId = (parked.result as { changeId: string }).changeId;
      expect(changeId).toMatch(/^chg_/u);
      // The live Duty is untouched — this is the whole point: it keeps running as it was.
      const live = await store.getDuty("d1");
      expect(live?.steps).toEqual([]);
      expect(live?.pendingChange?.id).toBe(changeId);
      expect(live?.pendingChange?.summary).toContain("1 step added");
      expect(notifyOwner).toHaveBeenCalledOnce();
      expect(notifyOwner.mock.calls[0]?.[0]).toContain("Book flight");
      expect(notifyOwner.mock.calls[0]?.[0]).toContain("duties.change.apply");

      const waiting = await call("duties.change.get", { id: "d1" });
      expect(waiting.result).toMatchObject({ pending: true });
    });

    it("applies a parked change on the owner's word, and discards it on the owner's word", async () => {
      const { call, store, methods } = harness();
      expect(methods.get("duties.change.apply")?.scope).toBe("operator.admin");
      expect(methods.get("duties.change.discard")?.scope).toBe("operator.admin");
      expect(methods.get("duties.change.get")?.scope).toBe("operator.read");
      await store.saveDuty(activeDuty);
      await store.updateSettings({ requireApprovalForEdits: true });
      await call("duties.steps", { id: "d1", steps: newSteps });

      const applied = await call("duties.change.apply", { id: "d1" });
      expect(applied.ok).toBe(true);
      const after = await store.getDuty("d1");
      expect(after?.steps).toHaveLength(1);
      expect(after?.pendingChange).toBeUndefined();
      // Nothing is waiting any more.
      expect((await call("duties.change.apply", { id: "d1" })).ok).toBe(false);

      // Discard leaves the live Duty exactly as it was.
      await call("duties.steps", { id: "d1", steps: [] });
      expect((await store.getDuty("d1"))?.pendingChange).toBeTruthy();
      const discarded = await call("duties.change.discard", { id: "d1" });
      expect(discarded.ok).toBe(true);
      const unchanged = await store.getDuty("d1");
      expect(unchanged?.steps).toHaveLength(1);
      expect(unchanged?.pendingChange).toBeUndefined();
    });

    it("replaces a pending change with the newest one, and refuses to apply a superseded id", async () => {
      const { call, store } = harness();
      await store.saveDuty(activeDuty);
      await store.updateSettings({ requireApprovalForEdits: true });

      const first = await call("duties.steps", { id: "d1", steps: newSteps });
      const second = await call("duties.steps", { id: "d1", steps: [] });
      const firstId = (first.result as { changeId: string }).changeId;
      const secondId = (second.result as { changeId: string }).changeId;
      expect(secondId).not.toBe(firstId);
      expect((await store.getDuty("d1"))?.pendingChange?.id).toBe(secondId);

      const stale = await call("duties.change.apply", { id: "d1", changeId: firstId });
      expect(stale.ok).toBe(false);
      expect(stale.error).toMatchObject({
        message: "that change has been superseded by a newer one",
      });
    });

    it("never gates a building Duty, or pausing an active one", async () => {
      const { call, store } = harness();
      await store.saveDuty({ ...baseDuty, status: "building" });
      await store.updateSettings({ requireApprovalForEdits: true });

      const built = await call("duties.steps", { id: "d1", steps: newSteps });
      expect(built.result).toMatchObject({ ok: true });
      expect(built.result).not.toMatchObject({ pending: true });
      expect((await store.getDuty("d1"))?.steps).toHaveLength(1);

      // Making it active, then pausing it, are status moves rather than edits to what it does.
      await call("duties.status", { id: "d1", status: "active" });
      const paused = await call("duties.status", { id: "d1", status: "paused" });
      expect(paused.ok).toBe(true);
      expect((await store.getDuty("d1"))?.status).toBe("paused");
      expect((await store.getDuty("d1"))?.pendingChange).toBeUndefined();
    });

    it("gates duties.draft and duties.save on an active Duty too", async () => {
      const { call, store } = harness();
      await store.saveDuty(activeDuty);
      await store.updateSettings({ requireApprovalForEdits: true });

      const drafted = await call("duties.draft", { id: "d1", name: "Renamed", summary: "s" });
      expect(drafted.result).toMatchObject({ pending: true });
      expect((await store.getDuty("d1"))?.name).toBe("Book flight");

      const saved = await call("duties.save", { duty: { ...activeDuty, summary: "different" } });
      expect(saved.result).toMatchObject({ pending: true });
      expect((await store.getDuty("d1"))?.summary).toBe("");
    });
  });

  it("duties.settings.set toggles requireApprovalForEdits without touching the owner", async () => {
    const { call, store } = harness();
    await call("duties.settings.set", { owner: { channel: "telegram", target: "111" } });

    const on = await call("duties.settings.set", { requireApprovalForEdits: true });
    expect(on.ok).toBe(true);
    expect((await store.getSettings()).requireApprovalForEdits).toBe(true);
    expect((await store.getSettings()).owner).toEqual({ channel: "telegram", target: "111" });

    await call("duties.settings.set", { requireApprovalForEdits: false });
    expect((await store.getSettings()).requireApprovalForEdits).toBe(false);
    expect((await call("duties.settings.set", { requireApprovalForEdits: "yes" })).ok).toBe(false);
  });

  it("duties.settings.set is admin-only and needs a non-empty channel and target", async () => {
    const { call, methods } = harness();

    expect(methods.get("duties.settings.set")?.scope).toBe("operator.admin");
    expect(methods.get("duties.settings.get")?.scope).toBe("operator.read");

    expect((await call("duties.settings.set", {})).ok).toBe(false);
    expect((await call("duties.settings.set", { owner: { channel: "telegram" } })).ok).toBe(false);
    expect((await call("duties.settings.set", { owner: { channel: " ", target: "111" } })).ok).toBe(
      false,
    );

    const saved = await call("duties.settings.set", {
      owner: { channel: "telegram", target: " 111 " },
    });
    expect(saved.ok).toBe(true);
    expect((await call("duties.settings.get", {})).result).toEqual({
      settings: { owner: { channel: "telegram", target: "111" } },
    });
  });

  it("duties.run.file serves a document this run recorded and refuses any other step", async () => {
    const { call, store, methods } = harness();
    const dir = await mkdtemp(path.join(tmpdir(), "duties-run-file-"));
    const filePath = path.join(dir, "p1.pdf");
    await writeFile(filePath, "%PDF-1.4");
    expect(methods.get("duties.run.file")?.scope).toBe("operator.read");
    await store.createRun({
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
          stepId: "p1",
          name: "p1.pdf",
          path: filePath,
          bytes: 8,
          contentType: "application/pdf",
        },
      ],
    });

    const served = await call("duties.run.file", { runId: "r1", stepId: "p1" });
    expect(served.result).toEqual({
      name: "p1.pdf",
      contentType: "application/pdf",
      base64: Buffer.from("%PDF-1.4").toString("base64"),
    });

    expect((await call("duties.run.file", { runId: "r1", stepId: "nope" })).ok).toBe(false);
    expect((await call("duties.run.file", { runId: "nope", stepId: "p1" })).ok).toBe(false);
  });

  it("duties.run.file caps the read and reports a swept document instead of a raw fs error", async () => {
    const { call, store } = harness();
    const dir = await mkdtemp(path.join(tmpdir(), "duties-run-file-"));
    const big = path.join(dir, "big.pdf");
    await writeFile(big, Buffer.alloc(4 * 1024 * 1024 + 1));
    const gone = path.join(dir, "gone.pdf");
    const file = (stepId: string, filePath: string) => ({
      stepId,
      name: path.basename(filePath),
      path: filePath,
      bytes: 0,
      contentType: "application/pdf",
    });
    await store.createRun({
      id: "r1",
      dutyId: "d1",
      status: "ok",
      startedAt: 1,
      trigger: "manual",
      inputs: {},
      outputs: {},
      steps: [],
      files: [file("big", big), file("gone", gone)],
    });

    // base64 inflates by a third and the whole document goes out in one RPC frame, so the size is
    // checked before the read rather than after.
    const tooBig = await call("duties.run.file", { runId: "r1", stepId: "big" });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.error).toMatchObject({
      message: `file too large to return (${4 * 1024 * 1024 + 1} bytes)`,
    });

    // The 30-day sweep removes the run directory long before the run row expires; the owner should
    // be told that, not handed an absolute state path in an ENOENT string.
    const swept = await call("duties.run.file", { runId: "r1", stepId: "gone" });
    expect(swept.ok).toBe(false);
    expect(swept.error).toMatchObject({ message: "that file is no longer stored" });
    expect(JSON.stringify(swept)).not.toContain(dir);
  });

  it("duties.template.preview returns the pdf and the png of the same render, both write-scoped", async () => {
    const previews = await mkdtemp(path.join(tmpdir(), "duties-preview-"));
    const { call, store, methods } = harness({
      previewDir: previews,
      render: {
        toPdf: async (_html, dest) => {
          await writeFile(dest, "%PDF-preview");
          const previewPath = `${dest.slice(0, -".pdf".length)}.png`;
          await writeFile(previewPath, "PNG-preview");
          return { bytes: 12, previewPath };
        },
      },
    });
    // Both render methods drive the managed browser and write a file: neither is a read.
    expect(methods.get("duties.template.preview")?.scope).toBe("operator.write");
    expect(methods.get("duties.template.render")?.scope).toBe("operator.write");
    expect(methods.get("duties.template.delete")?.scope).toBe("operator.admin");
    await store.saveTemplate({
      id: "note",
      name: "Note",
      kind: "pdf",
      html: "<p>{{slot:who}}</p>",
      slots: [{ name: "who", kind: "text", description: "Who" }],
      updatedAt: 1,
    });

    const preview = await call("duties.template.preview", { id: "note" });
    expect(preview.result).toEqual({
      pdf: {
        contentType: "application/pdf",
        base64: Buffer.from("%PDF-preview").toString("base64"),
      },
      preview: { contentType: "image/png", base64: Buffer.from("PNG-preview").toString("base64") },
    });
    expect((await call("duties.template.preview", { id: "missing" })).ok).toBe(false);
  });

  it("duties.template.preview caps its base64 payload exactly like duties.run.file", async () => {
    const previews = await mkdtemp(path.join(tmpdir(), "duties-preview-big-"));
    const oversize = 4 * 1024 * 1024 + 1;
    const { call, store } = harness({
      previewDir: previews,
      render: {
        toPdf: async (_html, dest) => {
          await writeFile(dest, Buffer.alloc(oversize));
          return { bytes: oversize };
        },
      },
    });
    await store.saveTemplate({
      id: "note",
      name: "Note",
      kind: "pdf",
      html: "<p>{{slot:who}}</p>",
      slots: [{ name: "who", kind: "text", description: "Who" }],
      updatedAt: 1,
    });
    const tooBig = await call("duties.template.preview", { id: "note" });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.error).toMatchObject({
      message: `file too large to return (${oversize} bytes)`,
    });
  });

  it("duties.run.file kind:preview answers the png the render adapter saved beside the document", async () => {
    const { call, store } = harness();
    const dir = await mkdtemp(path.join(tmpdir(), "duties-run-preview-"));
    const pdf = path.join(dir, "quote.pdf");
    const png = path.join(dir, "quote.png");
    await writeFile(pdf, "%PDF-1.4");
    await writeFile(png, "PNG-BYTES");
    await store.createRun({
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
          stepId: "p1",
          name: "quote.pdf",
          path: pdf,
          bytes: 8,
          contentType: "application/pdf",
          previewPath: png,
        },
        { stepId: "p2", name: "plain.pdf", path: pdf, bytes: 8, contentType: "application/pdf" },
      ],
    });

    const preview = await call("duties.run.file", { runId: "r1", stepId: "p1", kind: "preview" });
    expect(preview.result).toEqual({
      name: "quote.png",
      contentType: "image/png",
      base64: Buffer.from("PNG-BYTES").toString("base64"),
    });
    // A step whose render could not be screenshotted says so rather than answering the PDF.
    const none = await call("duties.run.file", { runId: "r1", stepId: "p2", kind: "preview" });
    expect(none.ok).toBe(false);
    expect(none.error).toMatchObject({ message: "no preview image for that step" });
    expect((await call("duties.run.file", { runId: "r1", stepId: "p1", kind: "zip" })).ok).toBe(
      false,
    );
  });

  it("duties.mail.status reports each missing piece of the Gmail path without leaking the address", async () => {
    const bare = harness();
    expect((await bare.call("duties.mail.status", {})).result).toEqual({
      hooksEnabled: false,
      gmailAccountSet: false,
      mappingPresent: false,
      agentPresent: false,
      // Rendering is a prerequisite too: on a default install the managed browser refuses the
      // plugin's own loopback render page, so every `template` step fails.
      renderAllowed: false,
    });

    const wired = harness({
      config: {
        hooks: {
          enabled: true,
          gmail: { account: "owner@example.com" },
          mappings: [{ agentId: "duties-mail" }],
        },
        agents: { entries: { "duties-mail": {} } },
        browser: { ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } },
      },
    });
    await wired.store.updateSettings({ lastMailDispatchAt: 5, lastMailDispatchDutyId: "d1" });
    const status = await wired.call("duties.mail.status", {});
    expect(status.result).toEqual({
      hooksEnabled: true,
      gmailAccountSet: true,
      mappingPresent: true,
      agentPresent: true,
      renderAllowed: true,
      lastDispatchAt: 5,
      lastDispatchDutyId: "d1",
    });
    expect(JSON.stringify(status)).not.toContain("owner@example.com");
  });

  // These four methods exist because the tools became clients of them: the tools must own no
  // runtime state, since the host loads a second copy of this plugin in tool-discovery mode.
  it("duties.run.wait answers with the run as it stands when the budget elapses", async () => {
    const waitFor = vi.fn(async (_runId: string, timeoutMs: number) => {
      expect(timeoutMs).toBe(50);
      return { id: "r1", status: "needs_input" };
    });
    const { methods, call } = harness({
      runs: { start: vi.fn(), cancel: vi.fn(), waitFor: waitFor as never },
    });
    expect(methods.get("duties.run.wait")?.scope).toBe("operator.read");
    const waited = await call("duties.run.wait", { runId: "r1", timeoutMs: 50 });
    // A run that is still going comes back as-is; the caller decides whether to poll again.
    expect(waited).toMatchObject({ ok: true, result: { run: { status: "needs_input" } } });

    const missing = await harness({
      runs: { start: vi.fn(), cancel: vi.fn(), waitFor: vi.fn(async () => undefined) as never },
    }).call("duties.run.wait", { runId: "gone" });
    expect(missing.ok).toBe(false);
  });

  it("duties.template.set reports validation errors verbatim and saves a valid template", async () => {
    const { methods, store, call } = harness();
    expect(methods.get("duties.template.set")?.scope).toBe("operator.write");
    const bad = await call("duties.template.set", {
      template: { id: "t1", name: "T", kind: "pdf", html: "<p>{{slot:missing}}</p>", slots: [] },
    });
    expect(bad.ok).toBe(true);
    expect((bad.result as { ok: boolean; errors: string[] }).ok).toBe(false);
    expect((bad.result as { errors: string[] }).errors.join(" ")).toContain("missing");

    const good = await call("duties.template.set", {
      template: {
        id: "t1",
        name: "T",
        kind: "pdf",
        html: "<p>{{slot:who}}</p>",
        slots: [{ name: "who", kind: "text", description: "who it is for" }],
      },
    });
    expect(good.result).toMatchObject({ ok: true });
    expect(await store.getTemplate("t1")).toMatchObject({ id: "t1", kind: "pdf" });
  });

  it("duties.cred.has answers whether a key is stored and never a value", async () => {
    const { methods, creds, call } = harness();
    expect(methods.get("duties.cred.has")?.scope).toBe("operator.read");
    expect(await call("duties.cred.has", { key: "amigos.password" })).toMatchObject({
      ok: true,
      result: { stored: true },
    });
    expect(await call("duties.cred.has", { key: "nope" })).toMatchObject({
      ok: true,
      result: { stored: false },
    });
    // The read path must never be able to return the secret itself.
    expect(creds.has).toHaveBeenCalledWith("amigos.password");
    expect(JSON.stringify(await call("duties.cred.has", { key: "amigos.password" }))).not.toContain(
      "value",
    );
  });

  it("duties.draft keeps existing steps and duties.steps validates the whole duty", async () => {
    const { store, call } = harness();
    const drafted = await call("duties.draft", { id: "d9", name: "Nine", summary: "s" });
    expect(drafted).toMatchObject({ ok: true, result: { duty: { status: "building" } } });
    // Defaults come from the Duty shape's owner, not from whichever caller drafted it.
    expect((drafted.result as { duty: Duty }).duty.machine).toBe("gateway");

    const bad = await call("duties.steps", {
      id: "d9",
      steps: [{ id: "s1", kind: "browser", label: "#btnlogin", params: {} }],
    });
    expect((bad.result as { ok: boolean; errors: string[] }).ok).toBe(false);
    const good = await call("duties.steps", {
      id: "d9",
      steps: [
        {
          id: "s1",
          kind: "browser",
          label: "Open it",
          params: { action: "open", url: "https://x" },
        },
      ],
    });
    expect((good.result as { ok: boolean }).ok).toBe(true);
    expect((await store.getDuty("d9"))?.steps).toHaveLength(1);
    // A header draft after steps exist must not wipe them.
    await call("duties.draft", { id: "d9", name: "Nine", summary: "changed" });
    expect((await store.getDuty("d9"))?.steps).toHaveLength(1);
  });

  it("duties.run validates the origin it is given and refuses a missing mail input", async () => {
    const start = vi.fn(async () => ({ runId: "r1", queued: false }));
    const { store, call } = harness({
      runs: { start: start as never, cancel: vi.fn(), waitFor: vi.fn() },
    });
    await store.saveDuty({
      ...baseDuty,
      id: "d8",
      inputs: [{ name: "mail", source: "mail" }],
      steps: [
        {
          id: "s1",
          kind: "browser",
          label: "Open it",
          params: { action: "open", url: "https://x" },
        },
      ],
    } as Duty);

    // The origin arrives as ordinary params, so an unknown kind is rejected rather than recorded.
    const badOrigin = await call("duties.run", {
      id: "d8",
      inputs: { mail: { from: "a@b.c", subject: "s", body: "b" } },
      origin: { kind: "spoofed" },
    });
    expect(badOrigin.ok).toBe(false);

    const missingInput = await call("duties.run", { id: "d8", inputs: {} });
    expect((missingInput.result as { ok: boolean }).ok).toBe(false);
    expect(start).not.toHaveBeenCalled();

    await call("duties.run", {
      id: "d8",
      inputs: { mail: { from: "a@b.c", subject: "s", body: "b" } },
      origin: {
        kind: "mail",
        sessionKey: "hook:gmail:1",
        agentId: "duties-mail",
        extra: "dropped",
      },
    });
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      trigger: "mail",
      origin: { kind: "mail", sessionKey: "hook:gmail:1", agentId: "duties-mail" },
    });
    expect(start.mock.calls[0]?.[0]?.origin).not.toHaveProperty("extra");
    // A mail dispatch is recorded for the mail health readout.
    expect((await store.getSettings()).lastMailDispatchDutyId).toBe("d8");
  });
});
