/**
 * Access-group admission proof for SMS, driven through the REAL inbound entry point
 * (`dispatchSmsInboundEvent`) with the account resolved by the REAL config reader
 * (`resolveSmsAccount`), because the defect lived in that reader's allowlist normalization:
 * `normalizeSmsAllowFrom` reduced `accessGroup:team` to the bare "+", which survived filtering,
 * matched nobody, and still counted as a configured allowlist — so a roster member was refused
 * with no error anywhere.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveSmsAccount } from "./accounts.js";
import { dispatchSmsInboundEvent, type SmsChannelRuntime } from "./inbound.js";

const sendSmsViaTwilio = vi.hoisted(() => vi.fn(async () => ({ sid: "SM-x", to: "+15551234567" })));
vi.mock("./twilio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./twilio.js")>()),
  sendSmsViaTwilio,
}));

const MEMBER = "+15551234567";
const STRANGER = "+15559998888";

function createRuntime() {
  const run = vi.fn(async () => undefined);
  const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR123", created: true }));
  const runtime = {
    commands: {
      isControlCommandMessage: () => false,
      shouldComputeCommandAuthorized: () => false,
    },
    pairing: { readAllowFromStore: async () => [] as string[], upsertPairingRequest },
    routing: {
      resolveAgentRoute: () => ({
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:sms:direct:x",
      }),
    },
    inbound: { run, buildContext: () => ({}) },
    media: { saveRemoteMedia: vi.fn() },
    session: { resolveStorePath: vi.fn(), recordInboundSession: vi.fn() },
    reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
  } as unknown as SmsChannelRuntime;
  return { runtime, run, upsertPairingRequest };
}

/** `channels.sms.allowFrom` holding only the roster reference, as Team projects it. */
function rosterConfig(memberNumbers: string[]): OpenClawConfig {
  return {
    accessGroups: {
      team: { type: "message.senders", members: { sms: memberNumbers } },
    },
    channels: {
      sms: {
        accountSid: "AC123",
        authToken: "secret",
        fromNumber: "+15557654321",
        dmPolicy: "allowlist",
        allowFrom: ["accessGroup:team"],
      },
    },
  } as unknown as OpenClawConfig;
}

async function dispatch(params: { cfg: OpenClawConfig; from: string }) {
  const mocks = createRuntime();
  await dispatchSmsInboundEvent({
    cfg: params.cfg,
    account: resolveSmsAccount(params.cfg, "default"),
    channelRuntime: mocks.runtime,
    receivedAt: 1_700_000_000_000,
    msg: {
      from: params.from,
      to: "+15557654321",
      body: "hello",
      messageSid: "SM-inbound",
      accountSid: "AC123",
      media: [],
    },
  });
  return mocks;
}

describe("SMS inbound admission resolves accessGroup: allowlist references", () => {
  it("admits a roster member whose only allowFrom entry is accessGroup:team", async () => {
    const { run } = await dispatch({ cfg: rosterConfig([MEMBER]), from: MEMBER });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-member against the same accessGroup:team allowlist", async () => {
    const { run } = await dispatch({ cfg: rosterConfig([MEMBER]), from: STRANGER });
    expect(run).not.toHaveBeenCalled();
  });
});
