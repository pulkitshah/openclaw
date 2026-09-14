import type { OpenClawPluginApi } from "../api.js";
import type { Duty } from "./duty.js";
import type { Brand, Template } from "./template.js";

export type RunStatus =
  | "queued"
  | "running"
  | "ok"
  | "failed"
  | "blocked"
  | "needs_input"
  | "cancelled"
  | "lost";
export type RunOrigin = {
  kind: "chat" | "mail" | "manual";
  sessionKey?: string;
  agentId?: string;
  channel?: string;
  accountId?: string;
};
export type RunFile = {
  stepId: string;
  name: string;
  path: string;
  bytes: number;
  contentType: string;
  /** PNG of the page this document was printed from, written beside it by the render adapter.
   *  Absent when the browser profile could not screenshot — `duties.run.file` then says so
   *  rather than inventing an image. */
  previewPath?: string;
};

/**
 * The Gateway session a run's `ai` and `ask` steps act under.
 *
 * `tools.invoke` and `question.request` both resolve the owning agent from the session key, and
 * under `agents.ownership: "explicit"` with more than one agent configured a bare `"main"` has no
 * owner at all (`AgentSelectionRequiredError`, src/agents/agent-scope-config.ts:42-59) — every
 * `ai`/`ask` step then fails before it runs. A run started from a chat turn, a mail dispatch, or an
 * authoring turn already carries the session that asked for it, so that session owns the run's
 * calls; a run that recorded only an agent falls back to that agent's own main session. `"main"`
 * remains the answer only for a run with no recorded origin, where a single-agent install resolves
 * it and a multi-agent one has nothing to resolve it to.
 */
export function runSessionKey(origin: RunOrigin | undefined): string {
  if (origin?.sessionKey) return origin.sessionKey;
  if (origin?.agentId) return `agent:${origin.agentId}:main`;
  return "main";
}
export type StepEvidence = {
  stepId: string;
  label: string;
  kind: string;
  /** Exactly what the runner emits: an `ok` step, a failed one, or an `ask` the owner never
   *  answered (`blocked`). A cancelled run writes no step row at all. */
  status: "ok" | "failed" | "blocked";
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
  targetId?: string;
  origin?: RunOrigin;
  files?: RunFile[];
};

type Keyed<T> = {
  register(key: string, value: T): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  entries(): Promise<Array<{ key: string; value: T }>>;
  delete(key: string): Promise<boolean>;
  /** The updater runs atomically against the current value; returning undefined leaves the entry unchanged. */
  update?: (key: string, fn: (current: T | undefined) => T | undefined) => Promise<boolean>;
};

/** Index of the credential keys the owner has saved. Only the key and when it was last written —
 *  the value itself never leaves the OS keychain, so it is never stored here. Listing keys from
 *  the keychain directly is not viable (`security dump-keychain` prompts and is heavy), so this
 *  index is what the Logins panel reads. */
export type CredKeyRecord = { key: string; updatedAt: number };

/** Owner-facing preferences shared across duties: who "the owner" resolves to for approvals
 *  and questions, and when the mail trigger last dispatched (so it can skip mail seen before). */
export type DutiesSettings = {
  owner?: { channel: string; target: string };
  lastMailDispatchAt?: number;
  lastMailDispatchDutyId?: string;
  /** Off by default: the agent edits Duties on its own, which is how a Duty gets repaired the
   *  moment it breaks. Turned on, an edit to an ACTIVE Duty is parked as a pending change and the
   *  live Duty keeps running unchanged until the owner applies it. */
  requireApprovalForEdits?: boolean;
  /** The RunManager's active-run ceiling (1-8; default 4 when unset — see `gateway-methods.ts`'s
   *  `duties.settings.set` validation and `index.ts`'s `RunManager` wiring). Read fresh on every
   *  `start()`/pump pass, so a hosted desk's owner can raise or lower it from the Duties page
   *  without a Gateway restart — sizing guidance (spec §6): `s-2vcpu-4gb` ≈ 2-3, `s-4vcpu-8gb` ≈ 6. */
  maxParallelRuns?: number;
};

export type DutyStores = {
  duties: Keyed<Duty>;
  runs: Keyed<DutyRun>;
  creds: Keyed<CredKeyRecord>;
  templates: Keyed<Template>;
  brands: Keyed<Brand>;
  settings: Keyed<DutiesSettings>;
};

/** Drops keys whose value is `undefined`. A run patch built from optional outcome fields
 *  (`failedStep`, `targetId`, `report`) otherwise carries explicit `undefined` values into the
 *  stored record, and the plugin state store rejects those as not JSON-serializable. Absent
 *  means "leave unchanged", which is what every caller means by an undefined patch field. */
function omitUndefined<T extends object>(patch: T): T {
  // SAFETY: filtering only REMOVES keys, and every key of a run patch is optional, so a `T` with fewer keys present is still a `T`.
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as T;
}

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
      creds: api.runtime.state.openKeyedStore<CredKeyRecord>({
        namespace: "creds",
        maxEntries: 1_000,
        overflowPolicy: "reject-new",
        // SAFETY: same PluginStateKeyedStore superset relationship as the duties store above.
      }) as unknown as Keyed<CredKeyRecord>,
      templates: api.runtime.state.openKeyedStore<Template>({
        namespace: "templates",
        maxEntries: 1_000,
        overflowPolicy: "reject-new",
        // SAFETY: same PluginStateKeyedStore superset relationship as the duties store above.
      }) as unknown as Keyed<Template>,
      brands: api.runtime.state.openKeyedStore<Brand>({
        namespace: "brands",
        maxEntries: 10,
        overflowPolicy: "reject-new",
        // SAFETY: same PluginStateKeyedStore superset relationship as the duties store above.
      }) as unknown as Keyed<Brand>,
      settings: api.runtime.state.openKeyedStore<DutiesSettings>({
        namespace: "settings",
        maxEntries: 10,
        overflowPolicy: "reject-new",
        // SAFETY: same PluginStateKeyedStore superset relationship as the duties store above.
      }) as unknown as Keyed<DutiesSettings>,
    });
  }

  async listCredKeys(): Promise<CredKeyRecord[]> {
    const entries = await this.stores.creds.entries();
    return entries.map((e) => e.value).toSorted((a, b) => a.key.localeCompare(b.key));
  }
  recordCredKey(key: string, updatedAt: number) {
    return this.stores.creds.register(key, { key, updatedAt });
  }
  forgetCredKey(key: string) {
    return this.stores.creds.delete(key);
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

  async listTemplates(): Promise<Template[]> {
    const entries = await this.stores.templates.entries();
    return entries.map((e) => e.value).toSorted((a, b) => a.name.localeCompare(b.name));
  }
  getTemplate(id: string) {
    return this.stores.templates.lookup(id);
  }
  saveTemplate(template: Template) {
    return this.stores.templates.register(template.id, template);
  }
  deleteTemplate(id: string) {
    return this.stores.templates.delete(id);
  }

  /** One brand per install, stored under a fixed key — there is no per-brand id to key on. */
  getBrand() {
    return this.stores.brands.lookup("default");
  }
  saveBrand(brand: Brand) {
    return this.stores.brands.register("default", brand);
  }

  async getSettings(): Promise<DutiesSettings> {
    return (await this.stores.settings.lookup("default")) ?? {};
  }
  /** Merges `patch` onto the current settings (or `{}` if unset) and returns the merged record,
   *  preferring the store's atomic `update` so concurrent patches never drop each other's fields. */
  async updateSettings(patch: Partial<DutiesSettings>): Promise<DutiesSettings> {
    const store = this.stores.settings;
    let merged: DutiesSettings = {};
    if (store.update) {
      await store.update("default", (cur) => {
        merged = { ...(cur ?? {}), ...patch };
        return merged;
      });
      return merged;
    }
    const current = (await store.lookup("default")) ?? {};
    merged = { ...current, ...patch };
    await store.register("default", merged);
    return merged;
  }

  createRun(run: DutyRun) {
    return this.stores.runs.register(run.id, run);
  }
  getRun(id: string) {
    return this.stores.runs.lookup(id);
  }
  async updateRun(id: string, rawPatch: Partial<DutyRun>): Promise<DutyRun | undefined> {
    const patch = omitUndefined(rawPatch);
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
  /** Appends one step to a run's evidence, preferring the store's atomic `update` so
   *  concurrent appends to the same run can never drop each other's step. */
  async appendRunStep(id: string, step: StepEvidence): Promise<DutyRun | undefined> {
    const store = this.stores.runs;
    if (store.update) {
      const applied = await store.update(id, (cur) =>
        cur ? { ...cur, steps: [...cur.steps, step] } : undefined,
      );
      if (!applied) return undefined;
      return store.lookup(id);
    }
    const current = await store.lookup(id);
    if (!current) return undefined;
    const next = { ...current, steps: [...current.steps, step] };
    await store.register(id, next);
    return next;
  }
  /** Appends one rendered file to a run's outputs, mirroring `appendRunStep`'s atomic-update
   *  preference so concurrent deliveries against the same run can never drop each other's file. */
  async appendRunFile(id: string, file: RunFile): Promise<DutyRun | undefined> {
    const store = this.stores.runs;
    if (store.update) {
      const applied = await store.update(id, (cur) =>
        cur ? { ...cur, files: [...(cur.files ?? []), file] } : undefined,
      );
      if (!applied) return undefined;
      return store.lookup(id);
    }
    const current = await store.lookup(id);
    if (!current) return undefined;
    const next = { ...current, files: [...(current.files ?? []), file] };
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
  /** Newest-first runs across every duty, regardless of status — unlike `listRuns`, which is
   *  scoped to one duty. Backs `duties.runs.recent` so the Board can show real failed/blocked
   *  history instead of only what this page session has observed via events. */
  async listRecentRuns(limit = 20): Promise<DutyRun[]> {
    const entries = await this.stores.runs.entries();
    return entries
      .map((e) => e.value)
      .toSorted((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
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
