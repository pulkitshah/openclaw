import { randomUUID } from "node:crypto";
import type { Duty } from "./duty.js";
import { runDuty, type RunnerDeps } from "./runner.js";
import type { DutyRun, DutyStore, RunStatus, StepEvidence } from "./store.js";

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

export class RunManager {
  private readonly active = new Map<string, Promise<DutyRun>>();
  private readonly waiters = new Map<string, { resolve: (run: DutyRun) => void }>();
  private readonly queue: Pending[] = [];
  private readonly activeByDuty = new Map<string, number>();
  private readonly cancelled = new Set<string>();
  private readonly maxParallel: number;
  constructor(
    private readonly params: {
      store: DutyStore;
      deps: () => RunnerDeps;
      emit: (event: RunEvent) => void;
      maxParallel?: number;
    },
  ) {
    this.maxParallel = params.maxParallel ?? 4;
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
    };
    await this.params.store.createRun(run);
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

  wait(runId: string): Promise<DutyRun> {
    const active = this.active.get(runId);
    if (active) return active;
    return new Promise((resolve) => {
      this.waiters.set(runId, { resolve });
      this.params.store.getRun(runId).then((r) => {
        if (r && !["queued", "running", "needs_input"].includes(r.status)) {
          this.waiters.delete(runId);
          resolve(r);
        }
      });
    });
  }

  async cancel(runId: string): Promise<boolean> {
    const index = this.queue.findIndex((q) => q.run.id === runId);
    if (index >= 0) {
      const [item] = this.queue.splice(index, 1);
      await this.finish(item!.run, { status: "cancelled" });
      return true;
    }
    if (this.active.has(runId)) {
      this.cancelled.add(runId);
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
    const promise = (async () => {
      await this.params.store.updateRun(run.id, { status: "running", startedAt: Date.now() });
      this.params.emit({ type: "run", runId: run.id, dutyId: duty.id, status: "running" });
      const deps = this.params.deps();
      const outcome = await runDuty(
        duty,
        {
          ...deps,
          onStep: (step) => {
            void this.appendStep(run.id, step);
            this.params.emit({
              type: "run",
              runId: run.id,
              dutyId: duty.id,
              status: "running",
              step,
            });
          },
        },
        {
          inputs: run.inputs,
          toStepId: item.toStepId,
          keepOpen: item.keepOpen,
          targetId: item.targetId,
        },
      );
      const status: RunStatus = this.cancelled.has(run.id) ? "cancelled" : outcome.status;
      const final = await this.finish(run, {
        status,
        outputs: outcome.outputs,
        steps: outcome.steps,
        failedStep: outcome.failedStep,
        report: outcome.report,
        targetId: item.keepOpen && outcome.targetId ? outcome.targetId : undefined,
      });
      if (status === "ok") {
        await this.params.store.saveDuty({ ...duty, lastRunAt: Date.now() });
      }
      return final;
    })().finally(() => {
      this.active.delete(run.id);
      this.cancelled.delete(run.id);
      this.activeByDuty.set(duty.id, Math.max(0, (this.activeByDuty.get(duty.id) ?? 1) - 1));
      this.pump();
    });
    this.active.set(run.id, promise);
  }

  /** Appends one step's evidence to the run's stored `steps`, reading the latest row so
   *  concurrent onStep calls don't clobber each other with a stale local copy. */
  private async appendStep(runId: string, step: StepEvidence): Promise<void> {
    const current = await this.params.store.getRun(runId);
    const steps = [...(current?.steps ?? []), step];
    await this.params.store.updateRun(runId, { steps });
  }

  private async finish(run: DutyRun, patch: Partial<DutyRun>): Promise<DutyRun> {
    const final = (await this.params.store.updateRun(run.id, {
      ...patch,
      endedAt: Date.now(),
    })) ?? {
      ...run,
      ...patch,
    };
    this.params.emit({ type: "run", runId: run.id, dutyId: run.dutyId, status: final.status });
    this.waiters.get(run.id)?.resolve(final);
    this.waiters.delete(run.id);
    return final;
  }
}
