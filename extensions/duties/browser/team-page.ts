// The Team page's own Control UI mount: registered as a second, independent nav+page pair
// alongside "duties" in index.ts's activate() now that Team is a top-level sidebar item (below
// Duties) rather than a card inside the Duties board's Settings strip. Mirrors the "duties" page
// mount's own shape (context/draw/loaders/click-router/dispose) in index.ts, scoped to the one
// responsibility this page owns: the roster `teamPanel` renders and the four writes
// `team-actions.ts` exposes. Split into its own module for the same reason data-loaders.ts,
// team-actions.ts and index-helpers.ts already are — a real responsibility seam, and index.ts is
// already at the extensions max-lines budget.
import type {
  ControlUiHost,
  ControlUiView,
  ControlUiViewContext,
} from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createTeamLoaders, createTeamPageState } from "./data-loaders.js";
import { attachTeamClickRouter, coerceErrorMessage } from "./index-helpers.js";
import type { Props } from "./index-helpers.js";
import { teamPanel } from "./render.js";
import { createTeamActions } from "./team-actions.js";
import "./styles.css";

export function createTeamPageMount(host: ControlUiHost): ControlUiView<Props> {
  return (container, initial) => {
    let context: ControlUiViewContext<Props> = initial;
    const state = createTeamPageState();
    let lastError: string | null = null;
    let lastRetry: (() => void) | null = null;

    const root = document.createElement("div");
    root.className = "dt";
    container.append(root);

    const fail = (error: unknown, retry: () => void): void => {
      lastError = coerceErrorMessage(error);
      lastRetry = retry;
      draw();
    };

    const clearError = (): void => {
      lastError = null;
      lastRetry = null;
    };

    const draw = (): void => {
      if (context.signal.aborted) {
        return;
      }
      root.innerHTML = teamPanel(
        state.team,
        state.canAdmin,
        lastError ? { error: lastError } : undefined,
      );
    };

    const loaders = createTeamLoaders({
      host,
      getContext: () => context,
      state,
      draw,
      fail,
    });

    const teamActions = createTeamActions({
      host,
      getContext: () => context,
      root,
      getTeam: () => state.team,
      clearError,
      loadTeam: loaders.loadTeam,
      fail,
    });

    attachTeamClickRouter(root, {
      getLastRetry: () => lastRetry,
      addTeamMember: () => void teamActions.addTeamMember(),
      removeTeamMember: (memberId) => void teamActions.removeTeamMember(memberId),
      transferTeamOwnership: (memberId) => void teamActions.transferTeamOwnership(memberId),
      addTeamChannel: (memberId) => void teamActions.addTeamChannel(memberId),
      saveOwnerSettings: () => void teamActions.saveOwnerSettings(),
    });

    // Keeps the roster live when another connection (or this same one, from a mutation above)
    // changes it — the same event the "duties" page's board used to key its own `loadTeam()` off
    // before Team had a page of its own.
    const offChanged = host.onEvent("plugin.duties.changed", (payload) => {
      if (isRecord(payload) && payload.team === true) {
        void loaders.loadTeam();
      }
    });

    draw();
    void loaders.loadTeam();
    void loaders.probeAdmin();

    return {
      update(next) {
        context = next;
        draw();
      },
      dispose() {
        offChanged();
        root.remove();
      },
    };
  };
}
