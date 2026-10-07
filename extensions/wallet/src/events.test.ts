import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebitEventEmitter } from "./events.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createDebitEventEmitter", () => {
  it("emits the first debit at once and folds a burst into one trailing event per window", async () => {
    vi.useFakeTimers();
    let balance = -100;
    const emit = vi.fn();
    const debit = createDebitEventEmitter({ emit, balance: async () => balance });
    debit("1");
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith({ balancePaise: -100, kind: "debit", entryId: "1" });
    for (const id of ["2", "3", "4"]) {
      balance -= 100;
      debit(id);
    }
    await vi.advanceTimersByTimeAsync(1_999);
    expect(emit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith({ balancePaise: -400, kind: "debit", entryId: "4" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
