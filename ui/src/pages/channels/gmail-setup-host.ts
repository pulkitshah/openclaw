// Page-side host for the guided Gmail connection card: owns the local
// step/form state and the one-shot config writes (gmail-setup.ts), the same
// way ChannelWizardHost (wizard-host.ts) owns the generic channel wizard's
// state — kept separate because this flow does not go through the gateway
// wizard.start/next machinery at all (see gmail-setup.ts for why).
import type { ApplicationContext } from "../../app/context.ts";
import { showToast } from "../../lib/toast.ts";
import {
  createGmailSetupFormState,
  GMAIL_HUB_CHANNEL_ID,
  removeGmailImapAccount,
  saveGmailImapAccount,
  validateGmailSetupForm,
  type GmailSetupFieldName,
  type GmailSetupFormState,
} from "./gmail-setup.ts";
import type { ChannelsProps } from "./view.types.ts";

type GmailChannelsProps = Pick<
  ChannelsProps,
  | "gmailSetup"
  | "gmailRemoving"
  | "onGmailSetupFieldChange"
  | "onGmailSetupTogglePasswordVisibility"
  | "onGmailSetupContinue"
  | "onGmailSetupSave"
  | "onGmailSetupClose"
  | "onGmailRemove"
>;

/** The slice of ChannelsProps this host owns, built once here rather than repeated inline at
 *  every render() call site. */
export function gmailChannelsProps(host: GmailSetupHost): GmailChannelsProps {
  return {
    gmailSetup: host.setup,
    gmailRemoving: host.removing,
    onGmailSetupFieldChange: (field, value) => host.changeField(field, value),
    onGmailSetupTogglePasswordVisibility: () => host.togglePasswordVisibility(),
    onGmailSetupContinue: () => host.continueToForm(),
    onGmailSetupSave: () => void host.save(),
    onGmailSetupClose: () => host.close(),
    onGmailRemove: () => void host.remove(),
  };
}

/** `ChannelsProps.onStartSetup`'s routing decision: the Gmail card runs its own guided flow
 *  (this host), every other channel keeps using the generic gateway wizard. */
export function routeStartSetup(params: {
  channelId: string | null;
  canAdmin: boolean;
  gmailHost: GmailSetupHost;
  startChannelWizard: (channelId: string | null) => void;
}): void {
  if (!params.canAdmin) {
    return;
  }
  if (params.channelId === GMAIL_HUB_CHANNEL_ID) {
    params.gmailHost.start();
    return;
  }
  params.startChannelWizard(params.channelId);
}

type GmailSetupHostDeps = {
  getContext: () => ApplicationContext | undefined;
  requestUpdate: () => void;
  /** Close any other setup surface (generic wizard, detail overlay) before opening. */
  clearCompetingSurfaces: () => void;
  /** Called once the account is actually removed, so the page can close a detail overlay
   *  that was showing it. */
  onRemoved: () => void;
};

/** Builds a page's GmailSetupHost, owning the "close competing surfaces" / "close the detail
 *  overlay on remove" wiring here rather than in the page class body. */
export function createGmailSetupHostForPage(page: {
  getContext: () => ApplicationContext | undefined;
  requestUpdate: () => void;
  closeGenericWizard: () => void;
  getSelectedChannel: () => string | null;
  setSelectedChannel: (channelId: string | null) => void;
}): GmailSetupHost {
  return new GmailSetupHost({
    getContext: page.getContext,
    requestUpdate: page.requestUpdate,
    clearCompetingSurfaces: () => {
      page.closeGenericWizard();
      page.setSelectedChannel(null);
    },
    onRemoved: () => {
      if (page.getSelectedChannel() === GMAIL_HUB_CHANNEL_ID) {
        page.setSelectedChannel(null);
      }
    },
  });
}

export class GmailSetupHost {
  private setupState: GmailSetupFormState | null = null;
  private removingState = false;

  constructor(private readonly deps: GmailSetupHostDeps) {}

  get setup(): GmailSetupFormState | null {
    return this.setupState;
  }

  get removing(): boolean {
    return this.removingState;
  }

  start(): void {
    const context = this.deps.getContext();
    if (!context) {
      return;
    }
    this.deps.clearCompetingSurfaces();
    this.setupState = createGmailSetupFormState(context.runtimeConfig.state.configForm);
    this.deps.requestUpdate();
  }

  close(): void {
    this.setupState = null;
    this.deps.requestUpdate();
  }

  continueToForm(): void {
    if (!this.setupState) {
      return;
    }
    this.setupState = { ...this.setupState, step: "form", error: null };
    this.deps.requestUpdate();
  }

  changeField(field: GmailSetupFieldName, value: string): void {
    const current = this.setupState;
    if (!current) {
      return;
    }
    this.setupState = {
      ...current,
      [field]: value,
      error: null,
      fieldErrors: { ...current.fieldErrors, [field]: "" },
    };
    this.deps.requestUpdate();
  }

  togglePasswordVisibility(): void {
    if (!this.setupState) {
      return;
    }
    this.setupState = { ...this.setupState, passwordVisible: !this.setupState.passwordVisible };
    this.deps.requestUpdate();
  }

  async save(): Promise<void> {
    const current = this.setupState;
    if (!current || current.saving) {
      return;
    }
    const fieldErrors = validateGmailSetupForm(current);
    if (Object.keys(fieldErrors).length > 0) {
      this.setupState = { ...current, fieldErrors };
      this.deps.requestUpdate();
      return;
    }
    const context = this.deps.getContext();
    if (!context) {
      return;
    }
    const pending: GmailSetupFormState = {
      ...current,
      saving: true,
      error: null,
      fieldErrors: {},
    };
    this.setupState = pending;
    this.deps.requestUpdate();
    const result = await saveGmailImapAccount(context.runtimeConfig, pending);
    if (this.setupState !== pending || this.deps.getContext() !== context) {
      // Closed, superseded, or the page navigated away mid-write; the config
      // write itself already completed or failed independently of this UI.
      return;
    }
    if (!result.ok) {
      this.setupState = { ...pending, saving: false, error: result.error };
      this.deps.requestUpdate();
      return;
    }
    this.setupState = null;
    this.deps.requestUpdate();
    await context.channels.refresh(true);
  }

  async remove(): Promise<void> {
    if (this.removingState) {
      return;
    }
    const context = this.deps.getContext();
    if (!context) {
      return;
    }
    this.removingState = true;
    this.deps.requestUpdate();
    const result = await removeGmailImapAccount(context.runtimeConfig);
    if (this.deps.getContext() !== context) {
      return;
    }
    this.removingState = false;
    this.deps.requestUpdate();
    if (!result.ok) {
      showToast({ message: result.error });
      return;
    }
    this.deps.onRemoved();
    await context.channels.refresh(true);
  }

  /** Page teardown: drop local state without touching config (nothing to cancel server-side). */
  reset(): void {
    this.setupState = null;
    this.removingState = false;
  }
}
