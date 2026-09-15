import { PRODUCT_NAME } from "../../brand.js";
import { ORB_ART } from "../../cli/claw-banner.js";
const RESET = "\x1b[0m";

// The terminal greets with the same dot-matrix orb the CLI banner draws (one owner: src/cli/claw-banner.ts).

// Always full art: open-time request.cols is the pre-fit boot grid (the client
// resizes immediately after open), so width gating keyed on it suppressed the
// art on real, wide terminals.
// ANSI-16 colors only: the server can't know the client's light/dark mode, and
// fixed 256-color indices (223/216) bypass the client theme and vanish on light
// backgrounds. Yellow/bright-magenta stay warm on dark and darken on light.
export function composeTerminalIntroBanner(): string {
  const headline = `\x1b[33mWelcome to ${PRODUCT_NAME}.${RESET}`;
  const art = `\x1b[95m${ORB_ART.join("\r\n")}\r\n\r\n`;
  return `\r\n${headline}\r\n\r\n${art}${RESET}`;
}
