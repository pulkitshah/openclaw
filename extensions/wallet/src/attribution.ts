import type { Activity } from "./store.js";

export type Attribution = { activity: Activity; ref: string; label: string };
export type AttributionInput = {
  sessionKey?: string;
  agentId?: string;
  trigger?: string;
  attribution?: { kind: string; ref: string; label: string };
  jobName?: string;
};
export type AttributionLookups = {
  memberName: (rosterId: string) => Promise<string | undefined>;
  groupName: (sessionKey: string) => Promise<string | undefined>;
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
  if (input.trigger === "history") {
    return { activity: "system", ref: "history", label: "System — history" };
  }
  if (input.trigger === "cron") {
    const name = input.jobName ?? "cron";
    return { activity: "system", ref: `cron:${name}`, label: `System — ${name}` };
  }
  const key = input.sessionKey;
  if (!key) {
    // No session: a plugin-runtime completion (rule 3, internal), booked to the agent that ran it.
    const agent = input.agentId ?? "unknown";
    return { activity: "system", ref: `agent:${agent}`, label: `System — ${agent}` };
  }
  const direct = DIRECT_SESSION.exec(key);
  if (direct?.[1]) {
    const name = await lookups.memberName(direct[1]);
    return { activity: "chat", ref: key, label: `Chat — ${name ?? direct[1]}` };
  }
  if (key.includes(":group:")) {
    const name = await lookups.groupName(key);
    return { activity: "chat", ref: key, label: `Chat — ${name ?? key}` };
  }
  return { activity: "chat", ref: key, label: `Chat — ${key}` };
}
