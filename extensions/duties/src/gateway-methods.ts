import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../api.js";
import type { RenderAdapter } from "./adapters/render.js";
import {
  DEFAULT_MACHINE,
  DEFAULT_REPORTS_TO,
  DEFAULT_TRIGGERS,
  DUTY_STATUSES,
  validateDuty,
  validateRunInputs,
  type Duty,
  type DutyInput,
  type DutyNode,
  type DutyStatus,
  type DutyTrigger,
} from "./duty.js";
import { mailStatusFromConfig } from "./mail.js";
import { renderTemplatePreview } from "./preview.js";
import type { RunManager } from "./run-service.js";
import { renderStatusFromConfig } from "./setup.js";
import type { DutyStore, RunOrigin } from "./store.js";
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
  if (!info) throw new Error("that file is no longer stored");
  if (info.size > MAX_RUN_FILE_BYTES) {
    throw new Error(`file too large to return (${info.size} bytes)`);
  }
  const bytes = await readFile(filePath).catch(() => undefined);
  if (!bytes) throw new Error("that file is no longer stored");
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

export function registerDutiesGatewayMethods(params: {
  api: OpenClawPluginApi;
  store: DutyStore;
  runs: Pick<RunManager, "start" | "cancel" | "waitFor">;
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
  /** Reads the config as it stands now, not the snapshot `register()` was handed: the Mail
   *  trigger health readout is exactly what an operator watches while fixing config, so answering
   *  it from a registration-time snapshot told them setup had not worked when it had. */
  config?: () => OpenClawConfig;
}): void {
  const { api, store, runs, emit, creds, evidence, render, previewDir } = params;
  const currentConfig = (): OpenClawConfig => params.config?.() ?? api.config;

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
    handler: (params: Record<string, unknown>) => Promise<unknown>,
  ) =>
    api.registerGatewayMethod(
      method,
      async (ctx: Ctx) => {
        try {
          ctx.respond(true, await handler(isRecord(ctx.params) ? ctx.params : {}));
        } catch (error) {
          ctx.respond(false, undefined, {
            code: "duties_error",
            message: coerceErrorMessage(error),
          });
        }
      },
      { scope },
    );

  const readId = (params: Record<string, unknown>): string => {
    if (typeof params.id !== "string" || !params.id) throw new Error("id is required");
    return params.id;
  };
  const readRunId = (params: Record<string, unknown>): string => {
    if (typeof params.runId !== "string" || !params.runId) throw new Error("runId is required");
    return params.runId;
  };
  const readCredKey = (params: Record<string, unknown>): string => {
    if (typeof params.key !== "string" || !params.key) throw new Error("key is required");
    return params.key;
  };
  /** Validates a caller-supplied run origin. The tools capture this from their trusted tool
   *  context, but it arrives here as ordinary params, so only the known fields in the known shapes
   *  are kept — an unknown `kind` is rejected rather than quietly recorded, and anything else is
   *  dropped. Absent origin means a manual run (the Control UI and the CLI). */
  const readOrigin = (value: unknown): RunOrigin | undefined => {
    if (value === undefined || value === null) return undefined;
    if (!isRecord(value)) throw new Error("origin must be an object");
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
    if (!duty) throw new Error(`no Duty "${dutyId}"`);
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

  register("duties.save", "operator.write", async (params) => {
    const candidate = isRecord(params.duty)
      ? { ...params.duty, updatedAt: Date.now() }
      : params.duty;
    const result = validateDuty(candidate);
    if (!result.ok) throw new Error(`invalid duty: ${result.errors.join("; ")}`);
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
    await store.saveDuty(draft);
    safeEmit("changed", { dutyId: id });
    return { ok: true, duty: draft };
  });

  /** Replaces a Duty's steps, validating the whole Duty first and returning the validator's own
   *  errors verbatim rather than throwing, so an author can act on them. */
  register("duties.steps", "operator.write", async (params) => {
    const id = readId(params);
    const existing = await store.getDuty(id);
    if (!existing) throw new Error(`no Duty "${id}"`);
    // SAFETY: authored duty config passed straight to validateDuty, which structurally checks every node; an invalid shape is reported in `errors`.
    const steps = (params.steps as DutyNode[] | undefined) ?? [];
    const result = validateDuty({ ...existing, steps, updatedAt: Date.now() });
    if (!result.ok) return { ok: false, errors: result.errors };
    await store.saveDuty(result.duty);
    safeEmit("changed", { dutyId: id });
    return { ok: true, duty: result.duty };
  });

  register("duties.delete", "operator.admin", async (params) => {
    const dutyId = readId(params);
    const deleted = await store.deleteDuty(dutyId);
    if (deleted) safeEmit("changed", { dutyId });
    return { ok: deleted };
  });

  register("duties.status", "operator.write", async (params) => {
    const duty = await requireDuty(readId(params));
    const status = params.status;
    // SAFETY: includes() is the actual runtime membership check; the cast only lets an arbitrary status be compared, and a non-DutyStatus value is reported as an error on the next line.
    if (typeof status !== "string" || !DUTY_STATUSES.includes(status as DutyStatus)) {
      throw new Error("status must be active or paused");
    }
    if (status === "building") throw new Error("status must be active or paused");
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
    if (errors.length) return { ok: false, errors };
    const origin = readOrigin(params.origin);
    if (origin?.kind === "mail") {
      await store.updateSettings({
        lastMailDispatchAt: Date.now(),
        lastMailDispatchDutyId: duty.id,
      });
    }
    return runs.start({
      duty,
      inputs,
      trigger: origin?.kind ?? "manual",
      ...(origin ? { origin } : {}),
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
    if (!run) throw new Error("no such run");
    return { run };
  });

  register("duties.run.get", "operator.read", async (params) => {
    const run = await store.getRun(readRunId(params));
    if (!run) throw new Error("no such run");
    return { run };
  });

  register("duties.run.cancel", "operator.write", async (params) => ({
    ok: await runs.cancel(readRunId(params)),
  }));

  register("duties.run.evidence", "operator.read", async (params) => {
    const runId = readRunId(params);
    if (typeof params.stepId !== "string" || !params.stepId) throw new Error("stepId is required");
    const run = await store.getRun(runId);
    if (!run) throw new Error("no such run");
    const blobId = run.steps.find((step) => step.stepId === params.stepId)?.screenshotBlobId;
    if (!blobId) throw new Error("no screenshot for that step");
    const entry = await evidence().lookup(blobId);
    if (!entry) throw new Error("that screenshot is no longer stored");
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
    if (typeof params.stepId !== "string" || !params.stepId) throw new Error("stepId is required");
    if (params.kind !== undefined && params.kind !== "document" && params.kind !== "preview") {
      throw new Error('kind must be "document" or "preview"');
    }
    const run = await store.getRun(runId);
    if (!run) throw new Error("no such run");
    // Only a path this run itself recorded is ever read: the caller never names a path, so this
    // method cannot be turned into an arbitrary file read.
    const file = (run.files ?? []).find((f) => f.stepId === params.stepId);
    if (!file) throw new Error("no document for that step");
    if (params.kind === "preview") {
      if (!file.previewPath) throw new Error("no preview image for that step");
      const preview = await readCappedBase64(file.previewPath);
      return {
        name: basename(file.previewPath),
        contentType: "image/png",
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
    if (!template) throw new Error(`no template "${id}"`);
    return { template };
  });

  register("duties.template.delete", "operator.admin", async (params) => {
    const id = readId(params);
    const deleted = await store.deleteTemplate(id);
    if (deleted) safeEmit("changed", { templateId: id });
    return { ok: deleted };
  });

  register("duties.template.set", "operator.write", async (params) => {
    if (!isRecord(params.template)) throw new Error("template is required");
    const result = validateTemplate({ ...params.template, updatedAt: Date.now() });
    if (!result.ok) return { ok: false, errors: result.errors };
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
   *  PDF and, when the profile could take one, a PNG of the same page. Both are capped like
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
    const image = rendered.previewPath
      ? await readCappedBase64(rendered.previewPath).catch(() => undefined)
      : undefined;
    return {
      pdf: { contentType: "application/pdf", base64: await readCappedBase64(rendered.path) },
      ...(image ? { preview: { contentType: "image/png", base64: image } } : {}),
    };
  });

  register("duties.brand.get", "operator.read", async () => ({ brand: await store.getBrand() }));

  register("duties.brand.set", "operator.write", async (params) => {
    const candidate = isRecord(params.brand)
      ? { ...params.brand, updatedAt: Date.now() }
      : params.brand;
    const result = validateBrand(candidate);
    if (!result.ok) throw new Error(`invalid brand: ${result.errors.join("; ")}`);
    await store.saveBrand(result.brand);
    safeEmit("changed", { brand: true });
    return { brand: result.brand };
  });

  register("duties.settings.get", "operator.read", async () => ({
    settings: await store.getSettings(),
  }));

  register("duties.settings.set", "operator.admin", async (params) => {
    const owner = params.owner;
    if (!isRecord(owner)) throw new Error("owner is required");
    const channel = owner.channel;
    const target = owner.target;
    if (typeof channel !== "string" || !channel.trim())
      throw new Error("owner.channel is required");
    if (typeof target !== "string" || !target.trim()) throw new Error("owner.target is required");
    const settings = await store.updateSettings({
      owner: { channel: channel.trim(), target: target.trim() },
    });
    safeEmit("changed", { settings: true });
    return { settings };
  });

  /** Setup readiness for both of Part 2's outward-facing paths: the Gmail dispatch chain and
   *  document rendering. One readout, because one Settings strip shows it. */
  register("duties.mail.status", "operator.read", async () => ({
    ...mailStatusFromConfig(currentConfig(), await store.getSettings()),
    ...renderStatusFromConfig(currentConfig()),
  }));
}
