import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../api.js";
import { previewContentType, type RenderAdapter } from "./adapters/render.js";
import { readDeskHealth, type DeskHealth } from "./desk.js";
import {
  DEFAULT_MACHINE,
  DEFAULT_REPORTS_TO,
  DEFAULT_TRIGGERS,
  DUTY_STATUSES,
  summarizeDutyChange,
  validateDuty,
  validateRunInputs,
  type Duty,
  type DutyInput,
  type DutyNode,
  type DutyStatus,
  type DutyTrigger,
  type PendingDutyChange,
} from "./duty.js";
import { mailStatusFromConfig } from "./mail.js";
import { renderTemplatePreview } from "./preview.js";
import type { RunManager } from "./run-service.js";
import { renderStatusFromConfig } from "./setup.js";
import type { DutyStore, RunOrigin } from "./store.js";
import { provisionMemberAgent, readBootstrapPending, type GatewayRequest } from "./team-agent.js";
import { revokePairingEntries, writeTeamProjection } from "./team-write.js";
import {
  normalizeTeamMemberId,
  teamPolicyWarnings,
  type TeamChannelIdentity,
  type TeamMember,
} from "./team.js";
import { validateBrand, validateTemplate } from "./template.js";

/** How long `duties.run.wait` blocks before answering with the run as it stands. Short enough that
 *  one request never holds a connection for a whole `ask`, long enough that a polling caller is
 *  not spinning. */
const DEFAULT_RUN_WAIT_MS = 30_000;
const MAX_RUN_WAIT_MS = 120_000;

type Ctx = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];
type Scope = "operator.read" | "operator.write" | "operator.admin";

/** Same per-entry ceiling the evidence blob store enforces on screenshots (`index.ts`), applied
 *  here by hand because a rendered document is a plain file with no store to bound it. */
const MAX_RUN_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Reads a file this plugin itself produced and returns it base64, bounded.
 *
 * One owner for the bound: every method that answers a rendered document or its preview image
 * sends the whole thing in one RPC frame, and base64 inflates it by a third, so they share both
 * the ceiling and its wording. Sized before reading, not after — and the sweep can still remove
 * the file between the stat and the read.
 */
async function readCappedBase64(filePath: string): Promise<string> {
  const info = await stat(filePath).catch(() => undefined);
  if (!info) {
    throw new Error("that file is no longer stored");
  }
  if (info.size > MAX_RUN_FILE_BYTES) {
    throw new Error(`file too large to return (${info.size} bytes)`);
  }
  const bytes = await readFile(filePath).catch(() => undefined);
  if (!bytes) {
    throw new Error("that file is no longer stored");
  }
  return bytes.toString("base64");
}

/**
 * Registers the Duties Gateway RPC surface, following the
 * `registerWorkboardResultMethods`/`respondError` pattern in
 * `extensions/workboard/src/gateway-helpers.ts`: every handler resolves a plain result object and
 * `register` wraps it into `context.respond(true, result)` / `context.respond(false, undefined,
 * { code, message })`.
 */
/** The read side of the evidence blob store (`index.ts` owns opening it lazily). */
type EvidenceBlobs = {
  lookup(
    key: string,
  ): Promise<{ bytes: Uint8Array; metadata: { contentType: string } } | undefined>;
};

export function registerDutiesGatewayMethods(deps: {
  api: OpenClawPluginApi;
  store: DutyStore;
  runs: Pick<RunManager, "start" | "cancel" | "waitFor" | "status" | "admit">;
  emit: (name: "changed" | "run", payload: Record<string, unknown>) => void;
  /** Credential writes. Values pass straight to the OS keychain and are never stored, logged,
   *  echoed in a result, or emitted in an event. */
  creds: {
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<boolean>;
    /** Whether a key is stored. Never reads the value. */
    has(key: string): Promise<boolean>;
  };
  evidence: () => EvidenceBlobs;
  render: RenderAdapter;
  previewDir: () => Promise<string>;
  /** Trusted in-process Gateway dispatch, already built in `index.ts` with
   *  `{ scopes: ["operator.admin"] }`. Injectable so tests never reach a real Gateway. */
  request: GatewayRequest;
  /** Reads the config as it stands now, not the snapshot `register()` was handed: the Mail
   *  trigger health readout is exactly what an operator watches while fixing config, so answering
   *  it from a registration-time snapshot told them setup had not worked when it had. */
  config?: () => OpenClawConfig;
  /** Sends one line to the owner target. Used only to say that a change to an active Duty is
   *  waiting; best-effort, and never on the critical path of the write itself. */
  notifyOwner?: (text: string) => Promise<void>;
  /** Test injection point for `duties.desk.status`; defaults to `desk.ts`'s file-backed reader. */
  deskHealth?: () => Promise<DeskHealth>;
}): void {
  const { api, store, runs, emit, creds, evidence, render, previewDir, notifyOwner, request } =
    deps;
  const currentConfig = (): OpenClawConfig => deps.config?.() ?? api.config;
  const readDesk = deps.deskHealth ?? readDeskHealth;

  // A committed write (save/delete/status) must still be reported as `ok: true` even if
  // best-effort event delivery fails after it; `createDutiesEventService`'s own `emit` never
  // throws, but this guards the contract regardless of what `emit` is wired to.
  const safeEmit = (name: "changed" | "run", payload: Record<string, unknown>): void => {
    try {
      emit(name, payload);
    } catch {
      // Event delivery is best-effort; a failure here must never turn a committed write into a
      // reported Gateway failure.
    }
  };

  const register = (
    method: string,
    scope: Scope,
    handler: (params: Record<string, unknown>, ctx: Ctx) => Promise<unknown>,
  ) =>
    api.registerGatewayMethod(
      method,
      async (ctx: Ctx) => {
        try {
          ctx.respond(true, await handler(isRecord(ctx.params) ? ctx.params : {}, ctx));
        } catch (error) {
          ctx.respond(false, undefined, {
            code: "duties_error",
            message: coerceErrorMessage(error),
          });
        }
      },
      { scope },
    );

  /** Re-asserts that the admin connection that dispatched this request still holds its authority,
   *  synchronously, immediately before a durable effect. `authorizeGatewayMethod` checked the scope
   *  before the handler body ran, but the roster read, the `agents.create` dispatch and the
   *  projection all await in between — and `src/gateway/AGENTS.md` is explicit that a token or a
   *  matching id is not live authority. Absent on in-process callers, which is not a revocation. */
  const assertStillAuthorized = (ctx: Ctx): void => {
    if (ctx.hasCurrentClientAuthority?.() === false) {
      throw new Error("your session is no longer authorized — reconnect and try again");
    }
  };

  const readId = (params: Record<string, unknown>): string => {
    if (typeof params.id !== "string" || !params.id) {
      throw new Error("id is required");
    }
    return params.id;
  };
  const readRunId = (params: Record<string, unknown>): string => {
    if (typeof params.runId !== "string" || !params.runId) {
      throw new Error("runId is required");
    }
    return params.runId;
  };
  const readCredKey = (params: Record<string, unknown>): string => {
    if (typeof params.key !== "string" || !params.key) {
      throw new Error("key is required");
    }
    return params.key;
  };
  const readMemberId = (params: Record<string, unknown>): string => {
    if (typeof params.memberId !== "string" || !params.memberId) {
      throw new Error("memberId is required");
    }
    return normalizeTeamMemberId(params.memberId);
  };

  /** Channel identities arrive as ordinary params, so only the known fields in the known shapes are
   *  kept. An identity with no channel or no sender id is rejected rather than stored half-formed —
   *  it would become an allowlist entry and a routing key. */
  const readIdentities = (value: unknown): TeamChannelIdentity[] => {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error("channels is required: at least one { channel, senderId }");
    }
    const now = Date.now();
    return value.map((raw, index) => {
      if (!isRecord(raw)) throw new Error(`channels[${index}]: must be an object`);
      const channel = typeof raw.channel === "string" ? raw.channel.trim() : "";
      const senderId = typeof raw.senderId === "string" ? raw.senderId.trim() : "";
      if (!channel) throw new Error(`channels[${index}].channel is required`);
      if (!senderId) throw new Error(`channels[${index}].senderId is required`);
      const accountId = typeof raw.accountId === "string" ? raw.accountId.trim() : "";
      return { channel, senderId, ...(accountId ? { accountId } : {}), addedAt: now };
    });
  };
  /** Validates a caller-supplied run origin. The tools capture this from their trusted tool
   *  context, but it arrives here as ordinary params, so only the known fields in the known shapes
   *  are kept — an unknown `kind` is rejected rather than quietly recorded, and anything else is
   *  dropped. Absent origin means a manual run (the Control UI and the CLI). */
  const readOrigin = (value: unknown): RunOrigin => {
    // A UI or CLI run records `kind: "manual"` rather than nothing, so `run.origin` is always
    // present and means what spec §3.5 says it means.
    if (value === undefined || value === null) {
      return { kind: "manual" };
    }
    if (!isRecord(value)) {
      throw new Error("origin must be an object");
    }
    const kind = value.kind;
    if (kind !== "chat" && kind !== "mail" && kind !== "manual") {
      throw new Error('origin.kind must be "chat", "mail" or "manual"');
    }
    const str = (field: unknown): string | undefined =>
      typeof field === "string" && field ? field : undefined;
    return {
      kind,
      ...(str(value.sessionKey) ? { sessionKey: str(value.sessionKey)! } : {}),
      ...(str(value.agentId) ? { agentId: str(value.agentId)! } : {}),
      ...(str(value.channel) ? { channel: str(value.channel)! } : {}),
      ...(str(value.accountId) ? { accountId: str(value.accountId)! } : {}),
    };
  };

  const requireDuty = async (dutyId: string) => {
    const duty = await store.getDuty(dutyId);
    if (!duty) {
      throw new Error(`no Duty "${dutyId}"`);
    }
    return duty;
  };

  register("duties.list", "operator.read", async () => ({ duties: await store.listDuties() }));

  register("duties.get", "operator.read", async (params) => {
    const duty = await requireDuty(readId(params));
    return { duty, runs: await store.listRuns(duty.id, { onlySuccessful: true, limit: 20 }) };
  });

  register("duties.runs.recent", "operator.read", async (params) => {
    const requested = params.limit;
    if (requested !== undefined && typeof requested !== "number") {
      throw new Error("limit must be a number");
    }
    const limit = Math.max(1, Math.min(100, requested ?? 20));
    return { runs: await store.listRecentRuns(limit) };
  });

  /**
   * Whether an edit to this Duty has to wait for the owner.
   *
   * Off by default, deliberately: the agent editing a Duty on its own is how a Duty gets repaired
   * the moment it breaks, and that is wanted. An owner who would rather see every change to a Duty
   * that is already live turns `requireApprovalForEdits` on, and only ACTIVE Duties are gated —
   * a `building` Duty is still being written, and pausing/resuming one is not an edit to what it
   * does.
   */
  const needsApproval = async (existing: Duty | undefined): Promise<boolean> =>
    existing?.status === "active" && (await store.getSettings()).requireApprovalForEdits === true;

  /**
   * Parks a validated candidate on the live Duty and tells the owner it is waiting.
   *
   * The owner applies it with `duties.change.apply`; there is no Apply/Discard card here on
   * purpose. A card would have to park on `question.waitAnswer` for as long as the owner takes,
   * and the only thing in this plugin that waits on a question is the RunManager, inside a run —
   * a second waiter living in an RPC handler would be a competing owner of the same contract for
   * a flow that has no run to park. The message names the two methods instead; the Control UI
   * wave can put buttons on them.
   */
  const parkChange = async (current: Duty, next: Duty) => {
    const { pendingChange: _superseded, ...candidate } = next;
    const change: PendingDutyChange = {
      id: `chg_${randomUUID()}`,
      duty: candidate,
      requestedAt: Date.now(),
      summary: summarizeDutyChange(current, candidate),
    };
    // A second edit while one is pending replaces it: the owner is shown the newest intent, never
    // asked to approve a change the agent has already moved past.
    await store.saveDuty({ ...current, pendingChange: change });
    safeEmit("changed", { dutyId: current.id, pendingChangeId: change.id });
    void notifyOwner?.(
      `${current.name}: a change to this active Duty is waiting for you — ${change.summary}. Apply it with duties.change.apply { dutyId: "${current.id}" }, or drop it with duties.change.discard.`,
    ).catch(() => {});
    return {
      ok: true,
      pending: true,
      changeId: change.id,
      summary: change.summary,
      duty: current,
      message:
        "This Duty is active and edits need the owner's approval. The change is waiting for them — tell the owner it is waiting and stop; do not act as if it were applied.",
    };
  };

  register("duties.save", "operator.write", async (params) => {
    const candidate = isRecord(params.duty)
      ? { ...params.duty, updatedAt: Date.now() }
      : params.duty;
    const result = validateDuty(candidate);
    if (!result.ok) {
      throw new Error(`invalid duty: ${result.errors.join("; ")}`);
    }
    const existing = await store.getDuty(result.duty.id);
    if (await needsApproval(existing)) {
      return parkChange(existing!, result.duty);
    }
    await store.saveDuty(result.duty);
    safeEmit("changed", { dutyId: result.duty.id });
    return { duty: result.duty };
  });

  /** Creates a Duty (status `building`) or updates an existing one's header fields, keeping its
   *  steps. Deliberately NOT validated as a whole: a header draft may still be missing what an
   *  active Duty needs, and only `duties.steps`/`duties.save` enforce the full shape. */
  register("duties.draft", "operator.write", async (params) => {
    const id = readId(params);
    const existing = await store.getDuty(id);
    const str = (value: unknown, fallback: string) =>
      typeof value === "string" ? value : fallback;
    const draft: Duty = {
      id,
      name: str(params.name, existing?.name ?? ""),
      summary: str(params.summary, existing?.summary ?? ""),
      status: existing?.status ?? "building",
      machine: str(params.machine, existing?.machine ?? DEFAULT_MACHINE),
      reportsTo: str(params.reportsTo, existing?.reportsTo ?? DEFAULT_REPORTS_TO),
      ...(params.exclusive !== undefined
        ? { exclusive: params.exclusive === true }
        : existing?.exclusive !== undefined
          ? { exclusive: existing.exclusive }
          : {}),
      // A header draft is saved as-is and only duties.steps/duties.save enforce the full shape.
      // SAFETY: authored duty config passed straight through; an invalid shape only ever surfaces from validateDuty in duties.steps/duties.save, never from this draft save.
      inputs: (params.inputs as DutyInput[] | undefined) ?? existing?.inputs ?? [],
      steps: existing?.steps ?? [],
      // SAFETY: see inputs above.
      triggers: (params.triggers as DutyTrigger[] | undefined) ??
        existing?.triggers ?? [...DEFAULT_TRIGGERS],
      updatedAt: Date.now(),
      ...(existing?.lastRunAt !== undefined ? { lastRunAt: existing.lastRunAt } : {}),
    };
    if (await needsApproval(existing)) {
      return parkChange(existing!, draft);
    }
    await store.saveDuty(draft);
    safeEmit("changed", { dutyId: id });
    return { ok: true, duty: draft };
  });

  /** Replaces a Duty's steps, validating the whole Duty first and returning the validator's own
   *  errors verbatim rather than throwing, so an author can act on them. */
  register("duties.steps", "operator.write", async (params) => {
    const id = readId(params);
    const existing = await store.getDuty(id);
    if (!existing) {
      throw new Error(`no Duty "${id}"`);
    }
    // SAFETY: authored duty config passed straight to validateDuty, which structurally checks every node; an invalid shape is reported in `errors`.
    const steps = (params.steps as DutyNode[] | undefined) ?? [];
    const result = validateDuty({ ...existing, steps, updatedAt: Date.now() });
    if (!result.ok) {
      return { ok: false, errors: result.errors };
    }
    if (await needsApproval(existing)) {
      return parkChange(existing, result.duty);
    }
    await store.saveDuty(result.duty);
    safeEmit("changed", { dutyId: id });
    return { ok: true, duty: result.duty };
  });

  /** What is waiting for the owner on this Duty, if anything. */
  register("duties.change.get", "operator.read", async (params) => {
    const duty = await requireDuty(readId(params));
    return {
      pending: duty.pendingChange !== undefined,
      ...(duty.pendingChange ? { change: duty.pendingChange } : {}),
    };
  });

  /** Applies the waiting change. Admin-only: this is the owner's decision, made on their behalf
   *  only by something holding their authority. The candidate was validated when it was parked,
   *  so applying it cannot fail on shape after the owner has said yes. */
  register("duties.change.apply", "operator.admin", async (params) => {
    const duty = await requireDuty(readId(params));
    const change = duty.pendingChange;
    if (!change) {
      throw new Error("no change is waiting on that Duty");
    }
    if (typeof params.changeId === "string" && params.changeId !== change.id) {
      throw new Error("that change has been superseded by a newer one");
    }
    // The candidate replaces the record outright — including dropping `pendingChange` itself —
    // but keeps the live Duty's run history.
    const applied: Duty = {
      ...change.duty,
      updatedAt: Date.now(),
      ...(duty.lastRunAt !== undefined ? { lastRunAt: duty.lastRunAt } : {}),
    };
    await store.saveDuty(applied);
    safeEmit("changed", { dutyId: duty.id });
    return { ok: true, duty: applied };
  });

  /** Drops the waiting change; the live Duty is untouched. */
  register("duties.change.discard", "operator.admin", async (params) => {
    const duty = await requireDuty(readId(params));
    if (!duty.pendingChange) {
      return { ok: false };
    }
    if (typeof params.changeId === "string" && params.changeId !== duty.pendingChange.id) {
      throw new Error("that change has been superseded by a newer one");
    }
    const { pendingChange: _discarded, ...live } = duty;
    await store.saveDuty(live);
    safeEmit("changed", { dutyId: duty.id });
    return { ok: true, duty: live };
  });

  register("duties.delete", "operator.admin", async (params) => {
    const dutyId = readId(params);
    const deleted = await store.deleteDuty(dutyId);
    if (deleted) {
      safeEmit("changed", { dutyId });
    }
    return { ok: deleted };
  });

  register("duties.status", "operator.write", async (params) => {
    const duty = await requireDuty(readId(params));
    const status = params.status;
    // SAFETY: includes() is the actual runtime membership check; the cast only lets an arbitrary status be compared, and a non-DutyStatus value is reported as an error on the next line.
    if (typeof status !== "string" || !DUTY_STATUSES.includes(status as DutyStatus)) {
      throw new Error("status must be active or paused");
    }
    if (status === "building") {
      throw new Error("status must be active or paused");
    }
    // SAFETY: status was checked above against DUTY_STATUSES with "building" excluded, so it can only be "active" or "paused" here.
    const next = { ...duty, status: status as DutyStatus, updatedAt: Date.now() };
    await store.saveDuty(next);
    safeEmit("changed", { dutyId: duty.id });
    return { duty: next };
  });

  register("duties.run", "operator.write", async (params) => {
    const duty = await requireDuty(readId(params));
    const inputs = isRecord(params.inputs) ? params.inputs : {};
    // A `mail`/`file` input the caller never supplied would otherwise surface deep inside the run
    // as an unresolved placeholder, so the run is refused before it is even created. The tool used
    // to do this before starting a run; now that every caller comes through here, the check does.
    const errors = validateRunInputs(duty, inputs);
    if (errors.length) {
      return { ok: false, errors };
    }
    const origin = readOrigin(params.origin);
    if (origin.kind === "mail") {
      await store.updateSettings({
        lastMailDispatchAt: Date.now(),
        lastMailDispatchDutyId: duty.id,
      });
    }
    return runs.start({
      duty,
      inputs,
      trigger: origin.kind,
      origin,
      toStepId: typeof params.toStepId === "string" ? params.toStepId : undefined,
      keepOpen: params.keepOpen === true,
      targetId: typeof params.targetId === "string" ? params.targetId : undefined,
    });
  });

  /** Waits for a run to reach a terminal status, or for `timeoutMs` to elapse — whichever comes
   *  first — and returns the run either way. A caller that must block until a run finishes (the
   *  `duty_run` tool) polls this instead of holding a reference to the RunManager, which only the
   *  full registration owns. */
  register("duties.run.wait", "operator.read", async (params) => {
    const runId = readRunId(params);
    const requested = params.timeoutMs;
    if (requested !== undefined && typeof requested !== "number") {
      throw new Error("timeoutMs must be a number");
    }
    const budget = Math.max(0, Math.min(MAX_RUN_WAIT_MS, requested ?? DEFAULT_RUN_WAIT_MS));
    const run = await runs.waitFor(runId, budget);
    if (!run) {
      throw new Error("no such run");
    }
    return { run };
  });

  register("duties.run.get", "operator.read", async (params) => {
    const run = await store.getRun(readRunId(params));
    if (!run) {
      throw new Error("no such run");
    }
    return { run };
  });

  register("duties.run.cancel", "operator.write", async (params) => ({
    ok: await runs.cancel(readRunId(params)),
  }));

  register("duties.run.evidence", "operator.read", async (params) => {
    const runId = readRunId(params);
    if (typeof params.stepId !== "string" || !params.stepId) {
      throw new Error("stepId is required");
    }
    const run = await store.getRun(runId);
    if (!run) {
      throw new Error("no such run");
    }
    const blobId = run.steps.find((step) => step.stepId === params.stepId)?.screenshotBlobId;
    if (!blobId) {
      throw new Error("no screenshot for that step");
    }
    const entry = await evidence().lookup(blobId);
    if (!entry) {
      throw new Error("that screenshot is no longer stored");
    }
    return {
      contentType: entry.metadata.contentType,
      base64: Buffer.from(entry.bytes).toString("base64"),
    };
  });

  register("duties.cred.set", "operator.admin", async (params) => {
    const key = readCredKey(params);
    if (typeof params.value !== "string" || !params.value) {
      throw new Error("value is required");
    }
    await creds.set(key, params.value);
    await store.recordCredKey(key, Date.now());
    return { ok: true };
  });

  register("duties.cred.list", "operator.read", async () => {
    const stored = await store.listCredKeys();
    return {
      keys: stored.map((entry) => entry.key),
      updatedAt: Object.fromEntries(stored.map((entry) => [entry.key, entry.updatedAt])),
    };
  });

  register("duties.cred.delete", "operator.admin", async (params) => {
    const key = readCredKey(params);
    const removed = await creds.delete(key);
    // The index entry goes regardless: a keychain item the owner removed by hand must not keep
    // the panel claiming a login is stored.
    await store.forgetCredKey(key);
    return { ok: removed };
  });

  register("duties.run.file", "operator.read", async (params) => {
    const runId = readRunId(params);
    if (typeof params.stepId !== "string" || !params.stepId) {
      throw new Error("stepId is required");
    }
    if (params.kind !== undefined && params.kind !== "document" && params.kind !== "preview") {
      throw new Error('kind must be "document" or "preview"');
    }
    const run = await store.getRun(runId);
    if (!run) {
      throw new Error("no such run");
    }
    // Only a path this run itself recorded is ever read: the caller never names a path, so this
    // method cannot be turned into an arbitrary file read.
    const file = (run.files ?? []).find((f) => f.stepId === params.stepId);
    if (!file) {
      throw new Error("no document for that step");
    }
    if (params.kind === "preview") {
      if (!file.previewPath) {
        throw new Error("no preview image for that step");
      }
      const preview = await readCappedBase64(file.previewPath);
      return {
        name: basename(file.previewPath),
        contentType: previewContentType(file.previewPath),
        base64: preview,
      };
    }
    return {
      name: file.name,
      contentType: file.contentType,
      base64: await readCappedBase64(file.path),
    };
  });

  register("duties.template.list", "operator.read", async () => ({
    templates: await store.listTemplates(),
  }));

  register("duties.template.get", "operator.read", async (params) => {
    const id = readId(params);
    const template = await store.getTemplate(id);
    if (!template) {
      throw new Error(`no template "${id}"`);
    }
    return { template };
  });

  register("duties.template.delete", "operator.admin", async (params) => {
    const id = readId(params);
    const deleted = await store.deleteTemplate(id);
    if (deleted) {
      safeEmit("changed", { templateId: id });
    }
    return { ok: deleted };
  });

  register("duties.template.set", "operator.write", async (params) => {
    if (!isRecord(params.template)) {
      throw new Error("template is required");
    }
    const result = validateTemplate({ ...params.template, updatedAt: Date.now() });
    if (!result.ok) {
      return { ok: false, errors: result.errors };
    }
    await store.saveTemplate(result.template);
    safeEmit("changed", { templateId: result.template.id });
    return { ok: true, template: result.template };
  });

  /** Renders a preview to a file and returns where it landed. `duties.template.preview` below
   *  answers the same render as base64 for the Control UI; both go through `renderTemplatePreview`
   *  so the owner can never be shown two different documents for one template.
   *
   *  `operator.write`, not read: rendering drives the managed browser, opens a tab and writes a
   *  file to disk. The spec put preview on the read side, but nothing about this call is a read. */
  register("duties.template.render", "operator.write", async (params) => {
    const id = readId(params);
    const data = isRecord(params.data) ? params.data : undefined;
    return await renderTemplatePreview({
      store,
      render,
      previewDir,
      id,
      ...(data ? { data } : {}),
    });
  });

  /** Whether a credential key is stored. Never returns, echoes, or logs a value. */
  register("duties.cred.has", "operator.read", async (params) => ({
    stored: await creds.has(readCredKey(params)),
  }));

  /** The same render as `duties.template.render`, answered inline for the Control UI: the printed
   *  PDF and, when the profile could take one, an image of the same page (PNG, or JPEG when the
   *  browser adapter normalised the capture — see `previewContentType`). Both are capped like
   *  `duties.run.file`. `preview` is omitted rather than null when there is no image. */
  register("duties.template.preview", "operator.write", async (params) => {
    const id = readId(params);
    const data = isRecord(params.data) ? params.data : undefined;
    const rendered = await renderTemplatePreview({
      store,
      render,
      previewDir,
      id,
      ...(data ? { data } : {}),
    });
    const previewPath = rendered.previewPath;
    const image = previewPath
      ? await readCappedBase64(previewPath).catch(() => undefined)
      : undefined;
    return {
      pdf: { contentType: "application/pdf", base64: await readCappedBase64(rendered.path) },
      ...(image && previewPath
        ? { preview: { contentType: previewContentType(previewPath), base64: image } }
        : {}),
    };
  });

  register("duties.brand.get", "operator.read", async () => ({ brand: await store.getBrand() }));

  register("duties.brand.set", "operator.write", async (params) => {
    const candidate = isRecord(params.brand)
      ? { ...params.brand, updatedAt: Date.now() }
      : params.brand;
    const result = validateBrand(candidate);
    if (!result.ok) {
      throw new Error(`invalid brand: ${result.errors.join("; ")}`);
    }
    await store.saveBrand(result.brand);
    safeEmit("changed", { brand: true });
    return { brand: result.brand };
  });

  register("duties.settings.get", "operator.read", async () => ({
    settings: await store.getSettings(),
  }));

  register("duties.settings.set", "operator.admin", async (params, ctx) => {
    const owner = params.owner;
    const approval = params.requireApprovalForEdits;
    const maxParallelRuns = params.maxParallelRuns;
    if (approval !== undefined && typeof approval !== "boolean") {
      throw new Error("requireApprovalForEdits must be a boolean");
    }
    if (
      maxParallelRuns !== undefined &&
      (typeof maxParallelRuns !== "number" ||
        !Number.isInteger(maxParallelRuns) ||
        maxParallelRuns < 1 ||
        maxParallelRuns > 8)
    ) {
      throw new Error("maxParallelRuns must be a whole number from 1 to 8");
    }
    if (owner === undefined && approval === undefined && maxParallelRuns === undefined) {
      throw new Error("owner, requireApprovalForEdits, or maxParallelRuns is required");
    }
    const patch: Parameters<typeof store.updateSettings>[0] = {};
    if (owner !== undefined) {
      if (!isRecord(owner)) {
        throw new Error("owner is required");
      }
      const channel = owner.channel;
      const target = owner.target;
      if (typeof channel !== "string" || !channel.trim()) {
        throw new Error("owner.channel is required");
      }
      if (typeof target !== "string" || !target.trim()) {
        throw new Error("owner.target is required");
      }
      const ownerPatch = { channel: channel.trim(), target: target.trim() };
      patch.owner = ownerPatch;
      // The owner row is the one owner of "who the desk reports to". Keep writing
      // `settings.owner` so an empty roster can still seed from it, and mirror the change onto the
      // owner's first channel identity when a roster already exists — otherwise this method would
      // silently write a field `ownerTarget` no longer reads.
      const ownerRow = await store.ownerMember();
      if (ownerRow) {
        const rest = ownerRow.channels.filter((c) => c.channel !== ownerPatch.channel);
        // A durable effect: re-check live authority immediately before it, same as every other
        // write this module performs (`assertStillAuthorized`'s own contract).
        assertStillAuthorized(ctx);
        await store.setMemberChannels(ownerRow.id, [
          { channel: ownerPatch.channel, senderId: ownerPatch.target, addedAt: Date.now() },
          ...rest,
        ]);
      }
    }
    if (approval !== undefined) {
      patch.requireApprovalForEdits = approval;
    }
    if (maxParallelRuns !== undefined) {
      patch.maxParallelRuns = maxParallelRuns;
    }
    const settings = await store.updateSettings(patch);
    safeEmit("changed", { settings: true });
    // One owner of admission: rather than a second queue-draining path here, tell the RunManager
    // to re-evaluate right now. A lowered limit is a no-op (admitQueue never evicts an active
    // run); a raised limit starts an already-queued run immediately instead of leaving it to wait
    // for the next unrelated start()/finish().
    if (maxParallelRuns !== undefined) {
      runs.admit();
    }
    return { settings };
  });

  /** The roster, seeding the one owner row on first read. The owner is a Team member from the
   *  start: the Duties Owner card already names a channel and a target, and that IS an owner
   *  identity, so it is promoted rather than asked for twice. */
  /** One shape for both the seeded and the already-populated answer, so the Team card never sees
   *  two different payloads. `warnings` is the non-throwing read: a warning is information, and
   *  `duties.team.get` is `operator.read`, so it must never refuse. */
  const teamView = async (members: TeamMember[]) => ({
    members: await Promise.all(
      members.map(async (member) => ({
        ...member,
        bootstrapPending: await readBootstrapPending(member.agentWorkspace),
      })),
    ),
    warnings: teamPolicyWarnings(currentConfig(), members),
  });

  register("duties.team.get", "operator.read", async (_params, ctx) => {
    const existing = await store.listMembers();
    if (existing.length > 0) return await teamView(existing);
    const settings = await store.getSettings();
    if (!settings.owner) return { members: [], warnings: [] };
    const agentId = resolveAgentRoute({
      cfg: currentConfig(),
      channel: settings.owner.channel,
      peer: { kind: "direct", id: settings.owner.target },
    }).agentId;
    // A seed is a durable effect: re-check live authority immediately before it, the same as any
    // other write this module performs.
    assertStillAuthorized(ctx);
    const seeded = await store.seedOwner({
      id: "owner",
      name: "Owner",
      agentId,
      addedBy: "owner",
      channels: [
        { channel: settings.owner.channel, senderId: settings.owner.target, addedAt: Date.now() },
      ],
    });
    return await teamView([seeded]);
  });

  register("duties.team.add", "operator.admin", async (params, ctx) => {
    if (typeof params.name !== "string" || !params.name.trim()) {
      throw new Error("name is required");
    }
    const name = params.name.trim();
    const memberId =
      typeof params.id === "string" && params.id.trim()
        ? normalizeTeamMemberId(params.id)
        : normalizeTeamMemberId(name.replace(/\s+/g, "-"));
    const channels = readIdentities(params.channels);
    if (await store.getMember(memberId)) throw new Error(`Team already has a member "${memberId}"`);
    const owner = await store.ownerMember();
    if (!owner) throw new Error("set the owner on the Duties page before adding anyone else");

    // Ordering matters: `pickFirstExistingAgentId` (src/routing/resolve-route.ts:147-173) throws
    // AgentSelectionRequiredError when a binding names an agent that is absent from
    // `agents.entries`, so the agent is created and read back BEFORE the projection runs.
    assertStillAuthorized(ctx);
    const agent = await provisionMemberAgent({ request, name });

    const member = await store.addMember({
      id: memberId,
      name,
      agentId: agent.agentId,
      ...(agent.workspace ? { agentWorkspace: agent.workspace } : {}),
      channels,
      addedBy: owner.id,
    });
    try {
      const { warnings } = await writeTeamProjection({
        members: await store.listMembers(),
        assertStillAuthorized: () => assertStillAuthorized(ctx),
      });
      safeEmit("changed", { team: true });
      return { ok: true, member, warnings };
    } catch (error) {
      // A rejected config write must not leave a roster row nothing enforces. The agent stays —
      // it is already created, and deleting it here would be the data loss GC1 rules out.
      await store.removeMember(memberId).catch(() => undefined);
      throw error;
    }
  });

  register("duties.team.setChannels", "operator.admin", async (params, ctx) => {
    const memberId = readMemberId(params);
    const identities = readIdentities(params.channels);
    const before = await store.getMember(memberId);
    if (!before) throw new Error(`no Team member "${memberId}"`);
    const member = await store.setMemberChannels(memberId, identities);
    const members = await store.listMembers();
    let warnings: string[];
    try {
      ({ warnings } = await writeTeamProjection({
        members,
        assertStillAuthorized: () => assertStillAuthorized(ctx),
      }));
    } catch (error) {
      // The channel write above already landed durably; a rejected projection (lost authority, an
      // assertTeamProjectionSafe refusal, a failed config write) must not leave it standing — a
      // config write is all-or-nothing, and so is this row. Same rollback shape as
      // `duties.team.add`'s own `store.removeMember(memberId).catch(() => undefined)`.
      await store.restoreMember(before).catch(() => undefined);
      throw error;
    }
    // An identity the member no longer has must lose its pairing-store approval too, or the
    // channel would keep admitting it independently of the allowlist.
    const dropped = before.channels.filter(
      (old) =>
        !identities.some((next) => next.channel === old.channel && next.senderId === old.senderId),
    );
    await revokePairingEntries({ runtime: api.runtime, identities: dropped });
    safeEmit("changed", { team: true });
    return { ok: true, member, warnings };
  });

  register("duties.team.remove", "operator.admin", async (params, ctx) => {
    const memberId = readMemberId(params);
    const member = await store.getMember(memberId);
    if (!member) throw new Error(`no Team member "${memberId}"`);
    // GC1: the row, the access-group entries, the links and the bindings go now. The agent and its
    // workspace stay — removal revokes access, it does not destroy a conversation.
    await store.removeMember(memberId);
    const members = await store.listMembers();
    let warnings: string[];
    try {
      ({ warnings } = await writeTeamProjection({
        members,
        assertStillAuthorized: () => assertStillAuthorized(ctx),
      }));
    } catch (error) {
      // The removal above already landed durably; a rejected projection must not leave it
      // standing, so the row goes back exactly as it was. Same rollback shape as
      // `duties.team.add`'s own `store.removeMember(memberId).catch(() => undefined)`.
      await store.restoreMember(member).catch(() => undefined);
      throw error;
    }
    await revokePairingEntries({ runtime: api.runtime, identities: member.channels });
    safeEmit("changed", { team: true });
    return { ok: true, removed: member, warnings };
  });

  register("duties.team.transferOwnership", "operator.admin", async (params, ctx) => {
    const memberId = readMemberId(params);
    // Snapshotted before the role swap below so a rejected projection can put both rows back
    // exactly as they were, not just report failure while the swap stands.
    const beforeOwner = await store.ownerMember();
    const beforeTarget = await store.getMember(memberId);
    const { from, to } = await store.transferOwnership(memberId);
    const members = await store.listMembers();
    let warnings: string[];
    try {
      ({ warnings } = await writeTeamProjection({
        members,
        assertStillAuthorized: () => assertStillAuthorized(ctx),
      }));
    } catch (error) {
      // The role swap above already landed durably on both rows; a rejected projection must not
      // leave a stuck ownership transfer standing — the worst-case outcome this guard exists to
      // prevent. Same rollback shape as `duties.team.add`'s own
      // `store.removeMember(memberId).catch(() => undefined)`.
      if (beforeOwner) await store.restoreMember(beforeOwner).catch(() => undefined);
      if (beforeTarget) await store.restoreMember(beforeTarget).catch(() => undefined);
      throw error;
    }
    // Approvals, questions and `to: "owner"` now resolve to the new owner, because `ownerTarget`
    // reads the owner row. Nothing else moves: the outgoing owner keeps their identities, their
    // access-group entries, their agent and their sessions.
    safeEmit("changed", { team: true, settings: true });
    return { ok: true, from, to, warnings };
  });

  /** Setup readiness for both of Part 2's outward-facing paths: the Gmail dispatch chain and
   *  document rendering. One readout, because one Settings strip shows it. */
  register("duties.mail.status", "operator.read", async () => ({
    ...mailStatusFromConfig(currentConfig(), await store.getSettings()),
    ...renderStatusFromConfig(currentConfig()),
  }));

  /** The hosted-desk "Desk" card's one readout (spec §8): the health file's own facts (or
   *  `{ hosted: false }` on a laptop install) plus the run manager's live ceiling and current
   *  activity, so the owner sees exactly what `maxParallelRuns` is doing right now. */
  register("duties.desk.status", "operator.read", async () => {
    const [health, settings] = await Promise.all([readDesk(), store.getSettings()]);
    return {
      ...health,
      maxParallelRuns: settings.maxParallelRuns ?? 4,
      ...runs.status(),
    };
  });
}
