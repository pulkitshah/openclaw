import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";

vi.mock("./src/store.js", () => ({
  DutyStore: { open: () => ({}) },
}));

import plugin, { resolveBrowserProfile } from "./index.js";

describe("duties plugin registration", () => {
  it("registers the sidebar tab descriptor", () => {
    const captured = capturePluginRegistration({
      id: "duties",
      name: "Duties",
      register: plugin.register,
    });
    expect(captured.controlUiDescriptors).toContainEqual({
      surface: "tab",
      id: "duties",
      label: "Duties",
      icon: "listChecks",
      group: "control",
      requiredScopes: ["operator.read"],
    });
  });

  it("replays browser steps on the managed profile unless the config names another", () => {
    expect(resolveBrowserProfile(undefined)).toBe("openclaw");
    expect(resolveBrowserProfile({})).toBe("openclaw");
    expect(resolveBrowserProfile({ browserProfile: "  " })).toBe("openclaw");
    expect(resolveBrowserProfile({ browserProfile: 7 })).toBe("openclaw");
    expect(resolveBrowserProfile({ browserProfile: "chrome" })).toBe("chrome");
  });
});
