// Brand constants tests cover the exact product strings surfaced across the CLI.
import { describe, expect, it } from "vitest";
import { CLI_ALIASES, MAKER_LINE, PRODUCT_NAME, TAGLINE } from "./brand.js";

describe("brand constants", () => {
  it("pins the exact product name", () => {
    expect(PRODUCT_NAME).toBe("Vasudev");
  });

  it("pins the exact maker line", () => {
    expect(MAKER_LINE).toBe("Vasudev · by TripIn Studio");
  });

  it("pins the exact tagline", () => {
    expect(TAGLINE).toBe("All your chats, one Vasudev.");
  });

  it("pins the exact CLI aliases", () => {
    expect(CLI_ALIASES).toEqual(["openclaw", "vasudev"]);
  });
});
