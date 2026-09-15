import { PRODUCT_NAME } from "openclaw/plugin-sdk/brand";
import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext session transcript sender labels", () => {
  it("labels assistant turns with the product name", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: { id: 999, type: "private" as const, first_name: "Alice" },
        from: { id: 42, first_name: "Alice", is_bot: false },
        text: "hello",
      },
    });

    expect(context?.ctxPayload.SessionTranscriptContext?.senderLabels).toEqual({
      assistant: PRODUCT_NAME,
      user: "User",
    });
  });
});
