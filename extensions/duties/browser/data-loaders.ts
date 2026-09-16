// Data-loading actions for the Duties Control UI page: every `host.request` call that updates
// the page's server-sourced state and redraws. Split out of index.ts's `mount()` to stay under
// the extensions max-lines budget — a real responsibility seam, since these only need the host,
// the live view context, the shared page state below, and mount()'s own draw/error closures.
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import type { Duty } from "../src/duty.js";
import type { MailStatus } from "../src/mail.js";
import type { DutiesSettings, DutyRun } from "../src/store.js";
import type { Brand, Template } from "../src/template.js";
import { isMissingDutyError } from "./index-helpers.js";
import type {
  BrandGetResult,
  CredListResult,
  DeskStatusResult,
  GetResult,
  ListResult,
  Props,
  RecentRunsResult,
  RunGetResult,
  SettingsGetResult,
  TeamGetResult,
  TemplateListResult,
} from "./index-helpers.js";
import type { DeskStatusView, TeamView } from "./render.js";

/** Everything the page fetches from the Gateway and `draw()` reads. Bundled into one object
 *  (rather than individual `let`s in `mount()`) so the loaders below can be a standalone module
 *  instead of closures nested inside `mount()`. */
export type PageState = {
  duties: Duty[];
  observedRuns: Map<string, DutyRun>;
  logins: CredListResult;
  templates: Template[];
  brand: Brand | undefined;
  settings: DutiesSettings;
  mailStatus: MailStatus | undefined;
  deskStatus: DeskStatusView | undefined;
};

export function createPageState(): PageState {
  return {
    duties: [],
    observedRuns: new Map(),
    logins: { keys: [], updatedAt: {} },
    templates: [],
    brand: undefined,
    settings: {},
    mailStatus: undefined,
    deskStatus: undefined,
  };
}

/** The Team page's own state (`team-page.ts`) — split from `PageState` above once Team became a
 *  top-level sidebar page (its own `mount()`) rather than a card the "duties" page's board drew:
 *  it needs neither `duties`, `templates`, nor any of that page's other server-sourced fields. */
export type TeamPageState = {
  team: TeamView | undefined;
  /** Cosmetic only — hides the Team panel's mutating controls. `duties.team.*` writes are gated at
   *  `operator.admin` server-side, which is the actual authority check; see `probeAdmin` below.
   *  Defaults `true` so the buttons show until the probe answers, rather than flashing hidden. */
  canAdmin: boolean;
};

export function createTeamPageState(): TeamPageState {
  return { team: undefined, canAdmin: true };
}

function rememberRuns(state: PageState, runs: readonly DutyRun[]): void {
  for (const run of runs) {
    state.observedRuns.set(run.id, run);
  }
}

function upsertDuty(state: PageState, duty: Duty): void {
  const idx = state.duties.findIndex((d) => d.id === duty.id);
  state.duties =
    idx === -1
      ? [...state.duties, duty].toSorted((a, b) => a.name.localeCompare(b.name))
      : state.duties.map((d, i) => (i === idx ? duty : d));
}

export function createDataLoaders(deps: {
  host: ControlUiHost;
  getContext: () => ControlUiViewContext<Props>;
  state: PageState;
  clearError: () => void;
  draw: () => void;
  fail: (error: unknown, retry: () => void) => void;
}) {
  const { host, getContext, state, clearError, draw, fail } = deps;

  const loadDutyRuns = async (id: string): Promise<void> => {
    try {
      const result = await host.request<GetResult>("duties.get", { id });
      if (getContext().signal.aborted) {
        return;
      }
      rememberRuns(state, result.runs);
      clearError();
      draw();
    } catch (error) {
      fail(error, () => void loadDutyRuns(id));
    }
  };

  const loadRecentRuns = async (): Promise<void> => {
    try {
      const result = await host.request<RecentRunsResult>("duties.runs.recent", {});
      if (getContext().signal.aborted) {
        return;
      }
      rememberRuns(state, result.runs);
      clearError();
      draw();
    } catch (error) {
      fail(error, () => void loadRecentRuns());
    }
  };

  // A burst of `plugin.duties.changed` events for ids unknown to the page each want a full
  // list refresh; coalesce them onto one in-flight request instead of firing one per event.
  let loadDutiesInFlight: Promise<void> | undefined;
  const loadDuties = (): Promise<void> => {
    if (loadDutiesInFlight) {
      return loadDutiesInFlight;
    }
    const run = async (): Promise<void> => {
      try {
        const result = await host.request<ListResult>("duties.list");
        if (getContext().signal.aborted) {
          return;
        }
        state.duties = result.duties;
        clearError();
        draw();
        await Promise.all(state.duties.map((duty) => loadDutyRuns(duty.id)));
      } catch (error) {
        fail(error, () => void loadDuties());
      }
    };
    loadDutiesInFlight = run().finally(() => {
      loadDutiesInFlight = undefined;
    });
    return loadDutiesInFlight;
  };

  const loadRun = async (runId: string): Promise<void> => {
    try {
      const result = await host.request<RunGetResult>("duties.run.get", { runId });
      if (getContext().signal.aborted) {
        return;
      }
      state.observedRuns.set(runId, result.run);
      clearError();
      draw();
    } catch (error) {
      fail(error, () => void loadRun(runId));
    }
  };

  /** Targeted refetch for a `plugin.duties.changed` event: a single `duties.get`, not a
   * full `duties.list` + per-duty N+1. A "no such Duty" response means the duty was
   * deleted, so it is removed from the local list instead of surfaced as an error. */
  const refreshDuty = async (dutyId: string): Promise<void> => {
    try {
      const result = await host.request<GetResult>("duties.get", { id: dutyId });
      if (getContext().signal.aborted) {
        return;
      }
      upsertDuty(state, result.duty);
      rememberRuns(state, result.runs);
      clearError();
      draw();
    } catch (error) {
      if (isMissingDutyError(error)) {
        state.duties = state.duties.filter((d) => d.id !== dutyId);
        draw();
        return;
      }
      fail(error, () => void refreshDuty(dutyId));
    }
  };

  const loadLogins = async (): Promise<void> => {
    try {
      const result = await host.request<CredListResult>("duties.cred.list", {});
      if (getContext().signal.aborted) {
        return;
      }
      state.logins = result;
      clearError();
      draw();
    } catch (error) {
      fail(error, () => void loadLogins());
    }
  };

  const loadTemplates = async (): Promise<void> => {
    try {
      const [templateResult, brandResult] = await Promise.all([
        host.request<TemplateListResult>("duties.template.list", {}),
        host.request<BrandGetResult>("duties.brand.get", {}),
      ]);
      if (getContext().signal.aborted) {
        return;
      }
      state.templates = templateResult.templates;
      state.brand = brandResult.brand;
      clearError();
      draw();
    } catch (error) {
      fail(error, () => void loadTemplates());
    }
  };

  const loadSettings = async (): Promise<void> => {
    try {
      const result = await host.request<SettingsGetResult>("duties.settings.get", {});
      if (getContext().signal.aborted) {
        return;
      }
      state.settings = result.settings;
      draw();
    } catch (error) {
      fail(error, () => void loadSettings());
    }
  };

  const loadMailStatus = async (): Promise<void> => {
    try {
      const result = await host.request<MailStatus>("duties.mail.status", {});
      if (getContext().signal.aborted) {
        return;
      }
      state.mailStatus = result;
      draw();
    } catch (error) {
      fail(error, () => void loadMailStatus());
    }
  };

  const loadDeskStatus = async (): Promise<void> => {
    try {
      const result = await host.request<DeskStatusResult>("duties.desk.status", {});
      if (getContext().signal.aborted) {
        return;
      }
      state.deskStatus = result;
      draw();
    } catch (error) {
      fail(error, () => void loadDeskStatus());
    }
  };

  return {
    loadRecentRuns,
    loadDuties,
    loadRun,
    refreshDuty,
    loadLogins,
    loadTemplates,
    loadSettings,
    loadMailStatus,
    loadDeskStatus,
  };
}

/** The Team page's own loaders (`team-page.ts`), split out alongside `TeamPageState` above for the
 *  same reason: `loadTeam`/`probeAdmin` only ever touched `state.team`/`state.canAdmin`, so moving
 *  Team to its own page means moving these with it rather than leaving them stranded in
 *  `createDataLoaders` — which the "duties" page no longer has a `team`/`canAdmin` field to receive
 *  them into. */
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
      const result = await host.request<TeamGetResult>("duties.team.get", {});
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
   *  tell the owner they had lost a permission they still hold. `duties.settings.set` is reused as
   *  the probe (rather than a dedicated method) because it is already registered at
   *  `operator.admin` and calling it with no fields is a no-op the handler rejects for a different,
   *  unambiguous reason once the scope check has passed. */
  const probeAdmin = async (): Promise<void> => {
    try {
      await host.request("duties.settings.set", {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // "owner, requireApprovalForEdits, or maxParallelRuns is required" == the handler ran, which
      // means the scope check passed.
      state.canAdmin = !/scope/i.test(message);
    }
    draw();
  };

  return { loadTeam, probeAdmin };
}
