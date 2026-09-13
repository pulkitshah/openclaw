import type { OpenClawPluginApi } from "../api.js";
import type { Duty } from "./duty.js";

export type RunStatus =
  | "queued"
  | "running"
  | "ok"
  | "failed"
  | "blocked"
  | "needs_input"
  | "cancelled"
  | "lost";
export type StepEvidence = {
  stepId: string;
  label: string;
  kind: string;
  status: "ok" | "failed" | "skipped";
  durationMs: number;
  summary: string;
  target?: string;
  screenshotBlobId?: string;
};
export type DutyRun = {
  id: string;
  dutyId: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  trigger: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  steps: StepEvidence[];
  failedStep?: string;
  report?: string;
  waitingOn?: { questionId: string; stepId: string };
};

type Keyed<T> = {
  register(key: string, value: T): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  entries(): Promise<Array<{ key: string; value: T }>>;
  delete(key: string): Promise<boolean>;
  /** The updater runs atomically against the current value; returning undefined leaves the entry unchanged. */
  update?: (key: string, fn: (current: T | undefined) => T | undefined) => Promise<boolean>;
};

export type DutyStores = { duties: Keyed<Duty>; runs: Keyed<DutyRun> };

export class DutyStore {
  constructor(private readonly stores: DutyStores) {}

  static open(api: OpenClawPluginApi): DutyStore {
    return new DutyStore({
      duties: api.runtime.state.openKeyedStore<Duty>({
        namespace: "duties",
        maxEntries: 5_000,
        overflowPolicy: "reject-new",
        // SAFETY: the real PluginStateKeyedStore is a superset of the local structural Keyed<T> (register/lookup/entries/delete/update all match by shape).
      }) as unknown as Keyed<Duty>,
      runs: api.runtime.state.openKeyedStore<DutyRun>({
        namespace: "runs",
        maxEntries: 50_000,
        overflowPolicy: "evict-oldest",
        defaultTtlMs: 90 * 24 * 3600 * 1000,
        // SAFETY: same PluginStateKeyedStore superset relationship as the duties store above.
      }) as unknown as Keyed<DutyRun>,
    });
  }

  async listDuties(): Promise<Duty[]> {
    const entries = await this.stores.duties.entries();
    return entries.map((e) => e.value).toSorted((a, b) => a.name.localeCompare(b.name));
  }
  getDuty(id: string) {
    return this.stores.duties.lookup(id);
  }
  saveDuty(duty: Duty) {
    return this.stores.duties.register(duty.id, duty);
  }
  deleteDuty(id: string) {
    return this.stores.duties.delete(id);
  }

  createRun(run: DutyRun) {
    return this.stores.runs.register(run.id, run);
  }
  getRun(id: string) {
    return this.stores.runs.lookup(id);
  }
  async updateRun(id: string, patch: Partial<DutyRun>): Promise<DutyRun | undefined> {
    const store = this.stores.runs;
    if (store.update) {
      const applied = await store.update(id, (cur) => (cur ? { ...cur, ...patch } : undefined));
      if (!applied) return undefined;
      return store.lookup(id);
    }
    const current = await store.lookup(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    await store.register(id, next);
    return next;
  }
  async listRuns(
    dutyId: string,
    opts?: { onlySuccessful?: boolean; limit?: number },
  ): Promise<DutyRun[]> {
    const entries = await this.stores.runs.entries();
    return entries
      .map((e) => e.value)
      .filter((r) => r.dutyId === dutyId && (!opts?.onlySuccessful || r.status === "ok"))
      .toSorted((a, b) => b.startedAt - a.startedAt)
      .slice(0, opts?.limit ?? 50);
  }
  async markRunningRunsLost(): Promise<number> {
    const store = this.stores.runs;
    const entries = await store.entries();
    let count = 0;
    for (const { key, value } of entries) {
      if (value.status !== "running" && value.status !== "queued") continue;
      if (store.update) {
        const applied = await store.update(key, (cur) =>
          cur && (cur.status === "running" || cur.status === "queued")
            ? { ...cur, status: "lost", endedAt: Date.now() }
            : undefined,
        );
        if (applied) count += 1;
        continue;
      }
      await store.register(key, { ...value, status: "lost", endedAt: Date.now() });
      count += 1;
    }
    return count;
  }
}
