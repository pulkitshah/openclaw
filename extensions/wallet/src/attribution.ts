import type { Activity } from "./store.js";

export type Attribution = { activity: Activity; ref: string; label: string };
export type AttributionInput = {
  sessionKey?: string;
  agentId?: string;
  trigger?: string;
  attribution?: { kind: string; ref: string; label: string };
  /** The cron job that ran this turn; its name is looked up so the statement never shows an id. */
  jobId?: string;
};
export type AttributionLookups = {
  /** Roster name for a direct chat's member id. */
  memberName: (rosterId: string) => Promise<string | undefined>;
  /** The host's own name for a session (group subject, saved contact name) when the roster has none. */
  sessionName: (sessionKey: string) => Promise<string | undefined>;
  /** Cron job name for a job id. */
  jobName: (jobId: string) => Promise<string | undefined>;
  mailAgentIds: () => string[];
};

const ACTIVITIES: readonly Activity[] = [
  "chat",
  "duty",
  "mail",
  "system",
  "hosting",
  "integration",
];
const DIRECT_SESSION = /^agent:[^:]+:(?:[^:]+:)?(?:direct|dm):(.+)$/;
/** The host's own non-conversational sessions: setup inference, incognito probes, model checks. */
const HOST_SESSION = /:(?:setup-inference|incognito-probe|probe)[:-]/;

/** Decides which activity a model call belongs to; never drops a call. */
export async function attribute(
  input: AttributionInput,
  lookups: AttributionLookups,
): Promise<Attribution> {
  const explicit = input.attribution;
  const explicitActivity = ACTIVITIES.find((a) => a === explicit?.kind);
  if (explicit && explicitActivity) {
    return { activity: explicitActivity, ref: explicit.ref, label: explicit.label };
  }
  if (input.agentId && lookups.mailAgentIds().includes(input.agentId)) {
    return { activity: "mail", ref: input.agentId, label: `Mail — ${input.agentId}` };
  }
  if (input.trigger === "heartbeat") {
    return { activity: "system", ref: "heartbeat", label: "System — heartbeat" };
  }
  if (input.trigger === "cron" || input.jobId) {
    // The ref keeps the id (stable across renames); the label is what the owner reads.
    const id = input.jobId ?? "cron";
    const name = input.jobId ? await lookups.jobName(input.jobId) : undefined;
    return { activity: "system", ref: `cron:${id}`, label: `System — ${name ?? id}` };
  }
  const key = input.sessionKey;
  if (!key) {
    // No session: a plugin-runtime completion (rule 3, internal), booked to the agent that ran it.
    const agent = input.agentId ?? "unknown";
    return { activity: "system", ref: `agent:${agent}`, label: `System — ${agent}` };
  }
  if (HOST_SESSION.test(key)) {
    return { activity: "system", ref: key, label: "System — host setup check" };
  }
  const direct = DIRECT_SESSION.exec(key);
  if (direct?.[1]) {
    const name = (await lookups.memberName(direct[1])) ?? (await lookups.sessionName(key));
    return { activity: "chat", ref: key, label: `Chat — ${name ?? direct[1]}` };
  }
  const name = await lookups.sessionName(key);
  return { activity: "chat", ref: key, label: `Chat — ${name ?? key}` };
}
