import { describe, expect, it, vi } from "vitest";
import {
  createAskSessionResolver,
  createDeliverAdapter,
  createMemberAskTarget,
  createOwnerRouteResolver,
  createRouteResolver,
  maskTarget,
  sessionRouteFromStore,
  type TeamMemberRoute,
} from "./deliver.js";

describe("createRouteResolver", () => {
  const owner = { channel: "telegram", target: "111" };
  it("routes trigger to the chat origin, and falls back to owner when there was no chat", async () => {
    const resolve = createRouteResolver({
      ownerTarget: async () => owner,
      sessionRoute: (o) =>
        o.sessionKey === "agent:main:telegram:222" ? { channel: "telegram", to: "222" } : undefined,
      teamMember: async () => undefined,
    });
    expect(
      await resolve("trigger", undefined, { kind: "chat", sessionKey: "agent:main:telegram:222" }),
    ).toEqual([{ channel: "telegram", to: "222" }]);
    expect(
      await resolve("trigger", undefined, { kind: "mail", sessionKey: "hook:gmail:1" }),
    ).toEqual([{ channel: "telegram", to: "111" }]);
    expect(await resolve("trigger", undefined, undefined)).toEqual([
      { channel: "telegram", to: "111" },
    ]);
    expect(await resolve("+919999", "whatsapp", undefined)).toEqual([
      { channel: "whatsapp", to: "+919999" },
    ]);
  });
  it("fails loudly when no owner target is configured", async () => {
    const resolve = createRouteResolver({
      ownerTarget: async () => undefined,
      sessionRoute: () => undefined,
      teamMember: async () => undefined,
    });
    await expect(resolve("owner", undefined, undefined)).rejects.toThrow(
      /no owner target configured — set it on the Team page/u,
    );
  });
});

describe("createRouteResolver: team targets", () => {
  const ramesh: TeamMemberRoute = {
    name: "Ramesh",
    channels: [
      { channel: "whatsapp", senderId: "+919812345678", accountId: "work", addedAt: 1 },
      { channel: "telegram", senderId: "5551234", addedAt: 1 },
    ],
  };
  const resolver = () =>
    createRouteResolver({
      ownerTarget: async () => ({ channel: "telegram", target: "111" }),
      sessionRoute: () => undefined,
      teamMember: async (id) => (id === "ramesh" ? ramesh : undefined),
    });

  it("resolves to that member's id on the named channel, carrying the account", async () => {
    await expect(resolver()("team:ramesh", "whatsapp", undefined)).resolves.toEqual([
      { channel: "whatsapp", to: "+919812345678", accountId: "work" },
    ]);
  });

  it("omits accountId when the identity has none", async () => {
    await expect(resolver()("team:ramesh", "telegram", undefined)).resolves.toEqual([
      { channel: "telegram", to: "5551234" },
    ]);
  });

  it("fans out to every channel identity when no channel was named", async () => {
    await expect(resolver()("team:ramesh", undefined, undefined)).resolves.toEqual([
      { channel: "whatsapp", to: "+919812345678", accountId: "work" },
      { channel: "telegram", to: "5551234" },
    ]);
  });

  it("throws when a member with no channel identities is fanned out, instead of an empty send", async () => {
    const noChannels: TeamMemberRoute = { name: "Empty", channels: [] };
    const resolve = createRouteResolver({
      ownerTarget: async () => ({ channel: "telegram", target: "111" }),
      sessionRoute: () => undefined,
      teamMember: async (id) => (id === "empty" ? noChannels : undefined),
    });
    await expect(resolve("team:empty", undefined, undefined)).rejects.toThrow(
      'deliver to "team:empty": Empty has no channel identity — add one on the Team card',
    );
  });

  it("throws when that member has no identity on the named channel, naming both", async () => {
    await expect(resolver()("team:ramesh", "signal", undefined)).rejects.toThrow(
      'deliver to "team:ramesh": Ramesh has no signal identity — add it on the Team card',
    );
  });

  it("throws on an unknown member id, naming the id", async () => {
    await expect(resolver()("team:nobody", "whatsapp", undefined)).rejects.toThrow(
      'deliver to "team:nobody": no Team member "nobody" — add them on the Team card',
    );
  });

  it("never falls back to the owner for a failed team target", async () => {
    await expect(resolver()("team:nobody", "telegram", undefined)).rejects.toThrow();
  });

  it("leaves owner, trigger and explicit targets exactly as before", async () => {
    const r = resolver();
    await expect(r("owner", undefined, undefined)).resolves.toEqual([
      { channel: "telegram", to: "111" },
    ]);
    await expect(r("trigger", undefined, undefined)).resolves.toEqual([
      { channel: "telegram", to: "111" },
    ]);
    await expect(r("+919700000000", "whatsapp", undefined)).resolves.toEqual([
      { channel: "whatsapp", to: "+919700000000" },
    ]);
  });
});

describe("createMemberAskTarget", () => {
  const ramesh: TeamMemberRoute = {
    name: "Ramesh",
    channels: [
      { channel: "whatsapp", senderId: "+919812345678", accountId: "work" },
      { channel: "telegram", senderId: "5551234" },
    ],
  };
  const cfg = {} as never;

  it("resolves the session and route through the member's first channel identity", async () => {
    const resolveRoute = vi.fn(() => ({ sessionKey: "agent:krishna:direct:ramesh" }) as never);
    const target = createMemberAskTarget({
      cfg,
      teamMember: async (id) => (id === "ramesh" ? ramesh : undefined),
      resolveRoute,
    });
    await expect(target("ramesh")).resolves.toEqual({
      sessionKey: "agent:krishna:direct:ramesh",
      route: { channel: "whatsapp", to: "+919812345678", accountId: "work" },
    });
    expect(resolveRoute).toHaveBeenCalledWith({
      cfg,
      channel: "whatsapp",
      peer: { kind: "direct", id: "+919812345678" },
    });
  });

  it("throws on an unknown member id", async () => {
    const target = createMemberAskTarget({ cfg, teamMember: async () => undefined });
    await expect(target("nobody")).rejects.toThrow(
      'ask target "team:nobody": no Team member "nobody" — add them on the Team card',
    );
  });

  it("throws when the member has no channel identity", async () => {
    const empty: TeamMemberRoute = { name: "Empty", channels: [] };
    const target = createMemberAskTarget({ cfg, teamMember: async () => empty });
    await expect(target("empty")).rejects.toThrow(
      'ask target "team:empty": Empty has no channel identity — add one on the Team card',
    );
  });
});

// A duty's questions have to be asked where the OWNER can answer them, and nowhere else: a tap on
// a question card is gated only by the channel's inline-button scope, so a card announced into a
// group is answerable by any member of that group. The rule: the origin chat only when it IS the
// owner's own direct chat; any other origin asks the owner.
describe("createAskSessionResolver", () => {
  const cfg = {} as never;
  const ownerRoute = { sessionKey: "agent:krishna:main", agentId: "krishna" };
  const owner = { channel: "telegram", target: "111" };
  /** Maps the owner's own chat session onto the owner target; every other session is someone
   *  else's chat (a group, another person's DM). */
  const sessionRoute = (origin: { sessionKey?: string }) =>
    origin.sessionKey === "agent:krishna:telegram:111"
      ? { channel: "telegram", to: "111" }
      : origin.sessionKey === "agent:krishna:telegram:-100group"
        ? { channel: "telegram", to: "-100group" }
        : undefined;
  const resolver = (ownerTarget: { channel: string; target: string } | undefined) =>
    createAskSessionResolver({
      cfg,
      ownerTarget: async () => ownerTarget,
      sessionRoute,
      resolveRoute: () => ownerRoute as never,
    });

  it("asks in the origin session when the run came from the owner's own direct chat", async () => {
    const resolve = resolver(owner);
    expect(
      await resolve({ kind: "chat", sessionKey: "agent:krishna:telegram:111", agentId: "krishna" }),
    ).toBe("agent:krishna:telegram:111");
  });

  it("asks the owner instead when the run came from a group or someone else's chat", async () => {
    const resolve = resolver(owner);
    expect(
      await resolve({
        kind: "chat",
        sessionKey: "agent:krishna:telegram:-100group",
        agentId: "krishna",
      }),
    ).toBe("agent:krishna:main");
    // A chat session with no delivery route at all cannot be proven to be the owner's either.
    expect(await resolve({ kind: "chat", sessionKey: "agent:krishna:unknown" })).toBe(
      "agent:krishna:main",
    );
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
      /no owner target configured — set it on the Team page/u,
    );
  });
});

describe("createOwnerRouteResolver", () => {
  const owner = { channel: "telegram", target: "111" };
  const sessionRoute = (origin: { sessionKey?: string }) =>
    origin.sessionKey === "owner-chat"
      ? { channel: "telegram", to: "111", accountId: "acct" }
      : origin.sessionKey === "group-chat"
        ? { channel: "telegram", to: "-100group" }
        : undefined;

  it("announces into the origin chat only when that chat is the owner's own", async () => {
    const resolve = createOwnerRouteResolver({
      ownerTarget: async () => owner,
      sessionRoute,
    });
    // Same channel and same target: the owner's direct chat, so the accountId it carries is kept.
    expect(await resolve({ kind: "chat", sessionKey: "owner-chat" })).toEqual({
      channel: "telegram",
      to: "111",
      accountId: "acct",
    });
    // A group the owner happens to be in is NOT the owner's chat: anyone there could tap Approve.
    expect(await resolve({ kind: "chat", sessionKey: "group-chat" })).toEqual({
      channel: "telegram",
      to: "111",
    });
    expect(await resolve({ kind: "mail", sessionKey: "hook:gmail:1" })).toEqual({
      channel: "telegram",
      to: "111",
    });
    expect(await resolve(undefined)).toEqual({ channel: "telegram", to: "111" });
  });

  it("fails loudly when no owner target is configured", async () => {
    const resolve = createOwnerRouteResolver({
      ownerTarget: async () => undefined,
      sessionRoute: () => undefined,
    });
    await expect(resolve(undefined)).rejects.toThrow(/no owner target configured/u);
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

// A duty's question has to arrive as something the owner can tap, not a paragraph of text they
// then answer into a different conversation. The channel builds those buttons only from a payload
// that carries both the Gateway-owned option order (`channelData.askUser`) and question-action
// buttons naming the same record id.
describe("createDeliverAdapter question cards", () => {
  const capture = () => {
    const sent: Array<Record<string, unknown>> = [];
    const deliver = createDeliverAdapter({
      cfg: {} as never,
      sendBatch: (async (p: { payloads: Array<Record<string, unknown>> }) => {
        sent.push(...p.payloads);
        return { status: "sent", results: [{ messageId: "m1" }] };
      }) as never,
    });
    return { deliver, sent };
  };

  it("carries the question presentation and option order through to the channel", async () => {
    const { deliver, sent } = capture();
    await deliver.send({
      route: { channel: "telegram", to: "5995225650" },
      text: "Hold?",
      question: { id: "ask_0123456789abcdef0123456789abcdef", options: ["Approve", "Decline"] },
    });
    const payload = sent[0] as {
      text?: string;
      presentation?: { blocks: Array<{ type: string; buttons?: Array<Record<string, unknown>> }> };
      channelData?: { askUser?: { questionId?: string; optionValues?: string[] } };
    };
    expect(payload.text).toBe("Hold?");
    expect(payload.channelData?.askUser).toEqual({
      questionId: "ask_0123456789abcdef0123456789abcdef",
      optionValues: ["Approve", "Decline"],
    });
    const buttons = payload.presentation?.blocks.find((b) => b.type === "buttons")?.buttons;
    expect(buttons).toEqual([
      {
        label: "Approve",
        action: {
          type: "question",
          questionId: "ask_0123456789abcdef0123456789abcdef",
          optionValue: "Approve",
        },
      },
      {
        label: "Decline",
        action: {
          type: "question",
          questionId: "ask_0123456789abcdef0123456789abcdef",
          optionValue: "Decline",
        },
      },
    ]);
  });

  it("sends plain text when the question cannot be rendered as a card", async () => {
    const { deliver, sent } = capture();
    // One option, so there is no Gateway-owned order to map a tap onto.
    await deliver.send({
      route: { channel: "telegram", to: "1" },
      text: "Only one",
      question: { id: "ask_0123456789abcdef0123456789abcdef", options: ["Ok"] },
    });
    expect(sent[0]?.presentation).toBeUndefined();
    expect(sent[0]?.channelData).toBeUndefined();
    expect(sent[0]?.text).toBe("Only one");
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
