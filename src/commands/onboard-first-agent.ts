import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { loadAgentTeamPreset, validateAgentTeamMemberIds } from "../agents/agent-roles.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { type FirstOnboardingAgent, validateFirstOnboardingAgentName } from "./onboard-agent.js";

/** Longest owner name the roster and the prompts render without wrapping. */
const MAX_OWNER_NAME_LENGTH = 60;

export function validateOnboardingOwnerName(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (!name) {
    return "Your name is required.";
  }
  if (name.length > MAX_OWNER_NAME_LENGTH) {
    return `Use ${MAX_OWNER_NAME_LENGTH} characters or fewer.`;
  }
  return undefined;
}

/**
 * The first thing onboarding asks. This is the owner's own name — personalization for the desk's
 * roster, not a name for any agent: the coordinator is always Vasu, and members are people, not
 * agents. Returns `undefined` only when nothing can be asked (non-interactive), so the caller can
 * carry on and let the Team step collect it later.
 */
export async function promptOnboardingOwnerName(
  prompter: WizardPrompter,
  options: { nonInteractive?: boolean } = {},
): Promise<string | undefined> {
  if (options.nonInteractive) {
    return undefined;
  }
  const name = await prompter.text({
    message: "What's your name?",
    placeholder: "Vasu uses this to address you and to start your team roster",
    validate: validateOnboardingOwnerName,
  });
  // `validate` is what stops an interactive owner from skipping this. A prompter that answers with
  // nothing anyway is not an error here: the Team step asks again before it can create the owner
  // row, so the answer is still collected before it is needed.
  return name.trim() || undefined;
}

/**
 * The desk's agent shape is fixed: one coordinator (Vasu) plus the preset's specialists, created
 * through `agents team create`'s own path. There is no one-agent alternative to choose between, so
 * this resolves the coordinator id rather than prompting for it. `requestedName` is `--agent-name`,
 * which now only renames the coordinator.
 */
export async function resolveFirstOnboardingAgent(
  hasAuthoredRoster: boolean,
  requestedName?: string,
): Promise<FirstOnboardingAgent | undefined> {
  if (hasAuthoredRoster) {
    return undefined;
  }
  const teamPreset = await loadAgentTeamPreset();
  const name = requestedName ?? teamPreset.coordinator.id;
  const error =
    validateFirstOnboardingAgentName(name) ??
    validateAgentTeamMemberIds([
      normalizeAgentId(name),
      ...teamPreset.specialists.map(({ id }) => id),
    ]);
  if (error) {
    throw new Error(error);
  }
  return { name };
}

export async function showSessionMigrationWarnings(
  prompter: WizardPrompter,
  warnings: readonly string[] | undefined,
): Promise<void> {
  if (warnings?.length) {
    await prompter.note(warnings.join("\n"), "Session history migration");
  }
}
