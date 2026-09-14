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

/**
 * Translates a duty step id into a question id the Gateway accepts.
 *
 * The two vocabularies do not agree: a step id is a slug
 * (`^[a-z0-9][a-z0-9_-]{0,63}$`, duty.ts) so hyphens and a leading digit are legal and natural —
 * `ask-hold`, `ask-which-flight` — while `question.request` requires `^[a-z][a-z0-9_]*$`
 * (QuestionRequestParamsSchema). Sending the step id straight through failed every hyphenated ask
 * step with a raw schema error, so the owner was never asked at all. The answer map is keyed by the
 * id that was sent, so the same translation has to be used to read the answer back.
 */
export function questionIdForStep(stepId: string): string {
  const slug = stepId.toLowerCase().replaceAll(/[^a-z0-9_]/gu, "_");
  return /^[a-z]/u.test(slug) ? slug : `q_${slug}`;
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
      const questionId = questionIdForStep(stepId);
      const requested = await params.request<{ id: string; expiresAtMs: number }>(
        "question.request",
        {
          sessionKey: params.sessionKey,
          timeoutMs: budget,
          questions: [
            {
              questionId,
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
          return { status: "answered", answer: state.answers?.answers[questionId]?.[0] ?? "" };
        }
        if (state.status === "cancelled") return { status: "cancelled" };
        if (state.status === "expired") return { status: "timeout" };
        await sleep(params.pollMs ?? 500);
      }
      return { status: "timeout" };
    },
  };
}
