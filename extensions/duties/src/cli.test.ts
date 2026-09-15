import type { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { buildDutiesSetup, registerDutiesSetupCli } from "./cli.js";
import { MAIL_AGENT_ID } from "./mail.js";
import { RENDER_ALLOWLIST_KEY } from "./setup.js";

describe("buildDutiesSetup", () => {
  it("reports every missing piece and the commands/snippets needed for a bare install", () => {
    const result = buildDutiesSetup({
      account: "ops@example.com",
      gogPath: undefined,
      config: {
        hooksEnabled: false,
        mappingPresent: false,
        agentPresent: false,
        renderAllowed: false,
      },
    });

    expect(result.missing).toContain(
      "gog CLI not found on PATH — install gogcli and run: gog auth add ops@example.com",
    );
    expect(result.commands).toContain("vasudev webhooks gmail setup --account ops@example.com");
    expect(result.commands).toContain(
      `vasudev approvals allowlist add --agent ${MAIL_AGENT_ID} <path-to-gog>`,
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
    const result = buildDutiesSetup({
      account: "ops@example.com",
      gogPath: "/opt/homebrew/bin/gog",
      config: {
        hooksEnabled: false,
        mappingPresent: false,
        agentPresent: false,
        renderAllowed: false,
      },
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
    const result = buildDutiesSetup({
      account: "ops@example.com",
      gogPath: "/opt/homebrew/bin/gog",
      config: {
        hooksEnabled: true,
        gmailAccount: "ops@example.com",
        mappingPresent: true,
        agentPresent: true,
        renderAllowed: true,
      },
    });

    expect(result.missing).not.toContain(
      "gog CLI not found on PATH — install gogcli and run: gog auth add ops@example.com",
    );
    expect(result.commands).toContain(
      `vasudev approvals allowlist add --agent ${MAIL_AGENT_ID} /opt/homebrew/bin/gog`,
    );
  });

  it("reports the account mismatch and stops asking for webhooks setup once everything matches", () => {
    const mismatched = buildDutiesSetup({
      account: "ops@example.com",
      gogPath: "/usr/local/bin/gog",
      config: {
        hooksEnabled: true,
        gmailAccount: "someone-else@example.com",
        mappingPresent: true,
        agentPresent: true,
        renderAllowed: true,
      },
    });
    expect(mismatched.missing.some((m) => m.includes("someone-else@example.com"))).toBe(true);
    expect(mismatched.commands).toContain("vasudev webhooks gmail setup --account ops@example.com");

    const fullySet = buildDutiesSetup({
      account: "ops@example.com",
      gogPath: "/usr/local/bin/gog",
      config: {
        hooksEnabled: true,
        gmailAccount: "ops@example.com",
        mappingPresent: true,
        agentPresent: true,
        renderAllowed: true,
      },
    });
    expect(fullySet.missing).toEqual([]);
    expect(fullySet.commands).not.toContain(
      "vasudev webhooks gmail setup --account ops@example.com",
    );
  });

  // Regression: on a default install the managed browser refuses to open the plugin's own
  // loopback render page, so every `template` step and every preview failed — and nothing shipped
  // said why. Setup has to print this prerequisite next to the Gmail ones.
  it("reports the browser render allowlist as a missing prerequisite, with the exact config key", () => {
    const blocked = buildDutiesSetup({
      account: "ops@example.com",
      gogPath: "/usr/local/bin/gog",
      config: {
        hooksEnabled: true,
        gmailAccount: "ops@example.com",
        mappingPresent: true,
        agentPresent: true,
        renderAllowed: false,
      },
    });
    expect(blocked.missing.some((m) => m.includes(RENDER_ALLOWLIST_KEY))).toBe(true);
    expect(blocked.missing.some((m) => m.includes("127.0.0.1"))).toBe(true);

    const allowed = buildDutiesSetup({
      account: "ops@example.com",
      gogPath: "/usr/local/bin/gog",
      config: {
        hooksEnabled: true,
        gmailAccount: "ops@example.com",
        mappingPresent: true,
        agentPresent: true,
        renderAllowed: true,
      },
    });
    expect(allowed.missing).toEqual([]);
  });

  // A hosted desk (docs/superpowers/specs/2026-09-14-hosted-desk-design.md §8) has two more
  // prerequisites nothing else in the printed setup checks: the credential keyfile the Linux
  // cred backend needs, and the virtual display Xvfb should have brought up.
  it("reports the desk keyfile and display as missing prerequisites only when hosted", () => {
    const notHosted = buildDutiesSetup({
      account: "ops@example.com",
      gogPath: "/usr/local/bin/gog",
      config: {
        hooksEnabled: true,
        gmailAccount: "ops@example.com",
        mappingPresent: true,
        agentPresent: true,
        renderAllowed: true,
      },
    });
    expect(notHosted.missing.some((m) => m.includes("keyfile"))).toBe(false);

    const hostedMissing = buildDutiesSetup({
      account: "ops@example.com",
      gogPath: "/usr/local/bin/gog",
      config: {
        hooksEnabled: true,
        gmailAccount: "ops@example.com",
        mappingPresent: true,
        agentPresent: true,
        renderAllowed: true,
        desk: { keyfilePresent: false, displayOk: false },
      },
    });
    expect(hostedMissing.missing.some((m) => m.includes("keyfile"))).toBe(true);
    expect(hostedMissing.missing.some((m) => m.toLowerCase().includes("display"))).toBe(true);

    const hostedReady = buildDutiesSetup({
      account: "ops@example.com",
      gogPath: "/usr/local/bin/gog",
      config: {
        hooksEnabled: true,
        gmailAccount: "ops@example.com",
        mappingPresent: true,
        agentPresent: true,
        renderAllowed: true,
        desk: { keyfilePresent: true, displayOk: true },
      },
    });
    expect(hostedReady.missing).toEqual([]);
  });
});

describe("registerDutiesSetupCli", () => {
  it("registers `duties setup` and keeps `setup-mail` working as an alias", () => {
    const registered: Array<{ name: string; aliases: string[] }> = [];
    const subcommand = {
      description: () => subcommand,
      alias: (value: string) => {
        registered.at(-1)!.aliases.push(value);
        return subcommand;
      },
      requiredOption: () => subcommand,
      action: () => subcommand,
    };
    const duties = {
      description: () => duties,
      command: (name: string) => {
        registered.push({ name, aliases: [] });
        return subcommand;
      },
    };
    const program = {
      command: () => duties,
      // SAFETY: registerDutiesSetupCli only calls program.command(...).description(...) and then
      // the subcommand builder methods this stub provides.
    } as unknown as Command;

    registerDutiesSetupCli({ program, config: {} });

    expect(registered).toEqual([{ name: "setup", aliases: ["setup-mail"] }]);
  });

  /** Builds the same commander stub as above, but captures the registered `action` callback so
   *  it can be invoked directly — the only way to exercise the real desk-facts wiring (reading
   *  the health file, checking the keyfile) without touching the filesystem. */
  function captureAction(): {
    program: Command;
    run: (opts: { account: string }) => Promise<void>;
  } {
    let action: ((opts: { account: string }) => Promise<void>) | undefined;
    const subcommand = {
      description: () => subcommand,
      alias: () => subcommand,
      requiredOption: () => subcommand,
      action: (fn: (opts: { account: string }) => Promise<void>) => {
        action = fn;
        return subcommand;
      },
    };
    const duties = { description: () => duties, command: () => subcommand };
    const program = { command: () => duties } as unknown as Command;
    return {
      program,
      run: async (opts) => {
        await action!(opts);
      },
    };
  }

  it("prints a Desk block with keyfile/display/render checks when the health file says hosted", async () => {
    const { program, run } = captureAction();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    try {
      registerDutiesSetupCli({
        program,
        config: { browser: { ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } } },
        readDeskHealth: async () => ({ hosted: true, display: true }),
        keyfilePresent: async () => true,
      });
      await run({ account: "ops@example.com" });
    } finally {
      logSpy.mockRestore();
    }
    const output = logs.join("\n");
    expect(output).toContain("Desk");
    expect(output).toContain("keyfile");
    expect(output).toMatch(/display.*yes/iu);
  });

  it("prints no Desk block when the health file says not hosted", async () => {
    const { program, run } = captureAction();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    try {
      registerDutiesSetupCli({
        program,
        config: {},
        readDeskHealth: async () => ({ hosted: false }),
        keyfilePresent: async () => false,
      });
      await run({ account: "ops@example.com" });
    } finally {
      logSpy.mockRestore();
    }
    expect(logs.join("\n")).not.toContain("Desk:");
  });
});
