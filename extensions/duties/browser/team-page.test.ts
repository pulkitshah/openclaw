// The Team page's own mount, driven through its real DOM: clicks go through the page's actual click
// router into the actual actions, so a control that renders but is wired to nothing fails here.
//
// That gap is why this file exists (final review C3): Task 10 moved the empty-roster "Tell Vasu where
// to reach you" form onto this page, `render.test.ts` proved its markup renders, and nothing proved
// the Save button did anything — which it did not, because `data-settings-save` was only ever routed
// on the Duties page, against a DOM root that no longer contains this form.
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { describe, expect, it, vi } from "vitest";
import type { Props } from "./index-helpers.js";
import { createTeamPageMount } from "./team-page.js";

type RequestFn = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** What `duties.settings.set` really answers the page's admin probe, which calls it with no fields:
 *  the handler runs (so the scope check passed) and then rejects for the unambiguous reason
 *  `probeAdmin` keys off. Modelled here so the probe's own call is never mistaken for a save. */
const SETTINGS_PROBE_ERROR = "owner, requireApprovalForEdits, or maxParallelRuns is required";

function ownerSaveCalls(request: { mock: { calls: Array<[string, Record<string, unknown>?]> } }) {
  return request.mock.calls.filter(
    ([method, params]) => method === "duties.settings.set" && params?.owner !== undefined,
  );
}

/** The Team page reads exactly two things off the host — `request` and `onEvent` — plus the view
 *  context's `signal`. Everything else on `ControlUiHost` belongs to surfaces this page never
 *  touches, so the stub carries only those. */
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

/** One microtask turn per awaited `host.request` in the flow under test. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("the Team page's own controls", () => {
  it("saves the owner target the form names and reloads the roster from the click alone", async () => {
    let members: Array<Record<string, unknown>> = [];
    const request = vi.fn<RequestFn>(async (method, params) => {
      if (method === "duties.team.get") return { members, warnings: [] };
      if (method === "duties.settings.set") {
        if (params?.owner === undefined) throw new Error(SETTINGS_PROBE_ERROR);
        // What the real handler does on a brand-new desk: records the owner target and seeds the
        // roster's owner row, so the next read answers a roster instead of the form.
        members = [
          {
            id: "owner",
            name: "Owner",
            role: "owner",
            agentId: "krishna",
            bootstrapPending: false,
            channels: [{ channel: "telegram", senderId: "111" }],
          },
        ];
        return { settings: { owner: { channel: "telegram", target: "111" } } };
      }
      throw new Error(`unexpected ${method}`);
    });
    const { host, context } = testHost(request);
    const container = document.createElement("div");
    const mounted = createTeamPageMount(host)(container, context);
    try {
      await settle();
      // The empty roster renders the owner form, not the roster.
      const channel = container.querySelector<HTMLSelectElement>("[data-settings-channel]")!;
      const target = container.querySelector<HTMLInputElement>("[data-settings-target]")!;
      const save = container.querySelector<HTMLButtonElement>("[data-settings-save]")!;
      expect(save).not.toBeNull();
      channel.value = "telegram";
      target.value = "  111  ";

      save.click();
      await settle();

      expect(ownerSaveCalls(request)).toEqual([
        ["duties.settings.set", { owner: { channel: "telegram", target: "111" } }],
      ]);
      // The save reloads this page's own team slice, so the form is replaced by the roster it
      // created — the owner is never left looking at a form that appears to have done nothing.
      expect(request.mock.calls.filter(([method]) => method === "duties.team.get")).toHaveLength(2);
      expect(container.textContent).toContain("Owner");
      expect(container.querySelector("[data-settings-save]")).toBeNull();
    } finally {
      mounted?.dispose?.();
    }
  });

  it("keeps an existing identity's accountId when another channel is added to that row (I7)", async () => {
    // `setChannels` replaces the whole identity list, so the page sends the existing identities back
    // with the new one. Rebuilding them as bare `{ channel, senderId }` pairs silently widened an
    // account-scoped WhatsApp identity into an unscoped `"*"` match.
    const request = vi.fn<RequestFn>(async (method, params) => {
      if (method === "duties.team.get") {
        return {
          members: [
            {
              id: "ramesh",
              name: "Ramesh",
              role: "member",
              agentId: "ramesh",
              bootstrapPending: false,
              channels: [{ channel: "whatsapp", senderId: "+919812345678", accountId: "business" }],
            },
          ],
          warnings: [],
        };
      }
      if (method === "duties.settings.set" && params?.owner === undefined) {
        throw new Error(SETTINGS_PROBE_ERROR);
      }
      if (method === "duties.team.setChannels") return { ok: true };
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

      expect(request).toHaveBeenCalledWith("duties.team.setChannels", {
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

  it("refuses an empty target with a retryable message instead of calling the Gateway", async () => {
    const request = vi.fn<RequestFn>(async (method, params) => {
      if (method === "duties.team.get") return { members: [], warnings: [] };
      if (method === "duties.settings.set" && params?.owner === undefined) {
        throw new Error(SETTINGS_PROBE_ERROR);
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
