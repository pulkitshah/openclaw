import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Duty } from "../src/duty.js";
import type { MailStatus } from "../src/mail.js";
import type { DutiesSettings, DutyRun } from "../src/store.js";
import type { Brand, Template } from "../src/template.js";
import {
  renderBoard,
  renderBuildPreview,
  renderDetail,
  renderLogins,
  renderPlaceholder,
  renderRun,
  renderTemplates,
} from "./render.js";
import "./styles.css";

const PAGE = "duties";
type Props = Readonly<Record<string, string>>;

type ListResult = { duties: Duty[] };
type GetResult = { duty: Duty; runs: DutyRun[] };
type RecentRunsResult = { runs: DutyRun[] };
type RunGetResult = { run: DutyRun };
type RunStartResult = { runId: string; queued: boolean; reason?: string };
type CredListResult = { keys: string[]; updatedAt: Record<string, number> };
type EvidenceResult = { contentType: string; base64: string };
type TemplateListResult = { templates: Template[] };
type BrandGetResult = { brand?: Brand };
type BrandSetResult = { brand: Brand };
type TemplatePreviewResult = { contentType: string; base64: string };
type SettingsGetResult = { settings: DutiesSettings };
type SettingsSetResult = { settings: DutiesSettings };
type RunFileResult = { name: string; contentType: string; base64: string };

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

/** Same shape as `CRED_KEY_RE` in `src/creds.ts`, which the browser bundle cannot import (it pulls
 * in `node:child_process`). Pre-validates the field; the Gateway method's own check is the
 * authority. */
const CRED_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;

/** Matches `validateBrand`'s `logoDataUrl` length ceiling in `src/template.ts` (700,000 base64
 *  characters ≈ 512 KB of image bytes). Checked against the raw file before it is even read, so a
 *  large logo is refused without spending a `FileReader` pass or a wasted Gateway round trip. */
const MAX_LOGO_BYTES = 512 * 1024;

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
        let logins: CredListResult = { keys: [], updatedAt: {} };
        let templates: Template[] = [];
        let brand: Brand | undefined;
        let settings: DutiesSettings = {};
        let mailStatus: MailStatus | undefined;

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
          } else if (view === "logins") {
            root.innerHTML = notice + renderLogins(logins, errorOpts);
          } else if (view === "templates") {
            root.innerHTML = notice + renderTemplates({ templates, brand }, errorOpts);
          } else if (view === "detail") {
            const duty = duties.find((d) => d.id === dutyId);
            root.innerHTML =
              notice +
              (duty
                ? renderDetail(duty, allKnownRuns(), errorOpts)
                : renderPlaceholder(errorOpts ?? {}));
          } else if (view === "run") {
            const run = observedRuns.get(runId);
            const duty = duties.find((d) => d.id === dutyId);
            root.innerHTML =
              notice + (run ? renderRun(run, duty, errorOpts) : renderPlaceholder(errorOpts ?? {}));
          } else {
            root.innerHTML =
              notice +
              renderBoard(duties, allKnownRuns(), { ...(errorOpts ?? {}), settings, mailStatus });
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

        // A burst of `plugin.duties.changed` events for ids unknown to the page each want a full
        // list refresh; coalesce them onto one in-flight request instead of firing one per event.
        let loadDutiesInFlight: Promise<void> | undefined;
        const loadDuties = (): Promise<void> => {
          if (loadDutiesInFlight) return loadDutiesInFlight;
          const run = async (): Promise<void> => {
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
          loadDutiesInFlight = run().finally(() => {
            loadDutiesInFlight = undefined;
          });
          return loadDutiesInFlight;
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

        const loadLogins = async (): Promise<void> => {
          try {
            const result = await host.request<CredListResult>("duties.cred.list", {});
            if (context.signal.aborted) return;
            logins = result;
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
            if (context.signal.aborted) return;
            templates = templateResult.templates;
            brand = brandResult.brand;
            clearError();
            draw();
          } catch (error) {
            fail(error, () => void loadTemplates());
          }
        };

        const loadSettings = async (): Promise<void> => {
          try {
            const result = await host.request<SettingsGetResult>("duties.settings.get", {});
            if (context.signal.aborted) return;
            settings = result.settings;
            draw();
          } catch (error) {
            fail(error, () => void loadSettings());
          }
        };

        const loadMailStatus = async (): Promise<void> => {
          try {
            const result = await host.request<MailStatus>("duties.mail.status", {});
            if (context.signal.aborted) return;
            mailStatus = result;
            draw();
          } catch (error) {
            fail(error, () => void loadMailStatus());
          }
        };

        /** Reads the key/value fields, saves the login, and clears the value field immediately.
         *  The value is never stored on this page, put in the DOM, or logged. */
        const saveLogin = async (): Promise<void> => {
          const keyInput = root.querySelector<HTMLInputElement>("[data-cred-key]");
          const valueInput = root.querySelector<HTMLInputElement>("[data-cred-value]");
          const key = keyInput?.value.trim() ?? "";
          const value = valueInput?.value ?? "";
          if (valueInput) valueInput.value = "";
          if (!CRED_KEY_RE.test(key)) {
            fail(
              new Error("A key looks like site.password: lowercase letters, digits, . _ -"),
              () => undefined,
            );
            return;
          }
          if (!value) {
            fail(new Error("Enter the password before saving."), () => undefined);
            return;
          }
          try {
            await host.request("duties.cred.set", { key, value });
            if (context.signal.aborted) return;
            if (keyInput) keyInput.value = "";
            clearError();
            await loadLogins();
          } catch (error) {
            fail(error, () => undefined);
          }
        };

        const deleteLogin = async (key: string): Promise<void> => {
          try {
            await host.request("duties.cred.delete", { key });
            if (context.signal.aborted) return;
            clearError();
            await loadLogins();
          } catch (error) {
            fail(error, () => void deleteLogin(key));
          }
        };

        const saveSettings = async (): Promise<void> => {
          const channelInput = root.querySelector<HTMLSelectElement>("[data-settings-channel]");
          const targetInput = root.querySelector<HTMLInputElement>("[data-settings-target]");
          const channel = channelInput?.value ?? "";
          const target = targetInput?.value.trim() ?? "";
          if (!channel || !target) {
            fail(new Error("Choose a channel and enter a target."), () => undefined);
            return;
          }
          try {
            const result = await host.request<SettingsSetResult>("duties.settings.set", {
              owner: { channel, target },
            });
            if (context.signal.aborted) return;
            settings = result.settings;
            clearError();
            draw();
          } catch (error) {
            fail(error, () => void saveSettings());
          }
        };

        /** Reads a chosen logo file into a data URL entirely client-side (no upload endpoint) so
         *  it can travel as `Brand.logoDataUrl`, the same shape `validateBrand` requires. */
        const readFileAsDataUrl = (file: File): Promise<string> =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.addEventListener("load", () => {
              if (typeof reader.result === "string") resolve(reader.result);
              else reject(new Error("Could not read that file."));
            });
            reader.addEventListener("error", () =>
              reject(reader.error ?? new Error("Could not read that file.")),
            );
            reader.readAsDataURL(file);
          });

        const saveBrand = async (): Promise<void> => {
          const nameInput = root.querySelector<HTMLInputElement>("[data-brand-name]");
          const logoInput = root.querySelector<HTMLInputElement>("[data-brand-logo]");
          const primaryInput = root.querySelector<HTMLInputElement>("[data-brand-primary]");
          const accentInput = root.querySelector<HTMLInputElement>("[data-brand-accent]");
          const phoneInput = root.querySelector<HTMLInputElement>("[data-brand-phone]");
          const emailInput = root.querySelector<HTMLInputElement>("[data-brand-email]");
          const footerInput = root.querySelector<HTMLInputElement>("[data-brand-footer]");
          const name = nameInput?.value.trim() ?? "";
          if (!name) {
            fail(new Error("Enter a brand name."), () => undefined);
            return;
          }
          const file = logoInput?.files?.[0];
          if (file && file.size > MAX_LOGO_BYTES) {
            fail(new Error("Logo must be under 512 KB"), () => undefined);
            return;
          }
          try {
            const logoDataUrl = file ? await readFileAsDataUrl(file) : brand?.logoDataUrl;
            const payload: Record<string, unknown> = {
              name,
              ...(logoDataUrl ? { logoDataUrl } : {}),
              ...(primaryInput?.value ? { primary: primaryInput.value } : {}),
              ...(accentInput?.value ? { accent: accentInput.value } : {}),
              ...(phoneInput?.value.trim() ? { phone: phoneInput.value.trim() } : {}),
              ...(emailInput?.value.trim() ? { email: emailInput.value.trim() } : {}),
              ...(footerInput?.value.trim() ? { footer: footerInput.value.trim() } : {}),
              updatedAt: Date.now(),
            };
            const result = await host.request<BrandSetResult>("duties.brand.set", {
              brand: payload,
            });
            if (context.signal.aborted) return;
            brand = result.brand;
            clearError();
            draw();
          } catch (error) {
            fail(error, () => void saveBrand());
          }
        };

        /** Lazily fetches one template's PDF preview and shows it inline; the same toggle shape
         *  as `toggleShot` below. Nothing is fetched until the owner opens the toggle. */
        const previewTemplate = async (id: string): Promise<void> => {
          const holder = root.querySelector<HTMLElement>(`[data-tpl-preview-for="${id}"]`);
          if (!holder) return;
          if (!holder.hidden) {
            holder.hidden = true;
            return;
          }
          holder.hidden = false;
          if (holder.dataset.loaded === "1") return;
          try {
            const preview = await host.request<TemplatePreviewResult>("duties.template.preview", {
              id,
            });
            if (context.signal.aborted) return;
            const iframe = document.createElement("iframe");
            iframe.src = `data:${preview.contentType};base64,${preview.base64}`;
            iframe.title = "Template preview";
            holder.replaceChildren(iframe);
            holder.dataset.loaded = "1";
          } catch (error) {
            holder.textContent = coerceErrorMessage(error);
          }
        };

        const deleteTemplate = async (id: string): Promise<void> => {
          try {
            await host.request("duties.template.delete", { id });
            if (context.signal.aborted) return;
            clearError();
            await loadTemplates();
          } catch (error) {
            fail(error, () => void deleteTemplate(id));
          }
        };

        const openEditTemplateWithAgent = (id: string): void => {
          const template = templates.find((t) => t.id === id);
          editNotice = `Open a chat with the agent and say: Edit the template "${template?.name ?? id}"`;
          draw();
        };

        /** Lazily fetches one run step's produced document and shows it inline as a `data:`
         *  iframe; the file's disk path never reaches the page. Same toggle shape as `toggleShot`. */
        const openFile = async (stepId: string): Promise<void> => {
          const holder = root.querySelector<HTMLElement>(`[data-file-for="${stepId}"]`);
          const runId = context.props.runId;
          if (!holder || !runId) return;
          if (!holder.hidden) {
            holder.hidden = true;
            return;
          }
          holder.hidden = false;
          if (holder.dataset.loaded === "1") return;
          try {
            const file = await host.request<RunFileResult>("duties.run.file", { runId, stepId });
            if (context.signal.aborted) return;
            const iframe = document.createElement("iframe");
            iframe.src = `data:${file.contentType};base64,${file.base64}`;
            iframe.title = file.name;
            holder.replaceChildren(iframe);
            holder.dataset.loaded = "1";
          } catch (error) {
            holder.textContent = coerceErrorMessage(error);
          }
        };

        /** Lazily fetches one step's screenshot and shows it inline; clicking the image expands
         *  it. Nothing is fetched until the owner opens the toggle. */
        const toggleShot = async (stepId: string): Promise<void> => {
          const holder = root.querySelector<HTMLElement>(`[data-shot-for="${stepId}"]`);
          const runId = context.props.runId;
          if (!holder || !runId) return;
          if (!holder.hidden) {
            holder.hidden = true;
            return;
          }
          holder.hidden = false;
          if (holder.dataset.loaded === "1") return;
          try {
            const shot = await host.request<EvidenceResult>("duties.run.evidence", {
              runId,
              stepId,
            });
            if (context.signal.aborted) return;
            const img = document.createElement("img");
            img.alt = "Step screenshot";
            img.src = `data:${shot.contentType};base64,${shot.base64}`;
            img.addEventListener("click", () => img.classList.toggle("big"));
            holder.replaceChildren(img);
            holder.dataset.loaded = "1";
          } catch (error) {
            holder.textContent = coerceErrorMessage(error);
          }
        };

        const ensureLoaded = (): void => {
          const view = context.props.view ?? "board";
          if (view === "run") {
            const runId = context.props.runId;
            if (runId && !observedRuns.has(runId)) void loadRun(runId);
          }
          if (view === "logins") void loadLogins();
          if (view === "templates") void loadTemplates();
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
            "[data-open],[data-open-run],[data-run],[data-edit],[data-build],[data-status],[data-delete],[data-cancel],[data-nav],[data-retry],[data-shot],[data-cred-save],[data-cred-delete],[data-settings-save],[data-brand-save],[data-tpl-preview],[data-tpl-edit],[data-tpl-delete],[data-file]",
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
            return;
          }
          if (dataset.shot !== undefined) {
            void toggleShot(dataset.shot);
            return;
          }
          if (dataset.credSave !== undefined) {
            void saveLogin();
            return;
          }
          if (dataset.settingsSave !== undefined) {
            void saveSettings();
            return;
          }
          if (dataset.brandSave !== undefined) {
            void saveBrand();
            return;
          }
          if (dataset.tplPreview !== undefined) {
            void previewTemplate(dataset.tplPreview);
            return;
          }
          if (dataset.tplEdit !== undefined) {
            openEditTemplateWithAgent(dataset.tplEdit);
            return;
          }
          if (dataset.tplDelete !== undefined) {
            void deleteTemplate(dataset.tplDelete);
            return;
          }
          if (dataset.file !== undefined) {
            void openFile(dataset.file);
            return;
          }
          if (dataset.credDelete !== undefined) {
            void deleteLogin(dataset.credDelete);
          }
        });

        const offChanged = host.onEvent("plugin.duties.changed", (payload) => {
          const dutyId = readDutyId(payload);
          if (dutyId) {
            if (duties.some((d) => d.id === dutyId)) {
              void refreshDuty(dutyId);
            } else {
              // Unknown to the page (a duty created elsewhere): only then is a full list refresh
              // warranted, instead of guessing at a single-duty fetch for an id we've never seen.
              void loadDuties();
            }
            return;
          }
          if (isRecord(payload) && (payload.templateId !== undefined || payload.brand === true)) {
            void loadTemplates();
            return;
          }
          if (isRecord(payload) && payload.settings === true) void loadSettings();
        });
        const offRun = host.onEvent("plugin.duties.run", (payload) => {
          const runId = readRunId(payload);
          if (runId) void loadRun(runId);
        });

        draw();
        ensureLoaded();
        void loadDuties();
        void loadRecentRuns();
        void loadSettings();
        void loadMailStatus();

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
