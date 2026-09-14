/**
 * `openclaw duties setup --account <email>` — prints every prerequisite a Duty needs before it can
 * work end to end: the config an operator pastes in for mail dispatch (the `duties-mail` agent with
 * the ownership and bindings that adding a second agent forces, and the `hooks` block with the
 * Gmail mapping and the session-key settings that mapping needs), the shell commands that wire the
 * rest up, and the browser allowlist entry without which every `template` step fails.
 *
 * `buildDutiesSetup` is pure and tested on its own; the Commander action below is the only piece
 * that touches the filesystem (a `which gog` lookup) or prints anything.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { MAIL_AGENT_ID, mailStatusFromConfig } from "./mail.js";
import { RENDER_ALLOWLIST_KEY, RENDER_LOOPBACK_HOST, renderStatusFromConfig } from "./setup.js";

const execFileAsync = promisify(execFile);

/** Config facts `buildDutiesSetup` needs — the CLI reads these off `mailStatusFromConfig` and
 *  `renderStatusFromConfig`, plus the raw `hooks.gmail.account` value (which the status readout
 *  deliberately never repeats). */
export type SetupConfigFacts = {
  hooksEnabled: boolean;
  gmailAccount?: string;
  mappingPresent: boolean;
  agentPresent: boolean;
  /** Whether the managed browser may open the loopback render page (`setup.ts`). */
  renderAllowed?: boolean;
};

export type SetupResult = {
  snippets: { agentEntry: string; hookMapping: string; renderAllowlist: string };
  commands: string[];
  missing: string[];
};

/** The bundled tool every `ai` step runs through. A Duty's `ai` steps are dead without it, and
 *  nothing else in an install turns it on, so it is wired up here rather than left to be
 *  discovered one failed run at a time. */
const LLM_TASK_TOOL = "llm-task";

/** The exact config block an operator pastes in: a minimal-profile dispatcher agent that can only
 *  list/get/run Duties, message the owner, run an `ai` step, and shell out to `gog` — never the
 *  browser, filesystem, web, cron, gateway, or node tools a mail-triggered dispatch has no business
 *  touching.
 *
 *  Adding that agent makes the install multi-agent, and the rest of the block is what that forces:
 *  with a second agent present and no explicit owner, every channel turn, every session key that is
 *  not agent-scoped, and every ambient call (which is how an `ai` step reaches a model) resolves to
 *  no agent at all (`AgentSelectionRequiredError`, src/agents/agent-scope-config.ts:42-59) — so
 *  `agents.ownership`, `agents.defaults.systemAgent` and `bindings` ship alongside it. Pasting the
 *  agent without them takes the operator's existing channels down and fails every `ai` step.
 *  `comment` is part of the binding schema (`RouteBindingSchema`,
 *  src/config/zod-schema.agents.ts:118-125), so the note travels with the config the operator
 *  pastes rather than being lost with the terminal scrollback. */
const AGENT_ENTRY_SNIPPET = {
  agents: {
    ownership: "explicit",
    defaults: {
      systemAgent: {
        agentId: "<your-main-agent-id>",
      },
    },
    entries: {
      [MAIL_AGENT_ID]: {
        name: "Duties mail dispatcher",
        skills: ["duties"],
        tools: {
          profile: "minimal",
          allow: ["duty_list", "duty_get", "duty_run", "message", "exec", LLM_TASK_TOOL],
          deny: ["browser", "group:fs", "group:web", "cron", "gateway", "nodes"],
        },
      },
    },
  },
  bindings: [
    {
      agentId: "<your-main-agent-id>",
      comment:
        "Required: one binding per enabled channel once a second agent exists. Without it that channel has no explicit owner and stops answering. Repeat this entry per channel.",
      match: { channel: "telegram", accountId: "*" },
    },
  ],
  plugins: { entries: { [LLM_TASK_TOOL]: { enabled: true } } },
  tools: { alsoAllow: [LLM_TASK_TOOL] },
};

/** The exact `hooks` block that routes every inbound Gmail message to the dispatcher agent above,
 *  one message at a time, without auto-delivering the agent's reply back to Gmail.
 *
 *  The four session-key/agent keys are not optional hardening: the mapping asks for a per-message
 *  `sessionKey`, so the hook receiver needs `allowRequestSessionKey` plus a prefix allowlist that
 *  covers it, `defaultSessionKey` for a delivery that names none, and `allowedAgentIds` so only
 *  the dispatcher can be woken this way. Without them an inbound message is rejected before it
 *  ever reaches the dispatcher. */
const HOOK_MAPPING_SNIPPET = {
  hooks: {
    enabled: true,
    defaultSessionKey: "hook:gmail:ingress",
    allowRequestSessionKey: true,
    allowedSessionKeyPrefixes: ["hook:gmail:"],
    allowedAgentIds: [MAIL_AGENT_ID],
    mappings: [
      {
        id: MAIL_AGENT_ID,
        match: { path: "gmail" },
        action: "agent",
        agentId: MAIL_AGENT_ID,
        wakeMode: "now",
        name: "Duties mail",
        forEach: "messages",
        deliver: false,
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate:
          "From: {{messages[0].from}}\nSubject: {{messages[0].subject}}\nMessage-Id: {{messages[0].id}}\n\n{{messages[0].snippet}}\n{{messages[0].body}}\n\nDispatch this mail to the matching Duty; see the duties skill.",
      },
    ],
  },
};

/** The one config line that lets a `template` step render at all. Kept next to the other two
 *  snippets so setup prints one pasteable block per prerequisite. */
const RENDER_ALLOWLIST_SNIPPET = {
  browser: { ssrfPolicy: { allowedHostnames: [RENDER_LOOPBACK_HOST] } },
};

/** Pure: given the account being wired up, whether `gog` was found on PATH, and the current
 *  config facts, returns what's missing, the shell commands to run, and the config snippets
 *  to paste in. Never reads the filesystem or config itself — the CLI action below gathers both
 *  and passes them in. */
export function buildDutiesSetup(params: {
  account: string;
  gogPath?: string;
  config: SetupConfigFacts;
}): SetupResult {
  const { account, gogPath, config } = params;
  const missing: string[] = [];
  const commands: string[] = [];

  if (!gogPath) {
    missing.push(`gog CLI not found on PATH — install gogcli and run: gog auth add ${account}`);
  }
  if (!config.hooksEnabled) {
    missing.push("hooks are not enabled (hooks.enabled)");
  }
  if (!config.gmailAccount) {
    missing.push("no Gmail account is configured for hooks (hooks.gmail.account)");
  } else if (config.gmailAccount !== account) {
    missing.push(
      `hooks.gmail.account is set to "${config.gmailAccount}", not "${account}" (hooks.gmail.account)`,
    );
  }
  if (!config.mappingPresent) {
    missing.push(`no hook mapping routes Gmail to the ${MAIL_AGENT_ID} agent (hooks.mappings)`);
  }
  if (!config.agentPresent) {
    missing.push(`no agent entry named "${MAIL_AGENT_ID}" (agents.entries)`);
  }
  if (config.renderAllowed === false) {
    // Rendering is the other half of Part 2: without this, every `template` step and every
    // preview fails at the browser's navigation guard with no next action.
    missing.push(
      `the managed browser may not open the render page — add "${RENDER_LOOPBACK_HOST}" to ${RENDER_ALLOWLIST_KEY}`,
    );
  }

  if (!config.gmailAccount || config.gmailAccount !== account || !config.mappingPresent) {
    commands.push(`openclaw webhooks gmail setup --account ${account}`);
  }
  // The allowlist command is always offered — there's no config fact that tells us whether this
  // exact gog binary is already exec-approved for the dispatcher agent, and re-running it is a
  // no-op when it already is.
  commands.push(
    `openclaw approvals allowlist add --agent ${MAIL_AGENT_ID} ${gogPath ?? "<path-to-gog>"}`,
  );

  return {
    snippets: {
      agentEntry: JSON.stringify(AGENT_ENTRY_SNIPPET, null, 2),
      hookMapping: JSON.stringify(HOOK_MAPPING_SNIPPET, null, 2),
      renderAllowlist: JSON.stringify(RENDER_ALLOWLIST_SNIPPET, null, 2),
    },
    commands,
    missing,
  };
}

/** Best-effort `which gog`: absent PATH entry, no gogcli install, or a `which` that itself fails
 *  are all just "not found" here — never a reason for the setup command itself to fail. */
async function findGogPath(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("which", ["gog"]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function printDutiesSetup(params: {
  account: string;
  config: SetupConfigFacts;
  result: SetupResult;
}): void {
  const { account, config, result } = params;
  console.log(`Duties setup for ${account}`);
  console.log("");
  console.log("Already in place:");
  console.log(`  hooks enabled: ${config.hooksEnabled ? "yes" : "no"}`);
  console.log(`  Gmail account configured: ${config.gmailAccount ? "yes" : "no"}`);
  console.log(`  hook mapping to ${MAIL_AGENT_ID}: ${config.mappingPresent ? "yes" : "no"}`);
  console.log(`  agent entry ${MAIL_AGENT_ID}: ${config.agentPresent ? "yes" : "no"}`);
  console.log(
    `  rendering allowed (${RENDER_ALLOWLIST_KEY}): ${config.renderAllowed ? "yes" : "no"}`,
  );
  console.log("");
  if (result.missing.length > 0) {
    console.log("Missing:");
    for (const item of result.missing) console.log(`  - ${item}`);
    console.log("");
  }
  console.log(
    `Agent config — merge into agents, bindings, plugins and tools (the ${MAIL_AGENT_ID} entry needs every other key here):`,
  );
  console.log(result.snippets.agentEntry);
  console.log("");
  console.log("Hook mapping — merge into hooks (settings and mappings) if missing:");
  console.log(result.snippets.hookMapping);
  console.log("");
  console.log(
    "Rendering — merge into browser; without it every template step and preview fails at the browser's navigation guard:",
  );
  console.log(result.snippets.renderAllowlist);
  console.log("");
  console.log("Commands:");
  for (const command of result.commands) console.log(`  ${command}`);
  console.log("");
  console.log("Then restart the Gateway.");
}

export function registerDutiesSetupCli(params: { program: Command; config: OpenClawConfig }): void {
  const { program, config } = params;
  const duties = program.command("duties").description("Duties setup");
  duties
    .command("setup")
    // `setup-mail` was the name while mail was the only prerequisite; it is kept so the command
    // printed in existing notes and transcripts still works.
    .alias("setup-mail")
    .description("Print every prerequisite a Duty needs: Gmail dispatch and document rendering")
    .requiredOption("--account <email>", "Gmail account gogcli is authenticated as")
    .action(async (options: { account: string }) => {
      const gogPath = await findGogPath();
      const status = mailStatusFromConfig(config, {});
      const configFacts: SetupConfigFacts = {
        hooksEnabled: status.hooksEnabled,
        ...(config.hooks?.gmail?.account ? { gmailAccount: config.hooks.gmail.account } : {}),
        mappingPresent: status.mappingPresent,
        agentPresent: status.agentPresent,
        renderAllowed: renderStatusFromConfig(config).renderAllowed,
      };
      const result = buildDutiesSetup({ account: options.account, gogPath, config: configFacts });
      printDutiesSetup({ account: options.account, config: configFacts, result });
    });
}
