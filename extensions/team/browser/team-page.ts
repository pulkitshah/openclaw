// The Team page's own Control UI mount: a top-level sidebar page (see `index.ts`), scoped to the
// one responsibility this plugin owns: the roster `teamPanel` renders and the writes
// `team-actions.ts` exposes.
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
      root.innerHTML = teamPanel(state.team, state.canAdmin, {
        pending: state.pending,
        ...(lastError ? { error: lastError } : {}),
      });
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
      loadPending: loaders.loadPending,
      fail,
    });

    attachTeamClickRouter(root, {
      getLastRetry: () => lastRetry,
      addTeamMember: () => void teamActions.addTeamMember(),
      addPendingTeamMember: (params) => void teamActions.addPendingTeamMember(params),
      removeTeamMember: (memberId) => void teamActions.removeTeamMember(memberId),
      transferTeamOwnership: (memberId) => void teamActions.transferTeamOwnership(memberId),
      addTeamChannel: (memberId) => void teamActions.addTeamChannel(memberId),
      saveOwnerSettings: () => void teamActions.saveOwnerSettings(),
    });

    // Keeps the roster live when another connection (or this same one, from a mutation above)
    // changes it. The pending-request prompt has no matching push event (core's own channels page
    // polls for the same reason — `ui/src/pages/channels/channels-page.ts`'s `pairingPolling`), so
    // it refreshes on this same signal plus every load the mount already does below; a request that
    // arrives while the page sits idle only surfaces on the next Team-roster change or reload.
    const offChanged = host.onEvent("plugin.team.changed", (payload) => {
      if (isRecord(payload) && payload.team === true) {
        void loaders.loadTeam();
        void loaders.loadPending();
      }
    });

    draw();
    void loaders.loadTeam();
    void loaders.loadPending();
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
