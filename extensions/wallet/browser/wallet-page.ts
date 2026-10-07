// The Wallet page's own Control UI mount: where the balance went, and (at admin scope) the
// recharge/adjust/settings controls. Server-sourced state is loaded here; `render.ts` is pure.
import type {
  ControlUiHost,
  ControlUiView,
  ControlUiViewContext,
} from "openclaw/plugin-sdk/control-ui";
import type { Activity, WalletEntry } from "../src/store.js";
import {
  attachWalletClickRouter,
  coerceErrorMessage,
  navigateReservedWindow,
  reserveWindowForDeferredNavigation,
  textToBase64,
} from "./index-helpers.js";
import type { Props } from "./index-helpers.js";
import {
  formatInr,
  renderActivities,
  renderAdmin,
  renderBuckets,
  renderEntries,
  renderErrorBanner,
  renderHeader,
  renderPeriodBar,
  renderStatement,
} from "./render.js";
import type { Period, WalletForm, WalletGet } from "./render.js";
import "./styles.css";

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const LEDGER_PAGE = 100;

export type WalletPageState = {
  get?: WalletGet;
  ledger: WalletEntry[];
  /** Cursor for the next ledger page; absent when the statement is complete. */
  nextBefore?: number;
  /** Entries behind the open activity row. */
  refEntries: WalletEntry[];
  period: Period;
  custom: { from: number; to: number };
  openBucket?: Activity;
  openRef?: string;
  openForm?: WalletForm;
  /** Cosmetic only: `wallet.*` writes are gated at operator.admin server-side. Defaults true until
   *  the probe answers, as Team's page does. */
  canAdmin: boolean;
  notice?: string;
  error?: string;
};

type Range = { from?: number; to?: number };

const istDayStart = (ms: number): number =>
  Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;

/** Epoch-ms bounds for the chosen period. "month" sends nothing: the gateway's default is the IST
 *  month to now. */
function rangeFor(state: WalletPageState, now: number): Range {
  switch (state.period) {
    case "today":
      return { from: istDayStart(now) };
    case "30d":
      return { from: now - 30 * DAY_MS };
    case "custom":
      return state.custom;
    default:
      return {};
  }
}

/** Rupees typed in a form to whole paise; undefined when it is not a finite amount. */
function toPaise(text: string): number | undefined {
  if (!text.trim()) {
    return undefined;
  }
  const rupees = Number(text);
  return Number.isFinite(rupees) ? Math.round(rupees * 100) : undefined;
}

export function createWalletPageMount(host: ControlUiHost): ControlUiView<Props> {
  return (container, initial) => {
    let context: ControlUiViewContext<Props> = initial;
    const now = Date.now();
    const state: WalletPageState = {
      ledger: [],
      refEntries: [],
      period: "month",
      custom: { from: istDayStart(now), to: now },
      canAdmin: true,
    };
    let lastRetry: (() => void) | null = null;

    const root = document.createElement("div");
    root.className = "dt wallet";
    container.append(root);

    const input = (attr: string): HTMLInputElement | null =>
      root.querySelector<HTMLInputElement>(`[${attr}]`);

    const draw = (): void => {
      if (context.signal.aborted) {
        return;
      }
      // A redraw from a live event must not wipe what the owner is typing into the open form.
      const typed = [
        ...root.querySelectorAll<HTMLInputElement>(
          "[data-f-amount],[data-f-reference],[data-f-note],[data-f-limit],[data-f-low],[data-f-enforce]",
        ),
      ].map(
        (el) =>
          [
            Object.keys(el.dataset)[0] ?? "",
            el.type === "checkbox" ? el.checked : el.value,
          ] as const,
      );
      const { get } = state;
      const parts: string[] = [];
      if (state.error) {
        parts.push(renderErrorBanner(state.error));
      }
      if (state.notice) {
        parts.push(`<div class="notice">${renderNotice(state.notice)}</div>`);
      }
      if (!get) {
        parts.push(`<p class="muted">Loading the wallet…</p>`);
      } else {
        parts.push(renderHeader(get, state.canAdmin));
        if (state.canAdmin) {
          parts.push(renderAdmin(get, state.openForm));
        }
        parts.push(renderPeriodBar(state.period, state.custom));
        parts.push(`<h2>Where it went</h2>`, renderBuckets(get.summary, state.openBucket));
        const bucket = get.summary.buckets.find((b) => b.activity === state.openBucket);
        if (bucket) {
          parts.push(renderActivities(bucket, state.openRef));
          if (state.openRef) {
            parts.push(renderEntries(state.refEntries));
          }
        }
        parts.push(renderStatement(state.ledger, state.nextBefore !== undefined));
      }
      root.innerHTML = parts.join("");
      if (state.openForm) {
        for (const [key, value] of typed) {
          const el = root.querySelector<HTMLInputElement>(
            `[data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`,
          );
          if (!el) {
            continue;
          }
          if (typeof value === "boolean") {
            el.checked = value;
          } else if (value) {
            el.value = value;
          }
        }
      }
    };

    const fail = (error: unknown, retry: () => void): void => {
      state.error = coerceErrorMessage(error);
      lastRetry = retry;
      draw();
    };
    const clearMessages = (): void => {
      delete state.error;
      delete state.notice;
      lastRetry = null;
    };

    const loadGet = async (): Promise<void> => {
      const result = await host.request<WalletGet>("wallet.get", rangeFor(state, Date.now()));
      if (!context.signal.aborted) {
        state.get = result;
      }
    };
    const loadLedger = async (before?: number): Promise<void> => {
      const result = await host.request<{ entries: WalletEntry[]; nextBefore?: number }>(
        "wallet.ledger",
        {
          ...rangeFor(state, Date.now()),
          limit: LEDGER_PAGE,
          ...(before === undefined ? {} : { before }),
        },
      );
      if (context.signal.aborted) {
        return;
      }
      state.ledger = before === undefined ? result.entries : [...state.ledger, ...result.entries];
      if (result.nextBefore === undefined) {
        delete state.nextBefore;
      } else {
        state.nextBefore = result.nextBefore;
      }
    };
    const loadRefEntries = async (): Promise<void> => {
      if (!state.openRef || !state.openBucket) {
        state.refEntries = [];
        return;
      }
      const result = await host.request<{ entries: WalletEntry[] }>("wallet.ledger", {
        ...rangeFor(state, Date.now()),
        ref: state.openRef,
        activity: state.openBucket,
      });
      if (!context.signal.aborted) {
        state.refEntries = result.entries;
      }
    };

    const reload = async (): Promise<void> => {
      try {
        await Promise.all([loadGet(), loadLedger(), loadRefEntries()]);
        clearMessages();
      } catch (error) {
        fail(error, () => void reload());
        return;
      }
      draw();
    };

    /** An admin-only call with an empty patch is a no-op the handler answers with the state; a
     *  missing-scope refusal means the mutating controls should not be drawn. Any other failure
     *  leaves them up rather than claiming a lost permission over a transient fault. */
    const probeAdmin = async (): Promise<void> => {
      try {
        await host.request("wallet.settings", {});
      } catch (error) {
        state.canAdmin = !/scope/i.test(error instanceof Error ? error.message : String(error));
      }
      draw();
    };

    const write = async (
      method: string,
      params: Record<string, unknown>,
      done: string,
    ): Promise<void> => {
      try {
        await host.request(method, params);
      } catch (error) {
        fail(error, () => undefined);
        return;
      }
      delete state.openForm;
      await reload();
      state.notice = done;
      draw();
    };

    const submit = async (form: string): Promise<void> => {
      const text = (attr: string) => input(attr)?.value.trim() ?? "";
      if (form === "recharge") {
        const amountPaise = toPaise(text("data-f-amount"));
        if (amountPaise === undefined || amountPaise <= 0 || !text("data-f-reference")) {
          fail(new Error("Enter an amount above zero and the payment reference."), () => undefined);
          return;
        }
        await write(
          "wallet.credit",
          { amountPaise, reference: text("data-f-reference"), note: text("data-f-note") },
          `Added ${formatInr(amountPaise)}.`,
        );
      } else if (form === "adjust") {
        const amountPaise = toPaise(text("data-f-amount"));
        if (amountPaise === undefined || amountPaise === 0 || !text("data-f-note")) {
          fail(new Error("Enter a non-zero amount and say why."), () => undefined);
          return;
        }
        await write(
          "wallet.adjust",
          { amountPaise, note: text("data-f-note") },
          "Adjustment applied.",
        );
      } else if (form === "settings") {
        const creditLimitPaise = toPaise(text("data-f-limit"));
        const lowBalancePaise = toPaise(text("data-f-low"));
        if (
          creditLimitPaise === undefined ||
          lowBalancePaise === undefined ||
          creditLimitPaise < 0 ||
          lowBalancePaise < 0
        ) {
          fail(
            new Error("Credit limit and low-balance line must be zero or more."),
            () => undefined,
          );
          return;
        }
        await write(
          "wallet.settings",
          { creditLimitPaise, lowBalancePaise, enforce: input("data-f-enforce")?.checked ?? false },
          "Settings saved.",
        );
      }
    };

    const backfill = async (): Promise<void> => {
      try {
        const r = await host.request<{
          sessions: number;
          days: number;
          failed: number;
          paise: number;
        }>("wallet.backfill", {});
        await reload();
        state.notice = `Imported ${r.days} ${r.days === 1 ? "day" : "days"} of past usage from ${r.sessions} ${r.sessions === 1 ? "chat" : "chats"} (${formatInr(r.paise)})${r.failed ? `; ${r.failed} could not be read` : ""}.`;
        draw();
      } catch (error) {
        fail(error, () => void backfill());
      }
    };

    const exportCsv = async (): Promise<void> => {
      // Reserved before the await: the popup blocker only honors a window opened inside the click.
      const win = reserveWindowForDeferredNavigation();
      try {
        const { csv } = await host.request<{ csv: string }>(
          "wallet.export",
          rangeFor(state, Date.now()),
        );
        navigateReservedWindow(win, textToBase64(csv), "text/csv");
      } catch (error) {
        win?.close();
        fail(error, () => void exportCsv());
      }
    };

    const customApply = (): void => {
      const from = input("data-custom-from")?.value;
      const to = input("data-custom-to")?.value;
      if (!from || !to) {
        fail(new Error("Pick both dates."), () => undefined);
        return;
      }
      const start = Date.parse(`${from}T00:00:00Z`) - IST_OFFSET_MS;
      const end = Date.parse(`${to}T00:00:00Z`) - IST_OFFSET_MS + DAY_MS - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
        fail(new Error("The end date must not be before the start date."), () => undefined);
        return;
      }
      state.custom = { from: start, to: end };
      void reload();
    };

    attachWalletClickRouter(root, {
      retry: () => lastRetry?.(),
      period: (period) => {
        if (period !== "today" && period !== "month" && period !== "30d" && period !== "custom") {
          return;
        }
        state.period = period;
        delete state.openBucket;
        delete state.openRef;
        state.refEntries = [];
        if (period === "custom") {
          draw();
          return;
        }
        void reload();
      },
      customApply,
      bucket: (activity) => {
        const match = state.get?.summary.buckets.find((b) => b.activity === activity);
        if (!match) {
          return;
        }
        state.openBucket = state.openBucket === match.activity ? undefined : match.activity;
        delete state.openRef;
        state.refEntries = [];
        draw();
      },
      activity: (ref) => {
        if (state.openRef === ref) {
          delete state.openRef;
          state.refEntries = [];
          draw();
          return;
        }
        state.openRef = ref;
        state.refEntries = [];
        draw();
        void loadRefEntries().then(draw, (error: unknown) => fail(error, () => undefined));
      },
      openForm: (form) => {
        if (form === "recharge" || form === "adjust" || form === "settings") {
          state.openForm = state.openForm === form ? undefined : form;
          clearMessages();
          draw();
        }
      },
      submit: (form) => void submit(form),
      backfill: () => void backfill(),
      exportCsv: () => void exportCsv(),
      more: () => {
        if (state.nextBefore !== undefined) {
          void loadLedger(state.nextBefore).then(draw, (error: unknown) =>
            fail(error, () => undefined),
          );
        }
      },
    });

    const offChanged = host.onEvent("plugin.wallet.changed", () => void reload());

    draw();
    void reload();
    void probeAdmin();

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

function renderNotice(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
