import type { OpenClawPluginApi } from "../api.js";
import {
  sortTeamMembers,
  type NewTeamMember,
  type TeamChannelIdentity,
  type TeamMember,
} from "./team.js";

type Keyed<T> = {
  register(key: string, value: T): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  entries(): Promise<Array<{ key: string; value: T }>>;
  delete(key: string): Promise<boolean>;
};

export type TeamStores = {
  team: Keyed<TeamMember>;
};

/**
 * Team's own persistence: a single `team` namespace under this plugin's OWN `plugin_id` ("team"),
 * not `DutyStore`'s `team` namespace under `plugin_id: "duties"`. Distinct physical storage — see
 * `legacy-import.ts` for the one-time migration of rows that already exist under the old location on
 * an upgrading desk.
 */
export class TeamStore {
  constructor(private readonly stores: TeamStores) {}

  static open(api: OpenClawPluginApi): TeamStore {
    return new TeamStore({
      team: api.runtime.state.openKeyedStore<TeamMember>({
        namespace: "team",
        maxEntries: 200,
        overflowPolicy: "reject-new",
      }),
    });
  }

  async listMembers(): Promise<TeamMember[]> {
    const entries = await this.stores.team.entries();
    return sortTeamMembers(entries.map((e) => e.value));
  }
  getMember(id: string): Promise<TeamMember | undefined> {
    return this.stores.team.lookup(id);
  }
  async ownerMember(): Promise<TeamMember | undefined> {
    return (await this.listMembers()).find((m) => m.role === "owner");
  }

  /** Writes the one owner row on first read, and does nothing at all once any row exists. */
  async seedOwner(input: NewTeamMember): Promise<TeamMember> {
    const existing = await this.listMembers();
    const owner = existing.find((m) => m.role === "owner");
    if (owner) {
      return owner;
    }
    if (existing.length > 0) {
      throw new Error("Team has members but no owner — transfer ownership to repair the roster");
    }
    const now = Date.now();
    const member: TeamMember = { ...input, role: "owner", addedAt: now, updatedAt: now };
    await this.stores.team.register(member.id, member);
    return member;
  }

  /** Always writes `role: "member"`. `transferOwnership` is the only writer of `role: "owner"`. */
  async addMember(input: NewTeamMember): Promise<TeamMember> {
    if (await this.stores.team.lookup(input.id)) {
      throw new Error(`Team already has a member "${input.id}"`);
    }
    const now = Date.now();
    const member: TeamMember = { ...input, role: "member", addedAt: now, updatedAt: now };
    await this.stores.team.register(member.id, member);
    return member;
  }

  async removeMember(id: string): Promise<boolean> {
    const member = await this.stores.team.lookup(id);
    if (!member) {
      return false;
    }
    if (member.role === "owner") {
      throw new Error("transfer ownership before removing the owner");
    }
    return this.stores.team.delete(id);
  }

  async setMemberChannels(
    id: string,
    channels: TeamChannelIdentity[],
  ): Promise<TeamMember | undefined> {
    const member = await this.stores.team.lookup(id);
    if (!member) {
      return undefined;
    }
    const next: TeamMember = { ...member, channels, updatedAt: Date.now() };
    await this.stores.team.register(id, next);
    return next;
  }

  /** Writes a Team row back exactly as given, bypassing every business rule this store otherwise
   *  enforces (role invariants, uniqueness, lookup-then-merge). Rollback-only: a caller that
   *  already holds the exact prior row (fetched before its own durable mutation) uses this to undo
   *  that mutation when a subsequent step fails — `gateway-methods.ts`'s `team.setChannels`,
   *  `.remove` and `.transferOwnership` roll back this way when the config projection that follows
   *  their store write is rejected, so "a rejected write leaves everything unchanged" holds for the
   *  roster row too, not just the config file. */
  async restoreMember(member: TeamMember): Promise<void> {
    await this.stores.team.register(member.id, member);
  }

  /** The one writer of `role`. Both rows move in one pass so the exactly-one-owner invariant is
   *  never observable as broken; the outgoing owner keeps their identities and admission. */
  async transferOwnership(toMemberId: string): Promise<{ from: TeamMember; to: TeamMember }> {
    const target = await this.stores.team.lookup(toMemberId);
    if (!target) {
      throw new Error(`no Team member "${toMemberId}"`);
    }
    const current = await this.ownerMember();
    if (!current) {
      throw new Error("Team has no owner to transfer from");
    }
    if (current.id === toMemberId) {
      throw new Error(`${target.name} is already the owner`);
    }
    const now = Date.now();
    const from: TeamMember = { ...current, role: "member", updatedAt: now };
    const to: TeamMember = { ...target, role: "owner", updatedAt: now };
    await this.stores.team.register(from.id, from);
    await this.stores.team.register(to.id, to);
    return { from, to };
  }
}
