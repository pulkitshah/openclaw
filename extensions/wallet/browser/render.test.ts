import { describe, expect, it } from "vitest";
import type { Summary, WalletEntry } from "../src/store.js";
import {
  renderActivities,
  renderAdmin,
  renderBuckets,
  renderEntries,
  renderHeader,
  renderModels,
  renderStatement,
  type WalletGet,
} from "./render.js";

const IST_DAY = Date.UTC(2026, 9, 7, 3, 0, 0); // 7 Oct 2026 08:30 IST

function walletGet(overrides: Partial<WalletGet> = {}): WalletGet {
  return {
    balancePaise: 1_234_567,
    state: { creditLimitPaise: 50_000, lowBalancePaise: 200_000, enforce: true },
    daysLeft: 12,
    period: { from: 0, to: IST_DAY },
    // Debits are stored negative, as wallet.get returns them.
    summary: {
      totalPaise: -100_000,
      tokens: 5000,
      models: [],
      buckets: [
        {
          activity: "chat",
          paise: -75_000,
          tokens: 4000,
          activities: [
            {
              ref: "agent:main:telegram:1",
              label: "Ramesh",
              paise: -50_000,
              tokens: 3000,
              entries: 4,
            },
            {
              ref: "agent:main:telegram:2",
              label: "Suresh",
              paise: -25_000,
              tokens: 1000,
              entries: 2,
            },
          ],
        },
        { activity: "duty", paise: -25_000, tokens: 1000, activities: [] },
      ],
    },
    contact: "TripIn Studio",
    unrecorded: 0,
    rateCard: {
      inrPerUsd: 88,
      multiplier: 2,
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
    ...overrides,
  };
}

const debit: WalletEntry = {
  id: "e1",
  at: IST_DAY,
  kind: "debit",
  charge: "tokens",
  activity: "chat",
  ref: "agent:main:telegram:1",
  provider: "anthropic",
  model: "sonnet",
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  rate: {} as never,
  unpriced: false,
  source: "live",
  amountPaise: -1234,
  balanceAfterPaise: 1_000_000,
  label: "Reply to Ramesh",
};
const credit: WalletEntry = {
  id: "e2",
  at: IST_DAY,
  kind: "credit",
  source: "manual",
  reference: "UPI-1",
  by: "operator",
  amountPaise: 500_000,
  balanceAfterPaise: 1_500_000,
  label: "Recharge",
};

describe("renderHeader", () => {
  it("shows the Indian-grouped balance and the Active chip", () => {
    const html = renderHeader(walletGet(), true);
    expect(html).toContain("₹12,345.67");
    expect(html).toContain("Active");
    expect(html).toContain("12 days");
  });
  it("shows Low once headroom is at or under the low-balance line", () => {
    const html = renderHeader(walletGet({ balancePaise: 100_000 }), true);
    expect(html).toContain("Low");
    expect(html).not.toContain("Active");
  });
  it("shows Paused since the IST date when stopped", () => {
    const html = renderHeader(
      walletGet({
        balancePaise: -60_000,
        state: {
          creditLimitPaise: 50_000,
          lowBalancePaise: 200_000,
          enforce: true,
          stoppedSince: IST_DAY,
        },
      }),
      true,
    );
    expect(html).toContain("Paused since 7 Oct 2026");
    expect(html).toContain("₹−600.00");
  });
  it("shows the credit limit next to the balance when one is set", () => {
    expect(renderHeader(walletGet(), true)).toContain("limit ₹500");
    const none = walletGet({ state: { creditLimitPaise: 0, lowBalancePaise: 0, enforce: false } });
    expect(renderHeader(none, true)).not.toContain("limit ₹");
  });
  it("names the contact, not a person, for recharge", () => {
    expect(renderHeader(walletGet(), false)).toContain("TripIn Studio");
  });
});

describe("renderBuckets and renderActivities", () => {
  it("shows each bucket's rupees and a share bar", () => {
    const html = renderBuckets(walletGet().summary, undefined);
    expect(html).toContain('data-bucket="chat"');
    expect(html).toContain("₹750.00");
    expect(html).toContain("₹250.00");
    expect(html).toContain("width:75%");
    expect(html).toContain("width:25%");
    for (const [, width] of html.matchAll(/width:(-?\d+)%/g)) {
      expect(Number(width)).toBeGreaterThanOrEqual(0);
      expect(Number(width)).toBeLessThanOrEqual(100);
    }
    for (const [, amount] of html.matchAll(/class="bamt mono">([^<]*)</g)) {
      expect(amount).not.toContain("−");
    }
  });
  it("lists the open bucket's activities and marks the open one", () => {
    const summary = walletGet().summary;
    const html = renderActivities(summary.buckets[0]!, "agent:main:telegram:1");
    expect(html).toContain('data-activity="agent:main:telegram:1"');
    expect(html).toContain("Ramesh");
    expect(html).toContain("₹500.00");
    expect(html).toContain("Suresh");
    expect(html).toContain("open");
  });
  it("escapes labels", () => {
    const summary = walletGet().summary;
    const bucket = {
      ...summary.buckets[0]!,
      activities: [{ ref: "r", label: "<b>x</b>", paise: 1, tokens: 0, entries: 1 }],
    };
    expect(renderActivities(bucket, undefined)).not.toContain("<b>x</b>");
  });
});

describe("renderEntries and renderStatement", () => {
  it("renders drill-down rows with amount and tokens", () => {
    const html = renderEntries([debit]);
    expect(html).toContain("Reply to Ramesh");
    expect(html).toContain("₹12.34");
    expect(html).not.toContain("₹−12.34");
    expect(html).toContain("150");
  });
  it("renders the statement with credits and balance after", () => {
    const html = renderStatement([credit, debit]);
    expect(html).toContain("Recharge");
    expect(html).toContain("UPI-1");
    expect(html).toContain("₹5,000.00");
    expect(html).toContain("₹15,000.00");
    expect(html).toContain("data-export");
  });
  it("shows model, tokens and price on each statement row", () => {
    const hosting: WalletEntry = {
      id: "e3",
      at: IST_DAY,
      kind: "debit",
      charge: "service",
      activity: "hosting",
      ref: "hosting:2026-10-07",
      service: "hosting",
      units: 1,
      unit: "day",
      unitRatePaise: 8000,
      source: "live",
      amountPaise: -8000,
      balanceAfterPaise: 900_000,
      label: "Hosting — 7 Oct",
    };
    const big: WalletEntry = {
      ...debit,
      id: "e4",
      provider: "claude-cli",
      model: "claude-opus-5",
      inputTokens: 40_000,
      outputTokens: 2_000,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 200,
    };
    const html = renderStatement([big, hosting, credit]);
    const rows = html.split("<tr").slice(2);
    expect(rows[0]).toContain("Claude Opus 5");
    expect(rows[0]).toContain("Anthropic");
    expect(rows[0]).not.toContain("claude-cli");
    expect(rows[0]).toContain("47.2 k");
    expect(rows[0]).toContain("₹−12.34");
    expect(rows[1]).toContain(">hosting<");
    expect(rows[1]).toContain(`<td class="stokens mono small num"></td>`);
    expect(rows[2]).toContain(
      '<td class="smodel small"></td><td class="stokens mono small num"></td>',
    );
    expect(html).toContain("<th>Model</th>");
  });
});

describe("renderAdmin", () => {
  it("offers Recharge, Adjust, Settings and Backfill", () => {
    const html = renderAdmin(walletGet(), undefined, true);
    for (const hook of [
      'data-open-form="recharge"',
      'data-open-form="adjust"',
      'data-open-form="settings"',
      "data-backfill",
    ]) {
      expect(html).toContain(hook);
    }
  });
  it("renders the open form pre-filled from state", () => {
    const html = renderAdmin(walletGet(), "settings", true);
    expect(html).toContain('data-submit="settings"');
    expect(html).toContain('value="500"');
    expect(html).toContain('value="2000"');
  });
  it("shows the limit, the effective rate card, and the backfill button until it has run", () => {
    const html = renderAdmin(walletGet(), undefined, true);
    expect(html).toContain("Credit limit");
    expect(html).toContain("₹88/USD × 2; fallback claude-opus-5; hosting ₹80/day");
    expect(html).toContain("data-backfill");
    expect(html).not.toContain("not recorded");
  });
  it("replaces the backfill button with its date once done, and flags unrecorded debits", () => {
    const html = renderAdmin(
      walletGet({
        state: {
          creditLimitPaise: 50_000,
          lowBalancePaise: 200_000,
          enforce: true,
          backfillDoneAt: IST_DAY,
        },
        unrecorded: 3,
      }),
      undefined,
      true,
    );
    expect(html).not.toContain("data-backfill");
    expect(html).toContain("Imported past usage on 7 Oct 2026");
    expect(html).toContain("3 debits not recorded — tell TripIn Studio");
  });
  it("draws nothing without canAdmin", () => {
    expect(renderAdmin(walletGet(), "recharge", false)).toBe("");
  });
  it("keeps fractional rupees out of the browser's reach with a 0.01 step", () => {
    expect(renderAdmin(walletGet(), "recharge", true)).toContain('step="0.01"');
  });
});

describe("renderModels", () => {
  const usage = (over: Partial<Summary["models"][number]>): Summary["models"][number] => ({
    provider: "claude-cli",
    model: "claude-opus-5",
    label: "Claude Opus 5",
    paise: -75_000,
    tokens: 38_700_000,
    input: 1,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
    calls: 12,
    unpriced: false,
    ...over,
  });
  const summary = (): Summary => ({
    ...walletGet().summary,
    models: [
      usage({}),
      usage({
        provider: "google",
        model: "mystery",
        label: "mystery",
        paise: -25_000,
        tokens: 900,
        calls: 1,
        unpriced: true,
      }),
    ],
  });

  it("shows label, provider chip, positive rupees, compact tokens, calls and shares", () => {
    const html = renderModels(summary());
    expect(html).toContain("Claude Opus 5");
    expect(html).toContain('class="chip mchip">Anthropic<');
    expect(html).not.toContain("claude-cli");
    expect(html).toContain('class="chip mchip">Google<');
    expect(html).toContain("₹750.00");
    expect(html).toContain("38.7 M");
    expect(html).toContain("900 tokens");
    expect(html).toContain("12 calls");
    expect(html).toContain("1 call<");
    expect(html).toContain("width:75%");
    expect(html).toContain("width:25%");
    for (const [, width] of html.matchAll(/width:(-?\d+)%/g)) {
      expect(Number(width)).toBeGreaterThanOrEqual(0);
      expect(Number(width)).toBeLessThanOrEqual(100);
    }
    expect(html).not.toContain("−");
  });

  it("flags only the model missing from the rate card", () => {
    const html = renderModels(summary());
    expect(html.match(/\(not in rate card\)/g)).toHaveLength(1);
  });

  it("draws nothing without model rows", () => {
    expect(renderModels({ ...summary(), models: [] })).toBe("");
  });
});
