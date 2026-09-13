import {
  capturePluginRegistration,
  createCapturedPluginRegistration,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { RENDER_ROUTE_PATH } from "./src/adapters/render.js";

vi.mock("./src/store.js", () => ({
  DutyStore: { open: () => ({}) },
}));

import plugin, { resolveBrowserProfile, resolveRenderBaseUrl } from "./index.js";

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

  it("matches the render base url to the scheme the Gateway actually serves", () => {
    // The port comes from resolveGatewayPort, which honours OPENCLAW_GATEWAY_PORT ahead of config,
    // so the assertions pin the scheme and the loopback host without depending on the environment.
    const plain = resolveRenderBaseUrl({ gateway: { port: 19001 } });
    expect(plain).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    // TLS is served on the same port, so only the scheme changes; an http:// URL would fail at the
    // transport and reach the owner as an opaque browser navigation error.
    expect(resolveRenderBaseUrl({ gateway: { port: 19001, tls: { enabled: true } } })).toBe(
      plain.replace("http://", "https://"),
    );
    expect(resolveRenderBaseUrl({ gateway: { port: 19001, tls: { enabled: false } } })).toBe(plain);
    expect(resolveRenderBaseUrl({ gateway: { port: 19001, tls: {} } })).toBe(plain);
    expect(resolveRenderBaseUrl({})).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  });
});
