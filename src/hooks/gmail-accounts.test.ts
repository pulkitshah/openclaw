import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  gmailHookPathForAccount,
  GMAIL_DEFAULT_ACCOUNT_ID,
  isGmailHookPath,
  resolveGmailHookAccounts,
} from "./gmail-accounts.js";

function cfg(gmail: unknown): OpenClawConfig {
  // SAFETY: a hand-built config fixture is a partial OpenClawConfig by construction.
  return { hooks: { enabled: true, gmail } } as OpenClawConfig;
}

describe("resolveGmailHookAccounts", () => {
  it("treats the root keys as the default account, so one mailbox needs no migration", () => {
    expect(resolveGmailHookAccounts(cfg({ account: "you@example.com", label: "INBOX" }))).toEqual([
      { accountId: GMAIL_DEFAULT_ACCOUNT_ID, account: "you@example.com" },
    ]);
  });

  it("returns nothing when no address is configured anywhere", () => {
    expect(resolveGmailHookAccounts(cfg({ label: "INBOX" }))).toEqual([]);
  });

  it("lists named accounts, with the root as their shared defaults", () => {
    const accounts = resolveGmailHookAccounts(
      cfg({
        label: "INBOX",
        defaultAccount: "orders",
        accounts: {
          orders: { account: "orders@prasthan.in" },
          enquiries: { account: "enquiries@prasthan.in", label: "Enquiries" },
        },
      }),
    );
    expect(accounts).toEqual([
      { accountId: "enquiries", account: "enquiries@prasthan.in" },
      { accountId: "orders", account: "orders@prasthan.in" },
    ]);
  });

  it("never inherits an address sideways into a sibling account", () => {
    const accounts = resolveGmailHookAccounts(
      cfg({ account: "root@example.com", accounts: { orders: {} } }),
    );
    expect(accounts).toEqual([]);
  });

  it("refuses an account id that is not session-safe", () => {
    expect(() =>
      resolveGmailHookAccounts(cfg({ accounts: { "bad id": { account: "a@b.c" } } })),
    ).toThrow(/is not session-safe/);
  });
});

describe("gmail hook paths", () => {
  it("keeps the default account on the existing path and gives each other its own", () => {
    expect(gmailHookPathForAccount(GMAIL_DEFAULT_ACCOUNT_ID)).toBe("gmail");
    expect(gmailHookPathForAccount("enquiries")).toBe("gmail-enquiries");
  });

  it("recognises both shapes as gmail paths", () => {
    expect(isGmailHookPath("gmail")).toBe(true);
    expect(isGmailHookPath("gmail-enquiries")).toBe(true);
    expect(isGmailHookPath("github")).toBe(false);
    expect(isGmailHookPath(undefined)).toBe(false);
  });
});
