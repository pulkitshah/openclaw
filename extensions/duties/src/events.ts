import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginService } from "../api.js";

type ServiceContext = Parameters<OpenClawPluginService["start"]>[0];
type GatewayEvents = NonNullable<ServiceContext["gatewayEvents"]>;
type Logger = ServiceContext["logger"];

type JsonPrimitive = string | number | boolean | null;
/** Structurally identical to the host's `PluginJsonValue` (`src/plugins/host-hook-json.ts`), so a
 * value narrowed to this type is assignable to `OpenClawPluginGatewayEvents.emit`'s payload
 * parameter without a cast. */
type BoundedJson = JsonPrimitive | BoundedJson[] | { [key: string]: BoundedJson };

function isBoundedJson(value: unknown): value is BoundedJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isBoundedJson);
  }
  if (typeof value !== "object") {
    return false;
  }
  return Object.values(value).every(isBoundedJson);
}

/**
 * Round-trips a payload through JSON so it can never carry an explicit `undefined` value (or a
 * function, symbol, etc.): the host's `isPluginJsonValue` (`src/plugins/host-hook-json.ts`)
 * rejects an object key whose value is `undefined` even when the key is present, which
 * `StepEvidence`'s optional `target`/`screenshotBlobId` fields do when a step has neither.
 * `JSON.stringify`/`JSON.parse` already guarantee JSON-shaped output; `isBoundedJson` then narrows
 * the result's type with a guard instead of a cast.
 */
function toBoundedJson(payload: Record<string, unknown>): BoundedJson | undefined {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON.stringify drops undefined-valued keys, which structuredClone would keep; the guard below relies on that.
  const roundTripped: unknown = JSON.parse(JSON.stringify(payload));
  return isBoundedJson(roundTripped) ? roundTripped : undefined;
}

/**
 * Duties Gateway-event service, wired the same way as Workboard's
 * `createWorkboardChangeEventService` (`extensions/workboard/src/change-events.ts`): it holds
 * `ctx.gatewayEvents` after `start` and forwards `emit(...)` calls into it, scoped to
 * `operator.read` so any operator-read client receives duty/run change notifications.
 *
 * `emit` never throws: a payload that cannot round-trip to bounded JSON, or a `gatewayEvents.emit`
 * call the host itself rejects (bounded-JSON validation, an unknown scope, a revoked plugin
 * lease, ...), is logged and dropped rather than propagated into a duty run or a Gateway method
 * handler.
 */
export function createDutiesEventService(): OpenClawPluginService & {
  emit(name: "changed" | "run", payload: Record<string, unknown>): void;
} {
  let gatewayEvents: GatewayEvents | undefined;
  let logger: Logger | undefined;

  return {
    id: "duties:events",
    start(ctx) {
      gatewayEvents = ctx.gatewayEvents;
      logger = ctx.logger;
    },
    stop() {
      gatewayEvents = undefined;
      logger = undefined;
    },
    emit(name, payload) {
      if (!gatewayEvents) {
        return;
      }
      try {
        const bounded = toBoundedJson(payload);
        if (bounded === undefined) {
          logger?.warn(`duties event "${name}" payload was not JSON-safe; dropped`);
          return;
        }
        gatewayEvents.emit(name, bounded, { scope: "operator.read" });
      } catch (error) {
        logger?.warn(`duties event "${name}" delivery failed: ${coerceErrorMessage(error)}`);
      }
    },
  };
}
