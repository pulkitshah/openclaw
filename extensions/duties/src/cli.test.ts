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
      "llm-task",
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

  // Regression: the snippets described only the dispatcher agent and the mapping. Pasting that
  // much made the install multi-agent with no explicit owner (taking the operator's existing
  // channels down) and left the hook receiver rejecting the per-message session key the mapping
  // itself asks for, so no mail ever reached the dispatcher.
  it("ships the ownership, bindings and hook session-key settings the dispatcher forces", () => {
    const result = buildMailSetup({
      account: "ops@example.com",
      gogPath: "/opt/homebrew/bin/gog",
      config: { hooksEnabled: false, mappingPresent: false, agentPresent: false },
    });

    const agentEntry = JSON.parse(result.snippets.agentEntry);
    expect(agentEntry.agents.ownership).toBe("explicit");
    // An `ai` step reaches a model through an ambient completion, which needs a named owner.
    expect(agentEntry.agents.defaults.systemAgent.agentId).toBe("<your-main-agent-id>");
    // ...and through the llm-task tool, which no install enables on its own.
    expect(agentEntry.plugins.entries["llm-task"]).toEqual({ enabled: true });
    expect(agentEntry.tools.alsoAllow).toEqual(["llm-task"]);
    expect(agentEntry.agents.entries[MAIL_AGENT_ID].tools.allow).toContain("llm-task");
    expect(agentEntry.bindings).toEqual([
      {
        agentId: "<your-main-agent-id>",
        comment: expect.stringContaining("one binding per enabled channel"),
        match: { channel: "telegram", accountId: "*" },
      },
    ]);

    const hooks = JSON.parse(result.snippets.hookMapping).hooks;
    expect(hooks.defaultSessionKey).toBe("hook:gmail:ingress");
    expect(hooks.allowRequestSessionKey).toBe(true);
    expect(hooks.allowedSessionKeyPrefixes).toEqual(["hook:gmail:"]);
    expect(hooks.allowedAgentIds).toEqual([MAIL_AGENT_ID]);
    // The prefix allowlist has to cover the session key the mapping actually asks for.
    expect(hooks.mappings[0].sessionKey.startsWith(hooks.allowedSessionKeyPrefixes[0])).toBe(true);
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
