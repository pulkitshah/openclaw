import { describe, expect, it } from "vitest";
import { buildMailSetup } from "./cli.js";
import { MAIL_AGENT_ID } from "./mail.js";

describe("buildMailSetup", () => {
  it("reports every missing piece and the commands/snippets needed for a bare install", () => {
    const result = buildMailSetup({
      account: "ops@example.com",
      gogPath: undefined,
      config: { hooksEnabled: false, mappingPresent: false, agentPresent: false },
    });

    expect(result.missing).toContain(
      "gog CLI not found on PATH — install gogcli and run: gog auth add ops@example.com",
    );
    expect(result.commands).toContain("openclaw webhooks gmail setup --account ops@example.com");
    expect(result.commands).toContain(
      `openclaw approvals allowlist add --agent ${MAIL_AGENT_ID} <path-to-gog>`,
    );

    const agentEntry = JSON.parse(result.snippets.agentEntry);
    expect(agentEntry.agents.entries[MAIL_AGENT_ID].tools.allow).toEqual([
      "duty_list",
      "duty_get",
      "duty_run",
      "message",
      "exec",
    ]);
    expect(agentEntry.agents.entries[MAIL_AGENT_ID].tools.profile).toBe("minimal");
    expect(agentEntry.agents.entries[MAIL_AGENT_ID].skills).toEqual(["duties"]);

    const hookMapping = JSON.parse(result.snippets.hookMapping);
    const mapping = hookMapping.hooks.mappings[0];
    expect(mapping.agentId).toBe(MAIL_AGENT_ID);
    expect(mapping.match.path).toBe("gmail");
    expect(mapping.forEach).toBe("messages");
    expect(mapping.deliver).toBe(false);
    expect(mapping.messageTemplate).toContain("Message-Id: {{messages[0].id}}");
  });

  it("finds gog on PATH and uses it in the allowlist command instead of a placeholder", () => {
    const result = buildMailSetup({
      account: "ops@example.com",
      gogPath: "/opt/homebrew/bin/gog",
      config: {
        hooksEnabled: true,
        gmailAccount: "ops@example.com",
        mappingPresent: true,
        agentPresent: true,
      },
    });

    expect(result.missing).not.toContain(
      "gog CLI not found on PATH — install gogcli and run: gog auth add ops@example.com",
    );
    expect(result.commands).toContain(
      `openclaw approvals allowlist add --agent ${MAIL_AGENT_ID} /opt/homebrew/bin/gog`,
    );
  });

  it("reports the account mismatch and stops asking for webhooks setup once everything matches", () => {
    const mismatched = buildMailSetup({
      account: "ops@example.com",
      gogPath: "/usr/local/bin/gog",
      config: {
        hooksEnabled: true,
        gmailAccount: "someone-else@example.com",
        mappingPresent: true,
        agentPresent: true,
      },
    });
    expect(mismatched.missing.some((m) => m.includes("someone-else@example.com"))).toBe(true);
    expect(mismatched.commands).toContain(
      "openclaw webhooks gmail setup --account ops@example.com",
    );

    const fullySet = buildMailSetup({
      account: "ops@example.com",
      gogPath: "/usr/local/bin/gog",
      config: {
        hooksEnabled: true,
        gmailAccount: "ops@example.com",
        mappingPresent: true,
        agentPresent: true,
      },
    });
    expect(fullySet.missing).toEqual([]);
    expect(fullySet.commands).not.toContain(
      "openclaw webhooks gmail setup --account ops@example.com",
    );
  });
});
