// Onboarding's mandatory "who are you, and who else is on your team" step.
//
// This owns no roster state of its own. Every write here is Team's own `team.owner.set` /
// `team.add` Gateway method — the same two calls the Team Control UI page makes — so the pairing
// approval `team.add` folds in, its authority checks, and its config projection all apply
// unchanged. A separate onboarding-only member-adding path would have none of that.
import {
  hasMeaningfulChannelConfigShallow,
  resolveChannelConfigRecord,
} from "../config/channel-configured-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/** One in-process or over-the-wire Gateway call. Injected so the step can be exercised without a
 *  live Gateway; production passes the `callGateway`-backed request built by its caller. */
export type TeamOnboardingRequest = <T>(
  method: string,
  params: Record<string, unknown>,
) => Promise<T>;

type TeamMemberView = {
  id: string;
  name: string;
  role: "owner" | "member";
  channels: Array<{ channel: string; senderId?: string; accountId?: string }>;
};

type PendingRequestView = {
  channel: string;
  channelLabel?: string;
  accountId?: string;
  senderId: string;
  metadata?: Record<string, string>;
};

export type TeamOnboardingOutcome =
  /** At least one member is on the roster; onboarding may report done. */
  | { status: "complete"; memberCount: number }
  /** The step could not finish. `reason` is what the owner is told, and what still has to happen. */
  | { status: "incomplete"; reason: string };

/** Channels a person can actually be reached on, matching the Team page's own list. */
const TEAM_CHANNELS = ["discord", "signal", "slack", "telegram", "whatsapp"] as const;

const TEAM_PAGE_HINT =
  "Open the Team tab in the Vasudev dashboard to tell Vasu who you are and add your team.";

/** Whatever the channel knows the waiting person as, falling back to their raw id. */
function pendingName(request: PendingRequestView): string {
  const meta = request.metadata ?? {};
  return (
    [meta.firstName, meta.lastName].filter(Boolean).join(" ").trim() ||
    meta.username?.trim() ||
    request.senderId
  );
}

function pendingLabel(request: PendingRequestView): string {
  const name = pendingName(request);
  const who = name === request.senderId ? request.senderId : `${name} (${request.senderId})`;
  return `${who} — ${request.channelLabel || request.channel}`;
}

/** Channels this desk has written config for. Reading the config directly (rather than the
 *  registry-backed `isChannelConfigured`) keeps the wizard off the bundled channel plugin probes:
 *  onboarding runs this immediately after writing that config, so the file is the live answer. */
function configuredTeamChannels(config: OpenClawConfig): string[] {
  return TEAM_CHANNELS.filter((channel) =>
    hasMeaningfulChannelConfigShallow(resolveChannelConfigRecord(config, channel)),
  );
}

/**
 * Runs after the owner's first channel is connected: makes sure the roster has an owner row, then
 * loops until at least one other person is on the team. Onboarding is not done until it returns
 * `complete` — a desk whose only member is the owner has nobody to delegate to and nobody to answer
 * a Duty's question.
 */
export async function runTeamOnboardingStep(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  request: TeamOnboardingRequest;
  /** The owner's own name, captured at the top of onboarding. Asked for here when absent. */
  ownerName?: string;
  /** Automated runs cannot answer prompts; they finish with the remaining work named. */
  nonInteractive?: boolean;
}): Promise<TeamOnboardingOutcome> {
  const { config, prompter, request } = params;
  const channels = configuredTeamChannels(config);
  if (channels.length === 0) {
    return {
      status: "incomplete",
      reason: `No channel is connected yet, so there is nowhere to reach your team. Connect a channel, then add your first teammate. ${TEAM_PAGE_HINT}`,
    };
  }

  let members: TeamMemberView[];
  try {
    ({ members } = await request<{ members: TeamMemberView[] }>("team.get", {}));
  } catch (error) {
    return {
      status: "incomplete",
      reason: `Vasu's team roster could not be read (${formatErrorMessage(error)}). ${TEAM_PAGE_HINT}`,
    };
  }

  if (params.nonInteractive) {
    const memberCount = members.filter((member) => member.role === "member").length;
    return memberCount > 0
      ? { status: "complete", memberCount }
      : {
          status: "incomplete",
          reason: `Nobody is on your team yet. ${TEAM_PAGE_HINT}`,
        };
  }

  const pickChannel = async (message: string): Promise<string> =>
    channels.length === 1
      ? channels[0]!
      : await prompter.select<string>({
          message,
          options: channels.map((channel) => ({ value: channel, label: channel })),
          initialValue: channels[0],
        });

  if (!members.some((member) => member.role === "owner")) {
    const ownerName =
      params.ownerName?.trim() ||
      (
        await prompter.text({
          message: "What's your name?",
          validate: (value) => (value.trim() ? undefined : "Your name is required."),
        })
      ).trim();
    const channel = await pickChannel("Which channel do you message Vasu from?");
    const target = await prompter.text({
      message: `Your id on ${channel} (phone number, @handle, or chat id)`,
      validate: (value) => (value.trim() ? undefined : "Enter the id Vasu will see you as."),
    });
    try {
      await request("team.owner.set", { channel, target: target.trim(), name: ownerName });
    } catch (error) {
      return {
        status: "incomplete",
        reason: `Vasu could not record you as the owner (${formatErrorMessage(error)}). ${TEAM_PAGE_HINT}`,
      };
    }
    await prompter.note(
      `${ownerName} is the owner of this desk, reachable on ${channel}.`,
      "Your team",
    );
  }

  let memberCount = members.filter((member) => member.role === "member").length;
  for (;;) {
    if (memberCount > 0) {
      const another = await prompter.confirm({
        message: "Add another teammate?",
        initialValue: false,
      });
      if (!another) {
        return { status: "complete", memberCount };
      }
    }

    // Anyone who already wrote in is waiting in the channel's own pairing store. Offering them by
    // name is the difference between one keystroke and the owner recalling a phone number, and
    // `team.add` approves the matching request as part of the same call.
    const pending = await request<{ requests?: PendingRequestView[] }>("channels.pairing.list", {})
      .then((listed) => (listed.requests ?? []).filter((entry) => entry.channel && entry.senderId))
      // Pending requests are a convenience; typing someone in still works without them.
      .catch((): PendingRequestView[] => []);

    const MANUAL = "__manual__";
    const choice =
      pending.length > 0
        ? await prompter.select<string>({
            message:
              memberCount > 0
                ? "Who else should be able to talk to Vasu?"
                : "Who else should be able to talk to Vasu? Add at least one person to finish setup.",
            options: [
              ...pending.map((entry, index) => ({
                value: String(index),
                label: pendingLabel(entry),
                hint: "waiting to be added",
              })),
              { value: MANUAL, label: "Someone else" },
            ],
            initialValue: "0",
          })
        : MANUAL;

    let addParams: Record<string, unknown>;
    if (choice === MANUAL) {
      const name = await prompter.text({
        message: "Their name",
        validate: (value) => (value.trim() ? undefined : "A name is required."),
      });
      const channel = await pickChannel(`Which channel does ${name.trim()} use?`);
      const senderId = await prompter.text({
        message: `${name.trim()}'s id on ${channel} (phone number, @handle, or chat id)`,
        validate: (value) => (value.trim() ? undefined : "An id on that channel is required."),
      });
      addParams = { name: name.trim(), channels: [{ channel, senderId: senderId.trim() }] };
    } else {
      const entry = pending[Number(choice)]!;
      addParams = {
        name: pendingName(entry),
        channels: [
          {
            channel: entry.channel,
            senderId: entry.senderId,
            ...(entry.accountId ? { accountId: entry.accountId } : {}),
          },
        ],
      };
    }

    try {
      const added = await request<{ member?: { name?: string } }>("team.add", addParams);
      memberCount += 1;
      await prompter.note(
        `${added.member?.name ?? String(addParams.name)} can now talk to Vasu.`,
        "Your team",
      );
    } catch (error) {
      // Team's own refusal carries the fix (a name collision, a channel that would be narrowed, a
      // lost pairing request). Show it and let the owner try again rather than ending setup here.
      await prompter.note(formatErrorMessage(error), "That did not work");
      if (memberCount === 0) {
        const retry = await prompter.confirm({
          message:
            "Try adding someone again? Setup is not finished until one person is on the team.",
          initialValue: true,
        });
        if (!retry) {
          return {
            status: "incomplete",
            reason: `Nobody is on your team yet. ${TEAM_PAGE_HINT}`,
          };
        }
      }
    }
  }
}
