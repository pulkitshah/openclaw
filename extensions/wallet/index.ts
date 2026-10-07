import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "./api.js";
import type { AttributionLookups } from "./src/attribution.js";
import { createLlmOutputMeter } from "./src/meter.js";
import { resolveRateCard } from "./src/money.js";
import { WalletStore } from "./src/store.js";

/** Shared with the wallet tool (Task 5): model calls whose debit could not be written. */
export const counters = { unrecorded: 0 };

export default function register(api: OpenClawPluginApi): void {
  if (api.registrationMode !== "full") return; // tool-discovery / cli-metadata modes add nothing yet (Task 10 adds the tool)
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

  const store = WalletStore.open(api);
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
  api.on(
    "llm_output",
    createLlmOutputMeter({
      store,
      rateCard,
      lookups,
      onUnrecorded: (error) => {
        counters.unrecorded += 1;
        api.logger.warn(`wallet: debit not recorded: ${coerceErrorMessage(error)}`);
      },
    }),
  );
}
