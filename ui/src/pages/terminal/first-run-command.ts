// First-run hand-off: a not-yet-onboarded install lands in the operator
// terminal with the CLI's own guided setup already running, instead of on the
// Model Setup page. This module owns the marker that carries that intent
// through the route and the exact command the terminal types.
import type { RouteLocation } from "@openclaw/uirouter";
import { CLI_DISPLAY_NAME } from "../../../../src/brand.js";
import {
  INTERNAL_TERMINAL_PATH_PARAM,
  restoreBridgedRouteLocation,
} from "../../app-route-paths.ts";

/** Marks the one terminal navigation that must type the guided setup. */
const TERMINAL_FIRST_RUN_PARAM = "firstRun";
export const TERMINAL_FIRST_RUN_SEARCH = `?${TERMINAL_FIRST_RUN_PARAM}=1`;

// The Control UI already is the Gateway's UI and health surface, and the daemon
// this run would install is the one serving this page, so the browser-launched
// onboarding skips exactly those steps. The displayed binary name comes from
// the brand owner so the typed command follows a renamed alias.
export const TERMINAL_FIRST_RUN_COMMAND = `${CLI_DISPLAY_NAME} onboard --skip-daemon --no-install-daemon --skip-ui --skip-health`;

export function isTerminalFirstRunLocation(location: RouteLocation): boolean {
  const restored = restoreBridgedRouteLocation(location, INTERNAL_TERMINAL_PATH_PARAM);
  return new URLSearchParams(restored.search).get(TERMINAL_FIRST_RUN_PARAM) === "1";
}
