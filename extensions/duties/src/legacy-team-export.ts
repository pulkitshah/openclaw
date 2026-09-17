/**
 * One-time migration bridge for the Team v2 plugin split.
 *
 * Before this split, the Team roster lived in `DutyStore`'s own `team` plugin-state namespace, under
 * `plugin_id: "duties"`. `extensions/team` now owns the roster in its OWN plugin-state namespace,
 * under `plugin_id: "team"` — a distinct physical location, so a desk with real roster rows already
 * written under the old location (this repo's two live desks, Prabhat's and Prasthan's, both have
 * one) needs those rows carried over, not silently orphaned on upgrade.
 *
 * No plugin can open another plugin's plugin-state namespace directly (`src/plugins/AGENTS.md`,
 * `src/plugin-sdk/AGENTS.md`: a bundled plugin's `api.runtime.state.openKeyedStore` is scoped to its
 * own plugin id), so the only sanctioned way for `extensions/team` to read what Duties used to store
 * is the same in-process Gateway RPC every other cross-plugin call in this codebase uses. These two
 * admin-scoped methods are that bridge, and nothing else: `export` returns the raw legacy rows
 * read-only, and `clear` deletes them once the new plugin has confirmed they are safely copied over.
 *
 * This is deliberately temporary, narrow, and undocumented as a public contract (it is not in this
 * plugin's `contracts.tools`, and it is not a `duties.team.*` roster method — the roster methods
 * themselves moved to `extensions/team` whole). Remove both methods and this file once every desk
 * this fork operates has confirmed an empty legacy namespace (`duties.legacyTeam.export` answering
 * `{ members: [] }`) — there is no other consumer to keep it working for.
 */
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../api.js";

/** The legacy row shape as Duties wrote it — including the `agentId`/`agentWorkspace` fields Team v2
 *  deletes outright. Kept as `unknown` fields here on purpose: this bridge does not interpret the
 *  roster shape at all, it only carries bytes across the plugin boundary; `extensions/team`'s own
 *  importer is the one place that decides what to keep and what to drop. */
export type LegacyTeamRow = Record<string, unknown>;

export function registerLegacyTeamExport(params: { api: OpenClawPluginApi }): void {
  const { api } = params;
  // Opened lazily, on the first actual call, never during plugin registration — the same
  // discipline `index.ts` already applies to the evidence blob store, so a registration-time
  // capture/test harness that never exercises this bridge never needs trusted plugin-runtime
  // storage access either.
  let legacyStore: ReturnType<typeof api.runtime.state.openKeyedStore<LegacyTeamRow>> | undefined;
  const store = () => {
    legacyStore ??= api.runtime.state.openKeyedStore<LegacyTeamRow>({
      namespace: "team",
      maxEntries: 200,
      overflowPolicy: "reject-new",
    });
    return legacyStore;
  };

  api.registerGatewayMethod(
    "duties.legacyTeam.export",
    async (ctx) => {
      const entries = await store().entries();
      ctx.respond(true, { members: entries.map((e) => e.value) });
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    "duties.legacyTeam.clear",
    async (ctx) => {
      const ids = (
        isRecord(ctx.params) && Array.isArray(ctx.params.ids) ? ctx.params.ids : []
      ).filter((id): id is string => typeof id === "string");
      for (const id of ids) {
        await store().delete(id);
      }
      ctx.respond(true, { cleared: ids.length });
    },
    { scope: "operator.admin" },
  );
}
