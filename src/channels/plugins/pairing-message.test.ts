import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../../brand.js";
import { PAIRING_APPROVED_MESSAGE } from "./pairing-message.js";

describe("PAIRING_APPROVED_MESSAGE", () => {
  it("names the product in the pairing approval message", () => {
    expect(PAIRING_APPROVED_MESSAGE).toBe(
      `✅ ${PRODUCT_NAME} access approved. Send a message to start chatting.`,
    );
  });
});
