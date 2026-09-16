// Hook mapping fan-out tests protect the per-item action contract: one action
// per payload array element, per-item template payloads, the item cap, and the
// producer-derived gmail body bound.
import { describe, expect, it } from "vitest";
import { applyHookMappings, resolveHookMappings } from "./hooks-mapping.js";

describe("hook mapping fan-out", () => {
  const fanOutUrl = new URL("http://127.0.0.1:18789/hooks/gmail");

  function applyGmailPreset(payload: Record<string, unknown>) {
    const mappings = resolveHookMappings({ presets: ["gmail"] });
    return applyHookMappings(mappings, { payload, headers: {}, url: fanOutUrl, path: "gmail" });
  }

  it("renders one action per batched gmail message with per-message session keys", async () => {
    const result = await applyGmailPreset({
      messages: [
        { id: "m1", from: "a@example.com", subject: "One" },
        { id: "m2", from: "b@example.com", subject: "Two" },
      ],
    });
    expect(result?.ok).toBe(true);
    if (!result?.ok) {
      return;
    }
    expect(result.fanout).toBe(true);
    expect(result.dropped).toBe(0);
    expect(result.actions).toHaveLength(2);
    const agentActions = result.actions.filter((action) => action.kind === "agent");
    expect(agentActions.map((action) => action.sessionKey)).toEqual([
      "hook:gmail:m1",
      "hook:gmail:m2",
    ]);
    expect(agentActions[0]?.message).toContain("a@example.com");
    expect(agentActions[0]?.message).toContain("One");
    expect(agentActions[1]?.message).toContain("b@example.com");
    expect(agentActions[1]?.message).toContain("Two");
  });

  it("produces no actions for an empty or missing fan-out array", async () => {
    for (const payload of [{ messages: [] }, {}, { messages: "not-an-array" }]) {
      const result = await applyGmailPreset(payload as Record<string, unknown>);
      expect(result).toMatchObject({ ok: true, actions: [], fanout: true, dropped: 0 });
    }
  });

  it("attaches the producer-derived body bound to every gmail-path mapping", () => {
    const mappings = resolveHookMappings({
      presets: ["gmail"],
      mappings: [
        {
          id: "gmail-safe-reader",
          match: { path: "gmail" },
          action: "agent",
          forEach: "messages",
          messageTemplate: "{{messages[0].subject}}",
        },
        { id: "other", match: { path: "other" }, action: "agent", messageTemplate: "x" },
      ],
      gmail: { maxBytes: 10_000 },
    });
    const expected = 100 * (10_000 * 3 + 8_192);
    expect(mappings.find((mapping) => mapping.id === "gmail-safe-reader")?.maxBodyBytes).toBe(
      expected,
    );
    expect(mappings.find((mapping) => mapping.id === "gmail")?.maxBodyBytes).toBe(expected);
    expect(mappings.find((mapping) => mapping.id === "other")?.maxBodyBytes).toBeUndefined();
  });

  // Pins the round-1 max-bytes correctness fix: a named account configured for larger messages
  // must get ITS OWN bound, not the root/default one — otherwise its larger messages would be
  // rejected by a bound sized for the smaller default, and gog's redelivery-on-rejection means
  // that wedges inbound mail for that mailbox permanently (see the GMAIL_HOOK_PER_MESSAGE_OVERHEAD
  // comment in hooks-mapping.ts).
  it("uses a named account's own maxBytes for its own mapping's body bound", () => {
    const mappings = resolveHookMappings({
      presets: ["gmail"],
      gmail: {
        maxBytes: 10_000,
        accounts: {
          orders: { account: "orders@example.com" },
          enquiries: { account: "enquiries@example.com", maxBytes: 100_000 },
        },
      },
    });
    const defaultExpected = 100 * (10_000 * 3 + 8_192);
    const enquiriesExpected = 100 * (100_000 * 3 + 8_192);
    // "orders" has no maxBytes override, so it inherits the root default.
    expect(mappings.find((mapping) => mapping.id === "gmail-orders")?.maxBodyBytes).toBe(
      defaultExpected,
    );
    // "enquiries" sets its own, larger maxBytes; its mapping must reflect that, not the root's.
    expect(mappings.find((mapping) => mapping.id === "gmail-enquiries")?.maxBodyBytes).toBe(
      enquiriesExpected,
    );
    expect(enquiriesExpected).toBeGreaterThan(defaultExpected);
  });

  it("rejects nested forEach paths", () => {
    expect(() =>
      resolveHookMappings({
        mappings: [
          {
            id: "nested",
            match: { path: "gmail" },
            action: "agent",
            forEach: "data.messages",
            messageTemplate: "x",
          },
        ],
      }),
    ).toThrow(/forEach must be a top-level payload key/);
  });
});
