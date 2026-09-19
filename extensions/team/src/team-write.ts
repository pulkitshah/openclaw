/**
 * The one place the Team roster reaches config and the pairing store.
 *
 * `team.ts` stays pure; this module owns the snapshot read, the safety assertions, the live-authority
 * re-check and the write. Precedents for a bundled plugin writing config this way:
 * `extensions/telegram/src/target-writeback.ts:148-161` (allowlist writeback) and
 * `extensions/feishu/src/dynamic-agent.ts:179-189` (binding materialization).
 */
import { isDeepStrictEqual } from "node:util";
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
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
 *
 * A projection that changes nothing commits no write. `replaceConfigFile` runs a full write cycle
 * whether or not the payload differs — file rewrite, canonical reread, runtime republication — and
 * this function is reached from `team:legacy-import`'s `start()` as well as from roster edits, so a
 * projection-shaped no-op would spend a disk write and a reload cycle to change nothing.
 */
export async function writeTeamProjection(params: {
  members: readonly TeamMember[];
  assertStillAuthorized: () => void;
}): Promise<{ warnings: string[]; config: OpenClawConfig }> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  const current = structuredClone(snapshot.config ?? {}) as OpenClawConfig;
  const warnings = assertTeamProjectionSafe(current, params.members);
  const nextConfig = applyTeamProjection(current, params.members);
  if (isDeepStrictEqual(nextConfig, current)) {
    return { warnings, config: current };
  }
  params.assertStillAuthorized();
  await replaceConfigFile({ nextConfig, snapshot, writeOptions, afterWrite: { mode: "auto" } });
  return { warnings, config: nextConfig };
}

/** The default account id every channel has (`DEFAULT_ACCOUNT_ID`, `src/routing/account-id.ts`),
 *  reachable through `openclaw/plugin-sdk/account-id` but spelled here to keep this module's import
 *  surface to the two SDK subpaths it actually needs. */
const DEFAULT_ACCOUNT_ID = "default";

/** Every account of one channel a roster identity with no `accountId` has to be cleaned out of.
 *
 *  `TeamChannelIdentity.accountId` being absent means "every account of that channel", so cleaning
 *  only `"default"` left a removed member paired on every named account.
 *  `createAccountListHelpers` is the generic cross-channel enumerator every channel plugin's own
 *  account listing is built from (`openclaw/plugin-sdk/account-helpers`), so this needs no
 *  per-channel knowledge; the default account is always included because a channel configured only
 *  at its root keys has an implicit default account that `accounts` does not list, and asking the
 *  pairing store about an account that does not exist is a no-op. */
function channelAccountIds(cfg: OpenClawConfig, channel: string): string[] {
  const { listAccountIds } = createAccountListHelpers(channel);
  return [...new Set([DEFAULT_ACCOUNT_ID, ...listAccountIds(cfg)])];
}

/** The one shape this module reads off `channels.pairing.list`'s `requests[]`
 *  (`packages/gateway-protocol/src/schema/channel-pairing.ts`) — only the fields
 *  `approvePendingPairingRequests` needs to match and then re-submit to `channels.pairing.approve`. */
type PendingPairingRequest = {
  requestId: string;
  channel: string;
  accountId: string;
  senderId: string;
};

/**
 * Looks up and approves any pending DM-pairing request matching one of the given identities, so
 * `team.add` is the ONE sanctioned path from "pending request" to "admitted, on the roster" — never
 * a separate `channels.pairing.approve` call that admits a sender the roster never named
 * (`senderGateForDirect`, `src/channels/message-access/sender-gates.ts:55`, admits a pairing-store
 * match independently of any allowlist, so an unrouted approval is a real, disconnected admission,
 * not a formality).
 *
 * An identity with no matching pending request is left untouched — that is the owner adding someone
 * pre-emptively, before they have ever messaged, and admission for that case is
 * `writeTeamProjection`'s `allowFrom` write, not this. `channels.pairing.list` throwing (a channel
 * with no pairing capability at all, or no pairing-policy account) is treated the same way: nothing
 * to approve for that identity, not a `team.add` failure.
 *
 * Each approval is a real, already-committed pairing-store transaction
 * (`resolveChannelPairingRequest` runs inside one SQLite write transaction,
 * `src/pairing/pairing-store.ts:348-400`) — it does not roll back on its own. If a later identity's
 * approval fails, or a later step in the caller's own flow fails, the caller must compensate by
 * revoking exactly the identities this call reports approved, via `revokePairingEntries` — passing
 * back `identity` with `accountId` set to the request's own `accountId` (never the original,
 * possibly-absent identity accountId) so the compensating revoke targets the one account that was
 * actually touched.
 */
export async function approvePendingPairingRequests(params: {
  runtime: OpenClawPluginApi["runtime"];
  identities: readonly TeamChannelIdentity[];
}): Promise<{ approved: TeamChannelIdentity[] }> {
  const approved: TeamChannelIdentity[] = [];
  try {
    for (const identity of params.identities) {
      let pending: PendingPairingRequest[];
      try {
        const result = await params.runtime.gateway.request<{ requests?: PendingPairingRequest[] }>(
          "channels.pairing.list",
          {
            channel: identity.channel,
            ...(identity.accountId ? { accountId: identity.accountId } : {}),
          },
          { scopes: ["operator.pairing"] },
        );
        pending = (result.requests ?? []).filter(
          (request) => request.senderId === identity.senderId,
        );
      } catch {
        continue;
      }
      for (const match of pending) {
        await params.runtime.gateway.request(
          "channels.pairing.approve",
          {
            channel: match.channel,
            accountId: match.accountId,
            requestId: match.requestId,
            notify: true,
          },
          { scopes: ["operator.pairing"] },
        );
        approved.push({ ...identity, accountId: match.accountId });
      }
    }
  } catch (error) {
    // An earlier identity in this same call was already approved — a committed pairing-store
    // write — before a later one failed. Leaving it standing while `team.add` reports failure is
    // exactly the disconnected admission this function exists to prevent, so it is undone here,
    // best-effort, before the failure propagates.
    if (approved.length > 0) {
      await revokePairingEntries({
        runtime: params.runtime,
        // SAFETY: `cfg` is only read by `revokePairingEntries` to enumerate a channel's accounts
        // for an identity with no `accountId` — every identity pushed onto `approved` above has one
        // (the matched request's own account), so that branch never runs and `cfg` is never read.
        cfg: {},
        identities: approved,
      }).catch(() => undefined);
    }
    throw error;
  }
  return { approved };
}

/**
 * Drops a removed identity from the channel's pairing store, on every account it could be paired on.
 *
 * Config is not the whole door: under `dmPolicy: "pairing"`, `senderGateForDirect`
 * (`src/channels/message-access/sender-gates.ts:55`) admits a pairing-store match independently of
 * the allowlist, so a member who was ALSO approved through pairing would survive removal from the
 * roster. Removal is available on this seam; addition is not, which is right — Team never writes to
 * the pairing store, it only cleans up after it.
 *
 * A failure is REPORTED, never swallowed: the config layer's own write has already succeeded by the
 * time this runs, so the caller still answers `ok: true`, but a cleanup that did not complete is the
 * difference between "access revoked" and "access revoked except through pairing" and the owner has
 * to be told which identity to check by hand.
 */
export async function revokePairingEntries(params: {
  runtime: OpenClawPluginApi["runtime"];
  /** Read-only: the accounts each channel has configured, for an identity that names none. */
  cfg: OpenClawConfig;
  identities: readonly TeamChannelIdentity[];
}): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  for (const identity of params.identities) {
    const accountIds = identity.accountId
      ? [identity.accountId]
      : channelAccountIds(params.cfg, identity.channel);
    for (const accountId of accountIds) {
      const pairing = createChannelPairingController({
        core: params.runtime,
        // SAFETY: a roster identity's channel is a message-channel id by construction; the pairing
        // store answers "not present" for any channel it does not own.
        channel: identity.channel as Parameters<
          typeof createChannelPairingController
        >[0]["channel"],
        accountId,
      });
      try {
        await pairing.removeAllowFromStoreEntry(identity.senderId);
      } catch (error) {
        const where = accountId === DEFAULT_ACCOUNT_ID ? "" : ` on account ${accountId}`;
        const reason = error instanceof Error ? error.message : String(error);
        warnings.push(
          `Could not clear the ${identity.channel} pairing approval for ${identity.senderId}${where} — ` +
            `they may still reach Vasu there under dmPolicy "pairing". ${reason}`,
        );
      }
    }
  }
  return { warnings };
}
