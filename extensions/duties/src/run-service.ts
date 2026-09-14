import { randomUUID } from "node:crypto";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { Duty } from "./duty.js";
import { runDuty, type RunnerDeps } from "./runner.js";
import type { DutyRun, DutyStore, RunFile, RunOrigin, RunStatus, StepEvidence } from "./store.js";

export type RunEvent = {
  type: "run";
  runId: string;
  dutyId: string;
  status: RunStatus;
  step?: StepEvidence;
};
type Pending = {
  run: DutyRun;
  duty: Duty;
  toStepId?: string;
  keepOpen?: boolean;
  targetId?: string;
};

/** The one-line chat status a terminal run reports back to the chat it was started from.
 *  `undefined` for any non-terminal status, so a status line is never posted mid-run. */
/** A run that has already finished, one way or another. Anything else is still this Gateway's to
 *  end — including `needs_input`, which is exactly the state a run parked on an owner question is
 *  left in when the Gateway that owned it stops. */
function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "ok" ||
    status === "failed" ||
    status === "blocked" ||
    status === "cancelled" ||
    status === "lost"
  );
}

function terminalStatusLine(run: Pick<DutyRun, "status" | "report" | "failedStep">): string {
  switch (run.status) {
    case "ok":
      return `Done — ${run.report ?? "ok"}`;
    case "failed":
      return run.failedStep
        ? `Failed at ${run.failedStep}: ${run.report ?? "failed"}`
        : `Failed — ${run.report ?? "failed"}`;
    case "blocked":
      return `Blocked — ${run.report ?? "blocked"}`;
    case "cancelled":
      return "Cancelled";
    default:
      return "";
  }
}

export class RunManager {
  private readonly active = new Map<string, Promise<DutyRun>>();
  private readonly waiters = new Map<string, Array<(run: DutyRun) => void>>();
  private readonly queue: Pending[] = [];
  private readonly activeByDuty = new Map<string, number>();
  private readonly cancelled = new Set<string>();
  /** Per-run chain of pending evidence appends, so overlapping `onStep` calls for the same
   *  run are serialized instead of racing on a read-modify-write of `steps`, and `finish`
   *  can wait for every append to land before writing the terminal status. */
  private readonly appendChains = new Map<string, Promise<void>>();
  private readonly maxParallel: number;
  constructor(
    private readonly params: {
      store: DutyStore;
      /** Built per run, not per duty: the run's own id decides its `filesDir`, and resolving that
       *  directory is asynchronous, so this may return a promise. */
      deps: (duty: Duty, run: DutyRun) => Promise<RunnerDeps> | RunnerDeps;
      emit: (event: RunEvent) => void;
      /** Posts one status line back to wherever the run reports: the conversation a chat-started
       *  run came from, otherwise the configured owner. Best-effort: the run's outcome never
       *  depends on it, and it is never awaited on the critical path. */
      notify?: (origin: RunOrigin | undefined, text: string) => Promise<void>;
      /** Cancels the Gateway question a parked run is waiting on, so `question.waitAnswer`
       *  returns and the run can unwind. Without it, cancelling a run parked on an owner question
       *  set a flag nothing would read until the question answered or timed out — up to fifteen
       *  minutes during which the run kept holding its browser session. */
      cancelQuestion?: (questionId: string) => Promise<void>;
      maxParallel?: number;
    },
  ) {
    this.maxParallel = params.maxParallel ?? 4;
  }

  /** A run that nobody is watching is the one whose status matters most, so status lines follow
   *  the same rule as `deliver`: back to the chat a run came from, otherwise to the owner. An
   *  unattended mail run used to report nowhere at all.
   *  Swallows both a synchronous throw and a rejection so `notify` can never break a run. */
  private announce(origin: RunOrigin | undefined, text: string): void {
    if (!this.params.notify || !text) return;
    try {
      this.params.notify(origin, text).catch(() => {});
    } catch {
      // status lines are decoration; a broken notifier must not affect the run.
    }
  }

  async recoverOrphans(): Promise<number> {
    return this.params.store.markRunningRunsLost();
  }

  async start(p: {
    duty: Duty;
    inputs: Record<string, unknown>;
    trigger: string;
    toStepId?: string;
    keepOpen?: boolean;
    targetId?: string;
    origin?: RunOrigin;
  }): Promise<{ runId: string; queued: boolean; reason?: string }> {
    const run: DutyRun = {
      id: randomUUID(),
      dutyId: p.duty.id,
      status: "queued",
      startedAt: Date.now(),
      trigger: p.trigger,
      inputs: p.inputs,
      outputs: {},
      steps: [],
      // Only when present: the state store rejects an explicit `undefined` value.
      ...(p.origin ? { origin: p.origin } : {}),
    };
    await this.params.store.createRun(run);
    this.params.emit({ type: "run", runId: run.id, dutyId: p.duty.id, status: "queued" });
    this.queue.push({
      run,
      duty: p.duty,
      toStepId: p.toStepId,
      keepOpen: p.keepOpen,
      targetId: p.targetId,
    });
    const queued = !this.canStart(p.duty);
    this.pump();
    return {
      runId: run.id,
      queued,
      reason: queued
        ? p.duty.exclusive
          ? "runs alone — waiting for the current run"
          : "waiting for a free slot"
        : undefined,
    };
  }

  /** `wait`, bounded. Resolves with the run as soon as it is terminal, or with whatever the store
   *  holds once `timeoutMs` elapses — so a caller polling over the Gateway gets an answer and can
   *  decide to keep waiting, rather than holding one request open for a fifteen-minute `ask`.
   *  Undefined only when no such run exists. */
  async waitFor(runId: string, timeoutMs: number): Promise<DutyRun | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        // A `wait` that rejects (no such run) falls through to the store read below, which is the
        // one place that decides between "still going" and "never existed".
        this.wait(runId).catch(() => undefined),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
          timer.unref?.();
        }),
      ]);
      return outcome ?? (await this.params.store.getRun(runId));
    } finally {
      clearTimeout(timer);
    }
  }

  wait(runId: string): Promise<DutyRun> {
    const active = this.active.get(runId);
    if (active) return active;
    return new Promise((resolve, reject) => {
      const resolvers = this.waiters.get(runId) ?? [];
      resolvers.push(resolve);
      this.waiters.set(runId, resolvers);
      this.params.store.getRun(runId).then((r) => {
        if (r && !["queued", "running", "needs_input"].includes(r.status)) {
          this.waiters.delete(runId);
          resolve(r);
          return;
        }
        if (!r && !this.queue.some((q) => q.run.id === runId) && !this.active.has(runId)) {
          this.waiters.delete(runId);
          reject(new Error("no such run"));
        }
      });
    });
  }

  /**
   * Cancels a run wherever it is: queued, running, parked on an owner question, or parked and no
   * longer held in memory at all because the Gateway restarted while it waited.
   *
   * A parked run needs more than the cancel flag. It is blocked inside the ask adapter, which
   * polls `question.waitAnswer`, so nothing reads the flag until that call returns on its own.
   * Cancelling the question it is waiting on is what lets the ask return `cancelled`, which the
   * runner already turns into a cancelled halt — and that path is what closes the browser tab the
   * run was holding.
   */
  async cancel(runId: string): Promise<boolean> {
    const index = this.queue.findIndex((q) => q.run.id === runId);
    if (index >= 0) {
      const [item] = this.queue.splice(index, 1);
      await this.finish(item!.run, { status: "cancelled" });
      return true;
    }
    const stored = await this.params.store.getRun(runId);
    if (this.active.has(runId)) {
      this.cancelled.add(runId);
      const waitingOn = stored?.waitingOn?.questionId;
      // Best-effort: a question that is already terminal, or a Gateway that refuses the cancel,
      // still leaves the run flagged, which is the behaviour cancel had before.
      if (waitingOn) await this.params.cancelQuestion?.(waitingOn).catch(() => {});
      return true;
    }
    // Not in memory. A run still recorded as waiting or working was parked when this Gateway
    // last stopped; the runner that owned it is gone, so the terminal row is written here.
    if (stored && !isTerminalRunStatus(stored.status)) {
      const waitingOn = stored.waitingOn?.questionId;
      if (waitingOn) await this.params.cancelQuestion?.(waitingOn).catch(() => {});
      await this.finish(stored, { status: "cancelled" });
      return true;
    }
    return false;
  }

  private canStart(duty: Duty): boolean {
    if (this.active.size >= this.maxParallel) return false;
    return !(duty.exclusive && (this.activeByDuty.get(duty.id) ?? 0) > 0);
  }

  private pump(): void {
    for (let i = 0; i < this.queue.length; i += 1) {
      const item = this.queue[i]!;
      if (!this.canStart(item.duty)) continue;
      this.queue.splice(i, 1);
      i -= 1;
      this.launch(item);
    }
  }

  private launch(item: Pending): void {
    const { run, duty } = item;
    this.activeByDuty.set(duty.id, (this.activeByDuty.get(duty.id) ?? 0) + 1);
    const promise = (async (): Promise<DutyRun> => {
      try {
        await this.params.store.updateRun(run.id, { status: "running", startedAt: Date.now() });
        this.params.emit({ type: "run", runId: run.id, dutyId: duty.id, status: "running" });
        this.announce(run.origin, `Running ${duty.name}…`);
        const deps = await this.params.deps(duty, run);
        const outcome = await runDuty(
          duty,
          {
            ...deps,
            isCancelled: () => this.cancelled.has(run.id),
            // Parking is written through the same per-run chain as evidence appends, so the
            // `needs_input` row can never land after — and revert — the terminal status.
            onWaiting: (waitingOn) => {
              const prior = this.appendChains.get(run.id) ?? Promise.resolve();
              this.appendChains.set(
                run.id,
                prior.then(() => this.markWaiting(run, waitingOn)),
              );
            },
            onStep: (step) => {
              const prior = this.appendChains.get(run.id) ?? Promise.resolve();
              this.appendChains.set(
                run.id,
                prior.then(() => this.appendStep(run.id, step)),
              );
              this.params.emit({
                type: "run",
                runId: run.id,
                dutyId: duty.id,
                status: "running",
                step,
              });
            },
            // Rendered documents go through the same per-run chain as evidence appends, so a
            // long run's files are recorded as they are produced and `finish` still waits for
            // every append before writing the terminal row.
            onFile: (file) => {
              const prior = this.appendChains.get(run.id) ?? Promise.resolve();
              this.appendChains.set(
                run.id,
                prior.then(() => this.appendFile(run.id, file)),
              );
            },
          },
          {
            inputs: run.inputs,
            toStepId: item.toStepId,
            keepOpen: item.keepOpen,
            targetId: item.targetId,
            origin: run.origin,
          },
        );
        const status: RunStatus = this.cancelled.has(run.id) ? "cancelled" : outcome.status;
        const final = await this.finish(run, {
          status,
          outputs: outcome.outputs,
          steps: outcome.steps,
          files: outcome.files,
          failedStep: outcome.failedStep,
          report: outcome.report,
          targetId: item.keepOpen && outcome.targetId ? outcome.targetId : undefined,
        });
        if (status === "ok") {
          const fresh = await this.params.store.getDuty(duty.id);
          if (fresh) await this.params.store.saveDuty({ ...fresh, lastRunAt: Date.now() });
        }
        return final;
      } catch (error) {
        return this.finish(run, { status: "failed", report: coerceErrorMessage(error) });
      }
    })().finally(() => {
      this.active.delete(run.id);
      this.cancelled.delete(run.id);
      this.appendChains.delete(run.id);
      this.activeByDuty.set(duty.id, Math.max(0, (this.activeByDuty.get(duty.id) ?? 1) - 1));
      this.pump();
    });
    this.active.set(run.id, promise);
    // Defensive only: `promise` above already resolves (never rejects) because every
    // failure path inside the async IIFE is caught and turned into a "failed" finish(); this
    // guards against an unhandled-rejection warning if something in `.finally()` ever throws.
    promise.catch(() => {});
  }

  /** Records that a run is parked on an owner question (`needs_input` + `waitingOn`), and flips
   *  it back to `running` once the answer arrives, so the Board's "Waiting on you" rollup and
   *  `recoverOrphans` both tell the truth about a run that is waiting rather than working.
   *  Re-attaching to an open question after a Gateway restart is Part 2. Best-effort: a store
   *  failure here must not break the run. */
  private async markWaiting(
    run: DutyRun,
    waitingOn: { questionId: string; stepId: string } | undefined,
  ): Promise<void> {
    const status: RunStatus = waitingOn ? "needs_input" : "running";
    try {
      await this.params.store.updateRun(run.id, waitingOn ? { status, waitingOn } : { status });
    } catch {
      // status bookkeeping is best-effort; the run's own outcome is still written by finish().
    }
    this.params.emit({ type: "run", runId: run.id, dutyId: run.dutyId, status });
  }

  /** Appends one step's evidence to the run's stored `steps` via the store's atomic
   *  `appendRunStep`. Callers must serialize calls per run (see `appendChains`) so a slow
   *  fallback lookup+register store still can't drop a concurrent step. Best-effort: a
   *  storage failure here must not break the run or reject the per-run append chain. */
  private async appendStep(runId: string, step: StepEvidence): Promise<void> {
    try {
      await this.params.store.appendRunStep(runId, step);
    } catch {
      // evidence persistence is best-effort; the run's outcome still carries the full step
      // list and is written by finish() once runDuty completes.
    }
  }

  /** Appends one rendered document to the run's stored `files`. Callers serialize per run (see
   *  `appendChains`). Best-effort: `finish` still writes the outcome's full file list. */
  private async appendFile(runId: string, file: RunFile): Promise<void> {
    try {
      await this.params.store.appendRunFile(runId, file);
    } catch {
      // file bookkeeping is best-effort; finish() writes outcome.files for the whole run.
    }
  }

  private async finish(run: DutyRun, patch: Partial<DutyRun>): Promise<DutyRun> {
    // Flush any pending evidence appends first so a late append can never land after — and
    // silently revert — the terminal status/steps written below.
    await (this.appendChains.get(run.id) ?? Promise.resolve());
    this.appendChains.delete(run.id);
    const final = (await this.params.store.updateRun(run.id, {
      ...patch,
      endedAt: Date.now(),
    })) ?? {
      ...run,
      ...patch,
    };
    this.params.emit({ type: "run", runId: run.id, dutyId: run.dutyId, status: final.status });
    this.announce(run.origin, terminalStatusLine(final));
    const resolvers = this.waiters.get(run.id);
    if (resolvers) for (const resolve of resolvers) resolve(final);
    this.waiters.delete(run.id);
    return final;
  }
}
