import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginService } from "../api.js";

type ServiceContext = Parameters<OpenClawPluginService["start"]>[0];
type GatewayEvents = NonNullable<ServiceContext["gatewayEvents"]>;
type Logger = ServiceContext["logger"];

type JsonPrimitive = string | number | boolean | null;
/** Structurally identical to the host's `PluginJsonValue` (`src/plugins/host-hook-json.ts`), so a
 *  value narrowed to this type is assignable to `OpenClawPluginGatewayEvents.emit`'s payload
 *  parameter without a cast. Duplicated from `extensions/duties/src/events.ts` rather than shared:
 *  browser/server modules never import across the plugin boundary in this codebase. */
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

function toBoundedJson(payload: Record<string, unknown>): BoundedJson | undefined {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON.stringify drops undefined-valued keys, which structuredClone would keep; the guard below relies on that.
  const roundTripped: unknown = JSON.parse(JSON.stringify(payload));
  return isBoundedJson(roundTripped) ? roundTripped : undefined;
}

/**
 * Team's Gateway-event service, the same shape as `extensions/duties/src/events.ts`'s
 * `createDutiesEventService`: it holds `ctx.gatewayEvents` after `start` and forwards `emit(...)`
 * calls into it, scoped to `operator.read` so any operator-read client (the Team page included)
 * receives roster-change notifications as `plugin.team.changed`.
 */
export function createTeamEventService(): OpenClawPluginService & {
  emit(name: "changed", payload: Record<string, unknown>): void;
} {
  let gatewayEvents: GatewayEvents | undefined;
  let logger: Logger | undefined;

  return {
    id: "team:events",
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
          logger?.warn(`team event "${name}" payload was not JSON-safe; dropped`);
          return;
        }
        gatewayEvents.emit(name, bounded, { scope: "operator.read" });
      } catch (error) {
        logger?.warn(`team event "${name}" delivery failed: ${coerceErrorMessage(error)}`);
      }
    },
  };
}
