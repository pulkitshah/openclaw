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
 *   required string (src/infra/outbound/deliver-types.ts:14-28) — accessing `.results` after
 *   excluding "failed"/"suppressed" is safe because both remaining arms share that field.
 * - `getSessionEntry(params: SessionStoreReadParams): SessionEntry | undefined`
 *   (src/plugin-sdk/session-store-runtime.ts:60-63); `SessionStoreReadParams` requires only
 *   `sessionKey` (`agentId` optional, defaults inside the store) (session-store-runtime-internal.ts:10-17).
 * - `deliveryContextFromSession(entry?: Pick<SessionEntry, "delivery">): DeliveryContext | undefined`
 *   returns `entry.delivery.context` only for `delivery.kind === "external"`
 *   (src/utils/delivery-context.shared.ts:252-256, re-exported from session-store-runtime.ts:59-65).
 */
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
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
 *  runner receives an injectable `sessionRoute` so tests never touch the session store. */
export function sessionRouteFromStore(origin: RunOrigin): DeliverRoute | undefined {
  if (!origin.sessionKey) return undefined;
  const entry = getSessionEntry({
    agentId: origin.agentId ?? "main",
    sessionKey: origin.sessionKey,
  });
  const ctx = deliveryContextFromSession(entry);
  if (!ctx?.channel || !ctx.to) return undefined;
  return {
    channel: ctx.channel,
    to: ctx.to,
    ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
  };
}

export type DeliverAdapter = {
  send(params: {
    route: DeliverRoute;
    text?: string;
    files?: string[];
  }): Promise<{ messageIds: string[] }>;
};

export function createDeliverAdapter(params: {
  cfg: OpenClawConfig;
  sendBatch?: typeof sendDurableMessageBatch;
}): DeliverAdapter {
  const sendBatch = params.sendBatch ?? sendDurableMessageBatch;
  return {
    async send({ route, text, files }) {
      const result = await sendBatch({
        cfg: params.cfg,
        channel: route.channel,
        to: route.to,
        ...(route.accountId ? { accountId: route.accountId } : {}),
        payloads: [{ ...(text ? { text } : {}), ...(files?.length ? { mediaUrls: files } : {}) }],
      });
      if (result.status === "failed") {
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
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
