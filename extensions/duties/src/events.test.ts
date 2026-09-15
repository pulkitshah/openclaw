import { describe, expect, it, vi } from "vitest";
import { createDutiesEventService } from "./events.js";
import type { RunEvent } from "./run-service.js";

/** Mirrors the host's rejection of an explicit `undefined` object value
 * (`isPluginJsonValue`, `src/plugins/host-hook-json.ts`), so a payload passing this check would
 * also pass the host's bounded-JSON validation. */
function assertNoUndefinedValues(value: unknown, path = "$"): void {
  if (value === undefined) {
    throw new Error(`${path} is undefined`);
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoUndefinedValues(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    assertNoUndefinedValues(entry, `${path}.${key}`);
  }
}

type ServiceContext = Parameters<ReturnType<typeof createDutiesEventService>["start"]>[0];
type GatewayEvents = NonNullable<ServiceContext["gatewayEvents"]>;
type EmitScope = Parameters<GatewayEvents["emit"]>[2]["scope"];

function contextWith(gatewayEvents: {
  emit: (name: string, payload: unknown, opts: { scope: EmitScope }) => void;
}) {
  return {
    config: {},
    stateDir: "/tmp/duties-events-test",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    gatewayEvents: { ...gatewayEvents, onSessionsChanged: () => () => undefined },
  } satisfies ServiceContext;
}

describe("createDutiesEventService", () => {
  it("captures gatewayEvents on start and forwards emit with { scope: 'operator.read' }", () => {
    const emit = vi.fn();
    const service = createDutiesEventService();
    void service.start(contextWith({ emit }));

    service.emit("changed", { dutyId: "d1" });

    expect(emit).toHaveBeenCalledWith("changed", { dutyId: "d1" }, { scope: "operator.read" });
  });

  it("stop() clears the captured gatewayEvents so a later emit is a no-op", () => {
    const emit = vi.fn();
    const service = createDutiesEventService();
    const context = contextWith({ emit });
    void service.start(context);
    void service.stop?.(context);

    service.emit("changed", { dutyId: "d1" });

    expect(emit).not.toHaveBeenCalled();
  });

  it("drops undefined-valued keys before emitting, so a step with an undefined target passes a strict no-undefined-values check", () => {
    const emit = vi.fn((_name: string, payload: unknown) => {
      assertNoUndefinedValues(payload);
    });
    const service = createDutiesEventService();
    void service.start(contextWith({ emit }));

    const event: RunEvent = {
      type: "run",
      runId: "r1",
      dutyId: "d1",
      status: "running",
      step: {
        stepId: "s1",
        label: "Step",
        kind: "browser",
        status: "ok",
        durationMs: 5,
        summary: "done",
        target: undefined,
        screenshotBlobId: undefined,
      },
    };

    expect(() => service.emit("run", event)).not.toThrow();
    expect(emit).toHaveBeenCalledTimes(1);
    const [, payload] = emit.mock.calls[0]!;
    // The undefined-valued `target`/`screenshotBlobId` keys were dropped entirely, not sent as
    // `null` or kept as `undefined` (which `assertNoUndefinedValues` above already confirmed).
    expect(payload).toMatchObject({ step: { stepId: "s1" } });
    expect((payload as { step: Record<string, unknown> }).step).not.toHaveProperty("target");
    expect((payload as { step: Record<string, unknown> }).step).not.toHaveProperty(
      "screenshotBlobId",
    );
  });

  it("never throws when the gateway event emitter itself throws", () => {
    const emit = vi.fn(() => {
      throw new Error("boom");
    });
    const service = createDutiesEventService();
    void service.start(contextWith({ emit }));

    expect(() => service.emit("changed", { dutyId: "d1" })).not.toThrow();
    expect(emit).toHaveBeenCalledOnce();
  });
});
