/**
 * The one place the Team roster reaches config and the pairing store.
 *
 * `team.ts` stays pure; this module owns the snapshot read, the safety assertions, the live-authority
 * re-check and the write. Precedents for a bundled plugin writing config this way:
 * `extensions/telegram/src/target-writeback.ts:148-161` (allowlist writeback) and
 * `extensions/feishu/src/dynamic-agent.ts:179-189` (binding materialization).
 */
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "openclaw/plugin-sdk/config-mutation";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "../api.js";
import {
  applyTeamProjection,
  assertTeamProjectionSafe,
  type TeamChannelIdentity,
  type TeamMember,
} from "./team.js";

/**
 * Applies the roster to config in one write.
 *
 * `assertStillAuthorized` is called synchronously immediately before `replaceConfigFile` — after
 * the snapshot read and the projection, which are awaited work — per `src/gateway/AGENTS.md`'s rule
 * that a durable effect revalidates live authority at the pre-commit edge.
 *
 * A rejected write throws and changes nothing; `assertAutomaticBindingsWriteAllowed`
 * (`src/config/io.ownership-write-guard.ts`) surfaces here verbatim as CONFIG_WRITE_REJECTED when
 * `bindings` lives behind `$include-owned`.
 */
export async function writeTeamProjection(params: {
  members: readonly TeamMember[];
  assertStillAuthorized: () => void;
}): Promise<{ warnings: string[]; config: OpenClawConfig }> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  const current = structuredClone(snapshot.config ?? {}) as OpenClawConfig;
  const warnings = assertTeamProjectionSafe(current, params.members);
  const nextConfig = applyTeamProjection(current, params.members);
  params.assertStillAuthorized();
  await replaceConfigFile({ nextConfig, snapshot, writeOptions, afterWrite: { mode: "auto" } });
  return { warnings, config: nextConfig };
}

/**
 * Drops a removed identity from the channel's pairing store.
 *
 * Config is not the whole door: under `dmPolicy: "pairing"`, `senderGateForDirect`
 * (`src/channels/message-access/sender-gates.ts:55`) admits a pairing-store match independently of
 * the allowlist, so a member who was ALSO approved through pairing would survive removal from the
 * roster. Removal is available on this seam; addition is not, which is right — Team never writes to
 * the pairing store, it only cleans up after it.
 *
 * SDK note: the brief for this task named `createScopedPairingAccess` from a
 * `plugin-sdk/pairing-access` subpath; no such subpath is exported (`package.json`'s
 * `exports` map has no `./plugin-sdk/pairing-access`, and `extensions/tsconfig.package-boundary.paths.json`
 * has no matching alias). `openclaw/plugin-sdk/channel-pairing` re-exports
 * `createChannelPairingController`, which wraps the same `createScopedPairingAccess` helper and
 * spreads its full return value — including `removeAllowFromStoreEntry` — so it is used here instead;
 * the extra `issueChallenge` it also exposes is unused.
 */
export async function revokePairingEntries(params: {
  runtime: OpenClawPluginApi["runtime"];
  identities: readonly TeamChannelIdentity[];
}): Promise<void> {
  for (const identity of params.identities) {
    const pairing = createChannelPairingController({
      core: params.runtime,
      // SAFETY: a roster identity's channel is a message-channel id by construction; the pairing
      // store answers "not present" for any channel it does not own.
      channel: identity.channel as Parameters<typeof createChannelPairingController>[0]["channel"],
      accountId: identity.accountId ?? "default",
    });
    await pairing.removeAllowFromStoreEntry(identity.senderId).catch(() => undefined);
  }
}
