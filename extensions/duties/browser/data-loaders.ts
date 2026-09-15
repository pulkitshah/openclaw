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
  TemplateListResult,
} from "./index-helpers.js";
import type { DeskStatusView } from "./render.js";

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
