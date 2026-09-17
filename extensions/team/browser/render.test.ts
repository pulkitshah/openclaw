import { describe, expect, it } from "vitest";
import { teamPanel } from "./render.js";

const teamView = {
  members: [
    {
      id: "owner",
      name: "Pulkit",
      role: "owner" as const,
      addedBy: "owner",
      addedAt: 1,
      updatedAt: 1,
      channels: [
        { channel: "telegram", senderId: "111", addedAt: 1 },
        { channel: "whatsapp", senderId: "+919800000000", addedAt: 1 },
      ],
    },
    {
      id: "ramesh",
      name: "Ramesh",
      role: "member" as const,
      addedBy: "owner",
      addedAt: 2,
      updatedAt: 2,
      channels: [{ channel: "whatsapp", senderId: "+919812345678", addedAt: 2 }],
    },
  ],
};

describe("teamPanel", () => {
  it("lists each person with their role and channels", () => {
    const html = teamPanel(teamView, true);
    expect(html).toContain("Pulkit");
    expect(html).toContain("Owner");
    expect(html).toContain("telegram");
    expect(html).toContain("whatsapp");
    expect(html).toContain("Ramesh");
  });

  it("offers Make owner and Remove on a member row, never on the owner's", () => {
    const html = teamPanel(teamView, true);
    expect(html).toContain('data-team-transfer="ramesh"');
    expect(html).toContain('data-team-remove="ramesh"');
    expect(html).not.toContain('data-team-transfer="owner"');
    expect(html).not.toContain('data-team-remove="owner"');
  });

  it("offers add-a-channel on every row, including the owner's", () => {
    const html = teamPanel(teamView, true);
    expect(html).toContain('data-team-channel-add="owner"');
    expect(html).toContain('data-team-channel-add="ramesh"');
    expect(html).toContain('data-team-row-sender="ramesh"');
  });

  it("shows no mutating control at all without admin scope", () => {
    const html = teamPanel(teamView, false);
    expect(html).toContain("Ramesh");
    expect(html).not.toContain("data-team-add");
    expect(html).not.toContain("data-team-remove");
    expect(html).not.toContain("data-team-transfer");
    expect(html).not.toContain("data-team-channel-add");
  });

  it("never renders a raw sender id without admin scope", () => {
    const html = teamPanel(teamView, false);
    expect(html).not.toContain("+919812345678");
    expect(html).toContain("whatsapp");
  });

  it("falls back to the owner prompt when the roster is empty", () => {
    const html = teamPanel({ members: [] }, true);
    expect(html).toContain("Tell Vasu where to reach you");
    expect(html).toContain("data-settings-channel");
    expect(html).toContain("data-settings-target");
  });

  it("surfaces a projection warning verbatim", () => {
    const html = teamPanel(
      {
        ...teamView,
        warnings: [
          'whatsapp is set to dmPolicy "open", so anyone can instruct Vasu there — Team does not restrict it.',
        ],
      },
      true,
    );
    expect(html).toContain("dmPolicy &quot;open&quot;");
  });

  it("escapes a name that contains markup", () => {
    const html = teamPanel(
      { members: [{ ...teamView.members[1]!, name: "<img src=x onerror=1>" }] },
      true,
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("shows a retryable error banner", () => {
    const html = teamPanel(teamView, true, {
      error: "Enter a name, a channel and their id on that channel.",
    });
    expect(html).toContain("Enter a name, a channel and their id on that channel.");
    expect(html).toContain("data-retry");
    expect(html).toContain("Pulkit");
  });
});
