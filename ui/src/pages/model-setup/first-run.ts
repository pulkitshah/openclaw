import type { RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { pluginSlugCandidate } from "../../app-route-paths.ts";
import { sameRouteLocation, type RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { readSessionDefaults } from "../../lib/sessions/session-key.ts";
import { isTerminalAvailable } from "../../lib/terminal-availability.ts";
import { TERMINAL_FIRST_RUN_SEARCH } from "../terminal/first-run-command.ts";

export type FirstRunSetupDestination = { routeId: RouteId; search: string };

/** Onboarding for a connection that cannot open a terminal. */
export const MODEL_SETUP_FIRST_RUN_DESTINATION: FirstRunSetupDestination = {
  routeId: "model-setup",
  search: "?firstRun=1",
};

/**
 * Where an install with no configured model lands. The CLI's guided `onboard`
 * run inside the operator terminal is the product's onboarding, so it wins
 * whenever this connection can actually open a terminal. The Model Setup page
 * stays the fallback for a disabled terminal surface, a Gateway that does not
 * advertise it, or a connection without operator.admin — a fresh install is
 * never left stranded on the default Chat landing.
 */
export function firstRunSetupDestination(
  context: Pick<ApplicationContext<RouteId>, "gateway" | "config">,
): FirstRunSetupDestination {
  return isTerminalAvailable(
    context.gateway.snapshot,
    context.config.current.terminalEnabled ?? false,
  )
    ? { routeId: "terminal", search: TERMINAL_FIRST_RUN_SEARCH }
    : MODEL_SETUP_FIRST_RUN_DESTINATION;
}

export function isDefaultChatLanding(
  location: RouteLocation,
  basePath: string,
  routeIdFromPath: (pathname: string, basePath: string) => string | null,
): boolean {
  return (
    !new URLSearchParams(location.search + "&" + location.hash.slice(1)).has("session") &&
    !pluginSlugCandidate(location.pathname, basePath) &&
    (routeIdFromPath(location.pathname, basePath) === null ||
      /^\/chat(?:\/main)?\/?$/u.test(location.pathname.slice(basePath.length)))
  );
}

export async function startModelSetupFirstRunRedirectAfterLocation(params: {
  context: ApplicationContext<RouteId>;
  enabled: boolean;
  history: Pick<RouterHistory, "location" | "replace">;
  initialLocationReady: Promise<RouteLocation>;
  installLocation?: (location: RouteLocation) => void | Promise<void>;
  shouldInstallLocation?: () => boolean;
  redirect?: (destination: FirstRunSetupDestination) => void;
  onInitialDecision?: () => void;
}): Promise<() => void> {
  const initialLocation = await params.initialLocationReady;
  if (
    !sameRouteLocation(params.history.location(), initialLocation) &&
    params.shouldInstallLocation?.() !== false
  ) {
    if (params.installLocation) {
      await params.installLocation(initialLocation);
    } else {
      params.history.replace(initialLocation);
    }
  }
  if (!params.enabled) {
    params.onInitialDecision?.();
    return () => undefined;
  }
  const { context } = params;
  const isStillDefaultLanding = () => sameRouteLocation(params.history.location(), initialLocation);
  const redirect =
    params.redirect ??
    ((destination: FirstRunSetupDestination) =>
      context.replace(destination.routeId, { search: destination.search }));
  let initialDecisionSettled = false;
  const settleInitialDecision = () => {
    if (!initialDecisionSettled) {
      initialDecisionSettled = true;
      params.onInitialDecision?.();
    }
  };
  const handleSnapshot: Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0] = (
    snapshot,
  ) => {
    if (initialDecisionSettled) {
      return;
    }
    if (snapshot.phase !== "connected") {
      // A build fence can move a previously authenticated client straight into
      // reconnecting or reload-required, while a terminal first attempt returns
      // to stopped. Do not hold the router when the shell needs to present recovery.
      if (snapshot.hello || snapshot.phase === "reload-required" || snapshot.phase === "stopped") {
        settleInitialDecision();
      }
      return;
    }
    const defaults = readSessionDefaults(snapshot);
    const selectedAgentId = context.agentSelection.state.selectedId?.trim() || null;
    if (
      canCallGatewayMethod(snapshot, "openclaw.setup.detect", "operator.admin") &&
      (!selectedAgentId || selectedAgentId === defaults?.defaultAgentId?.trim()) &&
      isStillDefaultLanding()
    ) {
      if (defaults?.modelConfigured === false) {
        redirect(firstRunSetupDestination(context));
      } else if (defaults?.modelConfigured) {
        try {
          if (localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")) {
            const ownerRevision = context.gateway.connectionRevision;
            // Crypto stays lazy; only an existing receipt suspends startup.
            void import("./model-setup-page.ts")
              .then(({ resumeFirstRunActivation }) =>
                resumeFirstRunActivation(
                  {
                    context,
                    isStillDefaultLanding,
                    // An unfinished activation was started on the Model Setup
                    // page; recovery returns to the surface that owns it.
                    redirect: () => redirect(MODEL_SETUP_FIRST_RUN_DESTINATION),
                  },
                  snapshot,
                  ownerRevision,
                  selectedAgentId,
                  () => initialDecisionSettled,
                  settleInitialDecision,
                ),
              )
              .catch(settleInitialDecision);
            return;
          }
        } catch {
          // Blocked browser storage cannot own durable activation recovery.
        }
      }
    }
    settleInitialDecision();
  };
  const unsubscribe = context.gateway.subscribe(handleSnapshot);
  handleSnapshot(context.gateway.snapshot);
  return () => {
    unsubscribe();
    settleInitialDecision();
  };
}
