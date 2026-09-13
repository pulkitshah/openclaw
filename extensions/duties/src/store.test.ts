import { describe, expect, it } from "vitest";
import { DutyStore, type DutyRun } from "./store.js";
import type { Duty } from "./duty.js";

function memoryKeyed<T>() {
  const map = new Map<string, T>();
  return {
    async register(key: string, value: T) { map.set(key, value); },
    async registerIfAbsent(key: string, value: T) { if (map.has(key)) return false; map.set(key, value); return true; },
    async update(key: string, fn: (cur: T | undefined) => T | undefined) { const next = fn(map.get(key)); if (next === undefined) return false; map.set(key, next); return true; },
    async lookup(key: string) { return map.get(key); },
    async consume(key: string) { const v = map.get(key); map.delete(key); return v; },
    async delete(key: string) { return map.delete(key); },
    async entries() { return [...map.entries()].map(([key, value]) => ({ key, value })); },
    async clear() { map.clear(); },
  };
}

const duty: Duty = {
  id: "d1", name: "D1", summary: "", status: "building", machine: "gateway", reportsTo: "owner",
  inputs: [], steps: [], triggers: [{ kind: "manual" }], updatedAt: 1,
};
const run = (id: string, status: DutyRun["status"]): DutyRun => ({
  id, dutyId: "d1", status, startedAt: Number(id.slice(1)), trigger: "manual", inputs: {}, outputs: {}, steps: [],
});

describe("DutyStore", () => {
  const store = new DutyStore({ duties: memoryKeyed(), runs: memoryKeyed() });
  it("saves, lists, gets and deletes duties", async () => {
    await store.saveDuty(duty);
    expect((await store.listDuties()).map((d) => d.id)).toEqual(["d1"]);
    expect((await store.getDuty("d1"))?.name).toBe("D1");
    expect(await store.deleteDuty("d1")).toBe(true);
    expect(await store.listDuties()).toEqual([]);
  });
  it("lists runs newest first and can filter to successful ones", async () => {
    await store.createRun(run("r1", "ok")); await store.createRun(run("r2", "failed")); await store.createRun(run("r3", "ok"));
    expect((await store.listRuns("d1")).map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
    expect((await store.listRuns("d1", { onlySuccessful: true })).map((r) => r.id)).toEqual(["r3", "r1"]);
  });
  it("patches a run and marks running runs lost", async () => {
    await store.createRun(run("r4", "running"));
    expect((await store.updateRun("r4", { report: "x" }))?.report).toBe("x");
    expect(await store.markRunningRunsLost()).toBe(1);
    expect((await store.getRun("r4"))?.status).toBe("lost");
  });
});
