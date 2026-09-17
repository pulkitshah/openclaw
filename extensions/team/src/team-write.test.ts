import { describe, expect, it, vi } from "vitest";
import { approvePendingPairingRequests } from "./team-write.js";

type GatewayCall = { method: string; params: Record<string, unknown>; scopes?: string[] };

/** A fake `OpenClawPluginApi["runtime"]` slice: `gateway.request` for the `channels.pairing.*`
 *  calls `approvePendingPairingRequests` makes, and `channel.pairing.removeAllowFromStoreEntry` for
 *  the compensating `revokePairingEntries` call its own failure path makes — both real dependencies
 *  of this module, not mocked away, so this test proves the actual wiring between them. */
function fakeRuntime(params: {
  list: (params: Record<string, unknown>) => unknown;
  approve?: (params: Record<string, unknown>) => unknown;
}) {
  const calls: GatewayCall[] = [];
  const removed: Array<{ channel: string; accountId: string; entry: string | number }> = [];
  const runtime = {
    gateway: {
      request: vi.fn(async (method: string, reqParams: Record<string, unknown>, opts?: unknown) => {
        calls.push({
          method,
          params: reqParams,
          ...(opts && typeof opts === "object" && "scopes" in opts
            ? { scopes: (opts as { scopes: string[] }).scopes }
            : {}),
        });
        if (method === "channels.pairing.list") {
          return params.list(reqParams);
        }
        if (method === "channels.pairing.approve") {
          return (params.approve ?? (() => ({})))(reqParams);
        }
        throw new Error(`unexpected method ${method}`);
      }),
    },
    channel: {
      pairing: {
        removeAllowFromStoreEntry: vi.fn(
          async (args: { channel: string; accountId: string; entry: string | number }) => {
            removed.push(args);
            return { changed: true, allowFrom: [] };
          },
        ),
      },
    },
    // SAFETY: `approvePendingPairingRequests` and its `revokePairingEntries` compensation path only
    // read `gateway.request` and `channel.pairing.removeAllowFromStoreEntry`.
  } as never;
  return { runtime, calls, removed };
}

describe("approvePendingPairingRequests", () => {
  it("approves the one pending request matching an identity's channel and senderId", async () => {
    const { runtime, calls } = fakeRuntime({
      list: () => ({
        requests: [
          { requestId: "req-1", channel: "telegram", accountId: "default", senderId: "5551234" },
          { requestId: "req-2", channel: "telegram", accountId: "default", senderId: "9999999" },
        ],
      }),
    });

    const { approved } = await approvePendingPairingRequests({
      runtime,
      identities: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
    });

    expect(approved).toEqual([
      { channel: "telegram", senderId: "5551234", addedAt: 1, accountId: "default" },
    ]);
    const approveCall = calls.find((c) => c.method === "channels.pairing.approve");
    expect(approveCall?.params).toEqual({
      channel: "telegram",
      accountId: "default",
      requestId: "req-1",
      notify: true,
    });
    expect(approveCall?.scopes).toEqual(["operator.pairing"]);
  });

  it("leaves an identity with no matching pending request untouched — no approve call at all", async () => {
    const { runtime, calls } = fakeRuntime({ list: () => ({ requests: [] }) });

    const { approved } = await approvePendingPairingRequests({
      runtime,
      identities: [{ channel: "telegram", senderId: "5551234", addedAt: 1 }],
    });

    expect(approved).toEqual([]);
    expect(calls.some((c) => c.method === "channels.pairing.approve")).toBe(false);
  });

  it("treats a channel with no pairing support the same way — list throwing is not a failure", async () => {
    const { runtime } = fakeRuntime({
      list: () => {
        throw new Error("unknown pairing channel: exec");
      },
    });

    const { approved } = await approvePendingPairingRequests({
      runtime,
      identities: [{ channel: "exec", senderId: "5551234", addedAt: 1 }],
    });

    expect(approved).toEqual([]);
  });

  it("compensates an approval already made this call when a later identity's approve fails", async () => {
    const { runtime, removed } = fakeRuntime({
      list: (reqParams) =>
        reqParams.channel === "telegram"
          ? {
              requests: [
                { requestId: "req-1", channel: "telegram", accountId: "default", senderId: "111" },
              ],
            }
          : {
              requests: [
                { requestId: "req-2", channel: "whatsapp", accountId: "default", senderId: "222" },
              ],
            },
      approve: (reqParams) => {
        if (reqParams.channel === "whatsapp") {
          throw new Error("pending DM access request no longer exists");
        }
        return { requestId: reqParams.requestId, senderId: "111" };
      },
    });

    await expect(
      approvePendingPairingRequests({
        runtime,
        identities: [
          { channel: "telegram", senderId: "111", addedAt: 1 },
          { channel: "whatsapp", senderId: "222", addedAt: 1 },
        ],
      }),
    ).rejects.toThrow("pending DM access request no longer exists");

    // The telegram approval landed as a real pairing-store transaction before whatsapp's failed;
    // it must not survive the whole call failing.
    expect(removed).toEqual([{ channel: "telegram", accountId: "default", entry: "111" }]);
  });
});
