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

describe("duties gateway methods", () => {
  it("saves a valid duty, lists it, and rejects an invalid one", async () => {
    const methods = new Map<
      string,
      {
        handler: (ctx: {
          params: Record<string, unknown>;
          respond: (ok: boolean, result?: unknown, error?: unknown) => void;
        }) => Promise<void>;
        scope: string;
      }
    >();
    const api = {
      registerGatewayMethod: (name: string, handler: never, opts: { scope: string }) =>
        methods.set(name, { handler, scope: opts.scope }),
    } as never;
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    const emit = vi.fn();
    registerDutiesGatewayMethods({
      api,
      store,
      runs: { start: vi.fn(), cancel: vi.fn() } as never,
      emit,
    });

    expect(methods.get("duties.delete")?.scope).toBe("operator.admin");

    const call = async (name: string, params: Record<string, unknown>) =>
      new Promise<{ ok: boolean; result?: unknown; error?: unknown }>((resolve) =>
        methods.get(name)!.handler({
          params,
          respond: (ok, result, error) => resolve({ ok, result, error }),
        }),
      );

    const duty = {
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
    expect((await call("duties.save", { duty })).ok).toBe(true);
    expect(emit).toHaveBeenCalledWith("changed", { dutyId: "d1" });
    expect(((await call("duties.list", {})).result as { duties: unknown[] }).duties).toHaveLength(
      1,
    );

    const bad = await call("duties.save", { duty: { ...duty, status: "draft" } });
    expect(bad.ok).toBe(false);
  });

  it("rejects duties.status transitions to building and runs/cancels via the RunManager", async () => {
    const methods = new Map<
      string,
      {
        handler: (ctx: {
          params: Record<string, unknown>;
          respond: (ok: boolean, result?: unknown, error?: unknown) => void;
        }) => Promise<void>;
        scope: string;
      }
    >();
    const api = {
      registerGatewayMethod: (name: string, handler: never, opts: { scope: string }) =>
        methods.set(name, { handler, scope: opts.scope }),
    } as never;
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    const start = vi.fn().mockResolvedValue({ runId: "r1", queued: false });
    const cancel = vi.fn().mockResolvedValue(true);
    const emit = vi.fn();
    registerDutiesGatewayMethods({ api, store, runs: { start, cancel } as never, emit });

    const call = async (name: string, params: Record<string, unknown>) =>
      new Promise<{ ok: boolean; result?: unknown; error?: unknown }>((resolve) =>
        methods.get(name)!.handler({
          params,
          respond: (ok, result, error) => resolve({ ok, result, error }),
        }),
      );

    const duty = {
      id: "d1",
      name: "D",
      summary: "",
      status: "active",
      machine: "gateway",
      reportsTo: "owner",
      inputs: [],
      steps: [],
      triggers: [{ kind: "manual" }],
      updatedAt: 0,
    };
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
