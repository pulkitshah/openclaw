import { describe, expect, it, vi } from "vitest";
import { istDay, postHostingDebits, startHostingJob } from "./hosting.js";
import { resolveRateCard } from "./money.js";
import { memoryStore } from "./store.test-helpers.js";

const card = resolveRateCard({ services: { hosting: { unit: "day", inrPerUnit: 80 } } });
const noHosting = { ...card, services: {} };
// 2026-10-07 20:00 IST
const now = Date.UTC(2026, 9, 7, 14, 30);

describe("istDay", () => {
  it("handles the UTC/IST midnight boundary", () => {
    expect(istDay(Date.UTC(2026, 9, 6, 18, 31))).toBe("2026-10-07");
    expect(istDay(Date.UTC(2026, 9, 6, 18, 29))).toBe("2026-10-06");
  });
});

describe("postHostingDebits", () => {
  it("posts one hosting debit per IST day from hostingStartedOn through today, idempotently", async () => {
    const store = memoryStore();
    await store.setState({ hostingStartedOn: "2026-10-05" });
    const onChanged = vi.fn();
    const afterDebit = vi.fn(async () => {});
    const deps = { store, rateCard: () => card, now: () => now, onChanged, afterDebit };
    expect(await postHostingDebits(deps)).toBe(3);
    const rows = await store.list({ kind: "debit" });
    expect(rows.map((r) => r.ref).toSorted()).toEqual([
      "hosting:2026-10-05",
      "hosting:2026-10-06",
      "hosting:2026-10-07",
    ]);
    const first = rows.find((r) => r.ref === "hosting:2026-10-05");
    expect(first).toMatchObject({
      amountPaise: -8000,
      label: "Hosting — 5 Oct",
      activity: "hosting",
      service: "hosting",
      units: 1,
      unit: "day",
      unitRatePaise: 8000,
      at: Date.UTC(2026, 9, 4, 18, 30),
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(afterDebit).toHaveBeenCalledTimes(1);
    expect(await postHostingDebits(deps)).toBe(0);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(afterDebit).toHaveBeenCalledTimes(1);
  });

  it("does nothing when services.hosting is absent", async () => {
    const store = memoryStore();
    const onChanged = vi.fn();
    expect(
      await postHostingDebits({ store, rateCard: () => noHosting, now: () => now, onChanged }),
    ).toBe(0);
    expect(await store.list({})).toEqual([]);
    expect((await store.getState()).hostingStartedOn).toBeUndefined();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("sets hostingStartedOn to today on first run when unset", async () => {
    const store = memoryStore();
    const n = await postHostingDebits({
      store,
      rateCard: () => card,
      now: () => now,
      onChanged: () => {},
    });
    expect(n).toBe(1);
    expect((await store.getState()).hostingStartedOn).toBe("2026-10-07");
  });
});

describe("startHostingJob", () => {
  it("runs immediately and on the interval, logs errors, and stops", async () => {
    vi.useFakeTimers({ now });
    try {
      const store = memoryStore();
      const log = vi.fn();
      let calls = 0;
      const stop = startHostingJob(
        {
          store,
          rateCard: () => {
            calls += 1;
            if (calls === 2) throw new Error("boom");
            return card;
          },
          now: () => Date.now(),
          onChanged: () => {},
          log,
        },
        1000,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(await store.hasHosting("2026-10-07")).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a tick while the previous run is still in flight", async () => {
    vi.useFakeTimers({ now });
    try {
      const store = memoryStore();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realHas = store.hasHosting.bind(store);
      vi.spyOn(store, "hasHosting").mockImplementation(async (day) => {
        await gate;
        return realHas(day);
      });
      const stop = startHostingJob(
        {
          store,
          rateCard: () => card,
          now: () => Date.now(),
          onChanged: () => {},
          log: () => {},
        },
        1000,
      );
      await vi.advanceTimersByTimeAsync(1000);
      release();
      await vi.advanceTimersByTimeAsync(0);
      stop();
      expect(await store.list({ kind: "debit" })).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
