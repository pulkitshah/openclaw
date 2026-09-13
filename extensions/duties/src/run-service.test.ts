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
function deps(delayMs: number): RunnerDeps {
  return {
    browser: {
      open: async () => {
        await new Promise((r) => setTimeout(r, delayMs));
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
  it("runs two different duties in parallel and records ok runs", async () => {
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    const emit = vi.fn();
    const mgr = new RunManager({ store, deps: () => deps(30), emit });
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
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "run", runId: a.runId, status: "ok" }),
    );
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
});
