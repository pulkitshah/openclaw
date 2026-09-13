import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../api.js";
import { DUTY_STATUSES, validateDuty, type DutyStatus } from "./duty.js";
import type { RunManager } from "./run-service.js";
import type { DutyStore } from "./store.js";

type Ctx = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];
type Scope = "operator.read" | "operator.write" | "operator.admin";

/**
 * Registers the Duties Gateway RPC surface, following the
 * `registerWorkboardResultMethods`/`respondError` pattern in
 * `extensions/workboard/src/gateway-helpers.ts`: every handler resolves a plain result object and
 * `register` wraps it into `context.respond(true, result)` / `context.respond(false, undefined,
 * { code, message })`.
 */
export function registerDutiesGatewayMethods(params: {
  api: OpenClawPluginApi;
  store: DutyStore;
  runs: Pick<RunManager, "start" | "cancel">;
  emit: (name: "changed" | "run", payload: Record<string, unknown>) => void;
}): void {
  const { api, store, runs, emit } = params;

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

  register("duties.save", "operator.write", async (params) => {
    const candidate = isRecord(params.duty)
      ? { ...params.duty, updatedAt: Date.now() }
      : params.duty;
    const result = validateDuty(candidate);
    if (!result.ok) throw new Error(`invalid duty: ${result.errors.join("; ")}`);
    await store.saveDuty(result.duty);
    emit("changed", { dutyId: result.duty.id });
    return { duty: result.duty };
  });

  register("duties.delete", "operator.admin", async (params) => {
    const dutyId = readId(params);
    await store.deleteDuty(dutyId);
    emit("changed", { dutyId });
    return { ok: true };
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
    emit("changed", { dutyId: duty.id });
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
}
