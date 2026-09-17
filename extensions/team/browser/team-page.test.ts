// The Team page's own mount, driven through its real DOM: clicks go through the page's actual click
// router into the actual actions, so a control that renders but is wired to nothing fails here.
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { describe, expect, it, vi } from "vitest";
import type { Props } from "./index-helpers.js";
import { createTeamPageMount } from "./team-page.js";

type RequestFn = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** What `team.add` really answers the page's admin probe, which calls it with no fields: the
 *  handler runs (so the scope check passed) and then rejects for the unambiguous reason
 *  `probeAdmin` keys off. Modelled here so the probe's own call is never mistaken for a real add. */
const ADD_PROBE_ERROR = "name is required";

function ownerSaveCalls(request: { mock: { calls: Array<[string, Record<string, unknown>?]> } }) {
  return request.mock.calls.filter(([method]) => method === "team.owner.set");
}

function testHost(request: RequestFn) {
  const events = new Map<string, Set<(payload: unknown) => void>>();
  const abort = new AbortController();
  const host = {
    request,
    onEvent: (event: string, listener: (payload: unknown) => void) => {
      const entries = events.get(event) ?? new Set<(payload: unknown) => void>();
      events.set(event, entries);
      entries.add(listener);
      return () => entries.delete(listener);
    },
    signal: abort.signal,
    // SAFETY: the Team page's mount only reads `request`/`onEvent`, and its view context only
    // `signal`; a full ControlUiHost would be a hundred lines of surfaces this page never reaches.
  } as unknown as ControlUiHost;
  const context = {
    host,
    props: {},
    presented: true,
    signal: abort.signal,
    mountDefault: () => () => undefined,
  } as ControlUiViewContext<Props>;
  return { host, context };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("the Team page's own controls", () => {
  it("saves the owner target the form names and reloads the roster from the click alone", async () => {
    let members: Array<Record<string, unknown>> = [];
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "team.get") {
        return { members, warnings: [] };
      }
      if (method === "team.add") {
        throw new Error(ADD_PROBE_ERROR);
      }
      if (method === "channels.pairing.list") {
        return { requests: [] };
      }
      if (method === "team.owner.set") {
        // What the real handler does on a brand-new desk: seeds the roster's owner row, so the
        // next read answers a roster instead of the form.
        members = [
          {
            id: "owner",
            name: "Owner",
            role: "owner",
            channels: [{ channel: "telegram", senderId: "111" }],
          },
        ];
        return { ok: true, member: members[0] };
      }
      throw new Error(`unexpected ${method}`);
    });
    const { host, context } = testHost(request);
    const container = document.createElement("div");
    const mounted = createTeamPageMount(host)(container, context);
    try {
      await settle();
      const channel = container.querySelector<HTMLSelectElement>("[data-settings-channel]")!;
      const target = container.querySelector<HTMLInputElement>("[data-settings-target]")!;
      const save = container.querySelector<HTMLButtonElement>("[data-settings-save]")!;
      expect(save).not.toBeNull();
      channel.value = "telegram";
      target.value = "  111  ";

      save.click();
      await settle();

      expect(ownerSaveCalls(request)).toEqual([
        ["team.owner.set", { channel: "telegram", target: "111" }],
      ]);
      // The save reloads this page's own team slice, so the form is replaced by the roster it
      // created — the owner is never left looking at a form that appears to have done nothing.
      expect(request.mock.calls.filter(([method]) => method === "team.get")).toHaveLength(2);
      expect(container.textContent).toContain("Owner");
      expect(container.querySelector("[data-settings-save]")).toBeNull();
    } finally {
      mounted?.dispose?.();
    }
  });

  it("keeps an existing identity's accountId when another channel is added to that row", async () => {
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "team.get") {
        return {
          members: [
            {
              id: "ramesh",
              name: "Ramesh",
              role: "member",
              channels: [{ channel: "whatsapp", senderId: "+919812345678", accountId: "business" }],
            },
          ],
          warnings: [],
        };
      }
      if (method === "team.add") {
        throw new Error(ADD_PROBE_ERROR);
      }
      if (method === "channels.pairing.list") {
        return { requests: [] };
      }
      if (method === "team.setChannels") {
        return { ok: true };
      }
      throw new Error(`unexpected ${method}`);
    });
    const { host, context } = testHost(request);
    const container = document.createElement("div");
    const mounted = createTeamPageMount(host)(container, context);
    try {
      await settle();
      container.querySelector<HTMLSelectElement>('[data-team-row-channel="ramesh"]')!.value =
        "telegram";
      container.querySelector<HTMLInputElement>('[data-team-row-sender="ramesh"]')!.value =
        "5551234";
      container.querySelector<HTMLButtonElement>('[data-team-channel-add="ramesh"]')!.click();
      await settle();

      expect(request).toHaveBeenCalledWith("team.setChannels", {
        memberId: "ramesh",
        channels: [
          { channel: "whatsapp", senderId: "+919812345678", accountId: "business" },
          { channel: "telegram", senderId: "5551234" },
        ],
      });
    } finally {
      mounted?.dispose?.();
    }
  });

  it("adds a pending pairing requester to the Team from the prompt's own button, no form to fill", async () => {
    let members: Array<Record<string, unknown>> = [
      {
        id: "owner",
        name: "Owner",
        role: "owner",
        channels: [{ channel: "telegram", senderId: "111" }],
      },
    ];
    const request = vi.fn<RequestFn>(async (method, params) => {
      if (method === "team.get") {
        return { members, warnings: [] };
      }
      if (method === "channels.pairing.list") {
        return {
          requests: [
            {
              requestId: "req-1",
              channel: "telegram",
              channelLabel: "Telegram",
              accountId: "default",
              senderId: "5551234",
              senderLabel: "Telegram user id",
              metadata: { firstName: "Ashu" },
              createdAt: "2026-01-01T00:00:00.000Z",
              lastSeenAt: "2026-01-01T00:00:00.000Z",
              expiresAt: "2026-01-01T01:00:00.000Z",
              notifySupported: true,
            },
          ],
        };
      }
      if (method === "team.add") {
        if (!params || Object.keys(params).length === 0) {
          // The page's own admin probe.
          throw new Error(ADD_PROBE_ERROR);
        }
        members = [...members, { id: "ashu", name: "Ashu", role: "member", channels: [] }];
        return { ok: true, member: members[1], pairingApproved: [] };
      }
      throw new Error(`unexpected ${method}`);
    });
    const { host, context } = testHost(request);
    const container = document.createElement("div");
    const mounted = createTeamPageMount(host)(container, context);
    try {
      await settle();
      expect(container.textContent).toContain("Ashu");
      expect(container.textContent).toContain("Waiting");
      const addButton = container.querySelector<HTMLButtonElement>("[data-team-add-pending]")!;
      expect(addButton).not.toBeNull();

      addButton.click();
      await settle();

      expect(request).toHaveBeenCalledWith("team.add", {
        name: "Ashu",
        channels: [{ channel: "telegram", senderId: "5551234", accountId: "default" }],
      });
    } finally {
      mounted?.dispose?.();
    }
  });

  it("refuses an empty target with a retryable message instead of calling the Gateway", async () => {
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "team.get") {
        return { members: [], warnings: [] };
      }
      if (method === "team.add") {
        throw new Error(ADD_PROBE_ERROR);
      }
      if (method === "channels.pairing.list") {
        return { requests: [] };
      }
      throw new Error(`unexpected ${method}`);
    });
    const { host, context } = testHost(request);
    const container = document.createElement("div");
    const mounted = createTeamPageMount(host)(container, context);
    try {
      await settle();
      container.querySelector<HTMLInputElement>("[data-settings-target]")!.value = "   ";
      container.querySelector<HTMLButtonElement>("[data-settings-save]")!.click();
      await settle();
      expect(ownerSaveCalls(request)).toEqual([]);
      expect(container.textContent).toContain("Choose a channel and enter a target.");
    } finally {
      mounted?.dispose?.();
    }
  });
});
