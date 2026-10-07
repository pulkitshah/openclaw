// Pure, closure-free pieces of the Wallet Control UI page: the click router, the popup-safe CSV
// download helpers, and the error-message helper. Same split as `extensions/team/browser`.
export type Props = Readonly<Record<string, string>>;

/** `openclaw/plugin-sdk/error-runtime` pulls Node-only infra esbuild cannot bundle for a browser
 *  target; every plugin's browser bundle keeps its own minimal copy. */
export function coerceErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "Something went wrong.";
  }
  if (typeof error === "string" && error) {
    return error;
  }
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message
  ) {
    return error.message;
  }
  return "Something went wrong.";
}

/** Copy of `reserveWindowForDeferredNavigation` in `extensions/duties/browser/index-helpers.ts`
 *  (plugins may not import each other's private files). Called before any `await` so the click's
 *  user activation still counts and the popup blocker lets the tab open. */
export function reserveWindowForDeferredNavigation(): Window | null {
  const opened = window.open("about:blank", "_blank");
  if (opened) {
    opened.opener = null;
  }
  return opened;
}

/** Copy of Duties' `navigateReservedWindow`: top-level navigation to a `blob:` URL (the host's
 *  `frame-src` CSP blocks framed data/blob URLs), revoked a minute later. */
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

/** UTF-8 text to base64 for `navigateReservedWindow`. */
export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export type WalletClickHandlers = {
  retry: () => void;
  period: (period: string) => void;
  customApply: () => void;
  bucket: (activity: string) => void;
  activity: (ref: string) => void;
  openForm: (form: string) => void;
  submit: (form: string) => void;
  backfill: () => void;
  exportCsv: () => void;
  more: () => void;
};

export function attachWalletClickRouter(root: HTMLElement, handlers: WalletClickHandlers): void {
  root.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }
    const target = event.target.closest<HTMLElement>(
      "[data-retry],[data-period],[data-custom-apply],[data-bucket],[data-activity],[data-open-form],[data-submit],[data-backfill],[data-export],[data-more]",
    );
    if (!target) {
      return;
    }
    event.preventDefault();
    const { dataset } = target;
    if (dataset.retry !== undefined) {
      handlers.retry();
    } else if (dataset.period !== undefined) {
      handlers.period(dataset.period);
    } else if (dataset.customApply !== undefined) {
      handlers.customApply();
    } else if (dataset.bucket !== undefined) {
      handlers.bucket(dataset.bucket);
    } else if (dataset.activity !== undefined) {
      handlers.activity(dataset.activity);
    } else if (dataset.openForm !== undefined) {
      handlers.openForm(dataset.openForm);
    } else if (dataset.submit !== undefined) {
      handlers.submit(dataset.submit);
    } else if (dataset.backfill !== undefined) {
      handlers.backfill();
    } else if (dataset.export !== undefined) {
      handlers.exportCsv();
    } else if (dataset.more !== undefined) {
      handlers.more();
    }
  });
}
