// Setup wizard types describe onboarding choices and derived config.
import type { GatewayAuthChoice } from "../commands/onboard-types.js";
import type { SecretInput } from "../config/types.secrets.js";

// Shared setup wizard types for quickstart/advanced gateway flows and their
// persisted defaults.
export type WizardFlow = "quickstart" | "advanced";

export type QuickstartGatewayDefaults = {
  hasExisting: boolean;
  port: number;
  bind: "loopback" | "lan" | "auto" | "custom" | "tailnet";
  authMode: GatewayAuthChoice;
  /**
   * An existing auth mode QuickStart does not manage (a reverse proxy or an explicit no-auth
   * setup). "Keeping your current gateway settings" then keeps `gateway.auth` byte for byte;
   * `authMode` is only the fallback the advanced flow offers.
   */
  keptAuthMode?: "trusted-proxy" | "none";
  tailscaleMode: "off" | "serve" | "funnel";
  token?: SecretInput;
  password?: SecretInput;
  customBindHost?: string;
};

export type GatewayWizardSettings = {
  port: number;
  bind: "loopback" | "lan" | "auto" | "custom" | "tailnet";
  customBindHost?: string;
  authMode: GatewayAuthChoice;
  gatewayToken?: string;
  tailscaleMode: "off" | "serve" | "funnel";
};
