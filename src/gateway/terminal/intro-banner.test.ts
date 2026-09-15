import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../../brand.js";
import { ORB_ART } from "../../cli/claw-banner.js";
import { composeTerminalIntroBanner } from "./intro-banner.js";

describe("composeTerminalIntroBanner", () => {
  it("composes the exact colored CRLF intro and resets ANSI state", () => {
    const banner = composeTerminalIntroBanner();

    expect(banner).toBe(
      `\r\n\x1b[33mWelcome to ${PRODUCT_NAME}.\x1b[0m\r\n\r\n\x1b[95m${ORB_ART.join("\r\n")}\r\n\r\n\x1b[0m`,
    );
    expect(banner.startsWith(`\r\n\x1b[33mWelcome to ${PRODUCT_NAME}.\x1b[0m`)).toBe(true);
    expect(banner.endsWith("\r\n\r\n\x1b[0m")).toBe(true);
    expect(banner.replaceAll("\r\n", "")).not.toContain("\n");
    expect(banner).not.toContain("Claw");
  });
});
