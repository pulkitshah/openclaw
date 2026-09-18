// Control UI module implements gateway credential retirement behavior.
import { resolveAuthHintKind } from "../lib/connection-hints.ts";
import type { ApplicationGatewayConnection, ApplicationGatewaySnapshot } from "./context.ts";
import { persistSessionToken } from "./settings.ts";

/**
 * Retire a stored Gateway secret the Gateway itself has refused.
 *
 * Only a token-mode hello ever persists that secret, so a rejection proves the
 * stored copy belongs to some other Gateway reachable at this same origin — the
 * shared front door (deploy/desk/front-door) serves every customer's desk from
 * one host, and `gatewayOriginScope` cannot tell those desks apart. Dropping it
 * the moment the login gate takes over means a reload asks for the right secret
 * instead of re-presenting a refused one; the submitted value stays in the live
 * connection so the gate can still show and correct it.
 */
export function retireRejectedGatewayCredential(
  connection: Pick<ApplicationGatewayConnection, "gatewayUrl" | "token" | "password">,
  snapshot: Pick<
    ApplicationGatewaySnapshot,
    "phase" | "lastError" | "lastErrorCode" | "lastErrorAuthReason"
  >,
): void {
  if (snapshot.phase === "connected" || !connection.token.trim()) {
    return;
  }
  const hint = resolveAuthHintKind({
    connected: false,
    lastError: snapshot.lastError,
    lastErrorCode: snapshot.lastErrorCode,
    lastErrorAuthReason: snapshot.lastErrorAuthReason,
    hasToken: true,
    hasPassword: Boolean(connection.password.trim()),
  });
  // "required" covers a Gateway asking for a secret it has not been given, which
  // a wrongly scoped token also produces; "trusted-proxy" means this desk wants
  // no token at all. Both make the stored copy unusable here.
  if (hint !== null) {
    persistSessionToken(connection.gatewayUrl, "");
  }
}
