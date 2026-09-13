import { describe, expect, it, vi } from "vitest";
import type { Duty } from "./duty.js";
import { RunManager } from "./run-service.js";
import type { RunnerDeps } from "./runner.js";
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

/** Same as memoryKeyed(), but every op yields a macrotask first (no atomic `update`), so a
 *  fire-and-forget read-modify-write against this store can actually interleave and drop a
 *  concurrent write — the shape RunManager's evidence-append serialization must survive. */
function memoryKeyedAsync<T>() {
  const m = new Map<string, T>();
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    register: async (k: string, v: T) => {
      await tick();
      m.set(k, v);
    },
    lookup: async (k: string) => {
      await tick();
      return m.get(k);
    },
    entries: async () => {
      await tick();
      return [...m].map(([key, value]) => ({ key, value }));
    },
    delete: async (k: string) => {
      await tick();
      return m.delete(k);
    },
  };
}

async function flushMacrotasks(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await new Promise((r) => setTimeout(r, 0));
}

const duty = (id: string, exclusive = false): Duty => ({
  id,
  name: id,
  summary: "",
  status: "active",
  machine: "gateway",
  reportsTo: "owner",
  exclusive,
  inputs: [],
  triggers: [{ kind: "manual" }],
  updatedAt: 1,
  steps: [
    { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
  ],
});

/** A duty with three fast steps, used to prove evidence appends are serialized. */
const multiStepDuty = (id: string): Duty => ({
  id,
  name: id,
  summary: "",
  status: "active",
  machine: "gateway",
  reportsTo: "owner",
  inputs: [],
  triggers: [{ kind: "manual" }],
  updatedAt: 1,
  steps: [
    { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
    {
      id: "s2",
      kind: "browser",
      label: "Click",
      params: { action: "click" },
      target: { css: "#a" },
    },
    { id: "s3", kind: "browser", label: "Press", params: { action: "press", key: "Enter" } },
  ],
});

function deps(delayMs: number, openTracker?: { current: number; max: number }): RunnerDeps {
  return {
    browser: {
      open: async () => {
        if (openTracker) {
          openTracker.current += 1;
          openTracker.max = Math.max(openTracker.max, openTracker.current);
        }
        await new Promise((r) => setTimeout(r, delayMs));
        if (openTracker) openTracker.current -= 1;
        return { targetId: "t" };
      },
      navigate: async () => {},
      isVisible: async () => true,
      click: async () => {},
      fill: async () => {},
      select: async () => {},
      press: async () => {},
      waitFor: async () => {},
      text: async () => "",
      url: async () => "",
      evaluate: async () => null,
      screenshot: async () => undefined,
      close: async () => {},
    },
    ai: { extract: async () => ({}) },
    ask: { ask: async () => ({ status: "answered", answer: "" }) },
    cred: async () => "",
  };
}

describe("RunManager", () => {
  it("runs two different duties in parallel, overlapping, and records ok runs", async () => {
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    const emit = vi.fn();
    const openTracker = { current: 0, max: 0 };
    const mgr = new RunManager({ store, deps: () => deps(30, openTracker), emit });
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      mgr.start({ duty: duty("a"), inputs: {}, trigger: "manual" }),
      mgr.start({ duty: duty("b"), inputs: {}, trigger: "manual" }),
    ]);
    const [ra, rb] = await Promise.all([mgr.wait(a.runId), mgr.wait(b.runId)]);
    expect([ra.status, rb.status]).toEqual(["ok", "ok"]);
    // Widened from the brief's <55ms: two 30ms runs should overlap, but a loaded CI box can
    // add scheduling jitter that flakes a tight bound.
    expect(Date.now() - t0).toBeLessThan(90);
    // The wall-clock bound alone is vacuous (it also passes if the runs happened to run back
    // to back quickly); assert actual overlap via a concurrency counter around browser.open.
    expect(openTracker.max).toBe(2);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "run", runId: a.runId, status: "ok" }),
    );
  });

  it("emits a queued RunEvent as soon as a run is created", async () => {
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    const emit = vi.fn();
    const mgr = new RunManager({ store, deps: () => deps(0), emit });
    const { runId } = await mgr.start({ duty: duty("q"), inputs: {}, trigger: "manual" });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "run", runId, status: "queued" }),
    );
    await mgr.wait(runId);
  });

  it("queues a second run of an exclusive duty until the first finishes", async () => {
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    const mgr = new RunManager({ store, deps: () => deps(30), emit: () => {} });
    const first = await mgr.start({ duty: duty("x", true), inputs: {}, trigger: "manual" });
    const second = await mgr.start({ duty: duty("x", true), inputs: {}, trigger: "manual" });
    expect(second.queued).toBe(true);
    expect((await store.getRun(second.runId))?.status).toBe("queued");
    await mgr.wait(second.runId);
    const r1 = await store.getRun(first.runId);
    const r2 = await store.getRun(second.runId);
    expect(r2!.startedAt).toBeGreaterThanOrEqual(r1!.endedAt!);
  });

  it("serializes concurrent evidence appends against a slow store so no step is dropped or reverts the terminal status", async () => {
    const store = new DutyStore({
      duties: memoryKeyed() as never,
      runs: memoryKeyedAsync() as never,
    });
    const mgr = new RunManager({ store, deps: () => deps(0), emit: () => {} });
    const { runId } = await mgr.start({
      duty: multiStepDuty("multi"),
      inputs: {},
      trigger: "manual",
    });
    const final = await mgr.wait(runId);
    expect(final.status).toBe("ok");
    // Give any (would-be) stray fire-and-forget append from the old implementation a chance
    // to land and corrupt the row before we check it.
    await flushMacrotasks();
    const stored = await store.getRun(runId);
    expect(stored?.status).toBe("ok");
    expect(stored?.steps.map((s) => s.stepId)).toEqual(["s1", "s2", "s3"]);
  });

  it("catches a synchronous deps() throw, ends the run failed, and produces no unhandled rejection", async () => {
    let unhandled: unknown;
    const onUnhandledRejection = (reason: unknown) => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
      const mgr = new RunManager({
        store,
        deps: () => {
          throw new Error("boom");
        },
        emit: () => {},
      });
      const { runId } = await mgr.start({ duty: duty("y"), inputs: {}, trigger: "manual" });
      const final = await mgr.wait(runId);
      expect(final.status).toBe("failed");
      expect(final.report).toBe("boom");
      await flushMacrotasks(3);
      expect(unhandled).toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("resolves every concurrent waiter for the same still-queued run", async () => {
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    const mgr = new RunManager({ store, deps: () => deps(20), emit: () => {} });
    const first = await mgr.start({ duty: duty("q1", true), inputs: {}, trigger: "manual" });
    const second = await mgr.start({ duty: duty("q1", true), inputs: {}, trigger: "manual" });
    expect(second.queued).toBe(true);
    const [w1, w2] = await Promise.all([mgr.wait(second.runId), mgr.wait(second.runId)]);
    expect(w1.status).toBe("ok");
    expect(w2.status).toBe("ok");
    expect((await store.getRun(first.runId))?.status).toBe("ok");
  });

  it("rejects wait() for an unknown run id instead of hanging", async () => {
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    const mgr = new RunManager({ store, deps: () => deps(0), emit: () => {} });
    await expect(mgr.wait("does-not-exist")).rejects.toThrow("no such run");
  });

  it("re-reads the duty at finish so a concurrent rename survives lastRunAt", async () => {
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    const mgr = new RunManager({ store, deps: () => deps(20), emit: () => {} });
    const original = duty("rename-me");
    await store.saveDuty(original);
    const { runId } = await mgr.start({ duty: original, inputs: {}, trigger: "manual" });
    await store.saveDuty({ ...original, name: "Renamed" });
    await mgr.wait(runId);
    const stored = await store.getDuty("rename-me");
    expect(stored?.name).toBe("Renamed");
    expect(stored?.lastRunAt).toBeGreaterThan(0);
  });

  it("skips setting lastRunAt when the duty was deleted while running", async () => {
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    const mgr = new RunManager({ store, deps: () => deps(20), emit: () => {} });
    const original = duty("delete-me");
    await store.saveDuty(original);
    const { runId } = await mgr.start({ duty: original, inputs: {}, trigger: "manual" });
    await store.deleteDuty("delete-me");
    const final = await mgr.wait(runId);
    expect(final.status).toBe("ok");
    expect(await store.getDuty("delete-me")).toBeUndefined();
  });
});
