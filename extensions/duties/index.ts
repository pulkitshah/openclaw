import { randomUUID } from "node:crypto";
import { definePluginEntry } from "./api.js";
import { createAiAdapter } from "./src/adapters/ai.js";
import { createAskAdapter } from "./src/adapters/ask.js";
import { createBrowserAdapter } from "./src/adapters/browser.js";
import { credDelete, credGet, credHas, credSet } from "./src/creds.js";
import { createDutiesEventService } from "./src/events.js";
import { registerDutiesGatewayMethods } from "./src/gateway-methods.js";
import { RunManager } from "./src/run-service.js";
import { DutyStore } from "./src/store.js";
import { registerDutyTools } from "./src/tools.js";

const EVIDENCE_BLOB_TTL_MS = 90 * 24 * 3600 * 1000;

export const DEFAULT_BROWSER_PROFILE = "openclaw";

/** Resolves the browser profile duty replays drive, from `plugins.entries.duties.config`. */
export function resolveBrowserProfile(pluginConfig?: Record<string, unknown>): string {
  const configured = pluginConfig?.browserProfile;
  if (typeof configured !== "string") {
    return DEFAULT_BROWSER_PROFILE;
  }
  const trimmed = configured.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_BROWSER_PROFILE;
}

export default definePluginEntry({
  id: "duties",
  name: "Duties",
  description: "Saved, replayable automations the agent authors from your instructions.",
  register(api) {
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "duties",
      label: "Duties",
      icon: "listChecks",
      group: "control",
      requiredScopes: ["operator.read"],
    });

    const browserProfile = resolveBrowserProfile(api.pluginConfig);
    const store = DutyStore.open(api);
    const events = createDutiesEventService();
    api.registerService(events);

    const request = <T = unknown>(method: string, params: Record<string, unknown>) =>
      api.runtime.gateway.request<T>(method, params, { scopes: ["operator.admin"] });

    // The blob store is opened lazily, only when a run actually starts (never during plugin
    // registration), so plugin registration never needs trusted plugin-runtime storage access;
    // it is then memoized across runs instead of reopened on every `deps()` call.
    let blobs: ReturnType<typeof openEvidenceBlobs> | undefined;
    function openEvidenceBlobs() {
      return api.runtime.state.openBlobStore<{ contentType: string; kind: string }>({
        namespace: "evidence",
        maxEntries: 20_000,
        maxBytesPerEntry: 4 * 1024 * 1024,
        maxBytesPerNamespace: 512 * 1024 * 1024,
        overflowPolicy: "evict-oldest",
        defaultTtlMs: EVIDENCE_BLOB_TTL_MS,
      });
    }
    const evidence = () => {
      blobs ??= openEvidenceBlobs();
      return blobs;
    };
    const runs = new RunManager({
      store,
      deps: (duty) => {
        const evidenceBlobs = evidence();
        return {
          browser: createBrowserAdapter({
            request,
            profile: browserProfile,
            tabLabel: `duty:${duty.id}`,
            blobs: {
              put: async (bytes, contentType) => {
                const key = randomUUID();
                await evidenceBlobs.register(key, bytes, { contentType, kind: "screenshot" });
                return key;
              },
            },
          }),
          ai: createAiAdapter({ request, sessionKey: "main" }),
          ask: createAskAdapter({ request, sessionKey: "main" }),
          cred: (key: string) => credGet(key),
        };
      },
      emit: (event) => events.emit("run", event),
    });
    api.registerService({
      id: "duties:runs",
      async start() {
        await runs.recoverOrphans();
      },
      stop() {},
    });

    registerDutiesGatewayMethods({
      api,
      store,
      runs,
      emit: events.emit,
      creds: { set: (key, value) => credSet(key, value), delete: (key) => credDelete(key) },
      evidence,
    });
    registerDutyTools({ api, store, runs, credHas: (key) => credHas(key) });
  },
});
