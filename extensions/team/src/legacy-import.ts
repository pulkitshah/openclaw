/**
 * One-time import of roster rows written before the Team v2 plugin split, when the roster lived in
 * `extensions/duties`'s own plugin state (see `extensions/duties/src/legacy-team-export.ts`).
 *
 * Runs once, on this plugin's own activation, only while its own store is still empty — never
 * against a roster that already has real rows, so a desk that has already migrated (or that never
 * had Duties-owned roster data to begin with, e.g. a fresh install) does nothing here beyond one
 * cheap `duties.legacyTeam.export` call that answers `{ members: [] }`.
 *
 * Per-member agents are deleted, not carried over: a legacy row's `agentId`/`agentWorkspace` fields
 * are read off the raw payload and discarded — everyone routes through the shared coordinator agent
 * from here on (`team.ts`'s `resolveCoordinatorAgentId`). The existing per-member agents themselves
 * are NOT deleted by this import; they simply stop being referenced by the roster projection the next
 * time it runs, which this import triggers immediately after the copy (via `writeTeamProjection`) so
 * a migrated desk's config stops pointing at them right away rather than drifting until the next
 * unrelated roster write.
 */
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TeamStore } from "./store.js";
import { writeTeamProjection } from "./team-write.js";
import { normalizeTeamMemberId, type TeamChannelIdentity, type TeamMember } from "./team.js";

function readChannels(raw: unknown): TeamChannelIdentity[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry): TeamChannelIdentity[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const channel = typeof entry.channel === "string" ? entry.channel : "";
    const senderId = typeof entry.senderId === "string" ? entry.senderId : "";
    if (!channel || !senderId) {
      return [];
    }
    const accountId = typeof entry.accountId === "string" ? entry.accountId : undefined;
    const addedAt = typeof entry.addedAt === "number" ? entry.addedAt : Date.now();
    return [{ channel, senderId, ...(accountId ? { accountId } : {}), addedAt }];
  });
}

/** Legacy row -> the new, agent-free `TeamMember` shape. Returns undefined for a row too malformed
 *  to safely carry over (no id, no role) rather than guessing — an incomplete legacy row is a data
 *  problem to surface, not one to paper over during a migration. */
function readLegacyMember(raw: unknown): TeamMember | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = typeof raw.id === "string" && raw.id ? raw.id : undefined;
  const role = raw.role === "owner" || raw.role === "member" ? raw.role : undefined;
  if (!id || !role) {
    return undefined;
  }
  let normalizedId: string;
  try {
    normalizedId = normalizeTeamMemberId(id);
  } catch {
    return undefined;
  }
  const now = Date.now();
  return {
    id: normalizedId,
    name: typeof raw.name === "string" && raw.name ? raw.name : normalizedId,
    role,
    channels: readChannels(raw.channels),
    addedBy: typeof raw.addedBy === "string" && raw.addedBy ? raw.addedBy : "owner",
    addedAt: typeof raw.addedAt === "number" ? raw.addedAt : now,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now,
  };
}

export type LegacyImportRequest = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>;

/**
 * Copies every legacy row into `store`, then re-projects config once so bindings stop pointing at
 * retired per-member agents. Best-effort throughout: a Duties install without the legacy bridge
 * (removed, or never installed at all) answers "unknown method", which is treated exactly like "no
 * legacy rows" — there is nothing to migrate, not a failure.
 *
 * Returns the ids actually copied, so the caller can log what happened; never throws.
 */
export async function importLegacyTeamRows(params: {
  store: TeamStore;
  request: LegacyImportRequest;
  assertStillAuthorized: () => void;
  logger?: { warn: (message: string) => void; info?: (message: string) => void };
}): Promise<{ imported: string[]; warnings: string[] }> {
  const { store, request, assertStillAuthorized, logger } = params;
  const warnings: string[] = [];

  if ((await store.listMembers()).length > 0) {
    // Already has real rows — either already migrated, or a desk that was set up after the split.
    return { imported: [], warnings };
  }

  let legacyRows: unknown[];
  try {
    const result = await request<{ members?: unknown[] }>("duties.legacyTeam.export", {});
    legacyRows = Array.isArray(result?.members) ? result.members : [];
  } catch {
    // No Duties bridge available (not installed, or already fully removed) — nothing to migrate.
    return { imported: [], warnings };
  }
  if (legacyRows.length === 0) {
    return { imported: [], warnings };
  }

  const members = legacyRows.map(readLegacyMember).filter((m): m is TeamMember => m !== undefined);
  const dropped = legacyRows.length - members.length;
  if (dropped > 0) {
    warnings.push(
      `${dropped} legacy Team ${dropped === 1 ? "row" : "rows"} could not be read (missing id/role) and ${dropped === 1 ? "was" : "were"} left in place — check them by hand.`,
    );
  }
  if (members.length === 0) {
    return { imported: [], warnings };
  }
  if (!members.some((m) => m.role === "owner")) {
    warnings.push("Legacy Team rows had no owner row — imported as members only.");
  }

  const imported: string[] = [];
  for (const member of members) {
    // SAFETY: this is the one caller allowed to write a role: "owner" row outside `seedOwner`'s own
    // invariant check — it is copying an already-valid roster whole, not constructing one.
    await store.restoreMember(member);
    imported.push(member.id);
  }

  try {
    await writeTeamProjection({ members: await store.listMembers(), assertStillAuthorized });
  } catch (error) {
    warnings.push(
      `Imported ${imported.length} legacy Team ${imported.length === 1 ? "member" : "members"} but could not re-project config yet: ${error instanceof Error ? error.message : String(error)}. The next Team roster edit will retry it.`,
    );
  }

  try {
    await request("duties.legacyTeam.clear", {
      ids: legacyRows.map((r) => (isRecord(r) ? r.id : undefined)).filter(Boolean),
    });
  } catch (error) {
    warnings.push(
      `Migrated legacy Team rows but could not clear the old copy: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  const message = `team: migrated ${imported.length} legacy Team ${imported.length === 1 ? "member" : "members"} from Duties' old roster storage (agentId/agentWorkspace dropped — everyone now shares the coordinator agent).`;
  if (logger?.info) {
    logger.info(message);
  } else {
    logger?.warn(message);
  }
  return { imported, warnings };
}
