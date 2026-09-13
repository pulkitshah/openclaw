import type { OpenClawPluginService } from "../api.js";

type GatewayEvents = NonNullable<Parameters<OpenClawPluginService["start"]>[0]["gatewayEvents"]>;

/**
 * Duties Gateway-event service, wired the same way as Workboard's
 * `createWorkboardChangeEventService` (`extensions/workboard/src/change-events.ts`): it holds
 * `ctx.gatewayEvents` after `start` and forwards `emit(...)` calls into it, scoped to
 * `operator.read` so any operator-read client receives duty/run change notifications.
 */
export function createDutiesEventService(): OpenClawPluginService & {
  emit(name: "changed" | "run", payload: Record<string, unknown>): void;
} {
  let gatewayEvents: GatewayEvents | undefined;

  return {
    id: "duties:events",
    start(ctx) {
      gatewayEvents = ctx.gatewayEvents;
    },
    stop() {
      gatewayEvents = undefined;
    },
    emit(name, payload) {
      // SAFETY: every duties event payload (dutyId strings, RunEvent fields) is built from JSON-safe primitives in gateway-methods.ts/run-service.ts, so it satisfies PluginJsonValue even though Record<string, unknown>'s index signature does not statically prove it.
      gatewayEvents?.emit(name, payload as never, { scope: "operator.read" });
    },
  };
}
