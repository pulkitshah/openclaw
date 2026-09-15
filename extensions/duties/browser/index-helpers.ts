// Pure, closure-free pieces of the Duties Control UI page: result-shape types, small parsing/
// escaping helpers, the reserved-window PDF/file navigation flow, and open-toggle state capture.
// Split out of index.ts (which owns the stateful `mount()` wiring) to stay under the extensions
// max-lines budget — none of this needs the page's mutable state, only its DOM root and payloads.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Duty } from "../src/duty.js";
import type { DutiesSettings, DutyRun } from "../src/store.js";
import type { Brand, Template } from "../src/template.js";
import type { DeskStatusView } from "./render.js";

export type Props = Readonly<Record<string, string>>;

export type ListResult = { duties: Duty[] };
export type GetResult = { duty: Duty; runs: DutyRun[] };
export type RecentRunsResult = { runs: DutyRun[] };
export type RunGetResult = { run: DutyRun };
export type RunStartResult = { runId: string; queued: boolean; reason?: string };
export type CredListResult = { keys: string[]; updatedAt: Record<string, number> };
export type EvidenceResult = { contentType: string; base64: string };
export type TemplateListResult = { templates: Template[] };
export type BrandGetResult = { brand?: Brand };
export type BrandSetResult = { brand: Brand };
/** `duties.template.preview`'s new shape (final review C4): the PDF itself for the "Open PDF"
 *  button, plus an optional PNG `preview` for the inline `<img>`. `preview` is optional so an
 *  older Gateway/plugin build that has not shipped the PNG render still degrades to the
 *  Open-PDF-only path instead of a blocked `data:` iframe. */
export type TemplatePreviewResult = {
  pdf: { contentType: string; base64: string };
  preview?: { contentType: string; base64: string };
};
export type SettingsGetResult = { settings: DutiesSettings };
export type SettingsSetResult = { settings: DutiesSettings };
export type DeskStatusResult = DeskStatusView;
/** `duties.run.file`'s result — the same shape whether `params.kind` is omitted (the full
 *  document) or `"preview"` (a PNG thumbnail of it). */
export type RunFileResult = { name: string; contentType: string; base64: string };

export function readDutyId(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.dutyId === "string" ? payload.dutyId : undefined;
}

export function readRunId(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.runId === "string" ? payload.runId : undefined;
}

/** `openclaw/plugin-sdk/error-runtime`'s `coerceErrorMessage` re-exports Node-only infra
 * (`../infra/errors.js`, `../infra/outbound/deliver-types.js`, ...) that esbuild cannot resolve
 * for a browser target (proven by a failed `Could not resolve "node:fs"` bundle build) — no
 * bundled plugin's `browser/` imports it. This is the same minimal shape for the browser side. */
export function coerceErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "Something went wrong.";
  }
  if (typeof error === "string" && error) {
    return error;
  }
  if (isRecord(error) && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return "Something went wrong.";
}

/** Mirrors `requireDuty`'s error text in `src/gateway-methods.ts` (`no Duty "<id>"`), the only
 * signal available to tell "this duty was deleted" apart from a transient request failure. */
export function isMissingDutyError(error: unknown): boolean {
  return coerceErrorMessage(error).includes('no Duty "');
}

/** Same shape as `CRED_KEY_RE` in `src/creds.ts`, which the browser bundle cannot import (it pulls
 * in `node:child_process`). Pre-validates the field; the Gateway method's own check is the
 * authority. */
export const CRED_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;

/** Matches `validateBrand`'s `logoDataUrl` length ceiling in `src/template.ts` (700,000 base64
 *  characters ≈ 512 KB of image bytes). Checked against the raw file before it is even read, so a
 *  large logo is refused without spending a `FileReader` pass or a wasted Gateway round trip. */
export const MAX_LOGO_BYTES = 512 * 1024;

export function esc(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Reserves a new browsing context synchronously — before any `await` — so it still carries the
 *  click's live user activation; opening it only after the Gateway round trip (the old
 *  `openBase64InNewTab` shape) meant browsers blocked it as a popup with no feedback. Mirrors the
 *  host's `reserveExternalWindowForDeferredNavigation` in `ui/src/lib/open-external-url.ts` — the
 *  plugin bundle cannot import from `ui/`, so this is a local copy of the same few lines. Detaching
 *  `opener` keeps the blank tab from reaching back into this page. */
export function reserveWindowForDeferredNavigation(): Window | null {
  const opened = window.open("about:blank", "_blank");
  if (opened) {
    opened.opener = null;
  }
  return opened;
}

/** How base64 file bytes reach the tab reserved by `reserveWindowForDeferredNavigation` (final
 *  review C4): a `blob:` object URL and a top-level navigation, never a framed `data:`/`blob:` src
 *  — the host's `frame-src` CSP is `'self' http: https:`, which blocks both, but a top-level
 *  navigation is not governed by `frame-src` at all. The URL is revoked a minute later, long enough
 *  for the tab to have finished loading it. A closed or never-reserved (e.g. popup-blocked) window
 *  is a no-op. */
export function navigateReservedWindow(
  win: Window | null,
  base64: string,
  contentType: string,
): void {
  if (!win || win.closed) {
    return;
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  win.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** What the owner had expanded before a full re-render (I6): the lazily-loaded
 *  screenshot/file-preview/template-preview toggles and any open `<details>` (the Duty
 *  page's `when` step groups). A redraw triggered by a `plugin.duties.changed` /
 *  `plugin.duties.run` event must not silently collapse these. Restoring re-invokes the
 *  same toggle handlers — the fresh DOM starts closed and unloaded, so this both reopens
 *  the panel and re-fetches its content. */
type OpenToggleKind = "shot" | "fileShot" | "tplPreview";
export type OpenState = { toggles: Array<[OpenToggleKind, string]>; detailsOpen: number[] };

export function captureOpenState(root: HTMLElement): OpenState {
  const toggles: Array<[OpenToggleKind, string]> = [];
  root
    .querySelectorAll<HTMLElement>("[data-shot-for],[data-file-shot-for],[data-tpl-preview-for]")
    .forEach((el) => {
      if (el.hidden) {
        return;
      }
      if (el.dataset.shotFor !== undefined) {
        toggles.push(["shot", el.dataset.shotFor]);
      } else if (el.dataset.fileShotFor !== undefined) {
        toggles.push(["fileShot", el.dataset.fileShotFor]);
      } else if (el.dataset.tplPreviewFor !== undefined) {
        toggles.push(["tplPreview", el.dataset.tplPreviewFor]);
      }
    });
  const detailsOpen: number[] = [];
  root.querySelectorAll<HTMLDetailsElement>("details").forEach((el, i) => {
    if (el.open) {
      detailsOpen.push(i);
    }
  });
  return { toggles, detailsOpen };
}

/** Reopens what `captureOpenState` observed, by index for `<details>` and by re-invoking the
 *  page's own toggle handlers (passed in by the caller, since they own the fetch/DOM state those
 *  toggles need) for the lazily-loaded panels. */
export function restoreOpenState(
  root: HTMLElement,
  state: OpenState,
  handlers: {
    onShot: (id: string) => void;
    onFileShot: (id: string) => void;
    onTplPreview: (id: string) => void;
  },
): void {
  root.querySelectorAll<HTMLDetailsElement>("details").forEach((el, i) => {
    if (state.detailsOpen.includes(i)) {
      el.open = true;
    }
  });
  for (const [kind, id] of state.toggles) {
    if (kind === "shot") {
      handlers.onShot(id);
    } else if (kind === "fileShot") {
      handlers.onFileShot(id);
    } else {
      handlers.onTplPreview(id);
    }
  }
}

/** Routes every click on the page's one delegated listener to the action it names via its
 *  `data-*` attribute, so `index.ts`'s `mount()` only has to own the actions themselves (each
 *  handler here is one of `mount()`'s own closures, passed in because they read/write state this
 *  module has no business touching). `getLastRetry`/`getContextId`/`getDuties` are live reads —
 *  those three change after this router is attached (a failed request, a page navigation, a
 *  `duties.list` reload) — never snapshots taken at attach time. */
export function attachClickRouter(
  root: HTMLElement,
  handlers: {
    getLastRetry: () => (() => void) | null;
    getContextId: () => string | undefined;
    getDuties: () => readonly Duty[];
    go: (params: Record<string, string>) => void;
    runDuty: (id: string) => void;
    openEditWithAgent: (duty: Duty | undefined) => void;
    setStatus: (id: string, next: string) => void;
    deleteDuty: (id: string) => void;
    cancelRun: (runId: string) => void;
    toggleShot: (stepId: string) => void;
    saveLogin: () => void;
    saveSettings: () => void;
    saveBrand: () => void;
    previewTemplate: (id: string) => void;
    openTemplatePdf: (id: string) => void;
    openEditTemplateWithAgent: (id: string) => void;
    deleteTemplate: (id: string) => void;
    toggleFilePreview: (stepId: string) => void;
    openRunFile: (stepId: string) => void;
    deleteLogin: (key: string) => void;
  },
): void {
  root.addEventListener("click", (event) => {
    // SAFETY: this listener is on `root`, an HTMLElement, so its click events always target an Element.
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-open],[data-open-run],[data-run],[data-edit],[data-build],[data-status],[data-delete],[data-cancel],[data-nav],[data-retry],[data-shot],[data-cred-save],[data-cred-delete],[data-settings-save],[data-brand-save],[data-tpl-preview],[data-tpl-pdf],[data-tpl-edit],[data-tpl-delete],[data-file-shot],[data-file-open]",
    );
    if (!target) {
      return;
    }
    event.preventDefault();
    const { dataset } = target;
    if (dataset.retry !== undefined) {
      handlers.getLastRetry()?.();
      return;
    }
    if (dataset.open !== undefined) {
      handlers.go({ view: "detail", id: dataset.open });
      return;
    }
    if (dataset.openRun !== undefined) {
      handlers.go({
        view: "run",
        id: dataset.dutyId ?? handlers.getContextId() ?? "",
        runId: dataset.openRun,
      });
      return;
    }
    if (dataset.nav !== undefined) {
      handlers.go({ view: dataset.nav });
      return;
    }
    if (dataset.run !== undefined) {
      handlers.runDuty(dataset.run);
      return;
    }
    if (dataset.build !== undefined) {
      handlers.go({ view: "build", id: dataset.build });
      return;
    }
    if (dataset.edit !== undefined) {
      handlers.openEditWithAgent(
        dataset.edit === "new"
          ? undefined
          : handlers.getDuties().find((d) => d.id === dataset.edit),
      );
      return;
    }
    if (dataset.status !== undefined && dataset.next) {
      handlers.setStatus(dataset.status, dataset.next);
      return;
    }
    if (dataset.delete !== undefined) {
      handlers.deleteDuty(dataset.delete);
      return;
    }
    if (dataset.cancel !== undefined) {
      handlers.cancelRun(dataset.cancel);
      return;
    }
    if (dataset.shot !== undefined) {
      handlers.toggleShot(dataset.shot);
      return;
    }
    if (dataset.credSave !== undefined) {
      handlers.saveLogin();
      return;
    }
    if (dataset.settingsSave !== undefined) {
      handlers.saveSettings();
      return;
    }
    if (dataset.brandSave !== undefined) {
      handlers.saveBrand();
      return;
    }
    if (dataset.tplPreview !== undefined) {
      handlers.previewTemplate(dataset.tplPreview);
      return;
    }
    if (dataset.tplPdf !== undefined) {
      handlers.openTemplatePdf(dataset.tplPdf);
      return;
    }
    if (dataset.tplEdit !== undefined) {
      handlers.openEditTemplateWithAgent(dataset.tplEdit);
      return;
    }
    if (dataset.tplDelete !== undefined) {
      handlers.deleteTemplate(dataset.tplDelete);
      return;
    }
    if (dataset.fileShot !== undefined) {
      handlers.toggleFilePreview(dataset.fileShot);
      return;
    }
    if (dataset.fileOpen !== undefined) {
      handlers.openRunFile(dataset.fileOpen);
      return;
    }
    if (dataset.credDelete !== undefined) {
      handlers.deleteLogin(dataset.credDelete);
    }
  });
}
