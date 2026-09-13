import { describe, expect, it, vi } from "vitest";
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

function harness(params?: {
  emit?: (name: "changed" | "run", payload: Record<string, unknown>) => void;
  runs?: { start: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
  blob?: { bytes: Uint8Array; metadata: { contentType: string } };
}) {
  const methods = new Map<string, { handler: Handler; scope: string }>();
  const api = {
    registerGatewayMethod: (name: string, handler: never, opts: { scope: string }) =>
      methods.set(name, { handler, scope: opts.scope }),
  } as never;
  const store = new DutyStore({
    duties: memoryKeyed() as never,
    runs: memoryKeyed() as never,
    creds: memoryKeyed() as never,
  });
  const emit = params?.emit ?? vi.fn();
  const runs = params?.runs ?? { start: vi.fn(), cancel: vi.fn() };
  const creds = {
    set: vi.fn<(key: string, value: string) => Promise<void>>(async () => {}),
    delete: vi.fn<(key: string) => Promise<boolean>>(async () => true),
  };
  registerDutiesGatewayMethods({
    api,
    store,
    runs: runs as never,
    emit,
    creds,
    evidence: () => ({ lookup: async () => params?.blob }),
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
};

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
    const emit = vi.fn(() => {
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
      expect.objectContaining({ duty: expect.objectContaining({ id: "d1" }), trigger: "manual" }),
    );

    const cancelled = await call("duties.run.cancel", { runId: "r1" });
    expect(cancelled).toEqual({ ok: true, result: { ok: true }, error: undefined });
    expect(cancel).toHaveBeenCalledWith("r1");

    const missingRun = await call("duties.run.get", { runId: "does-not-exist" });
    expect(missingRun.ok).toBe(false);
  });
});
