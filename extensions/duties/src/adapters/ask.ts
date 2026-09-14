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
  /** Sends a visible note about the question to wherever the run reports back to.
   *
   *  `question.request` records a question and returns its id; it never sends it to a channel.
   *  Channel delivery is done by the agent turn that raises a question
   *  (`runWithQuestionChannelDeliveries`/`registerDelivery`,
   *  src/infra/question-channel-runtime-internal.ts), and a Duty run has no such turn — verified
   *  by probing `question.request` against a live Gateway with the owner's own session key and
   *  seeing no channel send at all. So without this the owner is never told the run is waiting.
   *  Best-effort: a run must park on its question even if the note cannot be delivered. */
  announce?: (text: string) => Promise<void>;
}): AskAdapter {
  return {
    async ask({ stepId, question, header, options, timeoutMs, onAsked }) {
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
      // The run parks on `needs_input` from here until this call returns.
      onAsked?.(requested.id);
      if (params.announce) {
        const choices = options.length > 0 ? `\n\n${options.join(" / ")}` : "";
        await params.announce(`${header || "Duty"}: ${question}${choices}`).catch(() => {});
      }
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
