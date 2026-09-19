/**
 * Access-group admission proof driven through Telegram's REAL registered inbound gate
 * (`createTelegramHandlerAuthorization(...).authorizeInboundMessage`) — the same call
 * `bot-handlers.inbound-pipeline.ts` makes before it will dispatch or reply.
 *
 * A helper-level test on `normalizeAllowFrom` or `expandTelegramAllowFromWithAccessGroups`
 * would pass while this gate still returns `{ allowed: false }`, which is exactly how the
 * `accessGroup:team` regression reached a live desk.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import { createTelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";

const MEMBER_ID = "111222333";
const STRANGER_ID = "999888777";
const GROUP_CHAT_ID = -1001234567890;

/** The exact shape `extensions/team/src/team.ts` projects for a one-member roster. */
function teamAccessGroups(senderIds: string[], key = "telegram") {
  return {
    team: {
      type: "message.senders" as const,
      members: { [key]: senderIds },
    },
  };
}

function handlerParams(cfg: OpenClawConfig, overrides?: Partial<RegisterTelegramHandlerParams>) {
  const telegramCfg = cfg.channels?.telegram ?? {};
  return {
    accountId: "default",
    ownerAgentId: "main",
    bot: {
      api: { sendMessage: vi.fn(async () => ({ message_id: 1 })) },
    } as unknown as RegisterTelegramHandlerParams["bot"],
    cfg,
    mediaMaxBytes: 1,
    opts: { token: "test-token" },
    runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    telegramCfg,
    telegramDeps: {
      ...defaultTelegramBotDeps,
      getRuntimeConfig: () => cfg,
      readChannelAllowFromStore: async () => [],
      upsertChannelPairingRequest: vi.fn(async () => ({ created: true, id: "1" })),
    },
    logger: getChildLogger({ module: "telegram/access-group-admission-test" }),
    resolveGroupPolicy: () => ({ allowlistEnabled: true, allowed: true }),
    resolveGroupActivation: () => undefined,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({ groupConfig: undefined, topicConfig: undefined }),
    shouldSkipUpdate: () => false,
    processMessage: async () => ({ kind: "completed" as const }),
    ...overrides,
  } as RegisterTelegramHandlerParams;
}

async function authorizeDm(params: { cfg: OpenClawConfig; senderId: string }) {
  return await createTelegramHandlerAuthorization(
    handlerParams(params.cfg),
  ).authorizeInboundMessage({
    msg: {
      message_id: 11,
      date: 1_700_000_000,
      chat: { id: Number(params.senderId), type: "private" },
      from: { id: Number(params.senderId), is_bot: false, first_name: "Pat" },
      text: "hello",
    } as never,
    chatId: Number(params.senderId),
    isGroup: false,
    isForum: false,
    senderId: params.senderId,
    senderUsername: "",
    requireConfiguredGroup: false,
    dmAccess: "silent",
  });
}

async function authorizeGroup(params: {
  cfg: OpenClawConfig;
  senderId: string;
  overrides?: Partial<RegisterTelegramHandlerParams>;
}) {
  return await createTelegramHandlerAuthorization(
    handlerParams(params.cfg, {
      // The live shape: the chat has its own `groups.<id>` entry, so `chatExplicitlyAllowed` is
      // true and the "listed chat with no sender allowlist" shortcut is in play.
      resolveGroupPolicy: () => ({ allowlistEnabled: true, allowed: true, groupConfig: {} }),
      ...params.overrides,
    }),
  ).authorizeInboundMessage({
    msg: {
      message_id: 12,
      date: 1_700_000_000,
      chat: { id: GROUP_CHAT_ID, type: "supergroup", title: "Monitored" },
      from: { id: Number(params.senderId), is_bot: false, first_name: "Pat" },
      text: "hello",
    } as never,
    chatId: GROUP_CHAT_ID,
    isGroup: true,
    isForum: false,
    senderId: params.senderId,
    senderUsername: "",
    requireConfiguredGroup: false,
    dmAccess: "silent",
  });
}

describe("Telegram inbound gate resolves accessGroup: allowlist references", () => {
  it("admits a roster member whose only DM allowlist entry is accessGroup:team", async () => {
    const cfg = {
      accessGroups: teamAccessGroups([MEMBER_ID]),
      channels: {
        telegram: { dmPolicy: "allowlist", allowFrom: ["accessGroup:team"] },
      },
    } as unknown as OpenClawConfig;

    expect((await authorizeDm({ cfg, senderId: MEMBER_ID })).allowed).toBe(true);
  });

  it("refuses a non-member against the same accessGroup:team DM allowlist", async () => {
    const cfg = {
      accessGroups: teamAccessGroups([MEMBER_ID]),
      channels: {
        telegram: { dmPolicy: "allowlist", allowFrom: ["accessGroup:team"] },
      },
    } as unknown as OpenClawConfig;

    expect((await authorizeDm({ cfg, senderId: STRANGER_ID })).allowed).toBe(false);
  });

  it("admits a roster member in a group under groupPolicy allowlist", async () => {
    const cfg = {
      accessGroups: teamAccessGroups([MEMBER_ID]),
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          allowFrom: ["accessGroup:team"],
          groupAllowFrom: ["accessGroup:team"],
          groups: { [String(GROUP_CHAT_ID)]: {} },
        },
      },
    } as unknown as OpenClawConfig;

    expect((await authorizeGroup({ cfg, senderId: MEMBER_ID })).allowed).toBe(true);
  });

  it("refuses a non-member in a group under groupPolicy allowlist", async () => {
    const cfg = {
      accessGroups: teamAccessGroups([MEMBER_ID]),
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          allowFrom: ["accessGroup:team"],
          groupAllowFrom: ["accessGroup:team"],
          groups: { [String(GROUP_CHAT_ID)]: {} },
        },
      },
    } as unknown as OpenClawConfig;

    expect((await authorizeGroup({ cfg, senderId: STRANGER_ID })).allowed).toBe(false);
  });

  it("keeps a chat-listed group open when no sender allowlist is configured at all", async () => {
    // Shipped behavior the live desks depend on: `groups.<id>` with no sender allowlist admits
    // every member of that chat. A blind drop of `accessGroup:` entries would keep passing this
    // while failing open on the two tests above it.
    const cfg = {
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: { [String(GROUP_CHAT_ID)]: {} },
        },
      },
    } as unknown as OpenClawConfig;

    expect((await authorizeGroup({ cfg, senderId: STRANGER_ID })).allowed).toBe(true);
  });

  it("reports the roster group as referenced and matched in the admitted ingress state", async () => {
    // The gate's own access graph, not a helper's return value. Telegram used to hand the shared
    // resolver a list with the `accessGroup:` reference already stripped, so admission evidence and
    // `openclaw doctor` saw a channel with no group references at all.
    const cfg = {
      accessGroups: teamAccessGroups([MEMBER_ID]),
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          allowFrom: ["accessGroup:team"],
          groupAllowFrom: ["accessGroup:team"],
          groups: { [String(GROUP_CHAT_ID)]: {} },
        },
      },
    } as unknown as OpenClawConfig;

    const gate = await authorizeGroup({ cfg, senderId: MEMBER_ID });
    if (!gate.allowed) {
      throw new Error("expected the roster member to be admitted");
    }
    const ingress = await gate.resolveChannelIngress({
      agentId: "main",
      sessionKey: `agent:main:telegram:group:${String(GROUP_CHAT_ID)}`,
      messageId: "12",
      inboundEventKind: "user_request",
    });
    expect(ingress.state.allowlists.group.accessGroups).toMatchObject({
      referenced: ["team"],
      matched: ["team"],
      missing: [],
      unsupported: [],
    });
    expect(ingress.state.allowlists.group.hasConfiguredEntries).toBe(true);
  });

  it("scopes a roster identity to its own channel account", async () => {
    const cfg = {
      accessGroups: teamAccessGroups([MEMBER_ID], "telegram:work"),
      channels: {
        telegram: { dmPolicy: "allowlist", allowFrom: ["accessGroup:team"] },
      },
    } as unknown as OpenClawConfig;

    const onWork = await createTelegramHandlerAuthorization(
      handlerParams(cfg, { accountId: "work" }),
    ).authorizeInboundMessage({
      msg: {
        message_id: 13,
        date: 1_700_000_000,
        chat: { id: Number(MEMBER_ID), type: "private" },
        from: { id: Number(MEMBER_ID), is_bot: false, first_name: "Pat" },
        text: "hello",
      } as never,
      chatId: Number(MEMBER_ID),
      isGroup: false,
      isForum: false,
      senderId: MEMBER_ID,
      senderUsername: "",
      requireConfiguredGroup: false,
      dmAccess: "silent",
    });
    expect(onWork.allowed).toBe(true);

    // Same roster entry, different account: `telegram:work` must not admit on `default`.
    expect((await authorizeDm({ cfg, senderId: MEMBER_ID })).allowed).toBe(false);
  });
});
