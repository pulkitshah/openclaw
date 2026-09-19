// Telegram tests cover invalid allowFrom warning dedupe bounds.
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { warnMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  const createSubsystemLogger = () => {
    const logger = { warn: warnMock, child: () => logger };
    return logger as unknown as ReturnType<typeof actual.createSubsystemLogger>;
  };
  return { ...actual, createSubsystemLogger };
});

const WARN_CACHE_MAX = 256;
let normalizeAllowFrom: typeof import("./bot-access.js").normalizeAllowFrom;

function normalizeOutsideTestGuard(list: Array<string | number>) {
  return withEnv({ VITEST: undefined, NODE_ENV: "development" }, () => normalizeAllowFrom(list));
}

beforeEach(async () => {
  vi.resetModules();
  warnMock.mockReset();
  ({ normalizeAllowFrom } = await import("./bot-access.js"));
});

describe("normalizeAllowFrom invalid-entry warn dedupe", () => {
  it("warns once per invalid entry across repeated calls", () => {
    normalizeOutsideTestGuard(["@someone", "12345"]);
    normalizeOutsideTestGuard(["@someone"]);
    normalizeOutsideTestGuard(["@someone", "@other"]);

    expect(warnMock).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest warning while keeping recent duplicates suppressed", () => {
    for (let i = 0; i <= WARN_CACHE_MAX; i++) {
      normalizeOutsideTestGuard([`@user${i}`]);
    }
    expect(warnMock).toHaveBeenCalledTimes(WARN_CACHE_MAX + 1);

    normalizeOutsideTestGuard([`@user${WARN_CACHE_MAX}`]);
    expect(warnMock).toHaveBeenCalledTimes(WARN_CACHE_MAX + 1);

    normalizeOutsideTestGuard(["@user0"]);
    expect(warnMock).toHaveBeenCalledTimes(WARN_CACHE_MAX + 2);
  });

  it("does not change normalization or warn under the test guard", () => {
    expect(normalizeAllowFrom(["*", " tg:12345 ", "@someone"])).toEqual({
      entries: ["12345"],
      hasWildcard: true,
      hasEntries: true,
      invalidEntries: ["@someone"],
      accessGroupRefs: [],
    });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("treats an accessGroup reference as a configured allowlist, not an invalid sender id", () => {
    // It is neither a matchable Telegram user id nor a malformed one: the shared ingress resolver
    // owns its membership. Counting it as invalid warned operators about the one entry that makes
    // a Team roster work; counting it as absent would make a chat-listed group admit everyone.
    expect(normalizeAllowFrom(["accessGroup:team"])).toEqual({
      entries: [],
      hasWildcard: false,
      hasEntries: true,
      invalidEntries: [],
      accessGroupRefs: ["accessGroup:team"],
    });
    expect(normalizeOutsideTestGuard(["accessGroup:team"]).invalidEntries).toEqual([]);
    expect(warnMock).not.toHaveBeenCalled();
  });
});
