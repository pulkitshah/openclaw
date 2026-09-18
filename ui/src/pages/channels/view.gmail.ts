// Gmail connection card: a guided IMAP-app-password setup dialog plus the
// channel-detail status card, built on the generic extensions/imap plugin
// (see gmail-setup.ts for why, and why this is not a full ChannelPlugin).
import { html, nothing, type TemplateResult } from "lit";
import { renderChannelIcon } from "../../components/channel-icon.ts";
import "../../components/modal-dialog.ts";
import { renderSensitiveInput } from "../../components/sensitive-input.ts";
import { renderSettingsSection } from "../../components/settings-ui.ts";
import { renderWizardBusyButton } from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";
import {
  GMAIL_HUB_CHANNEL_ID,
  isGmailImapConfigured,
  resolveGmailImapAccount,
  type GmailSetupFieldName,
  type GmailSetupFormState,
} from "./gmail-setup.ts";
import {
  boolStatusKind,
  formatNullableBoolean,
  renderChannelActionRow,
  renderChannelFacts,
} from "./view.shared.ts";
import type { ChannelsProps } from "./view.types.ts";

export type GmailSetupModalProps = {
  state: GmailSetupFormState | null;
  onFieldChange: (field: GmailSetupFieldName, value: string) => void;
  onTogglePasswordVisibility: () => void;
  onContinue: () => void;
  onSave: () => void;
  onClose: () => void;
};

function fieldError(message: string | undefined) {
  return message
    ? html`<span class="settings-row__desc" style="color: var(--danger-text);">${message}</span>`
    : nothing;
}

function renderIntroStep(props: GmailSetupModalProps) {
  return html`
    <div class="channels-wizard__message">${t("channels.gmail.setup.introBody1")}</div>
    <ol class="channels-wizard__message">
      <li>
        <a href="https://myaccount.google.com/security" target="_blank" rel="noreferrer">
          ${t("channels.gmail.setup.enable2sv")}
        </a>
      </li>
      <li>
        <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
          ${t("channels.gmail.setup.createAppPassword")}
        </a>
      </li>
    </ol>
    <div class="channels-wizard__footer">
      <button type="button" class="btn" @click=${() => props.onClose()}>
        ${t("common.cancel")}
      </button>
      <button type="button" class="btn primary" @click=${() => props.onContinue()}>
        ${t("channels.setup.continue")}
      </button>
    </div>
  `;
}

function renderFormStep(props: GmailSetupModalProps, state: GmailSetupFormState) {
  const passwordId = "gmail-setup-app-password";
  return html`
    ${state.error ? html`<div class="channels-wizard__error">${state.error}</div>` : nothing}
    <div class="settings-row settings-row--stacked">
      <div class="settings-row__text">
        <label class="settings-row__title" for="gmail-setup-email"
          >${t("channels.gmail.setup.emailLabel")}</label
        >
        ${fieldError(state.fieldErrors.email)}
      </div>
      <div class="settings-row__control">
        <input
          id="gmail-setup-email"
          class="settings-input"
          type="email"
          autocomplete="email"
          placeholder=${t("channels.gmail.setup.emailPlaceholder")}
          .value=${state.email}
          ?disabled=${state.saving}
          @input=${(event: Event) =>
            props.onFieldChange("email", (event.currentTarget as HTMLInputElement).value)}
        />
      </div>
    </div>
    <div class="settings-row settings-row--stacked">
      <div class="settings-row__text">
        <label class="settings-row__title" for=${passwordId}
          >${t("channels.gmail.setup.appPasswordLabel")}</label
        >
        <span class="settings-row__desc">${t("channels.gmail.setup.appPasswordHelp")}</span>
        ${fieldError(state.fieldErrors.appPassword)}
      </div>
      <div class="settings-row__control">
        ${renderSensitiveInput({
          id: passwordId,
          name: "gmail-app-password",
          value: state.appPassword,
          revealed: state.passwordVisible,
          revealLabel: t("configForm.revealValue"),
          hideLabel: t("configForm.hideValue"),
          inputClassName: "settings-input",
          placeholder: t("channels.gmail.setup.appPasswordPlaceholder"),
          disabled: state.saving,
          onInput: (value) => props.onFieldChange("appPassword", value),
          onToggle: () => props.onTogglePasswordVisibility(),
        })}
      </div>
    </div>
    <div class="settings-row settings-row--stacked">
      <div class="settings-row__text">
        <label class="settings-row__title" for="gmail-setup-senders"
          >${t("channels.gmail.setup.allowedSendersLabel")}</label
        >
        <span class="settings-row__desc">${t("channels.gmail.setup.allowedSendersHelp")}</span>
        ${fieldError(state.fieldErrors.allowedSenders)}
      </div>
      <div class="settings-row__control">
        <textarea
          id="gmail-setup-senders"
          class="settings-input"
          rows="2"
          placeholder=${t("channels.gmail.setup.allowedSendersPlaceholder")}
          .value=${state.allowedSenders}
          ?disabled=${state.saving}
          @input=${(event: Event) =>
            props.onFieldChange(
              "allowedSenders",
              (event.currentTarget as HTMLTextAreaElement).value,
            )}
        ></textarea>
      </div>
    </div>
    <div class="channels-wizard__footer">
      <button type="button" class="btn" ?disabled=${state.saving} @click=${() => props.onClose()}>
        ${t("common.cancel")}
      </button>
      ${
        state.saving
          ? renderWizardBusyButton(t("channels.setup.working"))
          : html`<button type="button" class="btn primary" @click=${() => props.onSave()}>
              ${t("channels.gmail.setup.connect")}
            </button>`
      }
    </div>
  `;
}

export function renderGmailSetupModal(
  props: GmailSetupModalProps,
): TemplateResult | typeof nothing {
  const state = props.state;
  if (!state) {
    return nothing;
  }
  const label = t("channels.gmail.title");
  return html`
    <openclaw-modal-dialog
      label=${t("channels.setup.dialogLabel", { channel: label })}
      @modal-cancel=${() => props.onClose()}
    >
      <div class="channels-wizard">
        <div class="channels-wizard__header">
          ${renderChannelIcon(GMAIL_HUB_CHANNEL_ID, label, "tile", {})}
          <div class="channels-wizard__heading">
            <h2>${t("channels.setup.title", { channel: label })}</h2>
            <div class="muted channels-wizard__subtitle">
              <span>${t("channels.gmail.setup.subtitle")}</span>
            </div>
          </div>
        </div>
        ${state.step === "intro" ? renderIntroStep(props) : renderFormStep(props, state)}
      </div>
    </openclaw-modal-dialog>
  `;
}

export function renderGmailDetailCard(params: {
  props: ChannelsProps;
  removing: boolean;
  onRemove: () => void;
}) {
  const { props, removing, onRemove } = params;
  const account = resolveGmailImapAccount(props.configForm);
  const configured = isGmailImapConfigured(props.configForm);
  return renderSettingsSection(
    { title: t("channels.gmail.title"), description: t("channels.gmail.subtitle") },
    html`
      ${renderChannelFacts([
        {
          label: t("common.configured"),
          value: formatNullableBoolean(configured),
          kind: boolStatusKind(configured),
        },
        ...(configured && typeof account?.user === "string"
          ? [{ label: t("channels.gmail.account"), value: account.user }]
          : []),
      ])}
      ${
        !configured
          ? html`<div class="settings-row__desc">${t("channels.gmail.notConfigured")}</div>`
          : nothing
      }
      ${
        configured
          ? renderChannelActionRow(html`
              <button type="button" class="btn danger" ?disabled=${removing} @click=${onRemove}>
                ${removing ? t("channels.gmail.disconnecting") : t("channels.gmail.disconnect")}
              </button>
            `)
          : nothing
      }
    `,
  );
}
