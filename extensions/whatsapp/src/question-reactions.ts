// WhatsApp transport binding for numbered ask_user reactions.
import type { WAMessage } from "baileys";
import type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createQuestionReactionTargetStore,
  questionGatewayRuntime,
} from "openclaw/plugin-sdk/question-gateway-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { describeReplyContext, extractText } from "./inbound/extract.js";

type WhatsAppQuestionReactionIdentity = {
  accountId: string;
  remoteJid: string;
  messageId: string;
};

function buildKey(identity: WhatsAppQuestionReactionIdentity): string | undefined {
  const parts = [identity.accountId, identity.remoteJid, identity.messageId].map((part) =>
    part.trim(),
  );
  return parts.every(Boolean) ? parts.join(":") : undefined;
}

const questionReactionTargets = createQuestionReactionTargetStore({
  channel: "whatsapp",
  channelDisplayName: "WhatsApp",
  buildKey,
  registerChannelDelivery: questionGatewayRuntime.registerChannelDelivery,
  resolveReaction: questionGatewayRuntime.resolveReaction,
});

function addCandidate(values: string[], value: string | null | undefined): void {
  const normalized = value?.trim();
  if (normalized && !values.includes(normalized)) {
    values.push(normalized);
  }
}

function listDeliveredIdentities(
  results: readonly OutboundDeliveryResult[],
): Array<{ messageId: string; remoteJid: string }> {
  const identities: Array<{ messageId: string; remoteJid: string }> = [];
  const seen = new Set<string>();
  const add = (messageId?: string, remoteJid?: string) => {
    const id = messageId?.trim() ?? "";
    const jid = remoteJid?.trim() ?? "";
    const key = `${jid}:${id}`;
    if (id && id !== "unknown" && jid && !seen.has(key)) {
      seen.add(key);
      identities.push({ messageId: id, remoteJid: jid });
    }
  };
  for (const result of results) {
    if (result.channel !== "whatsapp") {
      continue;
    }
    add(result.messageId, result.toJid);
    for (const raw of result.receipt?.raw ?? []) {
      add(raw.messageId, raw.toJid);
    }
    for (const part of result.receipt?.parts ?? []) {
      add(part.raw?.messageId ?? part.platformMessageId, part.raw?.toJid);
    }
  }
  return identities;
}

export function registerWhatsAppQuestionReactionTargetForDeliveredPayload(params: {
  cfg: OpenClawConfig;
  target: { channel: string; accountId?: string | null };
  payload: ReplyPayload;
  results: readonly OutboundDeliveryResult[];
}): boolean {
  const binding = questionGatewayRuntime.readReactionBinding(params.payload);
  if (params.target.channel !== "whatsapp" || !binding) {
    return false;
  }
  const accountId = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.target.accountId,
  }).accountId;
  let registered = false;
  for (const identity of listDeliveredIdentities(params.results)) {
    registered =
      questionReactionTargets.register(binding, { accountId, ...identity }) || registered;
  }
  return registered;
}

export async function maybeResolveWhatsAppQuestionReaction(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: WAMessage;
  senderId: string;
  gatewayUrl?: string;
  resolveReactionTargetJids?: (jid: string) => Promise<readonly string[]>;
  logDebug?: (message: string) => void;
}): Promise<boolean> {
  const reaction = params.msg.message?.reactionMessage;
  const reactionKey = reaction?.text?.trim() ?? "";
  const messageId = reaction?.key?.id?.trim() ?? "";
  const optionIndex = questionGatewayRuntime.resolveReactionIndex(reactionKey);
  if (optionIndex === undefined || !messageId) {
    return false;
  }
  const remoteJids: string[] = [];
  addCandidate(remoteJids, reaction?.key?.remoteJid);
  addCandidate(remoteJids, params.msg.key?.remoteJid);
  const candidates: string[] = [];
  for (const remoteJid of remoteJids) {
    addCandidate(candidates, remoteJid);
    for (const mapped of (await params.resolveReactionTargetJids?.(remoteJid)) ?? []) {
      addCandidate(candidates, mapped);
    }
  }
  return await questionReactionTargets.resolve({
    identities: candidates.map((remoteJid) => ({
      accountId: params.accountId,
      remoteJid,
      messageId,
    })),
    optionIndex,
    cfg: params.cfg,
    senderId: params.senderId,
    gatewayUrl: params.gatewayUrl,
    logDebug: params.logDebug,
  });
}

/** Matches a typed reply's exact text (case-insensitive) or a bare 1-based index against the
 *  pending question's own option labels. Deliberately strict — a substring or fuzzy match could
 *  silently resolve the wrong option from a reply that only coincidentally contains one of the
 *  labels, and a Duty step's ask has real side effects once answered. */
function matchOptionIndex(text: string, optionValues: readonly string[]): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const asIndex = Number.parseInt(trimmed, 10);
  if (String(asIndex) === trimmed && asIndex >= 1 && asIndex <= optionValues.length) {
    return asIndex - 1;
  }
  const normalized = trimmed.toLowerCase();
  const index = optionValues.findIndex((value) => value.trim().toLowerCase() === normalized);
  return index >= 0 ? index : undefined;
}

/**
 * Resolves a pending WhatsApp question from a typed reply quoting the question message, for
 * owners who use WhatsApp's ordinary swipe-to-reply instead of the numbered emoji reaction
 * `maybeResolveWhatsAppQuestionReaction` expects.
 *
 * Personal/web-connected WhatsApp has no native interactive buttons (`prepareQuestionReactionPayloadForDelivery`
 * sends the options as plain numbered text for exactly that reason), so a reaction is the only
 * tap-to-answer affordance WhatsApp actually has — but replying to a message is the far more
 * familiar gesture, and a typed reply with no matching handler here silently fell through to
 * ordinary chat, leaving the run parked on `question.waitAnswer` until it timed out (up to an
 * hour) while the owner's actual answer was never recognized as one.
 *
 * Requires the reply to quote the exact question message (`describeReplyContext`'s `id`, WhatsApp's
 * own `stanzaId`) — the same precision a reaction gets from being attached to a specific message —
 * so an unrelated later message in the same chat can never be misread as answering a stale ask.
 */
export async function maybeResolveWhatsAppQuestionTextReply(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: WAMessage;
  senderId: string;
  resolveReactionTargetJids?: (jid: string) => Promise<readonly string[]>;
  logDebug?: (message: string) => void;
}): Promise<boolean> {
  const quotedMessageId = describeReplyContext(params.msg.message ?? undefined)?.id?.trim();
  const text = extractText(params.msg.message ?? undefined)?.trim();
  if (!quotedMessageId || !text) {
    return false;
  }
  const remoteJids: string[] = [];
  addCandidate(remoteJids, params.msg.key?.remoteJid);
  const candidates: string[] = [];
  for (const remoteJid of remoteJids) {
    addCandidate(candidates, remoteJid);
    for (const mapped of (await params.resolveReactionTargetJids?.(remoteJid)) ?? []) {
      addCandidate(candidates, mapped);
    }
  }
  const identities = candidates.map((remoteJid) => ({
    accountId: params.accountId,
    remoteJid,
    messageId: quotedMessageId,
  }));
  const target = questionReactionTargets.peek(identities);
  if (!target) {
    return false;
  }
  const optionIndex = matchOptionIndex(text, target.optionValues);
  if (optionIndex === undefined) {
    return false;
  }
  return await questionReactionTargets.resolve({
    identities,
    optionIndex,
    cfg: params.cfg,
    senderId: params.senderId,
    logDebug: params.logDebug,
  });
}
