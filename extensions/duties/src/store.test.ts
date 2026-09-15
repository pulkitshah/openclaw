import { describe, expect, it, vi } from "vitest";
import type { Duty } from "./duty.js";
import { DutyStore, runSessionKey, type DutyRun, type DutyStores } from "./store.js";

function memoryKeyed<T>() {
  const map = new Map<string, T>();
  return {
    async register(key: string, value: T) {
      map.set(key, value);
    },
    async registerIfAbsent(key: string, value: T) {
      if (map.has(key)) {
        return false;
      }
      map.set(key, value);
      return true;
    },
    async update(key: string, fn: (cur: T | undefined) => T | undefined) {
      const next = fn(map.get(key));
      if (next === undefined) {
        return false;
      }
      map.set(key, next);
      return true;
    },
    async lookup(key: string) {
      return map.get(key);
    },
    async consume(key: string) {
      const v = map.get(key);
      map.delete(key);
      return v;
    },
    async delete(key: string) {
      return map.delete(key);
    },
    async entries() {
      return [...map.entries()].map(([key, value]) => ({ key, value }));
    },
    async clear() {
      map.clear();
    },
  };
}

/** Same as memoryKeyed(), but with `update` spied so tests can assert the atomic path was used. */
function spyKeyed<T>() {
  const base = memoryKeyed<T>();
  return {
    ...base,
    update: vi.fn((key: string, fn: (cur: T | undefined) => T | undefined) => base.update(key, fn)),
  };
}

/** A keyed store lacking `update`, to prove DutyStore still works via the lookup+register fallback. */
function memoryKeyedNoUpdate<T>() {
  const map = new Map<string, T>();
  return {
    async register(key: string, value: T) {
      map.set(key, value);
    },
    async lookup(key: string) {
      return map.get(key);
    },
    async delete(key: string) {
      return map.delete(key);
    },
    async entries() {
      return [...map.entries()].map(([key, value]) => ({ key, value }));
    },
  };
}

const duty: Duty = {
  id: "d1",
  name: "D1",
  summary: "",
  status: "building",
  machine: "gateway",
  reportsTo: "owner",
  inputs: [],
  steps: [],
  triggers: [{ kind: "manual" }],
  updatedAt: 1,
};
const run = (id: string, status: DutyRun["status"]): DutyRun => ({
  id,
  dutyId: "d1",
  status,
  startedAt: Number(id.slice(1)),
  trigger: "manual",
  inputs: {},
  outputs: {},
  steps: [],
});

/** Builds a DutyStore over in-memory Keyed<T> fakes, overriding only the stores a test cares about. */
function makeStore(overrides: Partial<DutyStores> = {}): DutyStore {
  return new DutyStore({
    duties: memoryKeyed(),
    runs: memoryKeyed(),
    creds: memoryKeyed(),
    templates: memoryKeyed(),
    brands: memoryKeyed(),
    settings: memoryKeyed(),
    team: memoryKeyed(),
    ...overrides,
  });
}

describe("DutyStore", () => {
  const store = makeStore();
  it("saves, lists, gets and deletes duties", async () => {
    await store.saveDuty(duty);
    expect((await store.listDuties()).map((d) => d.id)).toEqual(["d1"]);
    expect((await store.getDuty("d1"))?.name).toBe("D1");
    expect(await store.deleteDuty("d1")).toBe(true);
    expect(await store.listDuties()).toEqual([]);
  });
  it("indexes credential keys without ever storing a value", async () => {
    await store.recordCredKey("acme-demo.password", 5);
    await store.recordCredKey("acme-demo.username", 7);
    const listed = await store.listCredKeys();
    expect(listed).toEqual([
      { key: "acme-demo.password", updatedAt: 5 },
      { key: "acme-demo.username", updatedAt: 7 },
    ]);
    expect(await store.forgetCredKey("acme-demo.password")).toBe(true);
    expect((await store.listCredKeys()).map((entry) => entry.key)).toEqual(["acme-demo.username"]);
    await store.forgetCredKey("acme-demo.username");
  });
  it("lists runs newest first and can filter to successful ones", async () => {
    await store.createRun(run("r1", "ok"));
    await store.createRun(run("r2", "failed"));
    await store.createRun(run("r3", "ok"));
    expect((await store.listRuns("d1")).map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
    expect((await store.listRuns("d1", { onlySuccessful: true })).map((r) => r.id)).toEqual([
      "r3",
      "r1",
    ]);
  });
  it("lists recent runs newest-first across every duty regardless of status", async () => {
    const runs = memoryKeyed<DutyRun>();
    const withRuns = makeStore({ runs });
    await withRuns.createRun(run("r20", "ok"));
    await withRuns.saveDuty({ ...duty, id: "d2" });
    await withRuns.createRun({ ...run("r21", "failed"), dutyId: "d2" });
    await withRuns.createRun(run("r22", "ok"));

    expect((await withRuns.listRecentRuns()).map((r) => r.id)).toEqual(["r22", "r21", "r20"]);
    expect((await withRuns.listRecentRuns(2)).map((r) => r.id)).toEqual(["r22", "r21"]);
  });

  it("patches a run and marks running runs lost", async () => {
    await store.createRun(run("r4", "running"));
    expect((await store.updateRun("r4", { report: "x" }))?.report).toBe("x");
    expect(await store.markRunningRunsLost()).toBe(1);
    expect((await store.getRun("r4"))?.status).toBe("lost");
  });

  it("updateRun drops undefined patch fields instead of storing them", async () => {
    const runs = memoryKeyed<DutyRun>();
    const withRuns = makeStore({ runs });
    await withRuns.createRun(run("r10", "running"));
    const patched = await withRuns.updateRun("r10", {
      status: "ok",
      failedStep: undefined,
      targetId: undefined,
    });
    expect(patched?.status).toBe("ok");
    expect(Object.keys(patched ?? {})).not.toContain("failedStep");
    expect(Object.keys(patched ?? {})).not.toContain("targetId");

    const noUpdate = makeStore({ runs: memoryKeyedNoUpdate<DutyRun>() });
    await noUpdate.createRun(run("r11", "running"));
    const fallback = await noUpdate.updateRun("r11", { status: "ok", failedStep: undefined });
    expect(Object.keys(fallback ?? {})).not.toContain("failedStep");
  });

  it("updateRun uses the store's atomic update when available", async () => {
    const runs = spyKeyed<DutyRun>();
    const withSpy = makeStore({ runs });
    await withSpy.createRun(run("r5", "running"));
    const patched = await withSpy.updateRun("r5", { report: "atomic" });
    expect(patched?.report).toBe("atomic");
    expect(runs.update).toHaveBeenCalledTimes(1);
    expect(runs.update).toHaveBeenCalledWith("r5", expect.any(Function));
  });

  it("updateRun falls back to lookup+register when atomic update is absent", async () => {
    const runs = memoryKeyedNoUpdate<DutyRun>();
    const noUpdate = makeStore({ runs });
    await noUpdate.createRun(run("r6", "running"));
    const patched = await noUpdate.updateRun("r6", { report: "fallback" });
    expect(patched?.report).toBe("fallback");
    expect((await noUpdate.getRun("r6"))?.report).toBe("fallback");
  });

  it("updateRun returns undefined for a missing run with and without atomic update", async () => {
    const withSpy = makeStore({ runs: spyKeyed<DutyRun>() });
    const withoutUpdate = makeStore({ runs: memoryKeyedNoUpdate<DutyRun>() });
    expect(await withSpy.updateRun("missing", { report: "x" })).toBeUndefined();
    expect(await withoutUpdate.updateRun("missing", { report: "x" })).toBeUndefined();
  });

  it("markRunningRunsLost uses the store's atomic update when available", async () => {
    const runs = spyKeyed<DutyRun>();
    const withSpy = makeStore({ runs });
    await withSpy.createRun(run("r7", "running"));
    await withSpy.createRun(run("r8", "ok"));
    const count = await withSpy.markRunningRunsLost();
    expect(count).toBe(1);
    expect((await withSpy.getRun("r7"))?.status).toBe("lost");
    expect((await withSpy.getRun("r8"))?.status).toBe("ok");
    expect(runs.update).toHaveBeenCalledTimes(1);
  });

  it("markRunningRunsLost falls back to lookup+register when atomic update is absent", async () => {
    const runs = memoryKeyedNoUpdate<DutyRun>();
    const noUpdate = makeStore({ runs });
    await noUpdate.createRun(run("r9", "queued"));
    const count = await noUpdate.markRunningRunsLost();
    expect(count).toBe(1);
    expect((await noUpdate.getRun("r9"))?.status).toBe("lost");
  });

  it("stores templates, one brand, settings, and appends run files atomically", async () => {
    const templateStore = makeStore();
    await templateStore.saveTemplate({
      id: "t",
      name: "T",
      kind: "pdf",
      html: "{{slot:a}}",
      slots: [{ name: "a", kind: "text", description: "" }],
      updatedAt: 1,
    });
    expect((await templateStore.listTemplates()).map((t) => t.id)).toEqual(["t"]);
    expect((await templateStore.getTemplate("t"))?.name).toBe("T");
    expect(await templateStore.deleteTemplate("t")).toBe(true);
    expect(await templateStore.listTemplates()).toEqual([]);

    await templateStore.saveBrand({ name: "Amigos", updatedAt: 1 });
    expect((await templateStore.getBrand())?.name).toBe("Amigos");

    expect(await templateStore.getSettings()).toEqual({});
    await templateStore.updateSettings({ owner: { channel: "telegram", target: "123" } });
    await templateStore.updateSettings({ lastMailDispatchAt: 5 });
    expect(await templateStore.getSettings()).toEqual({
      owner: { channel: "telegram", target: "123" },
      lastMailDispatchAt: 5,
    });

    await templateStore.createRun(run("r1", "ok"));
    const appended = await templateStore.appendRunFile("r1", {
      stepId: "t1",
      name: "a.pdf",
      path: "/x/a.pdf",
      bytes: 10,
      contentType: "application/pdf",
    });
    expect(appended?.files).toHaveLength(1);
    expect((await templateStore.getRun("r1"))?.files).toHaveLength(1);
    expect(
      await templateStore.appendRunFile("missing", { ...appended!.files![0]! }),
    ).toBeUndefined();
  });

  it("updateSettings falls back to lookup+register when atomic update is absent", async () => {
    const noUpdate = makeStore({ settings: memoryKeyedNoUpdate() });
    expect(await noUpdate.updateSettings({ lastMailDispatchAt: 9 })).toEqual({
      lastMailDispatchAt: 9,
    });
    expect(await noUpdate.getSettings()).toEqual({ lastMailDispatchAt: 9 });
  });
});

describe("runSessionKey", () => {
  it("acts under the session that started the run", () => {
    expect(
      runSessionKey({ kind: "chat", sessionKey: "agent:krishna:duties-p2", agentId: "krishna" }),
    ).toBe("agent:krishna:duties-p2");
    expect(
      runSessionKey({ kind: "mail", sessionKey: "hook:gmail:ingress", agentId: "duties-mail" }),
    ).toBe("hook:gmail:ingress");
  });

  it('falls back to the origin agent\'s own session, never an unowned "main"', () => {
    // A bare "main" has no owner under agents.ownership: "explicit" with several agents
    // configured, so every ai/ask step of such a run failed before it ran.
    expect(runSessionKey({ kind: "mail", agentId: "duties-mail" })).toBe("agent:duties-mail:main");
    expect(runSessionKey({ kind: "manual", agentId: "krishna" })).toBe("agent:krishna:main");
  });

  it("uses main only when the run recorded no origin at all", () => {
    expect(runSessionKey(undefined)).toBe("main");
    expect(runSessionKey({ kind: "manual" })).toBe("main");
  });
});
