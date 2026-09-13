import {
  capturePluginRegistration,
  createCapturedPluginRegistration,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { RENDER_ROUTE_PATH } from "./src/adapters/render.js";

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

  it("serves rendered documents to the managed browser on a plugin-authenticated prefix route", () => {
    const captured = createCapturedPluginRegistration({ id: "duties", name: "Duties" });
    const registerHttpRoute = vi.fn();
    captured.api.registerHttpRoute = registerHttpRoute;

    plugin.register(captured.api);

    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: RENDER_ROUTE_PATH,
        match: "prefix",
        auth: "plugin",
        handler: expect.any(Function),
      }),
    );
    expect(RENDER_ROUTE_PATH).toBe("/plugins/duties/render/");
  });
});
