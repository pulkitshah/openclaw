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
type RunGetResult = { run: DutyRun };
type RunStartResult = { runId: string; queued: boolean; reason?: string };

function readDutyId(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.dutyId === "string" ? payload.dutyId : undefined;
}

function readRunId(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.runId === "string" ? payload.runId : undefined;
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
        // Reachability of the host's "chat" page cannot be queried from a plugin: `openPage`
        // only resolves a native route through a tab the SAME plugin registered
        // (`ui/src/plugins/control-ui-host.ts`'s `pageLocation`), so "duties" can never reach
        // another feature's page that way. Show the instruction text every time until Part 2
        // gives this plugin a real hand-off (e.g. a host-provided chat-open capability).
        let editNotice: string | null = null;

        const root = document.createElement("div");
        root.className = "dt";
        container.append(root);

        const go = (params: Record<string, string>) =>
          host.navigation.openPage({ id: PAGE, params });

        const allKnownRuns = (): DutyRun[] => [...observedRuns.values()];

        const rememberRuns = (runs: readonly DutyRun[]): void => {
          for (const run of runs) observedRuns.set(run.id, run);
        };

        const draw = (): void => {
          if (context.signal.aborted) return;
          const view = context.props.view ?? "board";
          const dutyId = context.props.id ?? "";
          const runId = context.props.runId ?? "";
          const notice = editNotice ? `<div class="notice">${esc(editNotice)}</div>` : "";
          if (view === "build") {
            root.innerHTML = notice + renderBuildPreview();
          } else if (view === "detail") {
            const duty = duties.find((d) => d.id === dutyId);
            root.innerHTML =
              notice +
              (duty ? renderDetail(duty, allKnownRuns()) : `<p class="muted">Loading…</p>`);
          } else if (view === "run") {
            const run = observedRuns.get(runId);
            const duty = duties.find((d) => d.id === dutyId);
            root.innerHTML =
              notice + (run ? renderRun(run, duty) : `<p class="muted">Loading…</p>`);
          } else {
            root.innerHTML = notice + renderBoard(duties, allKnownRuns());
          }
        };

        const loadDutyRuns = async (id: string): Promise<void> => {
          try {
            const result = await host.request<GetResult>("duties.get", { id });
            if (context.signal.aborted) return;
            rememberRuns(result.runs);
            draw();
          } catch {
            // Per-duty run history is best-effort; the page still renders without it.
          }
        };

        const loadDuties = async (): Promise<void> => {
          try {
            const result = await host.request<ListResult>("duties.list");
            if (context.signal.aborted) return;
            duties = result.duties;
            draw();
            await Promise.all(duties.map((duty) => loadDutyRuns(duty.id)));
          } catch {
            // Best-effort; the page still renders with an empty duties list.
          }
        };

        const loadRun = async (runId: string): Promise<void> => {
          try {
            const result = await host.request<RunGetResult>("duties.run.get", { runId });
            if (context.signal.aborted) return;
            observedRuns.set(runId, result.run);
            draw();
          } catch {
            // The run may not exist yet, or have expired; the view shows "Loading…" either way.
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
            go({ view: "run", id: dutyId, runId: result.runId });
          } catch {
            // The user stays on the current view and can retry the Run button.
          }
        };

        const setStatus = async (dutyId: string, status: string): Promise<void> => {
          try {
            await host.request("duties.status", { id: dutyId, status });
            // The `plugin.duties.changed` event below refreshes `duties` once the write lands.
          } catch {
            // Best-effort; the view stays put and the user can retry.
          }
        };

        const deleteDuty = async (dutyId: string): Promise<void> => {
          try {
            await host.request("duties.delete", { id: dutyId });
            if (context.signal.aborted) return;
            go({ view: "board" });
          } catch {
            // Best-effort; the view stays put and the user can retry.
          }
        };

        const cancelRun = async (runId: string): Promise<void> => {
          try {
            await host.request("duties.run.cancel", { runId });
          } catch {
            // Best-effort; a `plugin.duties.run` event corrects the view if the cancel lands.
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
            "[data-open],[data-open-run],[data-run],[data-edit],[data-build],[data-status],[data-delete],[data-cancel],[data-nav]",
          );
          if (!target) return;
          event.preventDefault();
          const { dataset } = target;
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
            go({ view: "build" });
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
          void loadDuties();
          if (dutyId) void loadDutyRuns(dutyId);
        });
        const offRun = host.onEvent("plugin.duties.run", (payload) => {
          const runId = readRunId(payload);
          if (runId) void loadRun(runId);
        });

        draw();
        ensureLoaded();
        void loadDuties();

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
