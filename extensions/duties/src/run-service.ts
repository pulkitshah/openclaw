import { randomUUID } from "node:crypto";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { Duty, DutyNode } from "./duty.js";
import { runDuty, type RunnerDeps } from "./runner.js";
import type { DutyRun, DutyStore, RunFile, RunOrigin, RunStatus, StepEvidence } from "./store.js";

export type RunEvent = {
  type: "run";
  runId: string;
  dutyId: string;
  status: RunStatus;
  step?: StepEvidence;
};

/** The session progress card a chat-started run keeps for the person who started it: the same
 *  shape the `progress_card` tool writes, so the chat renders it exactly the way it renders the
 *  agent's own cards. The agent cannot keep this itself — `duty_run` blocks until the run ends. */
export type RunProgressCard = {
  markdown: string;
  plan?: Array<{ step: string; status: "pending" | "in_progress" | "completed" }>;
};

/** How many steps a run can pass through at most: every step on every branch, gates and stops
 *  excluded because they leave no evidence. A branch not taken makes the bar end short of its
 *  max, so a finished run pins the bar full rather than leaving it at 61/80. */
function countRunnableSteps(nodes: DutyNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.kind === "when") {
      total += countRunnableSteps(node.then) + countRunnableSteps(node.else ?? []);
    } else if (node.kind !== "stop") {
      total += 1;
    }
  }
  return total;
}

const PROGRESS_CARD_RECENT_STEPS = 5;

type ProgressState = {
  dutyName: string;
  total: number;
  done: string[];
  current?: string;
};

function buildProgressCard(
  state: ProgressState,
  line: string,
  terminal: "ok" | "other" | undefined,
): RunProgressCard {
  const { dutyName } = state;
  const value = terminal === "ok" ? state.total : Math.min(state.done.length, state.total);
  const label = `${dutyName} · ${value}/${state.total}`.replaceAll('"', "'");
  const plan: NonNullable<RunProgressCard["plan"]> = state.done
    .slice(-PROGRESS_CARD_RECENT_STEPS)
    .map((step) => ({ step, status: "completed" as const }));
  if (!terminal && state.current) {
    plan.push({ step: state.current, status: "in_progress" });
  }
  return {
    markdown: `<progress aria-label="${label}" value="${value}" max="${state.total}"></progress>\n**${dutyName}** — ${line}`,
    ...(plan.length > 0 ? { plan } : {}),
  };
}
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
  /** The active-run ceiling: a plain number, or a function resolved fresh on every `start()` and
   *  every `pump()` pass, so a live `maxParallelRuns` setting change (the hosted-desk Settings
   *  strip) takes effect on the very next run without restarting the Gateway. */
  private readonly maxParallel: number | (() => number | Promise<number>);
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
      /** Replaces the progress card of the session a run was started from (only ever called with
       *  an origin that names one). Best-effort like `notify`: a card that cannot be written never
       *  touches the run. */
      progress?: (
        origin: RunOrigin & { sessionKey: string },
        card: RunProgressCard,
      ) => Promise<void>;
      /** Brings the browser panel up in front of the person whose session started the run, called
       *  once, as the run's first browser step begins. Best-effort like `notify`. */
      showBrowser?: (origin: RunOrigin & { sessionKey: string }) => Promise<void>;
      /** Cancels the Gateway question a parked run is waiting on, so `question.waitAnswer`
       *  returns and the run can unwind. Without it, cancelling a run parked on an owner question
       *  set a flag nothing would read until the question answered or timed out — up to fifteen
       *  minutes during which the run kept holding its browser session. */
      cancelQuestion?: (questionId: string) => Promise<void>;
      maxParallel?: number | (() => number | Promise<number>);
    },
  ) {
    this.maxParallel = params.maxParallel ?? 4;
  }

  /** Reports what the manager is doing right now, for `duties.desk.status`: how many runs are
   *  actively executing and how many are queued behind the current `maxParallel` ceiling. */
  status(): { active: number; queued: number } {
    return { active: this.active.size, queued: this.queue.length };
  }

  private async resolveMaxParallel(): Promise<number> {
    const m = this.maxParallel;
    return typeof m === "function" ? await m() : m;
  }

  /** A run that nobody is watching is the one whose status matters most, so status lines follow
   *  the same rule as `deliver`: back to the chat a run came from, otherwise to the owner. An
   *  unattended mail run used to report nowhere at all.
   *  Swallows both a synchronous throw and a rejection so `notify` can never break a run. */
  private announce(origin: RunOrigin | undefined, text: string): void {
    if (!this.params.notify || !text) {
      return;
    }
    try {
      this.params.notify(origin, text).catch(() => {});
    } catch {
      // status lines are decoration; a broken notifier must not affect the run.
    }
  }

  /** Per-run progress-card state, present only while a run that reports to a session is alive. */
  private readonly progress = new Map<string, ProgressState>();
  /** Per-run chain of card writes, so a slow write can never land after — and overwrite — a
   *  later one; `finish` posts the terminal card through the same chain. */
  private readonly progressChains = new Map<string, Promise<void>>();

  private postProgress(run: DutyRun, line: string, terminal?: "ok" | "other"): void {
    const state = this.progress.get(run.id);
    const origin = run.origin;
    if (!state || !this.params.progress || !origin?.sessionKey) {
      return;
    }
    const card = buildProgressCard(state, line, terminal);
    const target = { ...origin, sessionKey: origin.sessionKey };
    const prior = this.progressChains.get(run.id) ?? Promise.resolve();
    this.progressChains.set(
      run.id,
      prior.then(async () => {
        try {
          await this.params.progress?.(target, card);
        } catch {
          // the card is decoration; a session that cannot take it must not affect the run.
        }
      }),
    );
  }

  /** The person watching a chat-started run should see the browser the moment it starts driving
   *  one, without hunting for the panel. Only a run with a session to show it in; swallows both a
   *  synchronous throw and a rejection (no UI connected is the usual one) like `announce`. */
  private showBrowser(run: DutyRun): void {
    const origin = run.origin;
    if (!this.params.showBrowser || !origin?.sessionKey) {
      return;
    }
    try {
      this.params.showBrowser({ ...origin, sessionKey: origin.sessionKey }).catch(() => {});
    } catch {
      // the panel is decoration; a UI that cannot take the command must not affect the run.
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
    // Both awaits happen before the queue is touched, so that once either resolves the rest of
    // this method — push, admit, read back whether this run's own item was launched — runs in one
    // synchronous stretch with no `await` in between. Two concurrent `start()` calls under the
    // same limit therefore can never both observe "a slot is free": whichever call's continuation
    // the microtask queue runs first fully admits the queue (including any earlier-queued items)
    // before the other call's continuation gets a turn, so `queued` below reflects the real
    // outcome instead of a stale `active.size` snapshot taken before this run's own place in the
    // queue was decided.
    const [, limit] = await Promise.all([
      this.params.store.createRun(run),
      this.resolveMaxParallel(),
    ]);
    this.params.emit({ type: "run", runId: run.id, dutyId: p.duty.id, status: "queued" });
    this.queue.push({
      run,
      duty: p.duty,
      toStepId: p.toStepId,
      keepOpen: p.keepOpen,
      targetId: p.targetId,
    });
    this.admitQueue(limit);
    const queued = !this.active.has(run.id);
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
    if (active) {
      return active;
    }
    return new Promise((resolve, reject) => {
      const resolvers = this.waiters.get(runId) ?? [];
      resolvers.push(resolve);
      this.waiters.set(runId, resolvers);
      void this.params.store.getRun(runId).then((r) => {
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
      if (waitingOn) {
        await this.params.cancelQuestion?.(waitingOn).catch(() => {});
      }
      return true;
    }
    // Not in memory. A run still recorded as waiting or working was parked when this Gateway
    // last stopped; the runner that owned it is gone, so the terminal row is written here.
    if (stored && !isTerminalRunStatus(stored.status)) {
      const waitingOn = stored.waitingOn?.questionId;
      if (waitingOn) {
        await this.params.cancelQuestion?.(waitingOn).catch(() => {});
      }
      await this.finish(stored, { status: "cancelled" });
      return true;
    }
    return false;
  }

  private canStart(duty: Duty, limit: number): boolean {
    if (this.active.size >= limit) {
      return false;
    }
    return !(duty.exclusive && (this.activeByDuty.get(duty.id) ?? 0) > 0);
  }

  /** The actual admission step, entirely synchronous: FIFO over the current queue, launching
   *  everything `canStart` allows against the given (already-resolved) limit. Every caller that
   *  mutates `queue`/`active` and then wants the queue re-evaluated goes through this one
   *  synchronous routine — `start()`, `drain()` (via `pump()`/`admit()`), never a second admission
   *  path — so at most `limit` runs are ever concurrently active regardless of who triggered the
   *  re-evaluation or how many callers raced to get here. */
  private admitQueue(limit: number): void {
    for (let i = 0; i < this.queue.length; i += 1) {
      const item = this.queue[i]!;
      if (!this.canStart(item.duty, limit)) {
        continue;
      }
      this.queue.splice(i, 1);
      i -= 1;
      this.launch(item);
    }
  }

  /** Fire-and-forget: resolves the current limit once, then admits synchronously against it. A
   *  caller never awaits `pump()` itself — every caller before this change was already
   *  fire-and-forget (`launch()`'s `.finally()`) — so turning it into a thin wrapper around an
   *  async drain keeps that call site unchanged. */
  private pump(): void {
    void this.drain();
  }

  private async drain(): Promise<void> {
    this.admitQueue(await this.resolveMaxParallel());
  }

  /** Re-evaluates the queue against the current limit right now, with no other event required to
   *  trigger it. Exists so a `maxParallelRuns` increase (the Desk card, `duties.settings.set`)
   *  starts an already-queued run immediately instead of leaving it to wait for the next
   *  unrelated `start()`/finish() — the run service is the one owner of admission, so the
   *  settings-set Gateway method calls this rather than reimplementing any part of it. */
  admit(): void {
    this.pump();
  }

  private launch(item: Pending): void {
    const { run, duty } = item;
    this.activeByDuty.set(duty.id, (this.activeByDuty.get(duty.id) ?? 0) + 1);
    const promise = (async (): Promise<DutyRun> => {
      try {
        await this.params.store.updateRun(run.id, { status: "running", startedAt: Date.now() });
        this.params.emit({ type: "run", runId: run.id, dutyId: duty.id, status: "running" });
        this.announce(run.origin, `Running ${duty.name}…`);
        let browserShown = false;
        if (run.origin?.sessionKey && this.params.progress) {
          this.progress.set(run.id, {
            dutyName: duty.name,
            total: countRunnableSteps(duty.steps),
            done: [],
          });
          this.postProgress(run, "Starting…");
        }
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
              const state = this.progress.get(run.id);
              if (state) {
                this.postProgress(
                  run,
                  waitingOn ? "Waiting for your answer" : (state.current ?? "Continuing…"),
                );
              }
            },
            onStepStart: (step) => {
              const state = this.progress.get(run.id);
              if (state) {
                state.current = step.label;
                this.postProgress(run, step.label);
              }
              if (step.kind.startsWith("browser") && !browserShown) {
                browserShown = true;
                this.showBrowser(run);
              }
            },
            onStep: (step) => {
              const state = this.progress.get(run.id);
              if (state) {
                state.done.push(step.label);
                state.current = undefined;
              }
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
          if (fresh) {
            await this.params.store.saveDuty({ ...fresh, lastRunAt: Date.now() });
          }
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
    if (this.progress.has(run.id)) {
      this.postProgress(run, terminalStatusLine(final), final.status === "ok" ? "ok" : "other");
      this.progress.delete(run.id);
      await (this.progressChains.get(run.id) ?? Promise.resolve());
      this.progressChains.delete(run.id);
    }
    const resolvers = this.waiters.get(run.id);
    if (resolvers) {
      for (const resolve of resolvers) {
        resolve(final);
      }
    }
    this.waiters.delete(run.id);
    return final;
  }
}
