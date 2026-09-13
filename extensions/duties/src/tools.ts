import { jsonResult } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import {
  validateDuty,
  type Duty,
  type DutyInput,
  type DutyNode,
  type DutyTrigger,
} from "./duty.js";
import type { RunManager } from "./run-service.js";
import type { DutyStore } from "./store.js";

type OpenClawPluginApiLike = { registerTool(tool: AnyAgentTool, opts: { name: string }): void };

/** Sensible header defaults for a freshly-drafted Duty that hasn't stated who runs it or
 *  reports on it yet, so `duty_draft` can save a valid-enough header immediately and let
 *  `duty_set_steps`'s errors focus on the steps being authored, not these unset fields. */
const DEFAULT_MACHINE = "local";
const DEFAULT_REPORTS_TO = "owner";

function readId(input: unknown): string {
  if (!isRecord(input) || typeof input.id !== "string" || !input.id) {
    throw new Error("id is required");
  }
  return input.id;
}

/**
 * Registers the seven agent-facing Duties tools (`duty_list`, `duty_get`, `duty_draft`,
 * `duty_set_steps`, `duty_run`, `duty_save`, `cred_needed`) declared in `openclaw.plugin.json`'s
 * `contracts.tools`. Every tool returns `jsonResult(payload)`; failures are thrown as `Error`s,
 * following the same shape as `registerDutiesGatewayMethods` in `gateway-methods.ts`.
 */
export function registerDutyTools(params: {
  api: OpenClawPluginApiLike;
  store: DutyStore;
  runs: Pick<RunManager, "start" | "wait">;
  credHas: (key: string) => Promise<boolean>;
}): void {
  const { api, store, runs, credHas } = params;

  const register = (tool: AnyAgentTool) => api.registerTool(tool, { name: tool.name });

  register({
    name: "duty_list",
    label: "List Duties",
    description: "List every saved Duty with its id, name, status, and summary.",
    parameters: Type.Object({}),
    execute: async () => {
      const duties = await store.listDuties();
      return jsonResult({
        duties: duties.map((d) => ({
          id: d.id,
          name: d.name,
          status: d.status,
          summary: d.summary,
        })),
      });
    },
  });

  register({
    name: "duty_get",
    label: "Get Duty",
    description: "Get one Duty's full definition plus its last 5 successful runs.",
    parameters: Type.Object({ id: Type.String({ description: "Duty id." }) }),
    execute: async (_toolCallId, input) => {
      const id = readId(input);
      const duty = await store.getDuty(id);
      if (!duty) throw new Error(`no Duty "${id}"`);
      const runs_ = await store.listRuns(id, { onlySuccessful: true, limit: 5 });
      return jsonResult({ duty, runs: runs_ });
    },
  });

  register({
    name: "duty_draft",
    label: "Draft Duty",
    description:
      "Create a new Duty (status building) or update an existing one's header fields, keeping its existing steps.",
    parameters: Type.Object({
      id: Type.String({ description: "Kebab-case Duty id." }),
      name: Type.String({ description: "Owner-facing name." }),
      summary: Type.String({ description: "One-line summary of what this Duty does." }),
      machine: Type.Optional(Type.String({ description: "Machine this Duty runs on." })),
      reportsTo: Type.Optional(Type.String({ description: "Who/what this Duty reports to." })),
      exclusive: Type.Optional(
        Type.Boolean({ description: "Whether only one run of this Duty may be active at once." }),
      ),
      inputs: Type.Optional(Type.Array(Type.Unknown(), { description: "Duty inputs." })),
      triggers: Type.Optional(Type.Array(Type.Unknown(), { description: "Duty triggers." })),
    }),
    execute: async (_toolCallId, rawInput) => {
      if (!isRecord(rawInput)) throw new Error("id is required");
      const id = readId(rawInput);
      const existing = await store.getDuty(id);
      const draft: Duty = {
        id,
        name: typeof rawInput.name === "string" ? rawInput.name : (existing?.name ?? ""),
        summary:
          typeof rawInput.summary === "string" ? rawInput.summary : (existing?.summary ?? ""),
        status: existing?.status ?? "building",
        machine:
          typeof rawInput.machine === "string"
            ? rawInput.machine
            : (existing?.machine ?? DEFAULT_MACHINE),
        reportsTo:
          typeof rawInput.reportsTo === "string"
            ? rawInput.reportsTo
            : (existing?.reportsTo ?? DEFAULT_REPORTS_TO),
        ...(rawInput.exclusive !== undefined
          ? { exclusive: rawInput.exclusive === true }
          : existing?.exclusive !== undefined
            ? { exclusive: existing.exclusive }
            : {}),
        // A header draft is saved as-is (it may still be missing fields validateDuty
        // requires for an active Duty) and only `duty_set_steps`/`duty_save` enforce the
        // full shape, so inputs/triggers are trusted here rather than re-validated.
        // SAFETY: authored duty config passed straight through; an invalid shape only ever surfaces from validateDuty in duty_set_steps/duty_save, never from this draft save.
        inputs: (rawInput.inputs as DutyInput[] | undefined) ?? existing?.inputs ?? [],
        steps: existing?.steps ?? [],
        // SAFETY: see inputs above.
        triggers: (rawInput.triggers as DutyTrigger[] | undefined) ?? existing?.triggers ?? [],
        updatedAt: Date.now(),
        ...(existing?.lastRunAt !== undefined ? { lastRunAt: existing.lastRunAt } : {}),
      };
      await store.saveDuty(draft);
      return jsonResult({ ok: true, duty: draft });
    },
  });

  register({
    name: "duty_set_steps",
    label: "Set Duty Steps",
    description:
      "Replace a Duty's steps, validating them first. Returns validation errors verbatim on failure.",
    parameters: Type.Object({
      id: Type.String({ description: "Duty id." }),
      steps: Type.Array(Type.Unknown(), { description: "The Duty's full new step tree." }),
    }),
    execute: async (_toolCallId, rawInput) => {
      if (!isRecord(rawInput)) throw new Error("id is required");
      const id = readId(rawInput);
      const existing = await store.getDuty(id);
      if (!existing) throw new Error(`no Duty "${id}"`);
      // SAFETY: authored duty config passed straight to validateDuty below, which structurally checks every node; an invalid shape is reported in `errors`.
      const steps = (rawInput.steps as DutyNode[] | undefined) ?? [];
      const candidate: Duty = { ...existing, steps, updatedAt: Date.now() };
      const result = validateDuty(candidate);
      if (!result.ok) return jsonResult({ ok: false, errors: result.errors });
      await store.saveDuty(result.duty);
      return jsonResult({ ok: true, duty: result.duty });
    },
  });

  register({
    name: "duty_run",
    label: "Run Duty",
    description:
      "Start a Duty run and wait for it to finish (or pause on a stop step / needs_input), returning its status, evidence, outputs, and report. Pass toStepId + keepOpen to leave the browser tab open and continue authoring from the returned targetId.",
    parameters: Type.Object({
      id: Type.String({ description: "Duty id." }),
      inputs: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { description: "Run inputs." }),
      ),
      toStepId: Type.Optional(
        Type.String({ description: "Stop after running the step with this id." }),
      ),
      keepOpen: Type.Optional(
        Type.Boolean({ description: "Leave the browser tab open after the run stops." }),
      ),
      targetId: Type.Optional(
        Type.String({ description: "Continue in this already-open browser tab." }),
      ),
    }),
    execute: async (_toolCallId, rawInput) => {
      if (!isRecord(rawInput)) throw new Error("id is required");
      const id = readId(rawInput);
      const duty = await store.getDuty(id);
      if (!duty) throw new Error(`no Duty "${id}"`);
      const { runId } = await runs.start({
        duty,
        inputs: isRecord(rawInput.inputs) ? rawInput.inputs : {},
        trigger: "manual",
        toStepId: typeof rawInput.toStepId === "string" ? rawInput.toStepId : undefined,
        keepOpen: rawInput.keepOpen === true,
        targetId: typeof rawInput.targetId === "string" ? rawInput.targetId : undefined,
      });
      const run = await runs.wait(runId);
      return jsonResult({
        status: run.status,
        steps: run.steps,
        outputs: run.outputs,
        failedStep: run.failedStep,
        report: run.report,
        targetId: run.targetId,
      });
    },
  });

  register({
    name: "duty_save",
    label: "Save Duty",
    description: "Mark a Duty active so it can run on its triggers.",
    parameters: Type.Object({ id: Type.String({ description: "Duty id." }) }),
    execute: async (_toolCallId, input) => {
      const id = readId(input);
      const existing = await store.getDuty(id);
      if (!existing) throw new Error(`no Duty "${id}"`);
      const next: Duty = { ...existing, status: "active", updatedAt: Date.now() };
      await store.saveDuty(next);
      return jsonResult({ duty: next });
    },
  });

  register({
    name: "cred_needed",
    label: "Credential Needed",
    description:
      "Tell the owner a credential must be stored before a Duty can use it. Never accepts or echoes a credential value — the owner enters it out-of-band.",
    parameters: Type.Object({
      key: Type.String({ description: "Credential key, e.g. amigos.password." }),
      reason: Type.String({ description: "Why this credential is needed." }),
    }),
    execute: async (_toolCallId, input) => {
      if (!isRecord(input) || typeof input.key !== "string" || !input.key) {
        throw new Error("key is required");
      }
      const stored = await credHas(input.key);
      return jsonResult({
        stored,
        howTo: `Ask the owner to open Duties → Logins and save the key ${input.key}, or run: openclaw duties cred set ${input.key}`,
      });
    },
  });
}
