import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Duty } from "../src/duty.js";
import type { DutyRun } from "../src/store.js";
import { renderBoard, renderBuildPreview, renderDetail, renderRun } from "./render.js";
import "./styles.css";

const PAGE = "duties";
type Props = Readonly<Record<string, string>>;

type ListResult = { duties: Duty[] };
type GetResult = { duty: Duty; runs: DutyRun[] };
type RecentRunsResult = { runs: DutyRun[] };
type RunGetResult = { run: DutyRun };
type RunStartResult = { runId: string; queued: boolean; reason?: string };

function readDutyId(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.dutyId === "string" ? payload.dutyId : undefined;
}

function readRunId(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.runId === "string" ? payload.runId : undefined;
}

/** `openclaw/plugin-sdk/error-runtime`'s `coerceErrorMessage` re-exports Node-only infra
 * (`../infra/errors.js`, `../infra/outbound/deliver-types.js`, ...) that esbuild cannot resolve
 * for a browser target (proven by a failed `Could not resolve "node:fs"` bundle build) — no
 * bundled plugin's `browser/` imports it. This is the same minimal shape for the browser side. */
function coerceErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || "Something went wrong.";
  if (typeof error === "string" && error) return error;
  if (isRecord(error) && typeof error.message === "string" && error.message) return error.message;
  return "Something went wrong.";
}

/** Mirrors `requireDuty`'s error text in `src/gateway-methods.ts` (`no Duty "<id>"`), the only
 * signal available to tell "this duty was deleted" apart from a transient request failure. */
function isMissingDutyError(error: unknown): boolean {
  return coerceErrorMessage(error).includes('no Duty "');
}

function esc(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export default defineControlUiPlugin({
  id: "duties",
  activate(host: ControlUiHost) {
    const unregisterNav = host.ui.registerNavigation({
      id: "duties",
      label: "Duties",
      page: { id: PAGE },
      icon: "listChecks",
      order: 15,
    });
    const unregisterPage = host.ui.registerPage({
      id: PAGE,
      label: "Duties",
      mount(container, initial) {
        let context: ControlUiViewContext<Props> = initial;
        let duties: Duty[] = [];
        const observedRuns = new Map<string, DutyRun>();
        let lastError: string | null = null;
        let lastRetry: (() => void) | null = null;
        // Reachability of the host's "chat" page cannot be queried from a plugin: `openPage`
        // only resolves a native route through a tab the SAME plugin registered
        // (`ui/src/plugins/control-ui-host.ts`'s `pageLocation`), so "duties" can never reach
        // another feature's page that way. Show the instruction text every time until Part 2
        // gives this plugin a real hand-off (e.g. a host-provided chat-open capability).
        let editNotice: string | null = null;

        const root = document.createElement("div");
        root.className = "dt";
        container.append(root);

        const go = (params: Record<string, string>) => {
          lastError = null;
          lastRetry = null;
          host.navigation.openPage({ id: PAGE, params });
        };

        const fail = (error: unknown, retry: () => void): void => {
          lastError = coerceErrorMessage(error);
          lastRetry = retry;
          draw();
        };

        const clearError = (): void => {
          lastError = null;
          lastRetry = null;
        };

        const allKnownRuns = (): DutyRun[] => [...observedRuns.values()];

        const rememberRuns = (runs: readonly DutyRun[]): void => {
          for (const run of runs) observedRuns.set(run.id, run);
        };

        const upsertDuty = (duty: Duty): void => {
          const idx = duties.findIndex((d) => d.id === duty.id);
          duties =
            idx === -1
              ? [...duties, duty].toSorted((a, b) => a.name.localeCompare(b.name))
              : duties.map((d, i) => (i === idx ? duty : d));
        };

        const draw = (): void => {
          if (context.signal.aborted) return;
          const view = context.props.view ?? "board";
          const dutyId = context.props.id ?? "";
          const runId = context.props.runId ?? "";
          const notice = editNotice ? `<div class="notice">${esc(editNotice)}</div>` : "";
          const errorOpts = lastError ? { error: lastError } : undefined;
          if (view === "build") {
            root.innerHTML = notice + renderBuildPreview();
          } else if (view === "detail") {
            const duty = duties.find((d) => d.id === dutyId);
            root.innerHTML =
              notice +
              (duty
                ? renderDetail(duty, allKnownRuns(), errorOpts)
                : `<p class="muted">Loading…</p>`);
          } else if (view === "run") {
            const run = observedRuns.get(runId);
            const duty = duties.find((d) => d.id === dutyId);
            root.innerHTML =
              notice + (run ? renderRun(run, duty, errorOpts) : `<p class="muted">Loading…</p>`);
          } else {
            root.innerHTML = notice + renderBoard(duties, allKnownRuns(), errorOpts);
          }
        };

        const loadDutyRuns = async (id: string): Promise<void> => {
          try {
            const result = await host.request<GetResult>("duties.get", { id });
            if (context.signal.aborted) return;
            rememberRuns(result.runs);
            clearError();
            draw();
          } catch (error) {
            fail(error, () => void loadDutyRuns(id));
          }
        };

        const loadRecentRuns = async (): Promise<void> => {
          try {
            const result = await host.request<RecentRunsResult>("duties.runs.recent", {});
            if (context.signal.aborted) return;
            rememberRuns(result.runs);
            clearError();
            draw();
          } catch (error) {
            fail(error, () => void loadRecentRuns());
          }
        };

        const loadDuties = async (): Promise<void> => {
          try {
            const result = await host.request<ListResult>("duties.list");
            if (context.signal.aborted) return;
            duties = result.duties;
            clearError();
            draw();
            await Promise.all(duties.map((duty) => loadDutyRuns(duty.id)));
          } catch (error) {
            fail(error, () => void loadDuties());
          }
        };

        const loadRun = async (runId: string): Promise<void> => {
          try {
            const result = await host.request<RunGetResult>("duties.run.get", { runId });
            if (context.signal.aborted) return;
            observedRuns.set(runId, result.run);
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
            if (context.signal.aborted) return;
            upsertDuty(result.duty);
            rememberRuns(result.runs);
            clearError();
            draw();
          } catch (error) {
            if (isMissingDutyError(error)) {
              duties = duties.filter((d) => d.id !== dutyId);
              draw();
              return;
            }
            fail(error, () => void refreshDuty(dutyId));
          }
        };

        const ensureLoaded = (): void => {
          const view = context.props.view ?? "board";
          if (view === "run") {
            const runId = context.props.runId;
            if (runId && !observedRuns.has(runId)) void loadRun(runId);
          }
        };

        const runDuty = async (dutyId: string): Promise<void> => {
          try {
            const result = await host.request<RunStartResult>("duties.run", { id: dutyId });
            if (context.signal.aborted) return;
            clearError();
            go({ view: "run", id: dutyId, runId: result.runId });
          } catch (error) {
            fail(error, () => void runDuty(dutyId));
          }
        };

        const setStatus = async (dutyId: string, status: string): Promise<void> => {
          try {
            await host.request("duties.status", { id: dutyId, status });
            clearError();
            draw();
            // The `plugin.duties.changed` event below refreshes `duties` once the write lands.
          } catch (error) {
            fail(error, () => void setStatus(dutyId, status));
          }
        };

        const deleteDuty = async (dutyId: string): Promise<void> => {
          try {
            await host.request("duties.delete", { id: dutyId });
            if (context.signal.aborted) return;
            clearError();
            go({ view: "board" });
          } catch (error) {
            fail(error, () => void deleteDuty(dutyId));
          }
        };

        const cancelRun = async (runId: string): Promise<void> => {
          try {
            await host.request("duties.run.cancel", { runId });
            clearError();
            draw();
          } catch (error) {
            fail(error, () => void cancelRun(runId));
          }
        };

        const openEditWithAgent = (duty: Duty | undefined): void => {
          const name = duty?.name ?? "New Duty";
          editNotice = `Open a chat with the agent and say: Edit the Duty "${name}"`;
          draw();
        };

        root.addEventListener("click", (event) => {
          // SAFETY: this listener is on `root`, an HTMLElement, so its click events always target an Element.
          const target = (event.target as HTMLElement).closest<HTMLElement>(
            "[data-open],[data-open-run],[data-run],[data-edit],[data-build],[data-status],[data-delete],[data-cancel],[data-nav],[data-retry]",
          );
          if (!target) return;
          event.preventDefault();
          const { dataset } = target;
          if (dataset.retry !== undefined) {
            lastRetry?.();
            return;
          }
          if (dataset.open !== undefined) {
            go({ view: "detail", id: dataset.open });
            return;
          }
          if (dataset.openRun !== undefined) {
            go({
              view: "run",
              id: dataset.dutyId ?? context.props.id ?? "",
              runId: dataset.openRun,
            });
            return;
          }
          if (dataset.nav !== undefined) {
            go({ view: dataset.nav });
            return;
          }
          if (dataset.run !== undefined) {
            void runDuty(dataset.run);
            return;
          }
          if (dataset.build !== undefined) {
            go({ view: "build", id: dataset.build });
            return;
          }
          if (dataset.edit !== undefined) {
            openEditWithAgent(
              dataset.edit === "new" ? undefined : duties.find((d) => d.id === dataset.edit),
            );
            return;
          }
          if (dataset.status !== undefined && dataset.next) {
            void setStatus(dataset.status, dataset.next);
            return;
          }
          if (dataset.delete !== undefined) {
            void deleteDuty(dataset.delete);
            return;
          }
          if (dataset.cancel !== undefined) {
            void cancelRun(dataset.cancel);
          }
        });

        const offChanged = host.onEvent("plugin.duties.changed", (payload) => {
          const dutyId = readDutyId(payload);
          if (!dutyId) return;
          if (duties.some((d) => d.id === dutyId)) {
            void refreshDuty(dutyId);
          } else {
            // Unknown to the page (a duty created elsewhere): only then is a full list refresh
            // warranted, instead of guessing at a single-duty fetch for an id we've never seen.
            void loadDuties();
          }
        });
        const offRun = host.onEvent("plugin.duties.run", (payload) => {
          const runId = readRunId(payload);
          if (runId) void loadRun(runId);
        });

        draw();
        ensureLoaded();
        void loadDuties();
        void loadRecentRuns();

        return {
          update(next) {
            context = next;
            ensureLoaded();
            draw();
          },
          dispose() {
            offChanged();
            offRun();
            root.remove();
          },
        };
      },
    });
    return () => {
      unregisterPage();
      unregisterNav();
    };
  },
});
