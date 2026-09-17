// Data-loading actions for the Team Control UI page: every `host.request` call that updates the
// page's server-sourced state and redraws.
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import type { TeamGetResult, Props } from "./index-helpers.js";
import type { TeamPendingRequestView, TeamView } from "./render.js";

export type TeamPageState = {
  team: TeamView | undefined;
  /** Pending DM-pairing requests, straight off `channels.pairing.list` — every request across every
   *  pairing-policy channel, not filtered to Team's own channels: a person waiting to be added may
   *  be on a channel no current member has an identity on yet. Empty (not `undefined`) until the
   *  first load answers, so `render.ts`'s `pendingSection` shows nothing rather than a loading
   *  state for a feature the roster view does not otherwise block on. */
  pending: TeamPendingRequestView[];
  /** Cosmetic only — hides the Team panel's mutating controls. `team.*` writes are gated at
   *  `operator.admin` server-side, which is the actual authority check; see `probeAdmin` below.
   *  Defaults `true` so the buttons show until the probe answers, rather than flashing hidden. */
  canAdmin: boolean;
};

export function createTeamPageState(): TeamPageState {
  return { team: undefined, pending: [], canAdmin: true };
}

export function createTeamLoaders(deps: {
  host: ControlUiHost;
  getContext: () => ControlUiViewContext<Props>;
  state: TeamPageState;
  draw: () => void;
  fail: (error: unknown, retry: () => void) => void;
}) {
  const { host, getContext, state, draw, fail } = deps;

  const loadTeam = async (): Promise<void> => {
    try {
      const result = await host.request<TeamGetResult>("team.get", {});
      if (getContext().signal.aborted) {
        return;
      }
      state.team = result;
      draw();
    } catch (error) {
      fail(error, () => void loadTeam());
    }
  };

  /** Cosmetic only. A read-level connection is refused server-side with a missing-scope error
   *  before any handler runs, so an admin-only request that comes back with that error means the
   *  Team panel's mutating controls should not be drawn. Any other failure leaves them up and lets
   *  the real error surface through `fail` instead, because hiding them on a transient fault would
   *  tell the owner they had lost a permission they still hold. `team.add` is reused as the probe
   *  (rather than a dedicated method) because it is already registered at `operator.admin` and
   *  calling it with no fields is a no-op the handler rejects for a different, unambiguous reason
   *  once the scope check has passed. */
  const probeAdmin = async (): Promise<void> => {
    try {
      await host.request("team.add", {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // "name is required" == the handler ran, which means the scope check passed.
      state.canAdmin = !/scope/i.test(message);
    }
    draw();
  };

  /** `channels.pairing.list` is core's own Gateway method, called directly rather than through a
   *  Team-owned wrapper — reusing it is the plan's own stated alternative to a redundant new
   *  method, and the Control UI host dispatches any method the connection's own scopes allow (no
   *  per-plugin RPC allowlist). A failure here is never sent through `fail`: it is cosmetic (no
   *  `operator.pairing` scope, or no channel currently has anything pending), and the roster itself
   *  is not blocked on it. */
  const loadPending = async (): Promise<void> => {
    try {
      const result = await host.request<{ requests?: TeamPendingRequestView[] }>(
        "channels.pairing.list",
        {},
      );
      if (getContext().signal.aborted) {
        return;
      }
      state.pending = result.requests ?? [];
    } catch {
      state.pending = [];
    }
    draw();
  };

  return { loadTeam, loadPending, probeAdmin };
}
