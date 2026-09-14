import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveGatewayPort, type OpenClawConfig } from "openclaw/plugin-sdk/core";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { definePluginEntry } from "./api.js";
import { createAiAdapter } from "./src/adapters/ai.js";
import { createAskAdapter } from "./src/adapters/ask.js";
import { createBrowserAdapter } from "./src/adapters/browser.js";
import {
  createAskSessionResolver,
  createDeliverAdapter,
  createRouteResolver,
  sessionRouteFromStore,
} from "./src/adapters/deliver.js";
import {
  createRenderAdapter,
  createRenderServer,
  RENDER_ROUTE_PATH,
} from "./src/adapters/render.js";
import { credDelete, credGet, credHas, credSet } from "./src/creds.js";
import { createDutiesEventService } from "./src/events.js";
import { createRunFiles } from "./src/files.js";
import { registerDutiesGatewayMethods } from "./src/gateway-methods.js";
import { RunManager } from "./src/run-service.js";
import { DutyStore, runSessionKey } from "./src/store.js";
import { registerDutyTools } from "./src/tools.js";

const EVIDENCE_BLOB_TTL_MS = 90 * 24 * 3600 * 1000;
/** Rendered run documents are kept a month: long enough to re-send a delivery the owner missed,
 *  short enough that a year of runs does not accumulate on disk. */
const RUN_FILES_TTL_MS = 30 * 24 * 3600 * 1000;

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

/** The loopback origin the managed browser fetches rendered HTML from. `gateway.tls.enabled`
 *  (`src/config/zod-schema.gateway.ts:195-197`) flips the scheme: the Gateway then serves TLS on
 *  the same port, so a hardcoded `http://` would fail at the transport and surface as an opaque
 *  browser navigation error on every `template` step and every preview. */
export function resolveRenderBaseUrl(config: OpenClawConfig): string {
  const scheme = config.gateway?.tls?.enabled === true ? "https" : "http";
  return `${scheme}://127.0.0.1:${resolveGatewayPort(config)}`;
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

    // The blob store is opened lazily, on the first run that captures evidence or the first
    // request that reads it back (never during plugin registration), so registration never needs
    // trusted plugin-runtime storage access; it is then memoized instead of reopened per call.
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
    // Rendered documents live on disk (delivery needs a path), under the plugin's own state dir so
    // the whole tree can be dropped with the plugin and swept by age.
    const runFiles = createRunFiles(
      path.join(api.runtime.state.resolveStateDir(), "plugins", "duties", "files"),
    );
    // The managed browser only navigates to http(s), so rendered HTML is served to it through this
    // plugin-authenticated route, one single-use token at a time.
    const renderServer = createRenderServer({ baseUrl: resolveRenderBaseUrl(api.config) });
    api.registerHttpRoute({
      path: RENDER_ROUTE_PATH,
      match: "prefix",
      auth: "plugin",
      handler: (req, res) => renderServer.handler(req, res),
    });
    const render = createRenderAdapter({
      server: renderServer,
      // A render owns its own tab (it navigates to the token URL and prints), so it never shares
      // the tab a duty's browser steps are driving.
      browser: createBrowserAdapter({
        request,
        profile: browserProfile,
        tabLabel: "duty:render",
      }),
    });
    const deliver = createDeliverAdapter({ cfg: api.config });
    const ownerTarget = async () => (await store.getSettings()).owner;
    const resolveRoute = createRouteResolver({
      ownerTarget,
      sessionRoute: sessionRouteFromStore,
    });
    const askSession = createAskSessionResolver({ cfg: api.config, ownerTarget });
    // Read through the store on every run so an edit on the Duties page is picked up by the next
    // run without rebuilding the deps.
    const templates = {
      get: (id: string) => store.getTemplate(id),
      brand: () => store.getBrand(),
    };

    const runs = new RunManager({
      store,
      deps: async (duty, run) => {
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
          ai: createAiAdapter({ request, sessionKey: runSessionKey(run.origin) }),
          // An `ask` is the one step that waits for a person, so it is raised in the session that
          // person uses — the run's own chat, or the owner's — and announced through the same
          // route `deliver` would use, because `question.request` sends to no channel by itself.
          ask: createAskAdapter({
            request,
            sessionKey: await askSession(run.origin),
            announce: async (text) => {
              const route = await resolveRoute("trigger", undefined, run.origin);
              await deliver.send({ route, text });
            },
          }),
          cred: (key: string) => credGet(key),
          templates,
          render,
          deliver,
          resolveRoute,
          filesDir: await runFiles.runDir(run.id),
        };
      },
      emit: (event) => events.emit("run", event),
      // Status lines go where the run reports: the conversation it was started from, else the
      // owner. Best-effort — `announce` swallows the failure, so a run with no owner target
      // configured still runs, it just reports nowhere.
      notify: async (origin, text) => {
        const route = await resolveRoute("trigger", undefined, origin);
        await deliver.send({ route, text });
      },
    });
    api.registerService({
      id: "duties:runs",
      async start() {
        await runs.recoverOrphans();
        // Best-effort: a sweep that cannot remove an old run's directory is a disk-space note,
        // never a reason for the Duties service to fail to start.
        await runFiles.cleanup(RUN_FILES_TTL_MS).catch((error: unknown) => {
          api.logger.warn(`duties: rendered-file cleanup failed: ${coerceErrorMessage(error)}`);
        });
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
      render,
      previewDir: () => runFiles.previewDir(),
    });
    registerDutyTools({
      api,
      store,
      runs,
      credHas: (key) => credHas(key),
      render,
      previewDir: () => runFiles.previewDir(),
    });

    api.registerCli(
      async ({ program, config }) => {
        const { registerDutiesSetupCli } = await import("./src/cli.js");
        registerDutiesSetupCli({ program, config });
      },
      {
        descriptors: [{ name: "duties", description: "Duties setup", hasSubcommands: true }],
      },
    );
  },
});
