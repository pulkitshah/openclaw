import { describe, expect, it } from "vitest";
import {
  createGmailSetupFormState,
  isGmailImapConfigured,
  parseGmailAllowedSenders,
  resolveGmailImapAccount,
  validateGmailSetupForm,
  type GmailSetupFormState,
} from "./gmail-setup.ts";

function baseForm(overrides: Partial<GmailSetupFormState> = {}): GmailSetupFormState {
  return {
    step: "form",
    email: "owner@gmail.com",
    appPassword: "abcd efgh ijkl mnop",
    passwordVisible: false,
    allowedSenders: "someone@example.com",
    saving: false,
    error: null,
    fieldErrors: {},
    ...overrides,
  };
}

describe("resolveGmailImapAccount / isGmailImapConfigured", () => {
  it("returns null/false for a config with no imap plugin at all", () => {
    expect(resolveGmailImapAccount(null)).toBeNull();
    expect(resolveGmailImapAccount({})).toBeNull();
    expect(isGmailImapConfigured(null)).toBe(false);
  });

  it("reads the wizard-owned account out of plugins.entries.imap.config.accounts.gmail", () => {
    const config = {
      plugins: {
        entries: {
          imap: {
            enabled: true,
            config: {
              accounts: {
                gmail: {
                  host: "imap.gmail.com",
                  user: "owner@example.com",
                  agentId: "duties-mail",
                },
                other: { host: "imap.example.com", user: "other@example.com" },
              },
            },
          },
        },
      },
    };
    expect(resolveGmailImapAccount(config)).toEqual({
      host: "imap.gmail.com",
      user: "owner@example.com",
      agentId: "duties-mail",
    });
    expect(isGmailImapConfigured(config)).toBe(true);
  });

  it("treats a blank user as not configured", () => {
    const config = {
      plugins: { entries: { imap: { config: { accounts: { gmail: { user: "  " } } } } } },
    };
    expect(isGmailImapConfigured(config)).toBe(false);
  });
});

describe("createGmailSetupFormState", () => {
  it("starts blank on the intro step when nothing is configured yet", () => {
    const state = createGmailSetupFormState(null);
    expect(state).toEqual({
      step: "intro",
      email: "",
      appPassword: "",
      passwordVisible: false,
      allowedSenders: "",
      saving: false,
      error: null,
      fieldErrors: {},
    });
  });

  it("prefills the email and allowed senders from an existing account, but never the password", () => {
    const config = {
      plugins: {
        entries: {
          imap: {
            config: {
              accounts: {
                gmail: {
                  user: "owner@example.com",
                  password: "should-never-appear",
                  allowedSenders: ["a@example.com", "@example.org"],
                },
              },
            },
          },
        },
      },
    };
    const state = createGmailSetupFormState(config);
    expect(state.email).toBe("owner@example.com");
    expect(state.allowedSenders).toBe("a@example.com, @example.org");
    expect(state.appPassword).toBe("");
  });
});

describe("parseGmailAllowedSenders", () => {
  it("splits on commas and newlines, trims, dedupes, and drops blanks", () => {
    expect(parseGmailAllowedSenders(" a@example.com,  @example.org\n a@example.com \n\n")).toEqual([
      "a@example.com",
      "@example.org",
    ]);
  });
});

describe("validateGmailSetupForm", () => {
  it("accepts a fully valid form", () => {
    expect(validateGmailSetupForm(baseForm())).toEqual({});
  });

  it("rejects a malformed email", () => {
    const errors = validateGmailSetupForm(baseForm({ email: "not-an-email" }));
    expect(errors.email).toBeTruthy();
  });

  it("rejects an app password that is too short once spaces are stripped", () => {
    const errors = validateGmailSetupForm(baseForm({ appPassword: "ab cd" }));
    expect(errors.appPassword).toBeTruthy();
  });

  it("requires at least one allowed sender", () => {
    const errors = validateGmailSetupForm(baseForm({ allowedSenders: "   " }));
    expect(errors.allowedSenders).toBeTruthy();
  });

  it("rejects a malformed allowed-sender entry", () => {
    const errors = validateGmailSetupForm(baseForm({ allowedSenders: "not valid entry" }));
    expect(errors.allowedSenders).toBeTruthy();
  });
});
