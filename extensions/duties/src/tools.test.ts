import { describe, expect, it, vi } from "vitest";
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

function makeTools() {
  const tools = new Map<
    string,
    { execute: (id: string, input: unknown) => Promise<{ content: Array<{ text: string }> }> }
  >();
  const api = {
    registerTool: (tool: { name: string; execute: never }) => tools.set(tool.name, tool as never),
  } as never;
  const run = async (name: string, input: unknown) =>
    JSON.parse((await tools.get(name)!.execute("c1", input)).content[0]!.text);
  return { api, run };
}

describe("duty tools", () => {
  it("drafts, sets steps, and refuses invalid steps with the validation errors", async () => {
    const { api, run } = makeTools();
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    registerDutyTools({
      api,
      store,
      runs: { start: vi.fn(), wait: vi.fn() } as never,
      credHas: async () => false,
    });
    await run("duty_draft", { id: "d1", name: "Book flight", summary: "books" });
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
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    registerDutyTools({
      api,
      store,
      runs: { start: vi.fn(), wait: vi.fn() } as never,
      credHas: async () => false,
    });
    await run("duty_draft", { id: "d1", name: "Book flight", summary: "books" });
    const got = await run("duty_get", { id: "d1" });
    expect(got.duty).toMatchObject({ id: "d1", status: "building" });
    expect(got.runs).toEqual([]);
  });

  it("duty_run starts a run and waits for it, returning the awaited run's fields", async () => {
    const { api, run } = makeTools();
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
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
    registerDutyTools({ api, store, runs: { start, wait } as never, credHas: async () => false });
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

  it("duty_save sets the duty's status to active", async () => {
    const { api, run } = makeTools();
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    registerDutyTools({
      api,
      store,
      runs: { start: vi.fn(), wait: vi.fn() } as never,
      credHas: async () => false,
    });
    await run("duty_draft", { id: "d1", name: "Book flight", summary: "books" });
    const saved = await run("duty_save", { id: "d1" });
    expect(saved.duty.status).toBe("active");
    const stored = await store.getDuty("d1");
    expect(stored?.status).toBe("active");
  });
});
