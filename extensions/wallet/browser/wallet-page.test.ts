// The Wallet page driven through its real DOM: clicks go through the actual router into the actual
// actions, so a control that renders but is wired to nothing fails here.
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { describe, expect, it, vi } from "vitest";
import type { Props } from "./index-helpers.js";
import { createWalletPageMount } from "./wallet-page.js";

type RequestFn = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

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
    // SAFETY: the Wallet page's mount only reads `request`/`onEvent`, and its view context only `signal`.
  } as unknown as ControlUiHost;
  const context = {
    host,
    props: {},
    presented: true,
    signal: abort.signal,
    mountDefault: () => () => undefined,
  } as ControlUiViewContext<Props>;
  const emit = (event: string, payload: unknown) =>
    events.get(event)?.forEach((listener) => listener(payload));
  return { host, context, emit };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const GET = {
  balancePaise: 1_000_000,
  state: { creditLimitPaise: 0, lowBalancePaise: 20_000, enforce: false },
  daysLeft: null,
  period: { from: 0, to: 1 },
  // Debits are stored negative, as wallet.get returns them.
  summary: {
    totalPaise: -100,
    tokens: 10,
    models: [],
    buckets: [
      {
        activity: "chat",
        paise: -100,
        tokens: 10,
        activities: [{ ref: "r1", label: "Ramesh", paise: -100, tokens: 10, entries: 1 }],
      },
    ],
  },
  contact: "TripIn Studio",
  unrecorded: 0,
  rateCard: {
    inrPerUsd: 88,
    multiplier: 2,
    tokenMarkup: 1.3,
    models: {},
    fallback: {
      inputUsdPerM: 5,
      outputUsdPerM: 25,
      cacheReadUsdPerM: 0.5,
      cacheWriteUsdPerM: 6.25,
    },
    aliases: { default: "claude-opus-5" },
    services: { hosting: { unit: "day", inrPerUnit: 80 } },
  },
};

function makeRequest(overrides: Record<string, () => unknown> = {}) {
  return vi.fn<RequestFn>(async (method) => {
    const override = overrides[method];
    if (override) {
      return override();
    }
    switch (method) {
      case "wallet.get":
        return GET;
      case "wallet.ledger":
        return { entries: [] };
      case "wallet.settings":
        return { state: GET.state };
      case "wallet.credit":
        return { entry: {} };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
}

function mount(request: RequestFn) {
  const { host, context, emit } = testHost(request);
  const container = document.createElement("div");
  const mounted = createWalletPageMount(host)(container, context);
  return { container, emit, dispose: () => mounted?.dispose?.() };
}

describe("the Wallet page", () => {
  it("loads the balance, then a bucket click shows its activities", async () => {
    const request = makeRequest();
    const { container, dispose } = mount(request);
    try {
      await settle();
      expect(container.textContent).toContain("₹10,000.00");
      expect(container.querySelector("[data-activity]")).toBeNull();
      container.querySelector<HTMLElement>('[data-bucket="chat"]')!.click();
      await settle();
      expect(container.querySelector('[data-activity="r1"]')).not.toBeNull();
      expect(container.textContent).toContain("Ramesh");
      expect(container.querySelector(".bamt")!.textContent).toBe("₹1.00");
      const width = Number(/width:(\d+)%/.exec(container.innerHTML)![1]);
      expect(width).toBeGreaterThanOrEqual(0);
      expect(width).toBeLessThanOrEqual(100);
    } finally {
      dispose();
    }
  });

  it("Load more passes the ledger's integer-id cursor back", async () => {
    const page = (id: string) => ({
      id,
      at: 1_000,
      kind: "adjustment",
      by: "t",
      label: `Row ${id}`,
      amountPaise: 1,
      balanceAfterPaise: 1,
    });
    let calls = 0;
    const request = makeRequest({
      "wallet.ledger": () =>
        ++calls === 1 ? { entries: [page("7")], nextBefore: 7 } : { entries: [page("3")] },
    });
    const { container, dispose } = mount(request);
    try {
      await settle();
      container.querySelector<HTMLElement>("[data-more]")!.click();
      await settle();
      const ledgerCalls = request.mock.calls.filter(([m]) => m === "wallet.ledger");
      expect(ledgerCalls.at(-1)![1]).toMatchObject({ before: 7 });
      expect(container.textContent).toContain("Row 3");
      expect(container.querySelector("[data-more]")).toBeNull();
    } finally {
      dispose();
    }
  });

  it("Recharge submit sends whole paise, the reference and an empty note", async () => {
    const request = makeRequest();
    const { container, dispose } = mount(request);
    try {
      await settle();
      container.querySelector<HTMLElement>('[data-open-form="recharge"]')!.click();
      container.querySelector<HTMLInputElement>("[data-f-amount]")!.value = "5000";
      container.querySelector<HTMLInputElement>("[data-f-reference]")!.value = "UPI-1";
      container.querySelector<HTMLElement>('[data-submit="recharge"]')!.click();
      await settle();
      expect(request).toHaveBeenCalledWith("wallet.credit", {
        amountPaise: 500000,
        reference: "UPI-1",
        note: "",
      });
      expect(request.mock.calls.filter(([m]) => m === "wallet.get").length).toBeGreaterThanOrEqual(
        2,
      );
    } finally {
      dispose();
    }
  });

  it("reloads when the wallet changes", async () => {
    const request = makeRequest();
    const { container, emit, dispose } = mount(request);
    try {
      await settle();
      const before = request.mock.calls.filter(([m]) => m === "wallet.get").length;
      emit("plugin.wallet.changed", { kind: "debit", balancePaise: 1, state: GET.state });
      await settle();
      expect(request.mock.calls.filter(([m]) => m === "wallet.get").length).toBe(before + 1);
      expect(container.textContent).toContain("₹");
    } finally {
      dispose();
    }
  });

  it("hides the admin strip when the probe is refused for scope", async () => {
    const request = makeRequest({
      "wallet.settings": () => {
        throw new Error("missing scope: operator.admin");
      },
    });
    const { container, dispose } = mount(request);
    try {
      await settle();
      expect(container.querySelector("[data-open-form]")).toBeNull();
      expect(container.textContent).toContain("₹10,000.00");
    } finally {
      dispose();
    }
  });

  it("a period click re-requests with a from bound", async () => {
    const request = makeRequest();
    const { container, dispose } = mount(request);
    try {
      await settle();
      request.mockClear();
      container.querySelector<HTMLElement>('[data-period="30d"]')!.click();
      await settle();
      const call = request.mock.calls.find(([m]) => m === "wallet.get");
      expect(typeof call?.[1]?.from).toBe("number");
    } finally {
      dispose();
    }
  });

  it("export reserves a window before awaiting the csv", async () => {
    const order: string[] = [];
    const win = { closed: false, location: { href: "" }, opener: 1 };
    vi.stubGlobal("open", () => {
      order.push("open");
      return win;
    });
    const request = makeRequest({
      "wallet.export": () => {
        order.push("request");
        return { csv: "a,b" };
      },
    });
    URL.createObjectURL = () => "blob:x";
    const { container, dispose } = mount(request);
    try {
      await settle();
      container.querySelector<HTMLElement>("[data-export]")!.click();
      await settle();
      expect(order).toEqual(["open", "request"]);
      expect(win.location.href).toBe("blob:x");
    } finally {
      dispose();
      vi.unstubAllGlobals();
    }
  });

  it("shows the reload error, not the success notice, when the reload after a write fails", async () => {
    let gets = 0;
    const request = makeRequest({
      "wallet.get": () => {
        gets += 1;
        if (gets > 1) {
          throw new Error("gateway unavailable");
        }
        return GET;
      },
    });
    const { container, dispose } = mount(request);
    try {
      await settle();
      container.querySelector<HTMLElement>('[data-open-form="recharge"]')!.click();
      container.querySelector<HTMLInputElement>("[data-f-amount]")!.value = "10";
      container.querySelector<HTMLInputElement>("[data-f-reference]")!.value = "UPI-2";
      container.querySelector<HTMLElement>('[data-submit="recharge"]')!.click();
      await settle();
      expect(request).toHaveBeenCalledWith("wallet.credit", expect.anything());
      expect(container.textContent).toContain("gateway unavailable");
      expect(container.textContent).not.toContain("Added");
    } finally {
      dispose();
    }
  });

  it("keeps the newer reload's answer when an older wallet.get resolves late", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    let gets = 0;
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "wallet.get") {
        gets += 1;
        return new Promise((resolve) => resolvers.push(resolve));
      }
      if (method === "wallet.ledger") {
        return { entries: [] };
      }
      if (method === "wallet.settings") {
        return { state: GET.state };
      }
      throw new Error(`unexpected ${method}`);
    });
    const { container, emit, dispose } = mount(request);
    try {
      await settle();
      emit("plugin.wallet.changed", {});
      await settle();
      expect(gets).toBe(2);
      resolvers[1]!({ ...GET, balancePaise: 222_200 });
      await settle();
      resolvers[0]!({ ...GET, balancePaise: 111_100 });
      await settle();
      expect(container.textContent).toContain("₹2,222.00");
      expect(container.textContent).not.toContain("₹1,111.00");
    } finally {
      dispose();
    }
  });

  it("keeps the balance when only the drill-down fetch fails", async () => {
    const request = vi.fn<RequestFn>(async (method, params) => {
      if (method === "wallet.get") {
        return GET;
      }
      if (method === "wallet.ledger") {
        if (params?.ref) {
          throw new Error("drill-down failed");
        }
        return { entries: [] };
      }
      return { state: GET.state };
    });
    const { container, dispose } = mount(request);
    try {
      await settle();
      container.querySelector<HTMLElement>('[data-bucket="chat"]')!.click();
      container.querySelector<HTMLElement>('[data-activity="r1"]')!.click();
      await settle();
      expect(container.textContent).toContain("drill-down failed");
      expect(container.textContent).toContain("₹10,000.00");
    } finally {
      dispose();
    }
  });
});
