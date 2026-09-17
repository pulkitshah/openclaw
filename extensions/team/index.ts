import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "./api.js";
import { createTeamEventService } from "./src/events.js";
import { registerTeamGatewayMethods } from "./src/gateway-methods.js";
import { importLegacyTeamRows } from "./src/legacy-import.js";
import { TeamStore } from "./src/store.js";
import { registerTeamTools } from "./src/tools.js";

export default definePluginEntry({
  id: "team",
  name: "Team",
  description: "The desk's owner/member roster: who may give the agent instructions.",
  register(api) {
    // The host loads this plugin a second time in `tool-discovery` mode to list and run its tools
    // (docs/plugins/sdk-entrypoints/registration-mode.md) — same discipline `extensions/duties`
    // follows for the identical reason: the tool copy must own no runtime state, or a tool-started
    // read/write competes with the full copy's store and event service.
    if (api.registrationMode === "tool-discovery") {
      registerTeamTools({ api });
      return;
    }
    if (api.registrationMode !== "full") {
      return;
    }

    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "team",
      label: "Team",
      icon: "users",
      group: "control",
      requiredScopes: ["operator.read"],
    });

    const store = TeamStore.open(api);
    const events = createTeamEventService();
    api.registerService(events);

    const currentConfig = (): OpenClawConfig => {
      if (!api.runtime.config?.current) {
        return api.config;
      }
      // SAFETY: matches the single-assertion pattern other runtime.config.current() callers use
      // (e.g. src/plugins/registry-api.ts, src/plugin-sdk/migration.ts) — every consumer here only
      // reads from the result.
      return api.runtime.config.current() as OpenClawConfig;
    };

    registerTeamGatewayMethods({
      api,
      store,
      currentConfig,
      safeEmit: (name, payload) => {
        try {
          events.emit(name, payload);
        } catch {
          // Event delivery is best-effort; a failure here must never turn a committed write into a
          // reported Gateway failure.
        }
      },
    });
    registerTeamTools({ api });

    // One-time carry-over of roster rows written before this plugin existed (see
    // `legacy-import.ts`). Runs from a service's `start()`, after every plugin has finished
    // `register()`, so the in-process Gateway RPC to Duties' bridge method has something registered
    // to answer it; a plain `duties.legacyTeam.export` request during `register()` itself would race
    // that registration.
    api.registerService({
      id: "team:legacy-import",
      async start(ctx) {
        const request = <T = unknown>(method: string, params?: Record<string, unknown>) =>
          api.runtime.gateway.request<T>(method, params ?? {}, { scopes: ["operator.admin"] });
        const { warnings } = await importLegacyTeamRows({
          store,
          request,
          // In-process migration dispatch: no external client authority to lose mid-request.
          assertStillAuthorized: () => {},
          logger: ctx.logger,
        }).catch((error: unknown) => {
          ctx.logger.warn(
            `team: legacy roster import failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return { imported: [], warnings: [] };
        });
        for (const warning of warnings) {
          ctx.logger.warn(`team: ${warning}`);
        }
      },
    });
  },
});
