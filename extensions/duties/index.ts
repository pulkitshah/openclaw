import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveGatewayPort, type OpenClawConfig } from "openclaw/plugin-sdk/core";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { createAiAdapter } from "./src/adapters/ai.js";
import { createAskAdapter } from "./src/adapters/ask.js";
import { createBrowserAdapter } from "./src/adapters/browser.js";
import {
  createAskSessionResolver,
  createDeliverAdapter,
  createOwnerRouteResolver,
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
/** How often the rendered-file sweep runs after the first pass at service start. Previews expire
 *  in a day (`PREVIEW_TTL_MS`), so hourly is well inside their clock and costs one readdir. */
const FILE_SWEEP_INTERVAL_MS = 3600 * 1000;

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
    // The host loads this plugin a second time in `tool-discovery` mode to list and run its tools
    // (docs/plugins/sdk-entrypoints/registration-mode.md). Everything below the tools owns runtime
    // state — the store handles, the RunManager, the events service, the blob store and the
    // render server's one-time token map — and a second copy of that state is not a duplicate, it
    // is a competing owner: renders published in the tool copy were served 404 by the full copy's
    // route, and tool-started runs were invisible to `duties.run.cancel`, to `plugin.duties.run`
    // events and to orphan recovery. So the tool copy registers the tools and nothing else; the
    // tools are clients of the full copy's Gateway methods.
    if (api.registrationMode === "tool-discovery") {
      registerDutyTools({ api });
      return;
    }
    // `cli-metadata` cannot touch runtime at all; it exists to collect root command descriptors.
    if (api.registrationMode === "cli-metadata") {
      registerDutiesCli(api);
      return;
    }
    // `discovery` is a read-only capability sweep: descriptors are fine, services and sockets are
    // not. `setup-only` has no runtime to open a store with.
    if (api.registrationMode !== "full") {
      registerDutiesCli(api);
      return;
    }

    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "duties",
      label: "Duties",
      icon: "listChecks",
      group: "control",
      requiredScopes: ["operator.read"],
    });

    const browserProfile = resolveBrowserProfile(api.pluginConfig);
    // `api.config` is the snapshot this plugin was registered with, not a live view
    // (src/plugins/api-builder.ts). A Gateway runs for weeks and its config is reloaded in place,
    // so everything below that reads config — mail/render readiness, the render base url, delivery,
    // owner routing — reads it through here instead. Same shape other bundled plugins use
    // (extensions/discord/src/activities/register.ts:22, extensions/memory-lancedb/index.ts:165).
    const currentConfig = (): OpenClawConfig => {
      if (!api.runtime.config?.current) {
        return api.config;
      }
      // SAFETY: matches the single-assertion pattern other runtime.config.current() callers use
      // (e.g. src/plugins/registry-api.ts, src/plugin-sdk/migration.ts) — every consumer here
      // only reads from the result.
      return api.runtime.config.current() as OpenClawConfig;
    };
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
    const renderServer = createRenderServer({
      baseUrl: () => resolveRenderBaseUrl(currentConfig()),
    });
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
    const deliver = createDeliverAdapter({ cfg: currentConfig });
    const ownerTarget = async () => (await store.getSettings()).owner;
    const resolveRoute = createRouteResolver({
      ownerTarget,
      sessionRoute: sessionRouteFromStore,
    });
    // Asks and run status lines are owner-facing: they go to the origin chat only when that chat
    // is the owner's own, never to a group the Duty happened to be triggered from.
    const ownerRoute = createOwnerRouteResolver({
      ownerTarget,
      sessionRoute: sessionRouteFromStore,
    });
    const askSession = createAskSessionResolver({
      cfg: currentConfig,
      ownerTarget,
      sessionRoute: sessionRouteFromStore,
    });
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
            // Resolved inside `ask()`, not here: `deps()` is built for EVERY run, so resolving
            // the owner eagerly failed a Duty with no `ask` at all — on a fresh install, where
            // the owner target is set by hand, that was every run.
            sessionKey: () => askSession(run.origin),
            announce: async (text, question) => {
              const route = await ownerRoute(run.origin);
              await deliver.send({ route, text, ...(question ? { question } : {}) });
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
      // Status lines are owner-facing, like asks: the origin chat only when it is the owner's own
      // direct chat, otherwise the owner. Best-effort — `announce` swallows the failure, so a run
      // with no owner target configured still runs, it just reports nowhere.
      notify: async (origin, text) => {
        const route = await ownerRoute(origin);
        await deliver.send({ route, text });
      },
      // Cancelling the question a parked run waits on is what lets its ask return and the run
      // unwind; without it the run keeps its browser session until the question times out.
      cancelQuestion: async (questionId) => {
        await request("question.resolve", { id: questionId, cancel: true });
      },
      // Read fresh on every start()/pump pass so a hosted desk's owner can raise or lower the
      // ceiling from the Duties page's Desk card without a Gateway restart.
      maxParallel: async () => (await store.getSettings()).maxParallelRuns ?? 4,
    });
    // Best-effort: a sweep that cannot remove an old run's directory is a disk-space note, never a
    // reason for the Duties service to fail to start.
    const sweep = async () => {
      await runFiles.cleanup(RUN_FILES_TTL_MS).catch((error: unknown) => {
        api.logger.warn(`duties: rendered-file cleanup failed: ${coerceErrorMessage(error)}`);
      });
    };
    let sweepTimer: ReturnType<typeof setInterval> | undefined;
    api.registerService({
      id: "duties:runs",
      async start() {
        await runs.recoverOrphans();
        await sweep();
        // Sweeping only at start meant a Gateway that stays up for months never swept again,
        // while every Templates-page card render writes another preview PDF. Previews expire in a
        // day, so an hourly pass keeps that honest without watching the directory.
        sweepTimer = setInterval(() => void sweep(), FILE_SWEEP_INTERVAL_MS);
        sweepTimer.unref?.();
      },
      stop() {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      },
    });

    registerDutiesGatewayMethods({
      api,
      store,
      runs,
      emit: (name, payload) => events.emit(name, payload),
      creds: {
        set: (key, value) => credSet(key, value),
        delete: (key) => credDelete(key),
        has: (key) => credHas(key),
      },
      evidence,
      render,
      previewDir: () => runFiles.previewDir(),
      config: currentConfig,
      // Same owner route asks and status lines use, so everything owner-facing lands in one place.
      notifyOwner: async (text) => {
        await deliver.send({ route: await ownerRoute(undefined), text });
      },
    });
    registerDutyTools({ api });

    registerDutiesCli(api);
  },
});

/** The `duties` CLI command. Registered in every mode that collects CLI surface, including
 *  `cli-metadata`, where the descriptor is all the host reads and the loader body never runs. */
function registerDutiesCli(api: OpenClawPluginApi): void {
  api.registerCli(
    async ({ program, config }) => {
      const { registerDutiesSetupCli } = await import("./src/cli.js");
      registerDutiesSetupCli({ program, config });
    },
    {
      descriptors: [{ name: "duties", description: "Duties setup", hasSubcommands: true }],
    },
  );
}
