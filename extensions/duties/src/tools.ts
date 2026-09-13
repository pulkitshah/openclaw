import { jsonResult } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import type { OpenClawPluginApi } from "../api.js";
import type { RenderAdapter } from "./adapters/render.js";
import {
  validateDuty,
  validateRunInputs,
  type Duty,
  type DutyInput,
  type DutyNode,
  type DutyTrigger,
} from "./duty.js";
import { MAIL_AGENT_ID } from "./mail.js";
import { renderTemplatePreview } from "./preview.js";
import type { RunManager } from "./run-service.js";
import type { DutyStore, RunOrigin } from "./store.js";
import { validateBrand, validateTemplate } from "./template.js";

/** Sensible header defaults for a freshly-drafted Duty that hasn't stated who runs it or
 *  reports on it yet, so `duty_draft` can save a valid-enough header immediately and let
 *  `duty_set_steps`'s errors focus on the steps being authored, not these unset fields. */
const DEFAULT_MACHINE = "gateway";
const DEFAULT_REPORTS_TO = "owner";
/** A Duty with no trigger cannot be run by anyone; every draft is at least manually runnable. */
const DEFAULT_TRIGGERS: DutyTrigger[] = [{ kind: "manual" }];

function readId(input: unknown): string {
  if (!isRecord(input) || typeof input.id !== "string" || !input.id) {
    throw new Error("id is required");
  }
  return input.id;
}

/**
 * Races `promise` against `signal` aborting, so a caller that abandons a `duty_run` tool call
 * (which can otherwise block on `runs.wait` for as long as an in-run `ask` step waits for the
 * owner, up to 15 minutes) gets a result immediately instead of hanging forever. Removes the
 * abort listener on whichever side settles first so it never lingers past this call.
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (!signal) return promise.then((value) => ({ aborted: false, value }));
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve({ aborted: true });
    };
    signal.addEventListener("abort", onAbort);
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ aborted: false, value });
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Where a `duty_run` call came from, read off the trusted tool context rather than anything the
 *  model can write: the mail agent id marks a mail dispatch, an active message channel marks a
 *  chat, and everything else (a CLI or Control UI turn) is a manual run. Only fields the host
 *  actually supplied are included — the plugin state store rejects explicit `undefined` values. */
function originFromToolContext(ctx: OpenClawPluginToolContext): RunOrigin {
  const kind: RunOrigin["kind"] =
    ctx.agentId === MAIL_AGENT_ID ? "mail" : ctx.messageChannel ? "chat" : "manual";
  return {
    kind,
    ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.messageChannel ? { channel: ctx.messageChannel } : {}),
    ...(ctx.agentAccountId ? { accountId: ctx.agentAccountId } : {}),
  };
}

/**
 * Registers the thirteen agent-facing Duties tools (`duty_list`, `duty_get`, `duty_draft`,
 * `duty_set_steps`, `duty_run`, `duty_save`, `cred_needed`, `template_list`, `template_get`,
 * `template_set`, `template_preview`, `brand_get`, `brand_set`) declared in
 * `openclaw.plugin.json`'s `contracts.tools`. Every tool returns `jsonResult(payload)`; failures
 * are thrown as `Error`s, following the same shape as `registerDutiesGatewayMethods` in
 * `gateway-methods.ts`.
 *
 * `duty_run` is registered as a factory so each turn's tool instance closes over that turn's
 * trusted context (session key, agent, channel, account) and can record the run's origin.
 */
export function registerDutyTools(params: {
  api: OpenClawPluginApi;
  store: DutyStore;
  runs: Pick<RunManager, "start" | "wait" | "cancel">;
  credHas: (key: string) => Promise<boolean>;
  render: RenderAdapter;
  previewDir: () => Promise<string>;
}): void {
  const { api, store, runs, credHas, render, previewDir } = params;

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
        triggers: (rawInput.triggers as DutyTrigger[] | undefined) ??
          existing?.triggers ?? [...DEFAULT_TRIGGERS],
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

  const dutyRunTool = (ctx: OpenClawPluginToolContext): AnyAgentTool => ({
    name: "duty_run",
    label: "Run Duty",
    description:
      "Starts the run and waits until it finishes (ok / failed / blocked / cancelled). An `ask` step inside the run waits for the owner's answer (up to 15 min) before this tool returns; use toStepId + keepOpen to build stage by stage.",
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
    execute: async (_toolCallId, rawInput, signal) => {
      if (!isRecord(rawInput)) throw new Error("id is required");
      const id = readId(rawInput);
      const duty = await store.getDuty(id);
      if (!duty) throw new Error(`no Duty "${id}"`);
      const inputs = isRecord(rawInput.inputs) ? rawInput.inputs : {};
      // A `mail`/`file` input the caller never supplied would otherwise surface deep inside the
      // run as an unresolved placeholder, so the run is refused before it is even created.
      const errors = validateRunInputs(duty, inputs);
      if (errors.length) return jsonResult({ ok: false, errors });
      const origin = originFromToolContext(ctx);
      if (origin.kind === "mail") {
        await store.updateSettings({ lastMailDispatchAt: Date.now(), lastMailDispatchDutyId: id });
      }
      const { runId } = await runs.start({
        duty,
        inputs,
        trigger: origin.kind,
        origin,
        toStepId: typeof rawInput.toStepId === "string" ? rawInput.toStepId : undefined,
        keepOpen: rawInput.keepOpen === true,
        targetId: typeof rawInput.targetId === "string" ? rawInput.targetId : undefined,
      });
      const outcome = await raceAbort(runs.wait(runId), signal);
      if (outcome.aborted) {
        await runs.cancel(runId);
        return jsonResult({ ok: false, runId, status: "cancelled", report: "tool call aborted" });
      }
      const run = outcome.value;
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
  api.registerTool(dutyRunTool, { name: "duty_run" });

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
        howTo: `Ask the owner to open Duties → Logins and save the key ${input.key}`,
      });
    },
  });

  register({
    name: "template_list",
    label: "List Templates",
    description: "List every saved document/message template with its id, name, kind and slots.",
    parameters: Type.Object({}),
    execute: async () => {
      const templates = await store.listTemplates();
      return jsonResult({
        templates: templates.map((t) => ({
          id: t.id,
          name: t.name,
          kind: t.kind,
          slots: t.slots.map((s) => s.name),
        })),
      });
    },
  });

  register({
    name: "template_get",
    label: "Get Template",
    description: "Get one template's full definition, including its html and slot declarations.",
    parameters: Type.Object({ id: Type.String({ description: "Template id." }) }),
    execute: async (_toolCallId, input) => {
      const id = readId(input);
      const template = await store.getTemplate(id);
      if (!template) throw new Error(`no template "${id}"`);
      return jsonResult({ template });
    },
  });

  register({
    name: "template_set",
    label: "Set Template",
    description:
      "Create or replace a template, validating its slots against its html first. Returns validation errors verbatim on failure.",
    parameters: Type.Object({
      template: Type.Record(Type.String(), Type.Unknown(), {
        description: "The full template: id, name, kind (pdf|message), html, slots.",
      }),
    }),
    execute: async (_toolCallId, rawInput) => {
      if (!isRecord(rawInput) || !isRecord(rawInput.template)) {
        throw new Error("template is required");
      }
      const result = validateTemplate({ ...rawInput.template, updatedAt: Date.now() });
      if (!result.ok) return jsonResult({ ok: false, errors: result.errors });
      await store.saveTemplate(result.template);
      return jsonResult({ ok: true, template: result.template });
    },
  });

  register({
    name: "template_preview",
    label: "Preview Template",
    description:
      "Render a pdf template to a throwaway PDF and return its path, so the owner can be shown the layout before a Duty uses it. Fills every slot with a placeholder unless data is given.",
    parameters: Type.Object({
      id: Type.String({ description: "Template id." }),
      data: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Slot values to render; placeholders are used for anything omitted.",
        }),
      ),
    }),
    execute: async (_toolCallId, rawInput) => {
      const id = readId(rawInput);
      const data = isRecord(rawInput) && isRecord(rawInput.data) ? rawInput.data : undefined;
      const preview = await renderTemplatePreview({
        store,
        render,
        previewDir,
        id,
        ...(data ? { data } : {}),
      });
      return jsonResult({ path: preview.path });
    },
  });

  register({
    name: "brand_get",
    label: "Get Brand",
    description: "Get the install's brand block (name, logo, colours, contact lines).",
    parameters: Type.Object({}),
    execute: async () => jsonResult({ brand: await store.getBrand() }),
  });

  register({
    name: "brand_set",
    label: "Set Brand",
    description:
      "Replace the install's brand block. Returns validation errors verbatim on failure.",
    parameters: Type.Object({
      brand: Type.Record(Type.String(), Type.Unknown(), {
        description: "The full brand block: name plus optional logoDataUrl, colours and contacts.",
      }),
    }),
    execute: async (_toolCallId, rawInput) => {
      if (!isRecord(rawInput) || !isRecord(rawInput.brand)) throw new Error("brand is required");
      const result = validateBrand({ ...rawInput.brand, updatedAt: Date.now() });
      if (!result.ok) return jsonResult({ ok: false, errors: result.errors });
      await store.saveBrand(result.brand);
      return jsonResult({ ok: true, brand: result.brand });
    },
  });
}
