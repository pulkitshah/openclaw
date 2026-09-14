/**
 * The prerequisites a fresh install needs before Duties can do its two outward-facing jobs:
 * dispatch an inbound mail to a Duty (`mail.ts`) and render a document (here).
 *
 * Verified config path (re-check before touching this file):
 * - `browser.ssrfPolicy.allowedHostnames` — `BrowserConfig.ssrfPolicy`
 *   (src/config/types.browser.ts:70) → `SsrFPolicyConfig.allowedHostnames`
 *   (src/config/types.ssrf.ts:10, src/config/zod-schema.core.ts:46).
 *
 * Why it is a prerequisite at all: a `template` step serves its HTML to the managed browser over
 * this plugin's own loopback route, and loopback is a private address, so the browser's navigation
 * guard refuses it (`shouldSkipPrivateNetworkChecks` → `isPrivateNetworkAllowedByPolicy(policy) ||
 * allowedHostnames.has(hostname)`, src/infra/net/ssrf.ts:228-232, reached from
 * extensions/browser/src/browser/navigation-guard.ts:166). Naming the host in `allowedHostnames` is
 * the narrowest opt-in — it opens exactly one address, unlike
 * `dangerouslyAllowPrivateNetwork`, which opens the whole private network.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

/** The config key that lets the managed browser open this plugin's own loopback render page. */
export const RENDER_ALLOWLIST_KEY = "browser.ssrfPolicy.allowedHostnames";
/** The host the render route is always served on (`resolveRenderBaseUrl`, index.ts). */
export const RENDER_LOOPBACK_HOST = "127.0.0.1";
/** One line an owner can act on, used by the CLI readout and by the render adapter's own failure
 *  text so the single error an owner sees carries its own remedy. */
export const RENDER_ALLOWLIST_REMEDY = `set ${RENDER_ALLOWLIST_KEY} to include "${RENDER_LOOPBACK_HOST}" so the managed browser may open the loopback render page`;

export type RenderStatus = {
  /** Whether the managed browser is allowed to open the loopback render page. */
  renderAllowed: boolean;
};

/** Never returns the rest of the allowlist: this is a readiness readout shown on the Duties page
 *  and printed by the CLI, not a config dump. */
export function renderStatusFromConfig(config: OpenClawConfig): RenderStatus {
  const allowed = config.browser?.ssrfPolicy?.allowedHostnames ?? [];
  return {
    renderAllowed: allowed.some(
      (host) => typeof host === "string" && host.trim().toLowerCase() === RENDER_LOOPBACK_HOST,
    ),
  };
}
