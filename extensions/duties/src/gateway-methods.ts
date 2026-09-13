import { readFile, stat } from "node:fs/promises";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../api.js";
import type { RenderAdapter } from "./adapters/render.js";
import { DUTY_STATUSES, validateDuty, type DutyStatus } from "./duty.js";
import { mailStatusFromConfig } from "./mail.js";
import { renderTemplatePreview } from "./preview.js";
import type { RunManager } from "./run-service.js";
import type { DutyStore } from "./store.js";
import { validateBrand } from "./template.js";

type Ctx = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];
type Scope = "operator.read" | "operator.write" | "operator.admin";

/** Same per-entry ceiling the evidence blob store enforces on screenshots (`index.ts`), applied
 *  here by hand because a rendered document is a plain file with no store to bound it. */
const MAX_RUN_FILE_BYTES = 4 * 1024 * 1024;

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
  runs: Pick<RunManager, "start" | "cancel">;
  emit: (name: "changed" | "run", payload: Record<string, unknown>) => void;
  /** Credential writes. Values pass straight to the OS keychain and are never stored, logged,
   *  echoed in a result, or emitted in an event. */
  creds: { set(key: string, value: string): Promise<void>; delete(key: string): Promise<boolean> };
  evidence: () => EvidenceBlobs;
  render: RenderAdapter;
  previewDir: () => Promise<string>;
}): void {
  const { api, store, runs, emit, creds, evidence, render, previewDir } = params;

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
    return runs.start({
      duty,
      inputs: isRecord(params.inputs) ? params.inputs : {},
      trigger: "manual",
      toStepId: typeof params.toStepId === "string" ? params.toStepId : undefined,
      keepOpen: params.keepOpen === true,
      targetId: typeof params.targetId === "string" ? params.targetId : undefined,
    });
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
    const run = await store.getRun(runId);
    if (!run) throw new Error("no such run");
    // Only a path this run itself recorded is ever read: the caller never names a path, so this
    // method cannot be turned into an arbitrary file read.
    const file = (run.files ?? []).find((f) => f.stepId === params.stepId);
    if (!file) throw new Error("no document for that step");
    // Sized before reading, not after: base64 inflates by a third and the whole thing goes out in
    // one RPC frame. Matches the evidence blob store's own per-entry cap (`index.ts`).
    const info = await stat(file.path).catch(() => undefined);
    if (!info) throw new Error("that file is no longer stored");
    if (info.size > MAX_RUN_FILE_BYTES) {
      throw new Error(`file too large to return (${info.size} bytes)`);
    }
    const bytes = await readFile(file.path).catch(() => undefined);
    // The sweep can remove the run directory between the stat and the read.
    if (!bytes) throw new Error("that file is no longer stored");
    return { name: file.name, contentType: file.contentType, base64: bytes.toString("base64") };
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

  register("duties.template.preview", "operator.read", async (params) => {
    const id = readId(params);
    const data = isRecord(params.data) ? params.data : undefined;
    const preview = await renderTemplatePreview({
      store,
      render,
      previewDir,
      id,
      ...(data ? { data } : {}),
    });
    return {
      contentType: "application/pdf",
      base64: (await readFile(preview.path)).toString("base64"),
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

  register("duties.mail.status", "operator.read", async () =>
    mailStatusFromConfig(api.config, await store.getSettings()),
  );
}
