import type { Readable } from "node:stream";
// Whatsapp plugin module implements media behavior.
import type { proto, WAMessage } from "baileys";
import { saveMediaStream, type SavedMedia } from "openclaw/plugin-sdk/media-store";
import { identitiesOverlap } from "../identity.js";
import type { createWaSocket } from "../session.js";
import { extractContextInfo } from "./extract.js";
import { resolveInboundMediaMimetype } from "./media-mimetype.js";
import { downloadMediaMessage, normalizeMessageContent } from "./runtime-api.js";

/**
 * Baileys hands back a decrypt Transform that is already being fed from the network. A small
 * ciphertext can finish piping — and fail its final AES check — before `saveMediaStream` has
 * opened its temp file and started reading, and a stream `'error'` with no listener is fatal to
 * the whole process (Prasthan's desk crash-looped on one such attachment for two days). Listen from
 * the moment the stream exists; the async iterator that consumes it later rejects with the same
 * error, which the message owner reports as an unavailable attachment.
 */
function holdStreamErrors(stream: unknown): AsyncIterable<unknown> {
  if (stream && typeof (stream as Readable).on === "function") {
    (stream as Readable).on("error", () => {});
  }
  return stream as AsyncIterable<unknown>;
}

function unwrapMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  const normalized = normalizeMessageContent(message);
  return normalized;
}

export async function downloadInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
  maxBytes = 50 * 1024 * 1024,
  normalizedMessage?: proto.IMessage,
): Promise<{ saved: SavedMedia; mimetype?: string; fileName?: string } | undefined> {
  const message = normalizedMessage ?? unwrapMessage(msg.message as proto.IMessage | undefined);
  if (!message) {
    return undefined;
  }
  const mimetype = resolveInboundMediaMimetype(message);
  const fileName = message.documentMessage?.fileName ?? undefined;
  if (
    !message.imageMessage &&
    !message.videoMessage &&
    !message.ptvMessage &&
    !message.documentMessage &&
    !message.audioMessage &&
    !message.stickerMessage
  ) {
    return undefined;
  }
  const stream = await downloadMediaMessage(
    msg as WAMessage,
    "stream",
    {},
    {
      reuploadRequest: sock.updateMediaMessage,
      logger: sock.logger,
    },
  );
  const saved = await saveMediaStream(
    holdStreamErrors(stream),
    mimetype,
    "inbound",
    maxBytes,
    fileName,
  );
  return { saved, mimetype, fileName };
}

export async function downloadQuotedInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
  maxBytes = 50 * 1024 * 1024,
): Promise<{ saved: SavedMedia; mimetype?: string; fileName?: string } | undefined> {
  const message = unwrapMessage(msg.message as proto.IMessage | undefined);
  const contextInfo = extractContextInfo(message);
  if (!contextInfo?.quotedMessage) {
    return undefined;
  }
  const quotedMessage = contextInfo.quotedMessage;
  const self = sock.user;
  // Baileys copies fromMe into the media-reupload receipt; own quoted media must retain its author.
  const quotedFromMe = identitiesOverlap(
    { jid: contextInfo.participant },
    { jid: self?.id, lid: self?.lid, e164: self?.phoneNumber },
  );
  return downloadInboundMedia(
    {
      key: {
        id: contextInfo?.stanzaId || undefined,
        remoteJid: contextInfo.remoteJid ?? msg.key?.remoteJid ?? undefined,
        participant: contextInfo?.participant ?? undefined,
        fromMe: quotedFromMe,
      },
      message: quotedMessage,
      messageTimestamp: msg.messageTimestamp,
    },
    sock,
    maxBytes,
  );
}
