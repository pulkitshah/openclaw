import { describe, expect, it } from "vitest";
import {
  isAgentDeniedPrivilegedGatewayMethod,
  listAgentAccessClassifiedChannelPairingMethods,
} from "./method-scopes.js";
import { listCoreGatewayHandlerMethodNames } from "./methods/core-descriptors.js";

describe("agent-denied privileged gateway methods", () => {
  it("classifies every channel-pairing method", () => {
    const familyMethods = listCoreGatewayHandlerMethodNames().get("channel-pairing") ?? [];

    expect(familyMethods.toSorted()).toEqual(
      listAgentAccessClassifiedChannelPairingMethods().toSorted(),
    );
  });

  it("denies pairing approval and dismissal, not the read", () => {
    expect(isAgentDeniedPrivilegedGatewayMethod("channels.pairing.approve")).toBe(true);
    expect(isAgentDeniedPrivilegedGatewayMethod("channels.pairing.dismiss")).toBe(true);
    expect(isAgentDeniedPrivilegedGatewayMethod("channels.pairing.list")).toBe(false);
  });

  it("leaves device and node pairing to their own shipped agent tool path", () => {
    expect(isAgentDeniedPrivilegedGatewayMethod("node.pair.approve")).toBe(false);
    expect(isAgentDeniedPrivilegedGatewayMethod("device.pair.approve")).toBe(false);
  });
});
