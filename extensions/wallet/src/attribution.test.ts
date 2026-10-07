import { describe, expect, it } from "vitest";
import { attribute } from "./attribution.js";

const lookups = {
  memberName: async (id: string) => (id === "asha" ? "Asha" : undefined),
  sessionName: async (key: string) =>
    key.includes(":group:") ? "Ops group" : key.endsWith(":+919205077716") ? "sumit" : undefined,
  jobName: async (id: string) => (id === "job-1" ? "daily-digest" : undefined),
  mailAgentIds: () => ["duties-mail"],
};

describe("attribute", () => {
  it("uses an explicit attribution first", async () => {
    expect(
      await attribute(
        {
          sessionKey: "agent:main:direct:asha",
          attribution: { kind: "duty", ref: "run-1", label: "Book flight — Asha" },
        },
        lookups,
      ),
    ).toEqual({ activity: "duty", ref: "run-1", label: "Book flight — Asha" });
  });
  it("maps the mail dispatcher agent to Mail", async () => {
    expect(
      await attribute(
        { agentId: "duties-mail", sessionKey: "agent:duties-mail:cron:abc" },
        lookups,
      ),
    ).toEqual({ activity: "mail", ref: "duties-mail", label: "Mail — duties-mail" });
  });
  it("maps heartbeat, cron and history triggers to System", async () => {
    expect(
      await attribute({ trigger: "heartbeat", sessionKey: "agent:main:main" }, lookups),
    ).toEqual({
      activity: "system",
      ref: "heartbeat",
      label: "System — heartbeat",
    });
    expect(
      await attribute(
        { trigger: "cron", jobId: "job-1", sessionKey: "agent:main:cron:job-1:run:x" },
        lookups,
      ),
    ).toEqual({ activity: "system", ref: "cron:job-1", label: "System — daily-digest" });
    // An unknown job keeps its id as the label rather than dropping the call.
    expect(await attribute({ trigger: "cron", jobId: "job-9" }, lookups)).toEqual({
      activity: "system",
      ref: "cron:job-9",
      label: "System — job-9",
    });
    // The host's own setup probes are system work, not a chat.
    expect(
      await attribute(
        { sessionKey: "agent:main:setup-inference:incognito-probe-setup-inference-1" },
        lookups,
      ),
    ).toEqual({
      activity: "system",
      ref: "agent:main:setup-inference:incognito-probe-setup-inference-1",
      label: "System — host setup check",
    });
    // A direct chat with no roster entry takes the host's saved name for the session.
    expect(await attribute({ sessionKey: "agent:main:direct:+919205077716" }, lookups)).toEqual({
      activity: "chat",
      ref: "agent:main:direct:+919205077716",
      label: "Chat — sumit",
    });
  });
  it("names member and group sessions, and never drops an unknown one", async () => {
    expect(
      await attribute({ sessionKey: "agent:main:direct:asha", trigger: "user" }, lookups),
    ).toEqual({
      activity: "chat",
      ref: "agent:main:direct:asha",
      label: "Chat — Asha",
    });
    expect(await attribute({ sessionKey: "agent:main:whatsapp:group:123@g.us" }, lookups)).toEqual({
      activity: "chat",
      ref: "agent:main:whatsapp:group:123@g.us",
      label: "Chat — Ops group",
    });
    expect(await attribute({ sessionKey: "agent:main:dashboard:0f9d" }, lookups)).toEqual({
      activity: "chat",
      ref: "agent:main:dashboard:0f9d",
      label: "Chat — agent:main:dashboard:0f9d",
    });
  });
  it("books a sessionless plugin-runtime call to System under its agent", async () => {
    expect(await attribute({ agentId: "krishna" }, lookups)).toEqual({
      activity: "system",
      ref: "agent:krishna",
      label: "System — krishna",
    });
    expect(await attribute({}, lookups)).toEqual({
      activity: "system",
      ref: "agent:unknown",
      label: "System — unknown",
    });
  });
});
