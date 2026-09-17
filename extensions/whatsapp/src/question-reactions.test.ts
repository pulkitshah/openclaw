// Covers WhatsApp delivery binding and numbered-reaction dispatch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...original,
    questionGatewayRuntime: {
      ...original.questionGatewayRuntime,
      resolveReaction: hoisted.resolve,
    },
  };
});

import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import {
  maybeResolveWhatsAppQuestionReaction,
  maybeResolveWhatsAppQuestionTextReply,
  registerWhatsAppQuestionReactionTargetForDeliveredPayload,
} from "./question-reactions.js";

const questionId = "ask_0123456789abcdef0123456789abcdef";

function buildPayload() {
  const presentation = {
    blocks: [
      { type: "text" as const, text: "Pick one" },
      {
        type: "buttons" as const,
        buttons: ["One", "Two"].map((label) => ({
          label,
          action: { type: "question" as const, questionId, optionValue: label },
        })),
      },
    ],
  };
  return questionGatewayRuntime.prepareReactionPayloadForDelivery({
    payload: { presentation, channelData: { askUser: { questionId } } },
    presentation,
  });
}

describe("WhatsApp question reactions", () => {
  beforeEach(() => {
    hoisted.resolve.mockReset().mockResolvedValue({
      status: "answered",
      questionId: "choice",
      optionValue: "Two",
    });
  });

  it("matches receipt identities through reaction-target JID aliases", async () => {
    const payload = buildPayload();
    expect(payload).not.toBeNull();
    expect(
      registerWhatsAppQuestionReactionTargetForDeliveredPayload({
        cfg: {},
        target: { channel: "whatsapp", accountId: "default" },
        payload: payload!,
        results: [
          {
            channel: "whatsapp",
            messageId: "summary",
            toJid: "group@g.us",
            receipt: {
              platformMessageIds: ["wa-1"],
              sentAt: 1,
              parts: [
                {
                  platformMessageId: "wa-1",
                  kind: "text",
                  index: 0,
                  raw: { messageId: "wa-1", toJid: "1555@s.whatsapp.net" },
                },
              ],
            },
          },
        ],
      }),
    ).toBe(true);
    const msg = {
      key: { remoteJid: "group@g.us", participant: "1555@s.whatsapp.net" },
      message: {
        reactionMessage: {
          text: "2️⃣",
          key: { id: "wa-1", remoteJid: "group@g.us" },
        },
      },
    };
    const debug = vi.fn();

    await expect(
      maybeResolveWhatsAppQuestionReaction({
        cfg: {},
        accountId: "default",
        msg,
        senderId: "+1555",
        resolveReactionTargetJids: async () => ["1555@s.whatsapp.net"],
        logDebug: debug,
      }),
    ).resolves.toBe(true);
    expect(hoisted.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ questionId, optionValue: "Two", senderId: "+1555" }),
    );
    expect(hoisted.resolve).toHaveBeenCalledOnce();
  });

  it("resolves a typed reply quoting the question message, matched by exact option text", async () => {
    const payload = buildPayload();
    expect(payload).not.toBeNull();
    expect(
      registerWhatsAppQuestionReactionTargetForDeliveredPayload({
        cfg: {},
        target: { channel: "whatsapp", accountId: "default" },
        payload: payload!,
        results: [
          {
            channel: "whatsapp",
            messageId: "summary",
            toJid: "1555@s.whatsapp.net",
            receipt: {
              platformMessageIds: ["wa-2"],
              sentAt: 1,
              parts: [
                {
                  platformMessageId: "wa-2",
                  kind: "text",
                  index: 0,
                  raw: { messageId: "wa-2", toJid: "1555@s.whatsapp.net" },
                },
              ],
            },
          },
        ],
      }),
    ).toBe(true);
    const msg = {
      key: { remoteJid: "1555@s.whatsapp.net" },
      message: {
        extendedTextMessage: {
          text: "Two",
          contextInfo: { stanzaId: "wa-2" },
        },
      },
    };

    await expect(
      maybeResolveWhatsAppQuestionTextReply({
        cfg: {},
        accountId: "default",
        msg,
        senderId: "+1555",
      }),
    ).resolves.toBe(true);
    expect(hoisted.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ questionId, optionValue: "Two", senderId: "+1555" }),
    );
  });

  it("leaves an ordinary reply that quotes no pending question alone", async () => {
    const msg = {
      key: { remoteJid: "1555@s.whatsapp.net" },
      message: { conversation: "just chatting, not answering anything" },
    };
    await expect(
      maybeResolveWhatsAppQuestionTextReply({
        cfg: {},
        accountId: "default",
        msg,
        senderId: "+1555",
      }),
    ).resolves.toBe(false);
    expect(hoisted.resolve).not.toHaveBeenCalled();
  });

  it("leaves a reply quoting the question with text that matches no option alone", async () => {
    const payload = buildPayload();
    expect(payload).not.toBeNull();
    registerWhatsAppQuestionReactionTargetForDeliveredPayload({
      cfg: {},
      target: { channel: "whatsapp", accountId: "default" },
      payload: payload!,
      results: [
        {
          channel: "whatsapp",
          messageId: "summary",
          toJid: "1555@s.whatsapp.net",
          receipt: {
            platformMessageIds: ["wa-3"],
            sentAt: 1,
            parts: [
              {
                platformMessageId: "wa-3",
                kind: "text",
                index: 0,
                raw: { messageId: "wa-3", toJid: "1555@s.whatsapp.net" },
              },
            ],
          },
        },
      ],
    });
    const msg = {
      key: { remoteJid: "1555@s.whatsapp.net" },
      message: {
        extendedTextMessage: {
          text: "maybe later",
          contextInfo: { stanzaId: "wa-3" },
        },
      },
    };
    await expect(
      maybeResolveWhatsAppQuestionTextReply({
        cfg: {},
        accountId: "default",
        msg,
        senderId: "+1555",
      }),
    ).resolves.toBe(false);
    expect(hoisted.resolve).not.toHaveBeenCalled();
  });
});
