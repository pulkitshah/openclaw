import { describe, expect, it, vi } from "vitest";
import { createDeliverAdapter, createRouteResolver, maskTarget } from "./deliver.js";

describe("createRouteResolver", () => {
  const owner = { channel: "telegram", target: "111" };
  it("routes trigger to the chat origin, and falls back to owner when there was no chat", async () => {
    const resolve = createRouteResolver({
      ownerTarget: async () => owner,
      sessionRoute: (o) =>
        o.sessionKey === "agent:main:telegram:222" ? { channel: "telegram", to: "222" } : undefined,
    });
    expect(
      await resolve("trigger", undefined, { kind: "chat", sessionKey: "agent:main:telegram:222" }),
    ).toEqual({ channel: "telegram", to: "222" });
    expect(
      await resolve("trigger", undefined, { kind: "mail", sessionKey: "hook:gmail:1" }),
    ).toEqual({ channel: "telegram", to: "111" });
    expect(await resolve("trigger", undefined, undefined)).toEqual({
      channel: "telegram",
      to: "111",
    });
    expect(await resolve("+919999", "whatsapp", undefined)).toEqual({
      channel: "whatsapp",
      to: "+919999",
    });
  });
  it("fails loudly when no owner target is configured", async () => {
    const resolve = createRouteResolver({
      ownerTarget: async () => undefined,
      sessionRoute: () => undefined,
    });
    await expect(resolve("owner", undefined, undefined)).rejects.toThrow(
      /no owner target configured — set it on the Duties page/u,
    );
  });
});

describe("createDeliverAdapter", () => {
  it("sends text and files through the durable batch and surfaces a failed status", async () => {
    const sendBatch = vi.fn(async () => ({
      status: "sent" as const,
      results: [{ messageId: "m1" }],
      receipt: {},
    }));
    // SAFETY: the adapter only forwards cfg; the stub never inspects it.
    const cfg = {} as unknown as import("openclaw/plugin-sdk/core").OpenClawConfig;
    // SAFETY: the stub returns the subset of DurableMessageBatchSendResult the adapter reads.
    const adapter = createDeliverAdapter({
      cfg,
      sendBatch:
        sendBatch as unknown as typeof import("openclaw/plugin-sdk/channel-outbound").sendDurableMessageBatch,
    });
    const r = await adapter.send({
      route: { channel: "telegram", to: "222" },
      text: "hi",
      files: ["/x/a.pdf"],
    });
    expect(r.messageIds).toEqual(["m1"]);
    expect(sendBatch.mock.calls[0]?.[0]).toMatchObject({
      channel: "telegram",
      to: "222",
      payloads: [{ text: "hi", mediaUrls: ["/x/a.pdf"] }],
    });
    const failing = vi.fn(async () => ({
      status: "failed" as const,
      error: new Error("channel down"),
    }));
    // SAFETY: as above.
    const bad = createDeliverAdapter({
      cfg,
      sendBatch:
        failing as unknown as typeof import("openclaw/plugin-sdk/channel-outbound").sendDurableMessageBatch,
    });
    await expect(
      bad.send({ route: { channel: "telegram", to: "222" }, text: "hi" }),
    ).rejects.toThrow(/channel down/u);
  });
  it("masks phone-like targets", () => {
    expect(maskTarget("+919876543210")).toBe("+91••••3210");
    expect(maskTarget("123456789")).toBe("123456789");
    expect(maskTarget("@someone")).toBe("@someone");
  });
});
