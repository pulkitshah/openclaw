import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveGatewaySessionDisplayName } from "./session-utils-display.js";

// The resolver reads the origin through `sessionDeliveryOrigin`, i.e. only from an EXTERNAL
// delivery record (src/utils/delivery-context.shared.ts:264-268) — a top-level `origin` is never
// consulted, so the fixture has to carry the delivery shape or every case passes vacuously.
function directEntry(label: string, from: string): SessionEntry {
  const channel = from.split(":")[0] ?? "telegram";
  return {
    sessionId: "s1",
    updatedAt: 1,
    chatType: "direct",
    delivery: {
      kind: "external",
      context: { channel, to: from },
      origin: { label, from, provider: channel },
    },
  } as unknown as SessionEntry;
}

describe("resolveGatewaySessionDisplayName", () => {
  it("does not title a per-peer member session with the last channel's origin label", () => {
    // `dmScope: "per-peer"` keys a person's session by roster id with no channel segment, so
    // the origin label is whichever channel they last wrote from — "P (@handle) id:5995…" after
    // Telegram, the contact name after WhatsApp. Naming the session after that leaks a channel
    // identity and flips as the person switches channels; the roster id is the stable name and
    // the UI renders it when the Gateway stays silent.
    const entry = directEntry("P (@curious_pantomath) id:5995225650", "telegram:5995225650");
    expect(resolveGatewaySessionDisplayName("agent:main:direct:pulkit", entry)).toBeUndefined();
    expect(resolveGatewaySessionDisplayName("agent:main:dm:anuj-bansal", entry)).toBeUndefined();
  });

  it("still uses the origin label for a channel-scoped direct session", () => {
    // agent:<x>:<channel>:direct:<id> is one channel's conversation; its origin label is the
    // right name for it and stays.
    const entry = directEntry("Alice", "telegram:42");
    expect(resolveGatewaySessionDisplayName("agent:main:telegram:direct:42", entry)).toBe("Alice");
  });

  it("lets an explicit label win on a member session", () => {
    const entry = {
      ...directEntry("P (@curious_pantomath) id:5995225650", "telegram:5995225650"),
      label: "Pulkit (work)",
    } as SessionEntry;
    expect(resolveGatewaySessionDisplayName("agent:main:direct:pulkit", entry)).toBe(
      "Pulkit (work)",
    );
  });

  it("keeps suppressing dashboard origin labels", () => {
    const entry = directEntry("askvasu@amigosalliance.com", "dashboard:askvasu");
    expect(
      resolveGatewaySessionDisplayName("agent:main:dashboard:0f9d5c1e-6d0f-4c9a", entry),
    ).toBeUndefined();
  });
});
