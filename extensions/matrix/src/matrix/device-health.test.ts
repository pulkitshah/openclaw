// Matrix tests cover device health plugin behavior.
import { describe, expect, it } from "vitest";
import { isOpenClawManagedMatrixDevice, summarizeMatrixDeviceHealth } from "./device-health.js";

describe("matrix device health", () => {
  it("detects Vasudev-managed device names", () => {
    expect(isOpenClawManagedMatrixDevice("Vasudev Gateway")).toBe(true);
    expect(isOpenClawManagedMatrixDevice("Vasudev Debug")).toBe(true);
    expect(isOpenClawManagedMatrixDevice("Element iPhone")).toBe(false);
    expect(isOpenClawManagedMatrixDevice(null)).toBe(false);
  });

  it("summarizes stale Vasudev-managed devices separately from the current device", () => {
    const summary = summarizeMatrixDeviceHealth([
      {
        deviceId: "du314Zpw3A",
        displayName: "Vasudev Gateway",
        current: true,
      },
      {
        deviceId: "BritdXC6iL",
        displayName: "Vasudev Gateway",
        current: false,
      },
      {
        deviceId: "G6NJU9cTgs",
        displayName: "Vasudev Debug",
        current: false,
      },
      {
        deviceId: "phone123",
        displayName: "Element iPhone",
        current: false,
      },
    ]);

    expect(summary).toEqual({
      currentDeviceId: "du314Zpw3A",
      currentOpenClawDevices: [
        {
          deviceId: "du314Zpw3A",
          displayName: "Vasudev Gateway",
          current: true,
        },
      ],
      staleOpenClawDevices: [
        {
          deviceId: "BritdXC6iL",
          displayName: "Vasudev Gateway",
          current: false,
        },
        {
          deviceId: "G6NJU9cTgs",
          displayName: "Vasudev Debug",
          current: false,
        },
      ],
    });
  });
});
