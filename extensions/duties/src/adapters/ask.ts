/**
 * Ask adapter over the Gateway's `question.request` / `question.waitAnswer` methods.
 *
 * Confirmed shapes (packages/gateway-protocol/src/schema/questions.ts):
 * - `question.request` params: `{ questions: [{ questionId, header (<=12 chars), question, options:
 *   [{ label, description? }] (<=4), multiSelect?, isOther? }] (1-3), agentId?, sessionKey?, runId?,
 *   timeoutMs? }` -> `{ id, expiresAtMs }` (QuestionRequestParamsSchema/QuestionRequestResultSchema,
 *   lines 91-103).
 * - `question.waitAnswer` params: `{ id, timeoutMs? }` -> one of `{ status: "pending" }`,
 *   `{ status: "answered", answers: { answers: Record<questionId, string[]> } }`,
 *   `{ status: "cancelled" }`, `{ status: "expired" }` (QuestionWaitAnswerResultSchema, lines 111-120).
 */
import type { AskAdapter } from "../runner.js";

type Request = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const WAIT_POLL_TIMEOUT_MS = 60_000;

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function createAskAdapter(params: {
  request: Request;
  sessionKey: string;
  pollMs?: number;
}): AskAdapter {
  return {
    async ask({ stepId, question, header, options, timeoutMs }) {
      const budget = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const requested = await params.request<{ id: string; expiresAtMs: number }>(
        "question.request",
        {
          sessionKey: params.sessionKey,
          timeoutMs: budget,
          questions: [
            {
              questionId: stepId,
              header: header.slice(0, 12) || "Duty",
              question,
              options: options.map((label) => ({ label })),
            },
          ],
        },
      );
      const deadline = Date.now() + budget;
      while (Date.now() < deadline) {
        const state = await params.request<{
          status: "pending" | "answered" | "cancelled" | "expired";
          answers?: { answers: Record<string, string[]> };
        }>("question.waitAnswer", {
          id: requested.id,
          timeoutMs: Math.min(WAIT_POLL_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
        });
        if (state.status === "answered") {
          return { status: "answered", answer: state.answers?.answers[stepId]?.[0] ?? "" };
        }
        if (state.status === "cancelled") return { status: "cancelled" };
        if (state.status === "expired") return { status: "timeout" };
        await sleep(params.pollMs ?? 500);
      }
      return { status: "timeout" };
    },
  };
}
