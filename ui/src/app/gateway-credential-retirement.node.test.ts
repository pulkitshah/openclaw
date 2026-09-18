// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  expectedGatewayUrl,
  installSettingsStorageLifecycle,
  setTestLocation,
} from "../test-helpers/settings-node.ts";
import { retireRejectedGatewayCredential } from "./gateway-credential-retirement.ts";
import { loadSettings, persistSessionToken } from "./settings.ts";

function failedSnapshot(overrides: { lastErrorCode?: string; lastError?: string } = {}) {
  return {
    phase: "offline" as const,
    lastError: overrides.lastError ?? "unauthorized",
    lastErrorCode: overrides.lastErrorCode ?? null,
    lastErrorAuthReason: null,
  };
}

describe("retireRejectedGatewayCredential", () => {
  installSettingsStorageLifecycle();

  function frontDoorGateway(token: string) {
    setTestLocation({ protocol: "https:", host: "vasudev.tripinstudio.com", pathname: "/" });
    const gatewayUrl = expectedGatewayUrl("");
    persistSessionToken(gatewayUrl, token);
    return { gatewayUrl, token, password: "" };
  }

  it("drops a stored token this desk refused, so a reload asks instead of re-presenting it", () => {
    // The shared front door serves several customers' desks from one origin, so
    // this token was stored after a *different* desk accepted it.
    const connection = frontDoorGateway("other-desk-gateway-token");
    expect(loadSettings(connection.gatewayUrl).token).toBe("other-desk-gateway-token");

    retireRejectedGatewayCredential(
      connection,
      failedSnapshot({ lastErrorCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH }),
    );

    expect(loadSettings(connection.gatewayUrl).token).toBe("");
  });

  it("drops a stored token a password-mode desk will never accept", () => {
    const connection = frontDoorGateway("other-desk-gateway-token");

    retireRejectedGatewayCredential(
      connection,
      failedSnapshot({ lastErrorCode: ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING }),
    );

    expect(loadSettings(connection.gatewayUrl).token).toBe("");
  });

  it("keeps a stored token across a failure that is not about authentication", () => {
    const connection = frontDoorGateway("this-desk-gateway-token");

    retireRejectedGatewayCredential(connection, failedSnapshot({ lastError: "connection lost" }));

    expect(loadSettings(connection.gatewayUrl).token).toBe("this-desk-gateway-token");
  });

  it("keeps a stored token while the connection is live", () => {
    const connection = frontDoorGateway("this-desk-gateway-token");

    retireRejectedGatewayCredential(connection, {
      ...failedSnapshot({ lastErrorCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH }),
      phase: "connected",
    });

    expect(loadSettings(connection.gatewayUrl).token).toBe("this-desk-gateway-token");
  });
});
