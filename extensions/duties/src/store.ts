import type { OpenClawPluginApi } from "../api.js";
import type { Duty } from "./duty.js";

export type RunStatus = "queued" | "running" | "ok" | "failed" | "blocked" | "needs_input" | "cancelled" | "lost";
export type StepEvidence = {
  stepId: string; label: string; kind: string; status: "ok" | "failed" | "skipped";
  durationMs: number; summary: string; target?: string; screenshotBlobId?: string;
};
export type DutyRun = {
  id: string; dutyId: string; status: RunStatus; startedAt: number; endedAt?: number; trigger: string;
  inputs: Record<string, unknown>; outputs: Record<string, unknown>; steps: StepEvidence[];
  failedStep?: string; report?: string; waitingOn?: { questionId: string; stepId: string };
};

type Keyed<T> = {
  register(key: string, value: T): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  entries(): Promise<Array<{ key: string; value: T }>>;
  delete(key: string): Promise<boolean>;
};

export type DutyStores = { duties: Keyed<Duty>; runs: Keyed<DutyRun> };

export class DutyStore {
  constructor(private readonly stores: DutyStores) {}

  static open(api: OpenClawPluginApi): DutyStore {
    return new DutyStore({
      duties: api.runtime.state.openKeyedStore<Duty>({ namespace: "duties", maxEntries: 5_000, overflowPolicy: "reject-new" }) as unknown as Keyed<Duty>,
      runs: api.runtime.state.openKeyedStore<DutyRun>({ namespace: "runs", maxEntries: 50_000, overflowPolicy: "evict-oldest", defaultTtlMs: 90 * 24 * 3600 * 1000 }) as unknown as Keyed<DutyRun>,
    });
  }

  async listDuties(): Promise<Duty[]> {
    const entries = await this.stores.duties.entries();
    return entries.map((e) => e.value).toSorted((a, b) => a.name.localeCompare(b.name));
  }
  getDuty(id: string) { return this.stores.duties.lookup(id); }
  saveDuty(duty: Duty) { return this.stores.duties.register(duty.id, duty); }
  deleteDuty(id: string) { return this.stores.duties.delete(id); }

  createRun(run: DutyRun) { return this.stores.runs.register(run.id, run); }
  getRun(id: string) { return this.stores.runs.lookup(id); }
  async updateRun(id: string, patch: Partial<DutyRun>): Promise<DutyRun | undefined> {
    const current = await this.stores.runs.lookup(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    await this.stores.runs.register(id, next);
    return next;
  }
  async listRuns(dutyId: string, opts?: { onlySuccessful?: boolean; limit?: number }): Promise<DutyRun[]> {
    const entries = await this.stores.runs.entries();
    return entries.map((e) => e.value)
      .filter((r) => r.dutyId === dutyId && (!opts?.onlySuccessful || r.status === "ok"))
      .toSorted((a, b) => b.startedAt - a.startedAt)
      .slice(0, opts?.limit ?? 50);
  }
  async markRunningRunsLost(): Promise<number> {
    const entries = await this.stores.runs.entries();
    let count = 0;
    for (const { key, value } of entries) {
      if (value.status === "running" || value.status === "queued") {
        await this.stores.runs.register(key, { ...value, status: "lost", endedAt: Date.now() });
        count += 1;
      }
    }
    return count;
  }
}
