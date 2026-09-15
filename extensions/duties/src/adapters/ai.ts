/**
 * AI adapter over the Gateway's `tools.invoke` method, calling the bundled `llm-task` tool.
 *
 * Confirmed shapes (read-only sources, not imported across the extensions boundary):
 * - `llm-task` tool params are `{ prompt, input?, schema? }` (extensions/llm-task/src/llm-task-tool.ts:88-99,
 *   106-123): `prompt` is the task instruction, `input` is an arbitrary JSON payload, `schema` is an
 *   optional JSON Schema the tool validates its own output against before returning.
 * - `llm-task` tool execute() resolves `{ content: [{ type: "text", text: <JSON string> }], details:
 *   { json: <parsed value>, provider, model } }` (llm-task-tool.ts:264-267).
 * - `tools.invoke` success result is `{ ok: true, toolName, output: <tool's execute() return value>,
 *   source }` (src/gateway/server-methods/tools-invoke.ts:70-78; ToolsInvokeResultSchema,
 *   packages/gateway-protocol/src/schema/agents-models-skills.ts:1460-1476) — the tool's raw return
 *   value round-trips unchanged under `output`, not `result`.
 * - `tools.invoke` FAILURE is also answered as `respond(true, payload)` (never a JSON-RPC error): the
 *   envelope is `{ ok: false, toolName, requiresApproval?: true, error: { code, message } }`
 *   (tools-invoke.ts:81-90; ToolsInvokeErrorSchema has `code`/`message`/`details?`, not `type`).
 *   `ok` must be checked before touching `output`, or a failure silently collapses into "no JSON
 *   object" with the actual reason lost. The message fallback below also checks `error.type` for
 *   forward/back compat with the pre-wire `ToolsInvokeOutcome` error shape.
 */
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AiAdapter } from "../runner.js";

type Request = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;

export function createAiAdapter(params: { request: Request; sessionKey: string }): AiAdapter {
  return {
    async extract({ instruction, input, schema }) {
      const result = await params.request("tools.invoke", {
        name: "llm-task",
        sessionKey: params.sessionKey,
        args: { prompt: instruction, input, schema },
      });
      if (isRecord(result) && result.ok === false) {
        const error = isRecord(result.error) ? result.error : undefined;
        const message =
          (typeof error?.message === "string" && error.message) ||
          (typeof error?.type === "string" && error.type) ||
          (typeof error?.code === "string" && error.code) ||
          "tool call failed";
        if (result.requiresApproval) {
          throw new Error(`ai step needs approval: ${message}`);
        }
        throw new Error(`ai step failed: ${message}`);
      }
      return parseToolJson(isRecord(result) ? result.output : undefined);
    },
  };
}

/**
 * Unwraps `llm-task`'s two documented shapes only: `details.json` (preferred) and the text content
 * block. An extracted object that legitimately carries its own `json`/`output` field is returned
 * as-is rather than unwrapped again — guessing there silently replaced the model's result with one
 * of its fields.
 */
function parseToolJson(result: unknown): Record<string, unknown> {
  if (isRecord(result)) {
    const details = isRecord(result.details) ? result.details : undefined;
    if (details && "json" in details) {
      return parseToolJson(details.json);
    }
    const content = result.content;
    if (Array.isArray(content)) {
      const text = content
        // SAFETY: tool content entries are untyped at this boundary; non-text-shaped entries are skipped.
        .filter((c): c is { type?: string; text?: string } => isRecord(c) && c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      return parseToolJson(text);
    }
    return result;
  }
  if (typeof result === "string") {
    const trimmed = result.trim().replace(/^```(?:json)?\s*|\s*```$/gu, "");
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      return parsed;
    }
  }
  throw new Error("ai step returned no JSON object");
}
