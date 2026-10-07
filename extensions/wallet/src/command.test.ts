import { describe, it, expect, beforeEach, vi } from "vitest";
import { walletStatusText } from "./command.js";
import type { WalletState, Summary } from "./store.js";

describe("walletStatusText", () => {
  let baseState: WalletState;
  let baseSummary: Summary;

  beforeEach(() => {
    baseState = {
      creditLimitPaise: 500000,
      lowBalancePaise: 50000,
      enforce: false,
    };
    baseSummary = {
      totalPaise: 0,
      tokens: 0,
      buckets: [],
    };
  });

  describe("funded case", () => {
    it("formats balance and usage with all buckets", () => {
      const text = walletStatusText({
        balancePaise: 124000, // ₹1,240.00
        state: baseState,
        daysLeft: 9,
        summary: {
          totalPaise: -31000, // ₹310.00 spent
          tokens: 0,
          buckets: [
            { activity: "duty", paise: -21200, tokens: 100, activities: [] }, // Duties ₹212.00
            { activity: "chat", paise: -7100, tokens: 50, activities: [] }, // Chat ₹71.00
            { activity: "hosting", paise: -2400, tokens: 0, activities: [] }, // Hosting ₹24.00
            { activity: "system", paise: -300, tokens: 0, activities: [] }, // System ₹3.00
          ],
        },
        contact: "TripIn Studio",
      });

      expect(text).toBe(
        "₹1,240.00 left · ₹310.00 this month (Duties ₹212.00, Chat ₹71.00, Hosting ₹24.00, System ₹3.00) · about 9 days at this rate.",
      );
    });

    it("omits zero buckets", () => {
      const text = walletStatusText({
        balancePaise: 10000, // ₹100.00
        state: baseState,
        daysLeft: 5,
        summary: {
          totalPaise: -20000, // ₹200.00 spent
          tokens: 0,
          buckets: [
            { activity: "duty", paise: -20000, tokens: 100, activities: [] },
            { activity: "chat", paise: 0, tokens: 0, activities: [] }, // zero, should be omitted
            { activity: "hosting", paise: 0, tokens: 0, activities: [] }, // zero, should be omitted
          ],
        },
        contact: "TripIn Studio",
      });

      expect(text).toContain("₹100.00 left · ₹200.00 this month (Duties ₹200.00)");
      expect(text).not.toContain("Chat");
      expect(text).not.toContain("Hosting");
    });

    it("sorts buckets in descending order", () => {
      const text = walletStatusText({
        balancePaise: 10000, // ₹100.00
        state: baseState,
        daysLeft: 5,
        summary: {
          totalPaise: -60000, // ₹600.00 spent
          tokens: 0,
          buckets: [
            { activity: "hosting", paise: -10000, tokens: 0, activities: [] }, // smallest (₹100)
            { activity: "chat", paise: -50000, tokens: 0, activities: [] }, // largest (₹500)
            { activity: "duty", paise: -0, tokens: 0, activities: [] }, // zero
          ],
        },
        contact: "TripIn Studio",
      });

      // Chat (₹500) should come before Hosting (₹100)
      const match = text.match(/\((.*?)\)/);
      expect(match?.[1]).toBe("Chat ₹500.00, Hosting ₹100.00");
    });
  });

  describe("low balance case", () => {
    it("shows low remaining balance", () => {
      const text = walletStatusText({
        balancePaise: 5000, // ₹50.00
        state: baseState,
        daysLeft: 1,
        summary: {
          totalPaise: -10000,
          tokens: 0,
          buckets: [{ activity: "chat", paise: -10000, tokens: 0, activities: [] }],
        },
        contact: "TripIn Studio",
      });

      expect(text).toContain("₹50.00 left");
      expect(text).toContain("about 1 day at this rate");
    });
  });

  describe("paused case", () => {
    it("shows Paused prefix and recharge message when enforce=true and balance exhausted", () => {
      // To trigger pause: balancePaise + creditLimitPaise <= 0
      // If creditLimitPaise = 500000, we need balancePaise <= -500000
      const pausedState = { ...baseState, enforce: true, creditLimitPaise: 50000 };
      const text = walletStatusText({
        balancePaise: -60000, // -60000 + 50000 = -10000, which is <= 0
        state: pausedState,
        daysLeft: null,
        summary: {
          totalPaise: -50000,
          tokens: 0,
          buckets: [{ activity: "chat", paise: -50000, tokens: 0, activities: [] }],
        },
        contact: "TripIn Studio",
      });

      expect(text).toMatch(/^Paused — /);
      expect(text).toContain("Ask TripIn Studio to recharge.");
    });

    it("shows correct contact name in pause message", () => {
      const pausedState = { ...baseState, enforce: true, creditLimitPaise: 50000 };
      const text = walletStatusText({
        balancePaise: -60000, // -60000 + 50000 = -10000, which is <= 0
        state: pausedState,
        daysLeft: null,
        summary: {
          totalPaise: -20000,
          tokens: 0,
          buckets: [],
        },
        contact: "Custom Contact",
      });

      expect(text).toContain("Ask Custom Contact to recharge.");
    });
  });

  describe("no history case", () => {
    it("omits days clause when daysLeft is null", () => {
      const text = walletStatusText({
        balancePaise: 10000, // ₹100.00
        state: baseState,
        daysLeft: null, // not enough history
        summary: {
          totalPaise: -5000, // ₹50.00 spent
          tokens: 0,
          buckets: [{ activity: "chat", paise: -5000, tokens: 0, activities: [] }],
        },
        contact: "TripIn Studio",
      });

      expect(text).toContain("₹100.00 left · ₹50.00 this month");
      expect(text).not.toContain("days at this rate");
    });
  });

  describe("zero buckets omitted", () => {
    it("omits all zero-amount buckets", () => {
      const text = walletStatusText({
        balancePaise: 100000,
        state: baseState,
        daysLeft: 5,
        summary: {
          totalPaise: 0,
          tokens: 0,
          buckets: [
            { activity: "duty", paise: 0, tokens: 0, activities: [] },
            { activity: "chat", paise: 0, tokens: 0, activities: [] },
            { activity: "hosting", paise: 0, tokens: 0, activities: [] },
          ],
        },
        contact: "TripIn Studio",
      });

      // Should have no buckets section
      expect(text).not.toContain("(");
      expect(text).toContain("₹1,000.00 left · ₹0.00 this month");
    });

    it("shows empty bucket list when no buckets", () => {
      const text = walletStatusText({
        balancePaise: 50000,
        state: baseState,
        daysLeft: 3,
        summary: {
          totalPaise: 0,
          tokens: 0,
          buckets: [],
        },
        contact: "TripIn Studio",
      });

      expect(text).toContain("₹500.00 left · ₹0.00 this month");
      expect(text).not.toMatch(/\(.*\)/);
    });
  });

  describe("edge cases", () => {
    it("handles single day correctly", () => {
      const text = walletStatusText({
        balancePaise: 10000,
        state: baseState,
        daysLeft: 1,
        summary: {
          totalPaise: -5000,
          tokens: 0,
          buckets: [],
        },
        contact: "TripIn Studio",
      });

      expect(text).toContain("about 1 day at this rate");
    });

    it("handles zero days", () => {
      const text = walletStatusText({
        balancePaise: 1000,
        state: baseState,
        daysLeft: 0,
        summary: {
          totalPaise: -10000,
          tokens: 0,
          buckets: [],
        },
        contact: "TripIn Studio",
      });

      expect(text).toContain("about 0 days at this rate");
    });

    it("formats large amounts correctly", () => {
      const text = walletStatusText({
        balancePaise: 50000000, // ₹5,00,000.00
        state: baseState,
        daysLeft: 365,
        summary: {
          totalPaise: -1000000, // ₹10,000.00
          tokens: 0,
          buckets: [
            { activity: "duty", paise: -500000, tokens: 0, activities: [] },
            { activity: "chat", paise: -500000, tokens: 0, activities: [] },
          ],
        },
        contact: "TripIn Studio",
      });

      expect(text).toContain("₹5,00,000.00 left");
      expect(text).toContain("₹10,000.00 this month");
      expect(text).toContain("about 365 days at this rate");
    });

    it("uses singular 'about' for single-digit days", () => {
      const text = walletStatusText({
        balancePaise: 10000,
        state: baseState,
        daysLeft: 5,
        summary: {
          totalPaise: -5000,
          tokens: 0,
          buckets: [],
        },
        contact: "TripIn Studio",
      });

      expect(text).toContain("about 5 days");
    });

    it("displays all bucket types", () => {
      const text = walletStatusText({
        balancePaise: 100000,
        state: baseState,
        daysLeft: null,
        summary: {
          totalPaise: -60000,
          tokens: 0,
          buckets: [
            { activity: "chat", paise: -10000, tokens: 0, activities: [] },
            { activity: "duty", paise: -20000, tokens: 0, activities: [] },
            { activity: "mail", paise: -15000, tokens: 0, activities: [] },
            { activity: "system", paise: -5000, tokens: 0, activities: [] },
            { activity: "hosting", paise: -8000, tokens: 0, activities: [] },
            { activity: "integration", paise: -2000, tokens: 0, activities: [] },
          ],
        },
        contact: "TripIn Studio",
      });

      expect(text).toContain("Duties");
      expect(text).toContain("Chat");
      expect(text).toContain("Mail");
      expect(text).toContain("System");
      expect(text).toContain("Hosting");
      expect(text).toContain("Integrations");
    });
  });
});
