/**
 * Deliver adapter: resolves a duty's delivery route and sends through the durable channel batch
 * sender.
 *
 * Verified SDK shapes (re-check before touching this file):
 * - `sendDurableMessageBatch(params: DurableMessageSendContextParams)` — required fields are only
 *   `cfg`, `channel`, `to`, `payloads` (src/infra/outbound/deliver-contracts.ts:169-175,
 *   src/channels/message/send.ts:37-47,188); everything else is optional.
 * - Result is `DurableMessageBatchSendResult`, a union on `status`: "sent" | "suppressed" |
 *   "partial_failed" | "failed" (src/channels/message/send.ts:61-91). "sent" and "partial_failed"
 *   both carry `results: OutboundDeliveryResult[]`, and `OutboundDeliveryResult.messageId` is a
 *   required string (src/infra/outbound/deliver-types.ts:14-28). "partial_failed" also carries
 *   `error`/`sentBeforeError: true` — some payload parts landed and then delivery failed, so
 *   `send()` throws rather than returning `messageIds` as if the batch had cleanly sent. "failed"
 *   carries `stage?` and `payloadOutcomes?`, both folded into the thrown message with the original
 *   error kept as `cause`. `DurableMessagePayloadDeliveryOutcome` itself is not exported from
 *   `openclaw/plugin-sdk/channel-outbound`, so `PayloadOutcomeLike` below loosens to only the
 *   fields this module reads.
 * - `getSessionEntry(params: SessionStoreReadParams): SessionEntry | undefined`
 *   (src/plugin-sdk/session-store-runtime.ts:60-63); `SessionStoreReadParams` requires only
 *   `sessionKey` (`agentId` optional, defaults inside the store) (session-store-runtime-internal.ts:10-17).
 * - `deliveryContextFromSession(entry?: Pick<SessionEntry, "delivery">): DeliveryContext | undefined`
 *   returns `entry.delivery.context` only for `delivery.kind === "external"`
 *   (src/utils/delivery-context.shared.ts:252-256, re-exported from session-store-runtime.ts:59-65).
 */
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  deliveryContextFromSession,
  getSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import type { RunOrigin } from "../store.js";

export type DeliverRoute = { channel: string; to: string; accountId?: string };
export type RouteResolver = (
  to: string,
  channel: string | undefined,
  origin: RunOrigin | undefined,
) => Promise<DeliverRoute>;

export const NO_OWNER_TARGET = "no owner target configured — set it on the Duties page";

/**
 * The Gateway session a run's questions are asked in.
 *
 * An `ask` is the one step that needs a person, so it has to be raised where that person can see
 * and answer it — the same place `deliver` would send to: the chat the run came from, otherwise
 * the configured owner. Keyed to the run's own origin session, a mail-triggered run asked inside
 * the `duties-mail` dispatcher's `hook:gmail:*` session, which belongs to an agent the owner never
 * talks to, so the approval gate parked where nobody could answer it.
 *
 * The owner's session key is built by the host's own resolver rather than assembled here:
 * `resolveAgentRoute` applies the configured `bindings[]` (which agent owns that channel) and the
 * session scope rules (`session.dmScope`, identity links) that decide whether an owner DM collapses
 * onto the agent's main session or gets a per-peer one. Duplicating either here would drift from
 * the channel the owner actually uses.
 *
 * Note this only decides *where the question lives*, and therefore who can answer it. Delivering a
 * visible message about it is separate: `question.request` never sends to a channel by itself —
 * channel delivery is performed by the agent turn that raises a question, and a Duty run has no
 * such turn — so the run also announces the question through the `deliver` adapter.
 */
export function createAskSessionResolver(params: {
  cfg: OpenClawConfig;
  ownerTarget: () => Promise<{ channel: string; target: string } | undefined>;
  /** Injectable so tests never load the host's routing tables. */
  resolveRoute?: typeof resolveAgentRoute;
}): (origin: RunOrigin | undefined) => Promise<string> {
  return async (origin) => {
    if (origin?.kind === "chat" && origin.sessionKey) return origin.sessionKey;
    const target = await params.ownerTarget();
    if (!target) throw new Error(NO_OWNER_TARGET);
    const resolve = params.resolveRoute ?? resolveAgentRoute;
    return resolve({
      cfg: params.cfg,
      channel: target.channel,
      peer: { kind: "direct", id: target.target },
    }).sessionKey;
  };
}

/** "trigger" -> the chat the run came from, else the owner; "owner" -> the owner target; anything
 *  else is an explicit channel target (validateDuty already required `channel` for it). */
export function createRouteResolver(params: {
  ownerTarget: () => Promise<{ channel: string; target: string } | undefined>;
  sessionRoute: (origin: RunOrigin) => DeliverRoute | undefined;
}): RouteResolver {
  const owner = async (): Promise<DeliverRoute> => {
    const target = await params.ownerTarget();
    if (!target) throw new Error(NO_OWNER_TARGET);
    return { channel: target.channel, to: target.target };
  };
  return async (to, channel, origin) => {
    if (to === "owner") return owner();
    if (to === "trigger") {
      const route = origin?.kind === "chat" ? params.sessionRoute(origin) : undefined;
      return route ?? owner();
    }
    if (!channel) throw new Error(`deliver to "${to}" needs a channel`);
    return { channel, to };
  };
}

/** Looks up the delivery route of the session that called `duty_run`. Real sessions only — the
 *  runner receives an injectable `sessionRoute` so tests never touch the session store.
 *
 *  `agentId` is forwarded only when `origin.agentId` is set. `resolveSqliteScope` gives an
 *  explicit `scope.agentId` priority over the agent id parsed from the session key itself
 *  (src/config/sessions/session-accessor.sqlite-scope.ts:298); a chat session key normally
 *  already encodes its real agent (`agent:<agentId>:...`), so defaulting the omitted case to
 *  "main" would force the wrong agent's (empty) store and silently drop the chat route whenever
 *  the real agent isn't "main". Omitting the field entirely lets the key decide, per
 *  `SessionAccessScope.agentId`'s own contract ("used when the session key does not already
 *  encode one", session-accessor.types.ts:41). `getEntry` is injectable so tests never touch the
 *  real session store. */
export function sessionRouteFromStore(
  origin: RunOrigin,
  deps: { getEntry?: typeof getSessionEntry } = {},
): DeliverRoute | undefined {
  if (!origin.sessionKey) return undefined;
  const getEntry = deps.getEntry ?? getSessionEntry;
  const entry = getEntry({
    sessionKey: origin.sessionKey,
    ...(origin.agentId ? { agentId: origin.agentId } : {}),
  });
  const ctx = deliveryContextFromSession(entry);
  if (!ctx?.channel || !ctx.to) return undefined;
  return {
    channel: ctx.channel,
    to: ctx.to,
    ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
  };
}

/** A pending Gateway question this message should present as tappable choices.
 *
 *  `id` is the question RECORD id (`question.request`'s own id), not the per-question id inside
 *  it — that is what the channel's callback data carries and what `question.get`/`question.resolve`
 *  take. */
export type DeliverQuestion = { id: string; options: readonly string[] };

export type DeliverAdapter = {
  send(params: {
    route: DeliverRoute;
    text?: string;
    files?: string[];
    question?: DeliverQuestion;
  }): Promise<{ messageIds: string[] }>;
};

/**
 * Builds the tappable half of a question message, mirroring the host's own question card
 * (`buildAgentHarnessQuestionPromptPayload`, src/agents/harness/user-input-bridge.ts:160-195),
 * which is not exported to plugins — only the payload shape it produces is public.
 *
 * A channel renders native choices only when both halves are present: `channelData.askUser` gives
 * the Gateway-owned option order that a tap's compact index is mapped through
 * (`resolveAskUserQuestionOptionIndices`, src/plugin-sdk/reply-payload.ts:26-60), and the
 * `question` button actions name the same record id
 * (`buildTelegramQuestionCallbackData`, extensions/telegram/src/question-callback-data.ts:15-32).
 * Presentation order is not authoritative — the index always comes from `optionValues`.
 *
 * Returns nothing when the options cannot carry a tap: the host accepts only 2-4 distinct
 * option values, so anything else stays plain text rather than shipping a card whose buttons
 * would be silently dropped.
 */
function questionCard(question: DeliverQuestion): Record<string, unknown> | undefined {
  const options = question.options.map((option) => option.trim()).filter(Boolean);
  const normalized = options.map((option) => option.toLowerCase());
  if (
    options.length !== question.options.length ||
    options.length < 2 ||
    options.length > 4 ||
    new Set(normalized).size !== options.length
  ) {
    return undefined;
  }
  return {
    presentation: {
      blocks: [
        {
          type: "buttons",
          buttons: options.map((option) => ({
            label: option,
            action: { type: "question", questionId: question.id, optionValue: option },
          })),
        },
      ],
    },
    channelData: { askUser: { questionId: question.id, optionValues: options } },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One payload outcome from `DurableMessageBatchSendResult.payloadOutcomes`, loosened to the
 *  fields this module reads — the full `DurableMessagePayloadDeliveryOutcome` union type is not
 *  exported from `openclaw/plugin-sdk/channel-outbound`. */
type PayloadOutcomeLike = { index: number; status: string; error?: unknown; reason?: string };

function describePayloadOutcome(outcome: PayloadOutcomeLike): string {
  if (outcome.status === "failed")
    return `#${outcome.index} failed: ${errorMessage(outcome.error)}`;
  if (outcome.status === "suppressed") return `#${outcome.index} suppressed: ${outcome.reason}`;
  return `#${outcome.index} ${outcome.status}`;
}

function summarizePayloadOutcomes(outcomes: readonly PayloadOutcomeLike[] | undefined): string {
  return (outcomes ?? []).map(describePayloadOutcome).join(", ");
}

export function createDeliverAdapter(params: {
  cfg: OpenClawConfig;
  sendBatch?: typeof sendDurableMessageBatch;
}): DeliverAdapter {
  const sendBatch = params.sendBatch ?? sendDurableMessageBatch;
  return {
    async send({ route, text, files, question }) {
      const card = question ? questionCard(question) : undefined;
      const result = await sendBatch({
        cfg: params.cfg,
        channel: route.channel,
        to: route.to,
        ...(route.accountId ? { accountId: route.accountId } : {}),
        payloads: [
          {
            ...(text ? { text } : {}),
            ...(files?.length ? { mediaUrls: files } : {}),
            ...(card ?? {}),
          },
        ],
      });
      if (result.status === "failed") {
        const stage = result.stage ?? "unknown";
        const n = result.payloadOutcomes?.length ?? 0;
        const suffix =
          n > 0
            ? ` (${n} payload outcome(s): ${summarizePayloadOutcomes(result.payloadOutcomes)})`
            : "";
        throw new Error(`delivery failed at ${stage}: ${errorMessage(result.error)}${suffix}`, {
          cause: result.error,
        });
      }
      if (result.status === "partial_failed") {
        // Some payload parts landed and then a real error stopped the rest (e.g. one of several
        // mediaUrls failed to upload) — returning messageIds here would silently report success
        // for a duty step that actually lost an attachment.
        const failed = (result.payloadOutcomes ?? []).filter((o) => o.status === "failed");
        const suffix = failed.length > 0 ? ` (${summarizePayloadOutcomes(failed)})` : "";
        throw new Error(`delivery partially failed: ${errorMessage(result.error)}${suffix}`, {
          cause: result.error,
        });
      }
      if (result.status === "suppressed") {
        throw new Error(`delivery suppressed: ${result.reason}`);
      }
      return { messageIds: result.results.map((r) => r.messageId) };
    },
  };
}

export function maskTarget(to: string): string {
  return /^\+\d{8,}$/u.test(to) ? `${to.slice(0, 3)}••••${to.slice(-4)}` : to;
}
