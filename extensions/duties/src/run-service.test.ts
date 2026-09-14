import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Duty } from "./duty.js";
import { RunManager } from "./run-service.js";
import type { RunnerDeps } from "./runner.js";
import { DutyStore } from "./store.js";
import type { DutyRun, RunOrigin } from "./store.js";
import type { Template } from "./template.js";

type Notify = (origin: RunOrigin | undefined, text: string) => Promise<void>;

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

function newStore(runs: unknown = memoryKeyed()): DutyStore {
  return new DutyStore({
    duties: memoryKeyed() as never,
    runs: runs as never,
    creds: memoryKeyed() as never,
    templates: memoryKeyed() as never,
    brands: memoryKeyed() as never,
    settings: memoryKeyed() as never,
  });
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
      screenshotPath: async () => undefined,
      close: async () => {},
      pdf: async () => "/tmp/duties-run-service-fake.pdf",
    },
    ai: { extract: async () => ({}) },
    ask: { ask: async () => ({ status: "answered", answer: "" }) },
    cred: async () => "",
    templates: { get: async () => undefined, brand: async () => undefined },
    render: {
      toPdf: async (_html: string, dest: string) => {
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, "%PDF");
        return { bytes: 4 };
      },
    },
    deliver: { send: async () => ({ messageIds: ["m-1"] }) },
    resolveRoute: async () => ({ channel: "telegram", to: "222" }),
    filesDir: "",
  };
}

/** A duty that prints a pdf template and then keeps running, so `onFile` has a real document to
 *  record *and* the run is still open while the test reads it back. */
const pdfTemplate: Template = {
  id: "note",
  name: "Note",
  kind: "pdf",
  html: "<p>{{slot:route}}</p>",
  slots: [{ name: "route", kind: "text", description: "The route" }],
  updatedAt: 1,
};
const printingDuty = (id: string): Duty => ({
  ...duty(id),
  steps: [
    {
      id: "p1",
      kind: "template",
      label: "Print the note",
      params: { template: "note", fill: { route: { from: "{{in:route}}" } } },
    },
    // Runs after the document exists and holds the run open, so a stored file observed here can
    // only have been written by `onFile` — `finish` has not run yet.
    { id: "p2", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
  ],
});

describe("RunManager", () => {
  it("runs two different duties in parallel, overlapping, and records ok runs", async () => {
    const store = newStore();
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
    const store = newStore();
    const emit = vi.fn();
    const mgr = new RunManager({ store, deps: () => deps(0), emit });
    const { runId } = await mgr.start({ duty: duty("q"), inputs: {}, trigger: "manual" });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "run", runId, status: "queued" }),
    );
    await mgr.wait(runId);
  });

  it("queues a second run of an exclusive duty until the first finishes", async () => {
    const store = newStore();
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
    const store = newStore(memoryKeyedAsync());
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

  it("reports active/queued counts via status()", async () => {
    const store = newStore();
    const mgr = new RunManager({ store, deps: () => deps(20), emit: () => {}, maxParallel: 1 });
    expect(mgr.status()).toEqual({ active: 0, queued: 0 });
    const first = await mgr.start({ duty: duty("st-1"), inputs: {}, trigger: "manual" });
    const second = await mgr.start({ duty: duty("st-2"), inputs: {}, trigger: "manual" });
    expect(mgr.status()).toEqual({ active: 1, queued: 1 });
    await Promise.all([mgr.wait(first.runId), mgr.wait(second.runId)]);
    // `wait()` resolves inside `finish()`, before `launch()`'s `.finally()` clears `active` —
    // give that cleanup a chance to land before reading status() again.
    await flushMacrotasks(3);
    expect(mgr.status()).toEqual({ active: 0, queued: 0 });
  });

  it("catches a synchronous deps() throw, ends the run failed, and produces no unhandled rejection", async () => {
    let unhandled: unknown;
    const onUnhandledRejection = (reason: unknown) => {
      unhandled = reason;
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const store = newStore();
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

  it("resolves maxParallel from an async function at pump time, so raising the limit drains the queue without waiting for a finish", async () => {
    const store = newStore();
    let limit = 1;
    const mgr = new RunManager({
      store,
      deps: () => deps(30),
      emit: () => {},
      maxParallel: async () => limit,
    });
    const first = await mgr.start({ duty: duty("mp-1"), inputs: {}, trigger: "manual" });
    expect(first.queued).toBe(false);
    const second = await mgr.start({ duty: duty("mp-2"), inputs: {}, trigger: "manual" });
    expect(second.queued).toBe(true);
    expect(second.reason).toBe("waiting for a free slot");
    expect((await store.getRun(second.runId))?.status).toBe("queued");

    limit = 2;
    const third = await mgr.start({ duty: duty("mp-3"), inputs: {}, trigger: "manual" });
    // Starting a third run triggers another pump; with the limit now 2, the previously queued
    // second run starts alongside the first without anything finishing first.
    await flushMacrotasks(3);
    expect((await store.getRun(second.runId))?.status).toBe("running");

    const [rf, rs, rt] = await Promise.all([
      mgr.wait(first.runId),
      mgr.wait(second.runId),
      mgr.wait(third.runId),
    ]);
    expect([rf.status, rs.status, rt.status]).toEqual(["ok", "ok", "ok"]);
  });

  it("admit() drains the queue immediately after the limit rises, with no other start/finish event", async () => {
    const store = newStore();
    let limit = 1;
    const mgr = new RunManager({
      store,
      deps: () => deps(30),
      emit: () => {},
      maxParallel: async () => limit,
    });
    const first = await mgr.start({ duty: duty("admit-1"), inputs: {}, trigger: "manual" });
    const second = await mgr.start({ duty: duty("admit-2"), inputs: {}, trigger: "manual" });
    expect(second.queued).toBe(true);
    expect((await store.getRun(second.runId))?.status).toBe("queued");

    limit = 2;
    // No other start()/finish() event — admit() alone must drain the queue.
    mgr.admit();
    await flushMacrotasks(3);
    expect((await store.getRun(second.runId))?.status).toBe("running");

    await Promise.all([mgr.wait(first.runId), mgr.wait(second.runId)]);
  });

  it("reports queued truthfully for two concurrent start() calls under a limit of 1", async () => {
    const store = newStore();
    const mgr = new RunManager({
      store,
      deps: () => deps(20),
      emit: () => {},
      maxParallel: async () => 1,
    });
    const [a, b] = await Promise.all([
      mgr.start({ duty: duty("race-1"), inputs: {}, trigger: "manual" }),
      mgr.start({ duty: duty("race-2"), inputs: {}, trigger: "manual" }),
    ]);
    // Exactly one of the two concurrent starts got the single slot; the other must say so
    // truthfully instead of both racing to read a stale "still under the limit" snapshot.
    expect(a.queued).not.toBe(b.queued);
    expect(mgr.status()).toEqual({ active: 1, queued: 1 });
    await Promise.all([mgr.wait(a.runId), mgr.wait(b.runId)]);
  });

  it("resolves every concurrent waiter for the same still-queued run", async () => {
    const store = newStore();
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
    const store = newStore();
    const mgr = new RunManager({ store, deps: () => deps(0), emit: () => {} });
    await expect(mgr.wait("does-not-exist")).rejects.toThrow("no such run");
  });

  it("re-reads the duty at finish so a concurrent rename survives lastRunAt", async () => {
    const store = newStore();
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

  it("parks the run on needs_input while an ask is pending and returns it to running", async () => {
    const store = newStore();
    const statuses: string[] = [];
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const askDuty: Duty = {
      ...duty("ask-me"),
      steps: [{ id: "s1", kind: "ask", label: "Which account?", params: { question: "Which?" } }],
    };
    const mgr = new RunManager({
      store,
      deps: () => ({
        ...deps(0),
        ask: {
          ask: async ({ onAsked }) => {
            onAsked?.("q-1");
            await pending;
            return { status: "answered", answer: "LIC Nagpur" };
          },
        },
      }),
      emit: (event) => statuses.push(event.status),
    });
    const { runId } = await mgr.start({ duty: askDuty, inputs: {}, trigger: "manual" });
    await flushMacrotasks(5);

    const parked = await store.getRun(runId);
    expect(parked?.status).toBe("needs_input");
    expect(parked?.waitingOn).toEqual({ questionId: "q-1", stepId: "s1" });
    expect(statuses).toContain("needs_input");

    release();
    const final = await mgr.wait(runId);
    expect(final.status).toBe("ok");
  });

  it("stops an active run at the next step when it is cancelled", async () => {
    const store = newStore();
    const slow: Duty = {
      ...duty("cancel-me"),
      steps: [
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        {
          id: "s2",
          kind: "browser",
          label: "Click",
          params: { action: "click" },
          target: { css: "#a" },
        },
      ],
    };
    let clicks = 0;
    const mgr = new RunManager({
      store,
      deps: () => {
        const base = deps(20);
        return { ...base, browser: { ...base.browser, click: async () => void (clicks += 1) } };
      },
      emit: () => {},
    });
    const { runId } = await mgr.start({ duty: slow, inputs: {}, trigger: "manual" });
    expect(await mgr.cancel(runId)).toBe(true);
    const final = await mgr.wait(runId);
    expect(final.status).toBe("cancelled");
    expect(clicks).toBe(0);
  });

  it("stores the run's origin so a deliver step can route back to the chat it came from", async () => {
    const store = newStore();
    const mgr = new RunManager({ store, deps: () => deps(0), emit: () => {} });
    const { runId } = await mgr.start({
      duty: duty("origin-me"),
      inputs: {},
      trigger: "chat",
      origin: { kind: "chat", sessionKey: "s" },
    });
    expect((await store.getRun(runId))?.origin).toEqual({ kind: "chat", sessionKey: "s" });
    await mgr.wait(runId);
    expect((await store.getRun(runId))?.origin).toEqual({ kind: "chat", sessionKey: "s" });
  });

  it("records a rendered document on the run while it is still running, and finish keeps it", async () => {
    const store = newStore();
    const root = await mkdtemp(path.join(tmpdir(), "duties-run-service-"));
    // Snapshotted from inside a step that is still executing. `finish` writes `outcome.files`
    // too, so only an observation taken *before* the terminal row can pin `onFile` itself: with
    // the onFile wiring removed, the poll below finds nothing and `midRun` stays undefined.
    let midRun: DutyRun | undefined;
    const mgr = new RunManager({
      store,
      deps: (_duty, run) => {
        const base = deps(0);
        return {
          ...base,
          templates: { get: async () => pdfTemplate, brand: async () => undefined },
          filesDir: path.join(root, run.id),
          browser: {
            ...base.browser,
            open: async () => {
              for (let i = 0; i < 100 && !midRun; i += 1) {
                const current = await store.getRun(run.id);
                if (current?.files?.length) midRun = current;
                else await new Promise((r) => setTimeout(r, 1));
              }
              return { targetId: "t" };
            },
          },
        };
      },
      emit: () => {},
    });
    const { runId } = await mgr.start({
      duty: printingDuty("print-me"),
      inputs: { route: "IXU → COK" },
      trigger: "manual",
    });
    const final = await mgr.wait(runId);

    expect(midRun?.status).toBe("running");
    // The document is named from the template, not the step id; the exact name is the runner's
    // contract (see runner.test.ts), so this case pins only that the SAME file is recorded while
    // the run is still going and after it finishes, in this run's own directory.
    const name = midRun?.files?.[0]?.name;
    expect(name).toMatch(/\.pdf$/u);
    expect(name).not.toBe("p1.pdf");
    expect(final.status).toBe("ok");
    expect(final.files?.map((f) => f.path)).toEqual([path.join(root, runId, name!)]);
    expect((await store.getRun(runId))?.files?.map((f) => f.path)).toEqual([
      path.join(root, runId, name!),
    ]);
  });
});

// Cancelling a parked run reported `{ ok: false }` and left the run — and the browser session it
// was holding — alive. Two separate holes: a run waiting on an owner question is blocked inside
// the ask, so the cancel flag alone is never reached, and a run whose Gateway restarted while it
// waited is not in memory at all.
describe("RunManager cancel of a parked run", () => {
  /** A duty whose only step is an ask, plus deps whose ask never answers on its own. */
  const askDuty = (id: string): Duty => ({
    ...duty(id),
    steps: [
      {
        id: "ask-owner",
        kind: "ask",
        label: "Approve?",
        params: { question: "Approve?", options: ["Approve", "Decline"] },
        saveAs: "decision",
      },
    ],
  });

  function parkedDeps(): { deps: RunnerDeps; release: (status: "cancelled") => void } {
    let release!: (status: "cancelled") => void;
    const parked = new Promise<{ status: "cancelled" }>((resolve) => {
      release = (status) => resolve({ status });
    });
    const base = deps(0);
    return {
      release,
      deps: {
        ...base,
        ask: {
          ask: async ({ stepId, onAsked }) => {
            onAsked?.(`ask_question_for_${stepId}`);
            return await parked;
          },
        },
      },
    };
  }

  it("cancels the pending question so the parked run actually ends", async () => {
    const store = newStore();
    const { deps: parked, release } = parkedDeps();
    const cancelQuestion = vi.fn(async (questionId: string) => {
      // Cancelling the question is what unblocks `question.waitAnswer` in the real adapter.
      expect(questionId).toBe("ask_question_for_ask-owner");
      release("cancelled");
    });
    const mgr = new RunManager({
      store,
      deps: () => parked,
      emit: () => {},
      cancelQuestion,
    });

    const started = await mgr.start({ duty: askDuty("parks"), inputs: {}, trigger: "manual" });
    await flushMacrotasks(5);
    expect((await store.getRun(started.runId))?.status).toBe("needs_input");

    expect(await mgr.cancel(started.runId)).toBe(true);
    // Bounded: a cancel that does not actually unblock the ask must fail fast here rather than
    // hang the suite the way it hung the live run.
    const final = await Promise.race([
      mgr.wait(started.runId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("cancel did not end the parked run")), 2_000),
      ),
    ]);
    expect(cancelQuestion).toHaveBeenCalledTimes(1);
    expect(final.status).toBe("cancelled");
  });

  it("cancels a parked run the Gateway no longer holds in memory", async () => {
    const store = newStore();
    // A fresh manager, as after a restart: the run row says needs_input, nothing is in flight.
    const mgr = new RunManager({ store, deps: () => deps(0), emit: () => {} });
    const runId = "run-parked-across-restart";
    await store.createRun({
      id: runId,
      dutyId: "parks",
      status: "needs_input",
      trigger: "manual",
      inputs: {},
      startedAt: 1,
      waitingOn: { questionId: "ask_stale", stepId: "ask-owner" },
    } as never);

    expect(await mgr.cancel(runId)).toBe(true);
    expect((await store.getRun(runId))?.status).toBe("cancelled");
  });
});

describe("RunManager", () => {
  // A mail- or manually-triggered run used to report nowhere at all, which is exactly the run
  // nobody is watching. Status lines now follow the same rule `deliver` does — the chat the run
  // came from, otherwise the owner — and the notifier is handed the origin so it can resolve that.
  it("posts a status line when the run starts and finishes, for an unattended run too", async () => {
    const store = newStore();
    const chat = vi.fn<Notify>(async () => {});
    const chatMgr = new RunManager({
      store,
      deps: () => deps(0),
      emit: () => {},
      notify: chat,
    });
    const started = await chatMgr.start({
      duty: duty("chatty"),
      inputs: {},
      trigger: "chat",
      origin: { kind: "chat", sessionKey: "s" },
    });
    await chatMgr.wait(started.runId);
    await flushMacrotasks(3);
    expect(chat.mock.calls.map((c) => c[1])).toEqual(["Running chatty…", "Done — ok"]);

    const quiet = vi.fn<Notify>(async () => {});
    const manualMgr = new RunManager({
      store,
      deps: () => deps(0),
      emit: () => {},
      notify: quiet,
    });
    const manual = await manualMgr.start({
      duty: duty("quiet"),
      inputs: {},
      trigger: "manual",
      origin: { kind: "manual" },
    });
    await manualMgr.wait(manual.runId);
    await flushMacrotasks(3);
    expect(quiet.mock.calls.map((c) => c[1])).toEqual(["Running quiet…", "Done — ok"]);
    // The origin reaches the notifier, which is what lets it route to the owner rather than guess.
    expect(quiet.mock.calls[0]?.[0]).toEqual({ kind: "manual" });
  });

  it("reports a failed chat run's failing step in its status line and never lets notify break the run", async () => {
    const store = newStore();
    const notify = vi.fn<Notify>(async () => {
      throw new Error("chat is gone");
    });
    const mgr = new RunManager({
      store,
      deps: () => {
        const base = deps(0);
        return {
          ...base,
          browser: {
            ...base.browser,
            open: async () => {
              throw new Error("no such host");
            },
          },
        };
      },
      emit: () => {},
      notify,
    });
    const { runId } = await mgr.start({
      duty: duty("broken"),
      inputs: {},
      trigger: "chat",
      origin: { kind: "chat", sessionKey: "s" },
    });
    const final = await mgr.wait(runId);
    await flushMacrotasks(3);
    expect(final.status).toBe("failed");
    expect(notify.mock.calls.map((c) => c[1])).toEqual([
      "Running broken…",
      "Failed at s1: no such host",
    ]);
  });

  it("skips setting lastRunAt when the duty was deleted while running", async () => {
    const store = newStore();
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
