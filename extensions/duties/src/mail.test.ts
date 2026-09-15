import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { MAIL_AGENT_ID, mailStatusFromConfig } from "./mail.js";

describe("mailStatusFromConfig", () => {
  it("reports nothing ready for an install with no hooks at all", () => {
    expect(mailStatusFromConfig({}, {})).toEqual({
      configured: false,
      hooksEnabled: false,
      gmailAccountSet: false,
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
      mappingPresent: true,
      agentPresent: true,
      lastDispatchAt: 1700000000000,
      lastDispatchDutyId: "book-by-mail",
    });
    // The readout says a mailbox is configured; it never repeats the address itself.
    expect(JSON.stringify(status)).not.toContain("owner@example.com");
  });
});
