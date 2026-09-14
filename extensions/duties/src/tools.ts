/**
 * The agent-facing Duties tools.
 *
 * Every tool here is a thin client of this plugin's own Gateway methods. It owns no state: no
 * store handle, no RunManager, no render adapter.
 *
 * That is not stylistic. The host loads a plugin a second time in
 * `registrationMode: "tool-discovery"` to list and run its tools (docs/plugins/sdk-entrypoints/
 * registration-mode.md), and `register()` runs again in that copy. When the tools owned runtime
 * state, that second copy built its own store handles, RunManager, events service and render
 * server — so a `template_preview` published its one-time token in the tool copy's map while the
 * HTTP route was served by the full copy (every tool render printed a 404 page), and a
 * tool-started run lived in the tool copy's RunManager, invisible to `duties.run.cancel`, to
 * `plugin.duties.run` events and to orphan recovery. Routing through the Gateway gives runs,
 * events and rendering exactly one owner: the full registration.
 *
 * Diagnosed by the owner's agent from a table of live renders on one pid: every Gateway-method
 * preview rendered, every tool render 404'd.
 */
import { jsonResult } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import type { OpenClawPluginApi } from "../api.js";
import { MAIL_AGENT_ID } from "./mail.js";
import type { RunOrigin } from "./store.js";

/** One poll of `duties.run.wait`. The method itself caps how long it blocks; the tool loops. */
const RUN_WAIT_POLL_MS = 30_000;
const TERMINAL_RUN_STATUSES = new Set(["ok", "failed", "blocked", "cancelled", "lost"]);

function readId(input: unknown): string {
  if (!isRecord(input) || typeof input.id !== "string" || !input.id) {
    throw new Error("id is required");
  }
  return input.id;
}

/**
 * Races `promise` against `signal` aborting, so a caller that abandons a `duty_run` tool call
 * (which can otherwise block for as long as an in-run `ask` step waits for the owner, up to 15
 * minutes) gets a result immediately instead of hanging forever. Removes the abort listener on
 * whichever side settles first so it never lingers past this call.
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (!signal) return promise.then((value) => ({ aborted: false, value }));
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
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
 *  actually supplied are included. `duties.run` revalidates this shape server-side — it arrives
 *  there as ordinary params like any other caller's. */
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
 * Registers the thirteen agent-facing Duties tools declared in `openclaw.plugin.json`'s
 * `contracts.tools`. Each one forwards to the Gateway method that owns the same operation and
 * returns its payload, so a tool and the Control UI can never disagree about what happened.
 *
 * `duty_run` is registered as a factory so each turn's tool instance closes over that turn's
 * trusted context (session key, agent, channel, account) and can record the run's origin.
 */
export function registerDutyTools(params: { api: OpenClawPluginApi }): void {
  const { api } = params;
  const call = <T = Record<string, unknown>>(
    method: string,
    args: Record<string, unknown>,
    scope: "operator.read" | "operator.write" | "operator.admin",
  ) => api.runtime.gateway.request<T>(method, args, { scopes: [scope] });

  const register = (tool: AnyAgentTool) => api.registerTool(tool, { name: tool.name });

  register({
    name: "duty_list",
    label: "List Duties",
    description: "List every saved Duty with its id, name, status, and summary.",
    parameters: Type.Object({}),
    execute: async () => {
      const { duties } = await call<{
        duties: Array<{ id: string; name: string; status: string; summary: string }>;
      }>("duties.list", {}, "operator.read");
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
      const result = await call<{ duty: unknown; runs: unknown[] }>(
        "duties.get",
        { id: readId(input) },
        "operator.read",
      );
      return jsonResult({ duty: result.duty, runs: result.runs.slice(0, 5) });
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
      return jsonResult(await call("duties.draft", rawInput, "operator.write"));
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
      return jsonResult(
        await call(
          "duties.steps",
          { id: readId(rawInput), steps: rawInput.steps ?? [] },
          "operator.write",
        ),
      );
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
      const started = await call<{ runId?: string; ok?: boolean; errors?: string[] }>(
        "duties.run",
        {
          id: readId(rawInput),
          inputs: isRecord(rawInput.inputs) ? rawInput.inputs : {},
          origin: originFromToolContext(ctx),
          ...(typeof rawInput.toStepId === "string" ? { toStepId: rawInput.toStepId } : {}),
          ...(rawInput.keepOpen === true ? { keepOpen: true } : {}),
          ...(typeof rawInput.targetId === "string" ? { targetId: rawInput.targetId } : {}),
        },
        "operator.write",
      );
      // Missing inputs are reported by the method, not thrown, so the author can fix them.
      if (started.ok === false || !started.runId) {
        return jsonResult({ ok: false, errors: started.errors ?? ["run could not be started"] });
      }
      const runId = started.runId;

      // The method answers after a bounded block rather than holding one request open for a
      // fifteen-minute `ask`, so the terminal status is reached by polling it. The abort check is
      // inside the loop as well as around it: `raceAbort` lets the tool return, but only this
      // stops the polling itself, which would otherwise outlive the call forever.
      const waitForTerminal = async (): Promise<Record<string, unknown>> => {
        for (;;) {
          const { run } = await call<{ run: Record<string, unknown> }>(
            "duties.run.wait",
            { runId, timeoutMs: RUN_WAIT_POLL_MS },
            "operator.read",
          );
          if (TERMINAL_RUN_STATUSES.has(String(run.status)) || signal?.aborted) return run;
        }
      };

      const outcome = await raceAbort(waitForTerminal(), signal);
      if (outcome.aborted) {
        await call("duties.run.cancel", { runId }, "operator.write").catch(() => {});
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
    execute: async (_toolCallId, input) =>
      jsonResult(
        await call("duties.status", { id: readId(input), status: "active" }, "operator.write"),
      ),
  });

  register({
    name: "cred_needed",
    label: "Credential Needed",
    description:
      "Tell the owner a credential must be stored before a Duty can use it. Never accepts or echoes a credential value — the owner enters it out-of-band.",
    parameters: Type.Object({
      key: Type.String({ description: "Credential key, e.g. acme-portal.password." }),
      reason: Type.String({ description: "Why this credential is needed." }),
    }),
    execute: async (_toolCallId, input) => {
      if (!isRecord(input) || typeof input.key !== "string" || !input.key) {
        throw new Error("key is required");
      }
      const { stored } = await call<{ stored: boolean }>(
        "duties.cred.has",
        { key: input.key },
        "operator.read",
      );
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
      const { templates } = await call<{
        templates: Array<{ id: string; name: string; kind: string; slots: string[] }>;
      }>("duties.template.list", {}, "operator.read");
      return jsonResult({ templates });
    },
  });

  register({
    name: "template_get",
    label: "Get Template",
    description: "Get one template's full definition, including its html and slot declarations.",
    parameters: Type.Object({ id: Type.String({ description: "Template id." }) }),
    execute: async (_toolCallId, input) =>
      jsonResult(await call("duties.template.get", { id: readId(input) }, "operator.read")),
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
      return jsonResult(
        await call("duties.template.set", { template: rawInput.template }, "operator.write"),
      );
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
      const data = isRecord(rawInput) && isRecord(rawInput.data) ? rawInput.data : undefined;
      // `operator.write`: the render drives the managed browser, opens a tab and writes a file.
      const { path } = await call<{ path: string; bytes: number }>(
        "duties.template.render",
        { id: readId(rawInput), ...(data ? { data } : {}) },
        "operator.write",
      );
      return jsonResult({ path });
    },
  });

  register({
    name: "brand_get",
    label: "Get Brand",
    description: "Get the install's brand block (name, logo, colours, contact lines).",
    parameters: Type.Object({}),
    execute: async () => jsonResult(await call("duties.brand.get", {}, "operator.read")),
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
      return jsonResult(
        await call("duties.brand.set", { brand: rawInput.brand }, "operator.write"),
      );
    },
  });
}
