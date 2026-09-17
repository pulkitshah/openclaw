// Pure, closure-free pieces of the Team Control UI page: result-shape types, the click router, and
// the small error-message helper. Split out of `team-page.ts` for the same reason
// `extensions/duties/browser/index-helpers.ts` splits its own page into small responsibility seams.
import type { TeamView } from "./render.js";

export type Props = Readonly<Record<string, string>>;

export type TeamGetResult = TeamView;

/** `openclaw/plugin-sdk/error-runtime`'s `coerceErrorMessage` re-exports Node-only infra that
 *  esbuild cannot resolve for a browser target — no bundled plugin's `browser/` imports it. This is
 *  the same minimal shape every other plugin's browser bundle in this codebase duplicates for the
 *  same reason (see `extensions/duties/browser/index-helpers.ts`'s own copy). */
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
    typeof (error as { message: unknown }).message === "string" &&
    (error as { message: string }).message
  ) {
    return (error as { message: string }).message;
  }
  return "Something went wrong.";
}

/** The Team page's own click router — the `data-team-*` branches, plus the empty-roster owner
 *  form's `data-settings-save`. */
export function attachTeamClickRouter(
  root: HTMLElement,
  handlers: {
    getLastRetry: () => (() => void) | null;
    addTeamMember: () => void;
    removeTeamMember: (memberId: string) => void;
    transferTeamOwnership: (memberId: string) => void;
    addTeamChannel: (memberId: string) => void;
    saveOwnerSettings: () => void;
  },
): void {
  root.addEventListener("click", (event) => {
    // SAFETY: this listener is on `root`, an HTMLElement, so its click events always target an Element.
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-retry],[data-team-add],[data-team-remove],[data-team-transfer],[data-team-channel-add],[data-settings-save]",
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
    if (dataset.teamAdd !== undefined) {
      handlers.addTeamMember();
      return;
    }
    if (dataset.teamRemove !== undefined) {
      handlers.removeTeamMember(dataset.teamRemove);
      return;
    }
    if (dataset.teamTransfer !== undefined) {
      handlers.transferTeamOwnership(dataset.teamTransfer);
      return;
    }
    if (dataset.teamChannelAdd !== undefined) {
      handlers.addTeamChannel(dataset.teamChannelAdd);
      return;
    }
    if (dataset.settingsSave !== undefined) {
      handlers.saveOwnerSettings();
    }
  });
}
