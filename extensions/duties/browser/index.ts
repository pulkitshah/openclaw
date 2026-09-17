import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Duty } from "../src/duty.js";
import type { DutyRun } from "../src/store.js";
import { createDataLoaders, createPageState } from "./data-loaders.js";
import {
  CRED_KEY_RE,
  MAX_LOGO_BYTES,
  attachClickRouter,
  captureOpenState,
  coerceErrorMessage,
  esc,
  navigateReservedWindow,
  readDutyId,
  readRunId,
  reserveWindowForDeferredNavigation,
  restoreOpenState,
} from "./index-helpers.js";
import type {
  BrandSetResult,
  EvidenceResult,
  Props,
  RunFileResult,
  RunStartResult,
  SettingsSetResult,
  TemplatePreviewResult,
} from "./index-helpers.js";
import type { NowShot } from "./render.js";
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
    // Team's own top-level sidebar entry (order 16) moved whole into `extensions/team`'s own
    // control-ui plugin (Team v2 Task 1) — this plugin no longer registers it.
    const unregisterPage = host.ui.registerPage({
      id: PAGE,
      label: "Duties",
      mount(container, initial) {
        let context: ControlUiViewContext<Props> = initial;
        const state = createPageState();
        let lastError: string | null = null;
        let lastRetry: (() => void) | null = null;
        // Reachability of the host's "chat" page cannot be queried from a plugin: `openPage`
        // only resolves a native route through a tab the SAME plugin registered
        // (`ui/src/plugins/control-ui-host.ts`'s `pageLocation`), so "duties" can never reach
        // another feature's page that way. Show the instruction text every time until Part 2
        // gives this plugin a real hand-off (e.g. a host-provided chat-open capability).
        let editNotice: string | null = null;
        // The run page's "Now" panel (I6): the newest step's screenshot while a run is still
        // running/queued. `nowShotFetchedFor` guards against re-fetching for a step id we already
        // requested (or are mid-request for); `nowShot` is what is actually shown. Keyed by
        // `${runId}:${stepId}` so switching to a different run's page never shows a stale shot.
        let nowShotFetchedFor: string | undefined;
        let nowShot: { key: string; imageDataUrl: string } | undefined;

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

        const allKnownRuns = (): DutyRun[] => [...state.observedRuns.values()];

        // Newest-step screenshot for the run page's "Now" panel (I6). `nowShotFetchedFor` is a
        // `${runId}:${stepId}` guard so a fetch is issued once per newest step, never on every
        // redraw; `nowShot` is what is actually shown once that fetch lands.
        const nowKeyFor = (run: DutyRun, stepId: string): string => `${run.id}:${stepId}`;

        const currentNowShot = (run: DutyRun): NowShot | undefined => {
          const newest = run.steps.at(-1);
          if (!newest || !nowShot || nowShot.key !== nowKeyFor(run, newest.stepId)) {
            return undefined;
          }
          return { stepId: newest.stepId, imageDataUrl: nowShot.imageDataUrl };
        };

        const ensureNowShot = (run: DutyRun): void => {
          if (run.status !== "running" && run.status !== "queued") {
            return;
          }
          const newest = run.steps.at(-1);
          if (!newest?.screenshotBlobId) {
            return;
          }
          const key = nowKeyFor(run, newest.stepId);
          if (nowShotFetchedFor === key) {
            return;
          }
          nowShotFetchedFor = key;
          const { id: runId } = run;
          const { stepId } = newest;
          void (async () => {
            try {
              const shot = await host.request<EvidenceResult>("duties.run.evidence", {
                runId,
                stepId,
              });
              if (context.signal.aborted) {
                return;
              }
              nowShot = { key, imageDataUrl: `data:${shot.contentType};base64,${shot.base64}` };
              draw();
            } catch {
              // Leave `nowShotFetchedFor` set: retrying the same failing fetch on every redraw
              // would spin. The panel keeps showing "Loading…" for this step, which is accurate
              // enough — the next step event moves the key forward and tries again.
            }
          })();
        };

        const draw = (): void => {
          if (context.signal.aborted) {
            return;
          }
          const view = context.props.view ?? "board";
          const dutyId = context.props.id ?? "";
          const runId = context.props.runId ?? "";
          const notice = editNotice ? `<div class="notice">${esc(editNotice)}</div>` : "";
          const errorOpts = lastError ? { error: lastError } : undefined;
          const openState = captureOpenState(root);
          if (view === "build") {
            root.innerHTML = notice + renderBuildPreview();
          } else if (view === "logins") {
            root.innerHTML = notice + renderLogins(state.logins, errorOpts);
          } else if (view === "templates") {
            root.innerHTML =
              notice +
              renderTemplates({ templates: state.templates, brand: state.brand }, errorOpts);
          } else if (view === "detail") {
            const duty = state.duties.find((d) => d.id === dutyId);
            root.innerHTML =
              notice +
              (duty
                ? renderDetail(duty, allKnownRuns(), errorOpts)
                : renderPlaceholder(errorOpts ?? {}));
          } else if (view === "run") {
            const run = state.observedRuns.get(runId);
            const duty = state.duties.find((d) => d.id === dutyId);
            if (run) {
              ensureNowShot(run);
            }
            root.innerHTML =
              notice +
              (run
                ? renderRun(run, duty, { ...errorOpts, now: currentNowShot(run) })
                : renderPlaceholder(errorOpts ?? {}));
          } else {
            root.innerHTML =
              notice +
              renderBoard(state.duties, allKnownRuns(), {
                ...errorOpts,
                settings: state.settings,
                mailStatus: state.mailStatus,
                deskStatus: state.deskStatus,
              });
          }
          restoreOpenState(root, openState, {
            onShot: (id) => void toggleShot(id),
            onFileShot: (id) => void toggleFilePreview(id),
            onTplPreview: (id) => void previewTemplate(id),
          });
        };

        const loaders = createDataLoaders({
          host,
          getContext: () => context,
          state,
          clearError,
          draw,
          fail,
        });

        /** Reads the key/value fields, saves the login, and clears the value field immediately.
         *  The value is never stored on this page, put in the DOM, or logged. */
        const saveLogin = async (): Promise<void> => {
          const keyInput = root.querySelector<HTMLInputElement>("[data-cred-key]");
          const valueInput = root.querySelector<HTMLInputElement>("[data-cred-value]");
          const key = keyInput?.value.trim() ?? "";
          const value = valueInput?.value ?? "";
          if (valueInput) {
            valueInput.value = "";
          }
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
            if (context.signal.aborted) {
              return;
            }
            if (keyInput) {
              keyInput.value = "";
            }
            clearError();
            await loaders.loadLogins();
          } catch (error) {
            fail(error, () => undefined);
          }
        };

        const deleteLogin = async (key: string): Promise<void> => {
          try {
            await host.request("duties.cred.delete", { key });
            if (context.signal.aborted) {
              return;
            }
            clearError();
            await loaders.loadLogins();
          } catch (error) {
            fail(error, () => void deleteLogin(key));
          }
        };

        // The owner-target form this page used to own moved to the Team plugin's own page, along
        // with the rest of Team (Team v2 Task 1) — its save lives in `extensions/team`'s own
        // `team-actions.ts` now. Nothing on this page renders `data-settings-save` any more, so a
        // second copy here would be a handler for markup that cannot appear.

        /** Fires on the Desk card's number input `change` (not a separate save button — a
         *  number input's own value change is already the owner's intent). Validated the same
         *  way `duties.settings.set` validates it, so a bad value never round-trips to the
         *  Gateway only to bounce back as an error. */
        const saveParallel = async (value: number): Promise<void> => {
          if (!Number.isInteger(value) || value < 1 || value > 8) {
            fail(new Error("maxParallelRuns must be a whole number from 1 to 8"), () => undefined);
            return;
          }
          try {
            const result = await host.request<SettingsSetResult>("duties.settings.set", {
              maxParallelRuns: value,
            });
            if (context.signal.aborted) {
              return;
            }
            state.settings = result.settings;
            clearError();
            draw();
          } catch (error) {
            fail(error, () => void saveParallel(value));
          }
        };

        /** Reads a chosen logo file into a data URL entirely client-side (no upload endpoint) so
         *  it can travel as `Brand.logoDataUrl`, the same shape `validateBrand` requires. */
        const readFileAsDataUrl = (file: File): Promise<string> =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.addEventListener("load", () => {
              if (typeof reader.result === "string") {
                resolve(reader.result);
              } else {
                reject(new Error("Could not read that file."));
              }
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
            const logoDataUrl = file ? await readFileAsDataUrl(file) : state.brand?.logoDataUrl;
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
            if (context.signal.aborted) {
              return;
            }
            state.brand = result.brand;
            clearError();
            draw();
          } catch (error) {
            fail(error, () => void saveBrand());
          }
        };

        /** Lazily fetches one template's PNG preview and shows it inline as an `<img>` (click to
         *  expand, same toggle shape as `toggleShot` below) — never a `data:` iframe, which the
         *  host's `frame-src` CSP blocks (final review C4). An older Gateway/plugin build that
         *  has not shipped the PNG render leaves `preview` absent; that degrades to a message
         *  pointing at the "Open PDF" button next to this toggle, never a blocked iframe. */
        const previewTemplate = async (id: string): Promise<void> => {
          const holder = root.querySelector<HTMLElement>(`[data-tpl-preview-for="${id}"]`);
          if (!holder) {
            return;
          }
          if (!holder.hidden) {
            holder.hidden = true;
            return;
          }
          holder.hidden = false;
          if (holder.dataset.loaded === "1") {
            return;
          }
          try {
            const result = await host.request<TemplatePreviewResult>("duties.template.preview", {
              id,
            });
            if (context.signal.aborted) {
              return;
            }
            if (result.preview) {
              const img = document.createElement("img");
              img.alt = "Template preview";
              img.src = `data:${result.preview.contentType};base64,${result.preview.base64}`;
              img.addEventListener("click", () => img.classList.toggle("big"));
              holder.replaceChildren(img);
            } else {
              holder.textContent = "No preview image available — use Open PDF.";
            }
            holder.dataset.loaded = "1";
          } catch (error) {
            holder.textContent = coerceErrorMessage(error);
          }
        };

        /** Fetches the same render as `previewTemplate` above and opens the PDF itself as a
         *  `blob:` object URL in a new tab (see `navigateReservedWindow`) — the way to actually
         *  view or print the document, independent of whether a PNG preview is available. The
         *  window is reserved before the `await` so it carries this click's user activation. */
        const openTemplatePdf = async (id: string): Promise<void> => {
          const reserved = reserveWindowForDeferredNavigation();
          try {
            const result = await host.request<TemplatePreviewResult>("duties.template.preview", {
              id,
            });
            if (context.signal.aborted) {
              reserved?.close();
              return;
            }
            navigateReservedWindow(reserved, result.pdf.base64, result.pdf.contentType);
          } catch (error) {
            reserved?.close();
            fail(error, () => void openTemplatePdf(id));
          }
        };

        const deleteTemplate = async (id: string): Promise<void> => {
          try {
            await host.request("duties.template.delete", { id });
            if (context.signal.aborted) {
              return;
            }
            clearError();
            await loaders.loadTemplates();
          } catch (error) {
            fail(error, () => void deleteTemplate(id));
          }
        };

        const openEditTemplateWithAgent = (id: string): void => {
          const template = state.templates.find((t) => t.id === id);
          editNotice = `Open a chat with the agent and say: Edit the template "${template?.name ?? id}"`;
          draw();
        };

        /** Lazily fetches a PNG thumbnail of a run-produced PDF (`duties.run.file` with
         *  `kind: "preview"`) and shows it inline as an `<img>`; the file's disk path and its full
         *  bytes never reach the page for this. Same toggle shape as `toggleShot`. A run recorded
         *  before this preview existed (or any other fetch failure) collapses the toggle back
         *  closed instead of showing an error — "Open PDF" next to it still works either way. */
        const toggleFilePreview = async (stepId: string): Promise<void> => {
          const holder = root.querySelector<HTMLElement>(`[data-file-shot-for="${stepId}"]`);
          const runId = context.props.runId;
          if (!holder || !runId) {
            return;
          }
          if (!holder.hidden) {
            holder.hidden = true;
            return;
          }
          holder.hidden = false;
          if (holder.dataset.loaded === "1") {
            return;
          }
          try {
            const preview = await host.request<RunFileResult>("duties.run.file", {
              runId,
              stepId,
              kind: "preview",
            });
            if (context.signal.aborted) {
              return;
            }
            const img = document.createElement("img");
            img.alt = "Document preview";
            img.src = `data:${preview.contentType};base64,${preview.base64}`;
            img.addEventListener("click", () => img.classList.toggle("big"));
            holder.replaceChildren(img);
            holder.dataset.loaded = "1";
          } catch {
            holder.hidden = true;
          }
        };

        /** Fetches a run step's full produced document and opens it as a `blob:` object URL in a
         *  new tab (see `navigateReservedWindow`) — replaces the old `data:` iframe, which the
         *  host's `frame-src` CSP blocks (final review C4). Used for both PDFs ("Open PDF") and
         *  any other file kind ("Open"); the file's disk path never reaches the page. The window is
         *  reserved before the `await` so it carries this click's user activation. */
        const openRunFile = async (stepId: string): Promise<void> => {
          const runId = context.props.runId;
          if (!runId) {
            return;
          }
          const reserved = reserveWindowForDeferredNavigation();
          try {
            const file = await host.request<RunFileResult>("duties.run.file", { runId, stepId });
            if (context.signal.aborted) {
              reserved?.close();
              return;
            }
            navigateReservedWindow(reserved, file.base64, file.contentType);
          } catch (error) {
            reserved?.close();
            fail(error, () => void openRunFile(stepId));
          }
        };

        /** Lazily fetches one step's screenshot and shows it inline; clicking the image expands
         *  it. Nothing is fetched until the owner opens the toggle. */
        const toggleShot = async (stepId: string): Promise<void> => {
          const holder = root.querySelector<HTMLElement>(`[data-shot-for="${stepId}"]`);
          const runId = context.props.runId;
          if (!holder || !runId) {
            return;
          }
          if (!holder.hidden) {
            holder.hidden = true;
            return;
          }
          holder.hidden = false;
          if (holder.dataset.loaded === "1") {
            return;
          }
          try {
            const shot = await host.request<EvidenceResult>("duties.run.evidence", {
              runId,
              stepId,
            });
            if (context.signal.aborted) {
              return;
            }
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
            if (runId && !state.observedRuns.has(runId)) {
              void loaders.loadRun(runId);
            }
          }
          if (view === "logins") {
            void loaders.loadLogins();
          }
          if (view === "templates") {
            void loaders.loadTemplates();
          }
        };

        const runDuty = async (dutyId: string): Promise<void> => {
          try {
            const result = await host.request<RunStartResult>("duties.run", { id: dutyId });
            if (context.signal.aborted) {
              return;
            }
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
            if (context.signal.aborted) {
              return;
            }
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

        attachClickRouter(root, {
          getLastRetry: () => lastRetry,
          getContextId: () => context.props.id,
          getDuties: () => state.duties,
          go,
          runDuty: (id) => void runDuty(id),
          openEditWithAgent,
          setStatus: (id, next) => void setStatus(id, next),
          deleteDuty: (id) => void deleteDuty(id),
          cancelRun: (runId) => void cancelRun(runId),
          toggleShot: (stepId) => void toggleShot(stepId),
          saveLogin: () => void saveLogin(),
          saveBrand: () => void saveBrand(),
          previewTemplate: (id) => void previewTemplate(id),
          openTemplatePdf: (id) => void openTemplatePdf(id),
          openEditTemplateWithAgent,
          deleteTemplate: (id) => void deleteTemplate(id),
          toggleFilePreview: (stepId) => void toggleFilePreview(stepId),
          openRunFile: (stepId) => void openRunFile(stepId),
          deleteLogin: (key) => void deleteLogin(key),
        });

        // The Desk card's parallel-runs field is a plain number input, not a button: its own
        // `change` is the save trigger, mirroring how a native settings control behaves.
        root.addEventListener("change", (event) => {
          // SAFETY: this listener is on `root`, an HTMLElement, so its change events always target an Element.
          const target = (event.target as HTMLElement).closest<HTMLInputElement>(
            "[data-parallel-save]",
          );
          if (!target) {
            return;
          }
          void saveParallel(Number(target.value));
        });

        const offChanged = host.onEvent("plugin.duties.changed", (payload) => {
          const dutyId = readDutyId(payload);
          if (dutyId) {
            if (state.duties.some((d) => d.id === dutyId)) {
              void loaders.refreshDuty(dutyId);
            } else {
              // Unknown to the page (a duty created elsewhere): only then is a full list refresh
              // warranted, instead of guessing at a single-duty fetch for an id we've never seen.
              void loaders.loadDuties();
            }
            return;
          }
          if (isRecord(payload) && (payload.templateId !== undefined || payload.brand === true)) {
            void loaders.loadTemplates();
            return;
          }
          if (isRecord(payload) && payload.settings === true) {
            void loaders.loadSettings();
            // `maxParallelRuns` is a setting but also half of what the Desk card shows, so a
            // settings change (from this page or elsewhere) keeps that card's number honest too.
            void loaders.loadDeskStatus();
          }
        });
        const offRun = host.onEvent("plugin.duties.run", (payload) => {
          const runId = readRunId(payload);
          if (runId) {
            void loaders.loadRun(runId);
          }
          // A run starting/finishing changes the Desk card's active/queued counts.
          void loaders.loadDeskStatus();
        });

        draw();
        ensureLoaded();
        void loaders.loadDuties();
        void loaders.loadRecentRuns();
        void loaders.loadSettings();
        void loaders.loadMailStatus();
        void loaders.loadDeskStatus();

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
