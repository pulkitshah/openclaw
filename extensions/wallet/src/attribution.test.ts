import { describe, expect, it } from "vitest";
import { attribute } from "./attribution.js";

const lookups = {
  memberName: async (id: string) => (id === "asha" ? "Asha" : undefined),
  groupName: async () => "Ops group",
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
        { trigger: "cron", jobName: "daily-digest", sessionKey: "agent:main:cron:x" },
        lookups,
      ),
    ).toEqual({ activity: "system", ref: "cron:daily-digest", label: "System — daily-digest" });
    expect(await attribute({ trigger: "history" }, lookups)).toEqual({
      activity: "system",
      ref: "history",
      label: "System — history",
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
    expect(await attribute({}, lookups)).toEqual({
      activity: "chat",
      ref: "unknown",
      label: "Chat — unknown",
    });
  });
});
