// @vitest-environment node
// One shared front door (deploy/desk/front-door) signs several customers in at a
// single origin and proxies each of them to their own desk, so every browser-side
// scope keyed by that origin is shared between customers. These cover what must
// not survive a sign-out in the same tab.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expectedGatewayUrl,
  installSettingsStorageLifecycle,
  makeUiSettings,
  setTestLocation,
} from "../test-helpers/settings-node.ts";
import { frontDoorSignOutAvailable } from "./front-door-session.ts";
import {
  clearStoredGatewaySession,
  loadGatewaySessionSelection,
  loadSettings,
  persistSessionToken,
  saveSettings,
} from "./settings.ts";

describe("clearStoredGatewaySession", () => {
  installSettingsStorageLifecycle();

  it("keeps one customer's Gateway secret and deep session out of the next sign-in", () => {
    setTestLocation({ protocol: "https:", host: "vasudev.tripinstudio.com", pathname: "/" });
    const frontDoorUrl = expectedGatewayUrl("");

    // Desk A: signed in, connected, viewing a deep session path.
    saveSettings(
      makeUiSettings(frontDoorUrl, {
        sessionKey: "prabhat/1f3b6c2e",
        lastActiveSessionKey: "prabhat/1f3b6c2e",
        selectedAgentId: "prabhat",
      }),
    );
    persistSessionToken(frontDoorUrl, "desk-a-gateway-token");
    expect(loadSettings().token).toBe("desk-a-gateway-token");
    expect(loadGatewaySessionSelection(frontDoorUrl)).toMatchObject({
      sessionKey: "prabhat/1f3b6c2e",
      selectedAgentId: "prabhat",
    });

    clearStoredGatewaySession(frontDoorUrl);

    // Desk B reaches the same origin behind the same front door: it must be
    // offered no credential, and no route belonging to desk A.
    expect(loadSettings().token).toBe("");
    expect(sessionStorage.length).toBe(0);
    expect(loadGatewaySessionSelection(frontDoorUrl)).toEqual({
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
    expect(loadSettings().selectedAgentId).toBeUndefined();
  });

  it("leaves another Gateway's stored session alone", () => {
    setTestLocation({ protocol: "https:", host: "vasudev.tripinstudio.com", pathname: "/" });
    const frontDoorUrl = expectedGatewayUrl("");
    const otherUrl = "wss://other-gateway.example/openclaw";
    saveSettings(makeUiSettings(otherUrl, { sessionKey: "main", lastActiveSessionKey: "main" }));
    persistSessionToken(otherUrl, "other-gateway-token");
    persistSessionToken(frontDoorUrl, "front-door-token");

    clearStoredGatewaySession(frontDoorUrl);

    expect(loadSettings(otherUrl).token).toBe("other-gateway-token");
    expect(loadSettings(frontDoorUrl).token).toBe("");
  });
});

describe("frontDoorSignOutAvailable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers sign-out only where the front door marked this browser", () => {
    vi.stubGlobal("document", { cookie: "" } as Document);
    expect(frontDoorSignOutAvailable()).toBe(false);

    vi.stubGlobal("document", { cookie: "theme=dark; vasudev_front_door=1" } as Document);
    expect(frontDoorSignOutAvailable()).toBe(true);
  });

  it("does not mistake a lookalike cookie name for the front-door marker", () => {
    vi.stubGlobal("document", { cookie: "not_vasudev_front_door=1" } as Document);
    expect(frontDoorSignOutAvailable()).toBe(false);
  });

  it("stays silent when the document is unavailable", () => {
    vi.stubGlobal("document", undefined);
    expect(frontDoorSignOutAvailable()).toBe(false);
  });
});
