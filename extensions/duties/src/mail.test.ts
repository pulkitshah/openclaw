import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { configuredGmailAddresses, MAIL_AGENT_ID, mailStatusFromConfig } from "./mail.js";

describe("mailStatusFromConfig", () => {
  it("reports nothing ready for an install with no hooks at all", () => {
    expect(mailStatusFromConfig({}, {})).toEqual({
      configured: false,
      hooksEnabled: false,
      gmailAccountSet: false,
      gmailAccountCount: 0,
      mappingPresent: false,
      agentPresent: false,
    });
  });

  it("reports each piece independently so the owner is told which one is missing", () => {
    const config: OpenClawConfig = {
      hooks: {
        enabled: true,
        gmail: { account: "" },
        mappings: [{ agentId: "main" }],
      },
      agents: { entries: { main: {} } },
    };
    expect(mailStatusFromConfig(config, {})).toEqual({
      configured: true,
      hooksEnabled: true,
      // An empty account string is not a configured mailbox.
      gmailAccountSet: false,
      gmailAccountCount: 0,
      // A mapping that routes to another agent does not feed Duties.
      mappingPresent: false,
      agentPresent: false,
    });
  });

  it("reports a fully wired path and carries the last dispatch through from settings", () => {
    const config: OpenClawConfig = {
      hooks: {
        enabled: true,
        gmail: { account: "owner@example.com" },
        mappings: [{ agentId: "main" }, { agentId: MAIL_AGENT_ID }],
      },
      agents: { entries: { [MAIL_AGENT_ID]: {} } },
    };
    const status = mailStatusFromConfig(config, {
      lastMailDispatchAt: 1700000000000,
      lastMailDispatchDutyId: "book-by-mail",
    });
    expect(status).toEqual({
      configured: true,
      hooksEnabled: true,
      gmailAccountSet: true,
      gmailAccountCount: 1,
      mappingPresent: true,
      agentPresent: true,
      lastDispatchAt: 1700000000000,
      lastDispatchDutyId: "book-by-mail",
    });
    // The readout says a mailbox is configured; it never repeats the address itself.
    expect(JSON.stringify(status)).not.toContain("owner@example.com");
  });

  it("still reports the shipped single-mailbox desk healthy, path-matched mapping and all", () => {
    // `deploy/desk/openclaw.json.tmpl`'s exact shape: one root `hooks.gmail.account`, one mapping
    // whose `match.path` is "gmail". Account-awareness must not regress this (C1).
    const status = mailStatusFromConfig(
      // SAFETY: fixture narrowing; only the keys this readout reads are set.
      {
        hooks: {
          enabled: true,
          gmail: { account: "owner@example.com" },
          mappings: [{ id: "duties-mail", agentId: MAIL_AGENT_ID, match: { path: "gmail" } }],
        },
        agents: { entries: { [MAIL_AGENT_ID]: {} } },
      } as OpenClawConfig,
      {},
    );
    expect(status.mappingPresent).toBe(true);
    expect(status.unmappedAccountIds).toBeUndefined();
    expect(status.gmailAccountCount).toBe(1);
  });

  it("reports a named account whose gmail-<accountId> hook path no mapping matches", () => {
    // The shipped desk template maps the one `gmail` path only, so a desk that follows the
    // documented "More than one inbox" example has no mapping for either named mailbox: mail is
    // accepted by the watcher and then dropped. The readout must not call that healthy (C1).
    const status = mailStatusFromConfig(
      // SAFETY: fixture narrowing; only the keys this readout reads are set.
      {
        hooks: {
          enabled: true,
          gmail: {
            accounts: {
              support: { account: "support@example.com" },
              billing: { account: "billing@example.com" },
            },
          },
          mappings: [{ agentId: MAIL_AGENT_ID, match: { path: "gmail-support" } }],
        },
        agents: { entries: { [MAIL_AGENT_ID]: {} } },
      } as OpenClawConfig,
      {},
    );
    expect(status.mappingPresent).toBe(false);
    // Named by account id (never by address) so the owner knows which mailbox to map.
    expect(status.unmappedAccountIds).toEqual(["billing"]);
    expect(JSON.stringify(status)).not.toContain("example.com");
  });

  it("reports healthy once every named account has its own matching mapping", () => {
    const status = mailStatusFromConfig(
      // SAFETY: fixture narrowing; only the keys this readout reads are set.
      {
        hooks: {
          enabled: true,
          gmail: {
            accounts: {
              support: { account: "support@example.com" },
              billing: { account: "billing@example.com" },
            },
          },
          mappings: [
            { agentId: MAIL_AGENT_ID, match: { path: "gmail-support" } },
            { agentId: MAIL_AGENT_ID, match: { path: "/gmail-billing/" } },
          ],
        },
        agents: { entries: { [MAIL_AGENT_ID]: {} } },
      } as OpenClawConfig,
      {},
    );
    expect(status.mappingPresent).toBe(true);
    expect(status.unmappedAccountIds).toBeUndefined();
    expect(status.gmailAccountCount).toBe(2);
  });

  it("treats the lowest-risk migration — renaming the one mailbox `default` — as already mapped", () => {
    // `default` keeps the original `gmail` hook path, which is exactly what the desk template
    // already maps, so naming an existing single mailbox `default` needs no mapping change.
    const status = mailStatusFromConfig(
      // SAFETY: fixture narrowing; only the keys this readout reads are set.
      {
        hooks: {
          enabled: true,
          gmail: { accounts: { default: { account: "owner@example.com" } } },
          mappings: [{ agentId: MAIL_AGENT_ID, match: { path: "gmail" } }],
        },
        agents: { entries: { [MAIL_AGENT_ID]: {} } },
      } as OpenClawConfig,
      {},
    );
    expect(status.mappingPresent).toBe(true);
    expect(status.unmappedAccountIds).toBeUndefined();
  });

  it("counts named accounts and still never returns an address", () => {
    const status = mailStatusFromConfig(
      // SAFETY: fixture narrowing; only the keys this readout reads are set.
      {
        hooks: {
          enabled: true,
          gmail: {
            accounts: {
              orders: { account: "orders@prasthan.in" },
              enquiries: { account: "enquiries@prasthan.in" },
            },
          },
        },
      } as OpenClawConfig,
      {},
    );
    expect(status.gmailAccountSet).toBe(true);
    expect(status.gmailAccountCount).toBe(2);
    expect(JSON.stringify(status)).not.toContain("prasthan.in");
  });

  // The three IMAP-recognition gaps this suite closes: an IMAP account routed to the mail agent
  // (via the Control UI's Gmail card, ui/src/pages/channels/gmail-setup.ts, or a hand-edited
  // extensions/imap config) must read exactly as healthy as a fully wired Gmail hook, not "not
  // configured".
  it("recognizes an IMAP account routed to the mail agent as a fully configured mail path", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          imap: {
            enabled: true,
            config: {
              accounts: {
                gmail: {
                  host: "imap.gmail.com",
                  user: "owner@example.com",
                  password: "app-password",
                  agentId: MAIL_AGENT_ID,
                },
              },
            },
          },
        },
      },
      agents: { entries: { [MAIL_AGENT_ID]: {} } },
    };
    const status = mailStatusFromConfig(config, {});
    expect(status).toEqual({
      configured: true,
      hooksEnabled: true,
      gmailAccountSet: true,
      gmailAccountCount: 1,
      mappingPresent: true,
      agentPresent: true,
    });
    // Never returns the address, matching this file's discipline for every other transport.
    expect(JSON.stringify(status)).not.toContain("example.com");
  });

  it("does not count an IMAP account whose plugin entry is not enabled", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          imap: {
            // enabled left unset: an account object existing in config does not mean the plugin
            // is actually running.
            config: {
              accounts: {
                gmail: {
                  host: "imap.gmail.com",
                  user: "owner@example.com",
                  password: "app-password",
                  agentId: MAIL_AGENT_ID,
                },
              },
            },
          },
        },
      },
    };
    const status = mailStatusFromConfig(config, {});
    expect(status.configured).toBe(false);
    expect(status.gmailAccountSet).toBe(false);
    expect(status.mappingPresent).toBe(false);
  });

  it("does not count an IMAP account routed to a different agent", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          imap: {
            enabled: true,
            config: {
              accounts: {
                support: {
                  host: "imap.example.com",
                  user: "support@example.com",
                  password: "x",
                  agentId: "some-other-agent",
                },
              },
            },
          },
        },
      },
    };
    const status = mailStatusFromConfig(config, {});
    expect(status.gmailAccountSet).toBe(false);
    expect(status.gmailAccountCount).toBe(0);
  });

  it("combines a Gmail hook mailbox and an IMAP mailbox in the account count", () => {
    const config: OpenClawConfig = {
      hooks: {
        enabled: true,
        gmail: { account: "hook@example.com" },
        mappings: [{ agentId: MAIL_AGENT_ID, match: { path: "gmail" } }],
      },
      plugins: {
        entries: {
          imap: {
            enabled: true,
            config: {
              accounts: {
                gmail: {
                  host: "imap.gmail.com",
                  user: "imap@example.com",
                  password: "x",
                  agentId: MAIL_AGENT_ID,
                },
              },
            },
          },
        },
      },
      agents: { entries: { [MAIL_AGENT_ID]: {} } },
    };
    const status = mailStatusFromConfig(config, {});
    expect(status.gmailAccountCount).toBe(2);
    expect(status.mappingPresent).toBe(true);
  });
});

describe("configuredGmailAddresses", () => {
  it("includes an IMAP account's address alongside any Gmail hook addresses", () => {
    const config: OpenClawConfig = {
      hooks: { gmail: { account: "hook@example.com" } },
      plugins: {
        entries: {
          imap: {
            enabled: true,
            config: {
              accounts: {
                gmail: {
                  host: "imap.gmail.com",
                  user: "imap@example.com",
                  password: "x",
                  agentId: MAIL_AGENT_ID,
                },
              },
            },
          },
        },
      },
    };
    expect(configuredGmailAddresses(config)).toEqual(["hook@example.com", "imap@example.com"]);
  });
});
