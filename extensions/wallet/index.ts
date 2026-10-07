import path from "node:path";
import { pathToFileURL } from "node:url";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "./api.js";
import type { AttributionLookups } from "./src/attribution.js";
import { createWalletCommand, createWalletStatusTool } from "./src/command.js";
import { createDebitEventEmitter, createWalletEventService } from "./src/events.js";
import { createBeforeAgentRun } from "./src/gate.js";
import { registerWalletGatewayMethods } from "./src/gateway-methods.js";
import { startHostingJob } from "./src/hosting.js";
import { createLlmOutputMeter } from "./src/meter.js";
import { resolveRateCard } from "./src/money.js";
import { createNotices } from "./src/notices.js";
import { WalletStore } from "./src/store.js";

/** Shared with the wallet tool (Task 10): model calls whose debit could not be written. */
export const counters = { unrecorded: 0 };

/** Remembers a name per key for a while; a failed or empty lookup is retried on the next call.
 *  Names change rarely (a renamed group, a renamed job), so a short memory is enough. */
function cachedLookup(
  resolve: (key: string) => Promise<string | undefined>,
  ttlMs = 10 * 60_000,
): (key: string) => Promise<string | undefined> {
  const cache = new Map<string, { name: string; until: number }>();
  return async (key) => {
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) {
      return hit.name;
    }
    try {
      const name = await resolve(key);
      if (name) {
        cache.set(key, { name, until: Date.now() + ttlMs });
      }
      return name;
    } catch {
      return undefined; // the label falls back to the key; the debit is never dropped
    }
  };
}

export default function register(api: OpenClawPluginApi): void {
  // Shared request helper for both tool-discovery and full modes
  const readRequest = (method: string, params: Record<string, unknown>) =>
    api.runtime.gateway.request(method, params, { scopes: ["operator.read"] });

  const registerStatusTool = () =>
    api.registerTool(createWalletStatusTool(readRequest), { name: "wallet_status" });

  // Register the wallet_status tool in tool-discovery mode only
  if (api.registrationMode === "tool-discovery") {
    registerStatusTool();
    return;
  }

  // cli-metadata / discovery / setup-only modes add nothing yet
  if (api.registrationMode !== "full") {
    return;
  }
  api.session.controls.registerControlUiDescriptor({
    surface: "tab",
    id: "wallet",
    label: "Wallet",
    icon: "coins",
    group: "control",
    requiredScopes: ["operator.read"],
  });
  const currentConfig = (): OpenClawConfig => {
    if (!api.runtime.config?.current) {
      return api.config;
    }
    // SAFETY: same single assertion duties/index.ts uses; every consumer here only reads.
    return api.runtime.config.current() as OpenClawConfig;
  };
  const pluginConfig = () => currentConfig().plugins?.entries?.wallet?.config ?? api.pluginConfig;
  const request = <T = unknown>(method: string, params: Record<string, unknown>) =>
    api.runtime.gateway.request<T>(method, params, { scopes: ["operator.admin"] });

  // The ledger lives in the plugin's own database. The service start opens it with the host's state
  // dir; a hook or method that runs earlier opens it on first use instead of dropping its write.
  let serviceStateDir: string | undefined;
  const store = WalletStore.deferred(() => {
    if (!api.runtimeSource) {
      throw new Error("Wallet requires a Vasudev host with runtime entrypoint metadata");
    }
    return {
      stateDir: serviceStateDir ?? resolveStateDir(),
      workerModuleUrl: new URL(
        `./src/store.worker${path.extname(api.runtimeSource)}`,
        pathToFileURL(api.runtimeSource),
      ),
    };
  });
  api.registerService({
    id: "wallet:store",
    async start(ctx) {
      serviceStateDir = ctx.stateDir;
      await store.ready();
      // The live meter is registered on every start; the first start on a desk is the backfill cutover.
      await store.ensureMeterStarted(Date.now());
    },
    async stop() {
      await store.close();
    },
  });
  const configField = (key: string): unknown => {
    const config: unknown = pluginConfig();
    return isRecord(config) ? config[key] : undefined;
  };
  const rateCard = () => resolveRateCard(configField("rateCard"));
  const lookups: AttributionLookups = {
    memberName: async (id) => {
      try {
        const res = await request<{ member?: { name?: string } }>("team.member.get", { id });
        return res.member?.name;
      } catch {
        return undefined; // Team not installed or no such member: the label falls back to the id
      }
    },
    // The host names sessions itself (a WhatsApp group's subject, a saved contact); read from the
    // session list and remembered per key, so a busy desk does not list sessions on every call.
    sessionName: cachedLookup(async (key) => {
      const agentId = /^agent:([^:]+):/.exec(key)?.[1];
      const res = await request<{
        sessions?: Array<{ key?: string; displayName?: string; label?: string; subject?: string }>;
      }>("sessions.list", { ...(agentId ? { agentId } : {}), limit: 500 });
      const hit = res?.sessions?.find((s) => s.key === key);
      const name = hit?.displayName ?? hit?.label ?? hit?.subject;
      return typeof name === "string" && name.trim() ? name.trim() : undefined;
    }),
    // Cron rows read as the job's name, never its id. One list per unknown id, remembered after.
    jobName: cachedLookup(async (jobId) => {
      const res = await request<{ jobs?: Array<{ id?: string; name?: string }> }>("cron.list", {
        includeDisabled: true,
        limit: 500,
      });
      const name = res?.jobs?.find((j) => j.id === jobId)?.name;
      return typeof name === "string" && name.trim() ? name.trim() : undefined;
    }),
    mailAgentIds: () => {
      // `wallet.role` is this plugin's own key on an agent entry, so it is read as untyped JSON.
      const entries: unknown = currentConfig().agents?.entries;
      const mail = Object.entries(isRecord(entries) ? entries : {})
        .filter(
          ([, entry]) => isRecord(entry) && isRecord(entry.wallet) && entry.wallet.role === "mail",
        )
        .map(([id]) => id);
      return ["duties-mail", ...mail];
    },
  };
  const contact = () => {
    const configured = configField("contact");
    return typeof configured === "string" && configured.trim()
      ? configured.trim()
      : "TripIn Studio";
  };
  // Owner route comes from Team, called in-process like Duties does; no owner means nothing to tell.
  const send = async (text: string): Promise<void> => {
    let owner: { channel: string; target: string } | undefined;
    try {
      owner = (await request<{ owner?: { channel: string; target: string } }>("team.owner.get", {}))
        ?.owner;
    } catch {
      owner = undefined;
    }
    if (!owner) {
      api.logger.info("wallet: no owner target configured; balance notice not sent");
      return;
    }
    const result = await sendDurableMessageBatch({
      cfg: currentConfig(),
      channel: owner.channel,
      to: owner.target,
      payloads: [{ text }],
    });
    if (result.status !== "sent") {
      throw new Error(`wallet notice delivery ${result.status}`);
    }
  };
  const notices = createNotices({
    store,
    contact,
    send: async (text) => {
      try {
        await send(text);
      } catch (error) {
        api.logger.warn(`wallet: notice not delivered: ${coerceErrorMessage(error)}`);
      }
    },
  });
  const events = createWalletEventService();
  api.registerService(events);
  // A busy desk writes a debit per model call; the page needs the balance, not every row.
  const debitEvents = createDebitEventEmitter({
    emit: (payload) => events.emit("changed", payload),
    balance: () => store.balance(),
  });
  registerWalletGatewayMethods({
    api,
    store,
    rateCard,
    contact,
    notices,
    events,
    counters,
    request,
    lookups,
  });

  // Register the wallet_status tool and /wallet command in full mode
  registerStatusTool();
  api.registerCommand(createWalletCommand(readRequest));

  let stopHosting: (() => void) | undefined;
  api.registerService({
    id: "wallet:hosting",
    start() {
      stopHosting?.();
      stopHosting = startHostingJob({
        store,
        rateCard,
        now: Date.now,
        afterDebit: notices.reconcile,
        onChanged: async () =>
          events.emit("changed", {
            balancePaise: await store.balance(),
            kind: "debit",
            entryId: "",
          }),
        log: (message) => api.logger.warn(message),
      });
    },
    stop() {
      stopHosting?.();
      stopHosting = undefined;
    },
  });
  api.on(
    "before_agent_run",
    createBeforeAgentRun({ store, contact, log: (message) => api.logger.warn(message) }),
  );
  api.on(
    "llm_output",
    createLlmOutputMeter({
      store,
      rateCard,
      lookups,
      afterAppend: notices.reconcile,
      onDebit: debitEvents,
      onUnrecorded: (error) => {
        counters.unrecorded += 1;
        api.logger.warn(`wallet: debit not recorded: ${coerceErrorMessage(error)}`);
      },
      log: (message) => api.logger.info(message),
    }),
  );
  api.logger.info("wallet: hooks registered (before_agent_run, llm_output)");
}
