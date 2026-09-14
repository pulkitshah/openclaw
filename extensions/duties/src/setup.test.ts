import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { RENDER_ALLOWLIST_KEY, renderStatusFromConfig } from "./setup.js";

describe("renderStatusFromConfig", () => {
  it("reports rendering blocked on a default install, where nothing allows the loopback page", () => {
    expect(renderStatusFromConfig({} as OpenClawConfig)).toEqual({ renderAllowed: false });
    expect(
      renderStatusFromConfig({
        browser: { ssrfPolicy: { allowedHostnames: ["internal.example"] } },
      } as OpenClawConfig),
    ).toEqual({ renderAllowed: false });
  });

  it("reports rendering allowed once 127.0.0.1 is on the browser allowlist", () => {
    expect(
      renderStatusFromConfig({
        browser: { ssrfPolicy: { allowedHostnames: ["internal.example", " 127.0.0.1 "] } },
      } as OpenClawConfig),
    ).toEqual({ renderAllowed: true });
  });

  it("names the config key an owner has to set, so the readout and the render failure agree", () => {
    expect(RENDER_ALLOWLIST_KEY).toBe("browser.ssrfPolicy.allowedHostnames");
  });
});
