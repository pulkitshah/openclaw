/**
 * Shared test support for the ai/ask/browser adapters' `Request` parameter
 * (`type Request = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;`,
 * declared privately and identically in ai.ts/ask.ts/browser.ts). Structurally reproduced here so
 * tests can name it without crossing into those files' internals.
 */
export type Request = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;

/**
 * Casts a concrete-returning `vi.fn` request mock to the adapter's generic `Request` type.
 * `Request`'s `<T>` lets each production call site request whatever shape it expects back with
 * no runtime check; a mock built from a fixed-shape implementation returns the same object
 * regardless of the caller's `T`, which is exactly what every fixture in this suite does, so this
 * only names in the type system a contract the mock already satisfies at runtime. The mock keeps
 * its own concrete, param-typed signature everywhere else (`.mock.calls`, `.mockClear()`, ...) —
 * only the value handed to `createAiAdapter`/`createAskAdapter`/`createBrowserAdapter` needs to be
 * told it also satisfies `Request`.
 */
export function asRequest(mock: (...args: never[]) => unknown): Request {
  // SAFETY: `mock` is always one of this suite's `vi.fn(...)` request fixtures, driven only by
  // the adapter under test with the same method/params shapes the fixture was written against.
  return mock as Request;
}
