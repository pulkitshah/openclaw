// Control UI module implements front-door session behavior.
import { clearWarmBootState } from "./bootstrap-warm-boot.ts";
import { clearStoredGatewaySession, loadSettings } from "./settings.ts";

/**
 * The Vasudev front door (deploy/desk/front-door/auth-server.mjs) terminates
 * sign-in for every customer at one shared origin and proxies each of them to
 * their own desk. Its `/login` and `/logout` endpoints live at the origin root,
 * above any Control UI base path, and are the only paths a signed-out browser
 * reaches.
 *
 * A desk reached directly has no front door, so `/logout` would 404 there. The
 * front door therefore marks the browser with this non-secret, readable
 * companion to its HttpOnly session cookie; its presence is what makes the
 * sign-out control discoverable, and only where it actually works.
 */
const FRONT_DOOR_MARKER_COOKIE = "vasudev_front_door";
const FRONT_DOOR_LOGOUT_PATH = "/logout";

export function frontDoorSignOutAvailable(): boolean {
  try {
    return document.cookie
      .split(";")
      .some((entry) => entry.split("=")[0]?.trim() === FRONT_DOOR_MARKER_COOKIE);
  } catch {
    // No document, or cookies blocked: offer nothing rather than a dead control.
    return false;
  }
}

/**
 * Clear this browser's Gateway state before handing the tab back to the front
 * door. The front door only clears its own session cookie, so a signed-out tab
 * would otherwise keep the previous desk's token, session selection, and cached
 * transcripts and present them to whichever desk the next sign-in reaches.
 */
export function signOutOfFrontDoor(): void {
  // The settings owner resolves the gateway the mounted runtime is bound to, so
  // the cleared scope is the one this page actually authenticated against.
  clearStoredGatewaySession(loadSettings().gatewayUrl);
  clearWarmBootState();
  location.assign(FRONT_DOOR_LOGOUT_PATH);
}
