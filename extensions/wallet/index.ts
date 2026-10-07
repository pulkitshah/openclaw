import path from "node:path";
import { pathToFileURL } from "node:url";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { OpenClawPluginApi } from "./api.js";
import type { AttributionLookups } from "./src/attribution.js";
import { createWalletCommand, createWalletStatusTool } from "./src/command.js";
import { createWalletEventService } from "./src/events.js";
import { createBeforeAgentRun } from "./src/gate.js";
import { registerWalletGatewayMethods } from "./src/gateway-methods.js";
import { startHostingJob } from "./src/hosting.js";
import { createLlmOutputMeter } from "./src/meter.js";
import { resolveRateCard } from "./src/money.js";
import { createNotices } from "./src/notices.js";
import { WalletStore } from "./src/store.js";

/** Shared with the wallet tool (Task 10): model calls whose debit could not be written. */
export const counters = { unrecorded: 0 };

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
  const rateCard = () =>
    resolveRateCard((pluginConfig() as { rateCard?: unknown } | undefined)?.rateCard);
  const lookups: AttributionLookups = {
    memberName: async (id) => {
      try {
        const res = await request<{ member?: { name?: string } }>("team.member.get", { id });
        return res.member?.name;
      } catch {
        return undefined; // Team not installed or no such member: the label falls back to the id
      }
    },
    groupName: async () => undefined, // no group registry yet; the label falls back to the session key
    mailAgentIds: () => {
      const entries = currentConfig().agents?.entries as
        | Record<string, { wallet?: { role?: string } } | undefined>
        | undefined;
      const mail = Object.entries(entries ?? {})
        .filter(([, entry]) => entry?.wallet?.role === "mail")
        .map(([id]) => id);
      return ["duties-mail", ...mail];
    },
  };
  const contact = () => {
    const configured = (pluginConfig() as { contact?: unknown } | undefined)?.contact;
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
        afterDebit: notices.afterDebit,
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
    createBeforeAgentRun({ store, contact, onStopped: notices.afterStop }),
  );
  api.on(
    "llm_output",
    createLlmOutputMeter({
      store,
      rateCard,
      lookups,
      afterAppend: notices.afterDebit,
      onUnrecorded: (error) => {
        counters.unrecorded += 1;
        api.logger.warn(`wallet: debit not recorded: ${coerceErrorMessage(error)}`);
      },
    }),
  );
}
