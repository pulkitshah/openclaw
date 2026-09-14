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
import { randomBytes } from "node:crypto";
import type { AskAdapter } from "../runner.js";
import { canRenderQuestionCard } from "./deliver.js";

type Request = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const WAIT_POLL_TIMEOUT_MS = 60_000;

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Mints the question RECORD id, in the one shape a channel can build tappable choices from.
 *
 * `question.request` will happily accept any non-empty id and mint a UUID when given none, but a
 * channel's callback envelope is narrower: Telegram's is
 * `tgq1:<ask_[a-f0-9]{32}>:<optionIndex>` and it refuses to build a button for anything else
 * (`buildTelegramQuestionCallbackData`, extensions/telegram/src/question-callback-data.ts:15-32).
 * A server-minted UUID therefore renders as plain text with no way to answer it. This mirrors the
 * host's own generator (`ask_${randomBytes(16).toString("hex")}`,
 * src/agents/harness/gateway-question.ts:558).
 */
function newQuestionRecordId(): string {
  return `ask_${randomBytes(16).toString("hex")}`;
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
  /**
   * The session the question is raised in, or a resolver for it.
   *
   * A resolver is what the plugin passes: resolving the owner's session eagerly meant building
   * every run's deps threw `NO_OWNER_TARGET` before step 1 — so on a fresh install, where the
   * owner target is set by hand on the Duties page, pressing Run failed every Duty with an
   * unrelated error, including Duties with no `ask` at all. Only a run that actually reaches an
   * `ask` needs an owner.
   */
  sessionKey: string | (() => Promise<string>);
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
  announce?: (text: string, question?: { id: string; options: readonly string[] }) => Promise<void>;
}): AskAdapter {
  return {
    async ask({ stepId, question, header, options, timeoutMs, onAsked }) {
      const budget = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const questionId = questionIdForStep(stepId);
      const recordId = newQuestionRecordId();
      const sessionKey =
        typeof params.sessionKey === "string" ? params.sessionKey : await params.sessionKey();
      const requested = await params.request<{ id: string; expiresAtMs: number }>(
        "question.request",
        {
          id: recordId,
          sessionKey,
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
      // An ask that could not be rendered as a tappable card reached the owner as plain prose,
      // and a typed reply does not resolve a plugin-raised question — the answer goes to the
      // agent as ordinary chat and the run waits out its timeout. `validateDuty` refuses such an
      // ask at authoring time; a Duty saved before that rule says so in its own evidence.
      const note = canRenderQuestionCard(options)
        ? undefined
        : "sent without buttons: an ask needs 2–4 distinct options";
      if (params.announce) {
        // The options stay in the text too: a channel that cannot render choices still has to say
        // what they are, and the card's own buttons are built from `options`, not from this text.
        const choices = options.length > 0 ? `\n\n${options.join(" / ")}` : "";
        await params
          .announce(
            `${header || "Duty"}: ${question}${choices}`,
            options.length > 0 ? { id: requested.id, options } : undefined,
          )
          .catch(() => {});
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
          return {
            status: "answered",
            answer: state.answers?.answers[questionId]?.[0] ?? "",
            ...(note ? { note } : {}),
          };
        }
        if (state.status === "cancelled") return { status: "cancelled" };
        if (state.status === "expired") return { status: "timeout" };
        await sleep(params.pollMs ?? 500);
      }
      return { status: "timeout" };
    },
  };
}
