/**
 * Reads the health file a hosted desk's `desk-health.timer` writes every two minutes
 * (`deploy/desk/desk-health.sh`, spec §4.8/§8): the Gateway, virtual display, Chromium and
 * Tailscale reachability checks, whether the mail watcher hook is wired, and basic load/memory —
 * everything the "Desk" card on the Duties page and `openclaw duties setup` need to show.
 *
 * A non-hosted install (the common case: a laptop, or any Gateway that isn't a desk) simply has
 * no file at this path, which is exactly what `{ hosted: false }` means — this is never an error
 * an owner needs to act on.
 */
import { readFile } from "node:fs/promises";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type DeskHealth = {
  hosted: boolean;
  at?: number;
  gateway?: boolean;
  display?: boolean;
  chromium?: boolean;
  tailscale?: boolean;
  mailWatcher?: boolean;
  load1?: number;
  memFreeMb?: number;
};

/** Overridable for a desk whose state lives somewhere other than the default system path (tests,
 *  and any future non-standard install). */
export const DESK_HEALTH_PATH =
  process.env.DUTIES_DESK_HEALTH ?? "/var/lib/openclaw/desk-health.json";

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Reads and validates the health file field by field — a field of the wrong type is dropped
 *  rather than passed through, since every reader downstream (the Desk card, `duties.desk.status`,
 *  `openclaw duties setup`) treats an absent field as "unknown", never as a stale wrong-shaped
 *  value. `hosted` is always `true` here: reaching this point means the file existed and parsed
 *  as an object, which only happens on an actual hosted desk (`hosted: false` is reserved for the
 *  absent/unparseable case in `readDeskHealth` below). */
function toDeskHealth(parsed: Record<string, unknown>): DeskHealth {
  const at = numberField(parsed.at);
  const gateway = boolField(parsed.gateway);
  const display = boolField(parsed.display);
  const chromium = boolField(parsed.chromium);
  const tailscale = boolField(parsed.tailscale);
  const mailWatcher = boolField(parsed.mailWatcher);
  const load1 = numberField(parsed.load1);
  const memFreeMb = numberField(parsed.memFreeMb);
  return {
    hosted: true,
    ...(at !== undefined ? { at } : {}),
    ...(gateway !== undefined ? { gateway } : {}),
    ...(display !== undefined ? { display } : {}),
    ...(chromium !== undefined ? { chromium } : {}),
    ...(tailscale !== undefined ? { tailscale } : {}),
    ...(mailWatcher !== undefined ? { mailWatcher } : {}),
    ...(load1 !== undefined ? { load1 } : {}),
    ...(memFreeMb !== undefined ? { memFreeMb } : {}),
  };
}

/** Absent, unreadable, or unparseable (not valid JSON, or not a JSON object) all mean the same
 *  thing to every caller: this is not a hosted desk, so answer `{ hosted: false }` rather than
 *  throwing — a health readout is never a reason to fail the Gateway method, the CLI command, or
 *  the Duties page that reads it. */
export async function readDeskHealth(filePath = DESK_HEALTH_PATH): Promise<DeskHealth> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { hosted: false };
    return toDeskHealth(parsed);
  } catch {
    return { hosted: false };
  }
}
