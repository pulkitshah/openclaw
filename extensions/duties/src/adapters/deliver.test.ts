import { describe, expect, it, vi } from "vitest";
import {
  createAskSessionResolver,
  createDeliverAdapter,
  createRouteResolver,
  maskTarget,
  sessionRouteFromStore,
} from "./deliver.js";

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

// A duty's questions have to be asked in a session the owner can actually answer from. Keyed to
// the dispatcher's own `hook:gmail:*` session, a mail-triggered run's approval gate parked where
// nobody could see or answer it. The rule is the one `deliver` already uses: the chat the run came
// from, otherwise the configured owner.
describe("createAskSessionResolver", () => {
  const cfg = {} as never;
  const ownerRoute = { sessionKey: "agent:krishna:main", agentId: "krishna" };
  const resolver = (ownerTarget: { channel: string; target: string } | undefined) =>
    createAskSessionResolver({
      cfg,
      ownerTarget: async () => ownerTarget,
      resolveRoute: () => ownerRoute as never,
    });

  it("asks in the session the run came from when that was a chat", async () => {
    const resolve = resolver({ channel: "telegram", target: "111" });
    expect(
      await resolve({ kind: "chat", sessionKey: "agent:krishna:duties-p2", agentId: "krishna" }),
    ).toBe("agent:krishna:duties-p2");
  });

  it("asks in the owner's own session for a mail run, not the dispatcher's", async () => {
    const resolve = resolver({ channel: "telegram", target: "5995225650" });
    expect(
      await resolve({ kind: "mail", sessionKey: "hook:gmail:1", agentId: "duties-mail" }),
    ).toBe("agent:krishna:main");
    expect(await resolve({ kind: "manual" })).toBe("agent:krishna:main");
    expect(await resolve(undefined)).toBe("agent:krishna:main");
  });

  it("fails loudly when there is no owner target to ask", async () => {
    const resolve = resolver(undefined);
    await expect(resolve({ kind: "mail", sessionKey: "hook:gmail:1" })).rejects.toThrow(
      /no owner target configured — set it on the Duties page/u,
    );
  });
});

describe("createDeliverAdapter", () => {
  it("sends text and files through the durable batch and surfaces a failed status", async () => {
    const sendBatch = vi.fn(
      async (
        _params: Parameters<
          typeof import("openclaw/plugin-sdk/channel-outbound").sendDurableMessageBatch
        >[0],
      ) => ({
        status: "sent" as const,
        results: [{ messageId: "m1" }],
        receipt: {},
      }),
    );
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
    const failing = vi.fn(
      async (
        _params: Parameters<
          typeof import("openclaw/plugin-sdk/channel-outbound").sendDurableMessageBatch
        >[0],
      ) => ({
        status: "failed" as const,
        error: new Error("channel down"),
      }),
    );
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
  it("throws on partial_failed instead of returning ids as if the batch fully sent", async () => {
    // SAFETY: the adapter only forwards cfg; the stub never inspects it.
    const cfg = {} as unknown as import("openclaw/plugin-sdk/core").OpenClawConfig;
    const originalError = new Error("upload timeout");
    const partial = vi.fn(
      async (
        _params: Parameters<
          typeof import("openclaw/plugin-sdk/channel-outbound").sendDurableMessageBatch
        >[0],
      ) => ({
        status: "partial_failed" as const,
        results: [{ messageId: "m1" }],
        receipt: {},
        error: originalError,
        sentBeforeError: true as const,
        payloadOutcomes: [
          { index: 0, status: "sent" as const, results: [{ messageId: "m1" }] },
          {
            index: 1,
            status: "failed" as const,
            error: originalError,
            sentBeforeError: true,
            stage: "platform_send" as const,
          },
        ],
      }),
    );
    // SAFETY: the stub returns the subset of DurableMessageBatchSendResult the adapter reads.
    const adapter = createDeliverAdapter({
      cfg,
      sendBatch:
        partial as unknown as typeof import("openclaw/plugin-sdk/channel-outbound").sendDurableMessageBatch,
    });
    const promise = adapter.send({
      route: { channel: "telegram", to: "222" },
      text: "hi",
      files: ["/x/a.pdf", "/x/b.pdf"],
    });
    await expect(promise).rejects.toThrow(/delivery partially failed: upload timeout/u);
    await expect(promise).rejects.toThrow(/#1 failed: upload timeout/u);
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBe(originalError);
    });
  });
  it("includes stage and a payload outcome summary on failed, keeping the original error as cause", async () => {
    // SAFETY: the adapter only forwards cfg; the stub never inspects it.
    const cfg = {} as unknown as import("openclaw/plugin-sdk/core").OpenClawConfig;
    const originalError = new Error("channel down");
    const failing = vi.fn(
      async (
        _params: Parameters<
          typeof import("openclaw/plugin-sdk/channel-outbound").sendDurableMessageBatch
        >[0],
      ) => ({
        status: "failed" as const,
        error: originalError,
        stage: "queue" as const,
        payloadOutcomes: [
          {
            index: 0,
            status: "failed" as const,
            error: originalError,
            sentBeforeError: false,
            stage: "queue" as const,
          },
        ],
      }),
    );
    // SAFETY: as above.
    const bad = createDeliverAdapter({
      cfg,
      sendBatch:
        failing as unknown as typeof import("openclaw/plugin-sdk/channel-outbound").sendDurableMessageBatch,
    });
    const promise = bad.send({ route: { channel: "telegram", to: "222" }, text: "hi" });
    await expect(promise).rejects.toThrow(/delivery failed at queue: channel down/u);
    await expect(promise).rejects.toThrow(/1 payload outcome\(s\)/u);
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBe(originalError);
    });
  });
  it("masks phone-like targets", () => {
    expect(maskTarget("+919876543210")).toBe("+91••••3210");
    expect(maskTarget("123456789")).toBe("123456789");
    expect(maskTarget("@someone")).toBe("@someone");
  });
});

describe("sessionRouteFromStore", () => {
  it("omits agentId when the origin has none, letting the session key decide", () => {
    const getEntry = vi.fn(() => undefined);
    sessionRouteFromStore({ kind: "chat", sessionKey: "agent:acme:telegram:1" }, { getEntry });
    expect(getEntry).toHaveBeenCalledWith({ sessionKey: "agent:acme:telegram:1" });
  });
  it("passes agentId through when the origin has one", () => {
    const getEntry = vi.fn(() => undefined);
    sessionRouteFromStore({ kind: "chat", sessionKey: "s1", agentId: "acme" }, { getEntry });
    expect(getEntry).toHaveBeenCalledWith({ agentId: "acme", sessionKey: "s1" });
  });
  it("returns undefined without calling the store when there is no sessionKey", () => {
    const getEntry = vi.fn();
    expect(sessionRouteFromStore({ kind: "chat" }, { getEntry })).toBeUndefined();
    expect(getEntry).not.toHaveBeenCalled();
  });
  it("builds a route from the entry's external delivery context", () => {
    // SAFETY: the stub carries only the `delivery` field deliveryContextFromSession reads.
    const entry = {
      delivery: {
        kind: "external",
        context: { channel: "telegram", to: "222", accountId: "acc1" },
      },
    } as unknown as import("openclaw/plugin-sdk/session-store-runtime").SessionEntry;
    const getEntry = vi.fn(() => entry);
    expect(sessionRouteFromStore({ kind: "chat", sessionKey: "s1" }, { getEntry })).toEqual({
      channel: "telegram",
      to: "222",
      accountId: "acc1",
    });
  });
});
