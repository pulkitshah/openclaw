// Team roster mutations for the Duties Control UI page: the DOM-reading actions behind the Team
// panel's add-someone / add-a-channel / remove / transfer controls. Split out of index.ts's
// mount() to stay under the extensions max-lines budget — this can't fold into data-loaders.ts
// (that module's own comment: loaders only need the host, the live view context and page state,
// never the DOM root), so it is a second, DOM-owning seam alongside it, scoped to one
// responsibility: every write `duties.team.*` accepts.
import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import type { Props } from "./index-helpers.js";
import type { TeamView } from "./render.js";

export function createTeamActions(deps: {
  host: ControlUiHost;
  getContext: () => ControlUiViewContext<Props>;
  root: HTMLElement;
  getTeam: () => TeamView | undefined;
  clearError: () => void;
  loadTeam: () => Promise<void>;
  fail: (error: unknown, retry: () => void) => void;
}) {
  const { host, getContext, root, getTeam, clearError, loadTeam, fail } = deps;

  const addTeamMember = async (): Promise<void> => {
    const name = root.querySelector<HTMLInputElement>("[data-team-name]")?.value.trim() ?? "";
    const channel = root.querySelector<HTMLSelectElement>("[data-team-channel]")?.value ?? "";
    const senderId = root.querySelector<HTMLInputElement>("[data-team-sender]")?.value.trim() ?? "";
    if (!name || !channel || !senderId) {
      fail(new Error("Enter a name, a channel and their id on that channel."), () => undefined);
      return;
    }
    try {
      await host.request("duties.team.add", { name, channels: [{ channel, senderId }] });
      if (getContext().signal.aborted) {
        return;
      }
      clearError();
      await loadTeam();
    } catch (error) {
      // A refusal (no channel-wide binding, a channel that would be narrowed, an agent name
      // collision) carries the whole message and the fix; show it rather than a generic one.
      fail(error, () => undefined);
    }
  };

  const removeTeamMember = async (memberId: string): Promise<void> => {
    try {
      await host.request("duties.team.remove", { memberId });
      if (getContext().signal.aborted) {
        return;
      }
      clearError();
      await loadTeam();
    } catch (error) {
      fail(error, () => void removeTeamMember(memberId));
    }
  };

  /** `duties.team.transferOwnership` also flips `settings.owner` server-side and emits
   *  `{ team: true, settings: true }` (`gateway-methods.ts`) — this page only re-reads its own
   *  `team` slice; the "duties" page's board owns `settings` and refreshes it independently off
   *  that same event when it is the one mounted, so there is nothing for this page to fetch or
   *  hold onto for a field it never renders. */
  const transferTeamOwnership = async (memberId: string): Promise<void> => {
    try {
      await host.request("duties.team.transferOwnership", { memberId });
      if (getContext().signal.aborted) {
        return;
      }
      clearError();
      await loadTeam();
    } catch (error) {
      fail(error, () => void transferTeamOwnership(memberId));
    }
  };

  /** `setChannels` REPLACES a member's whole identity list, so the existing identities are sent
   *  back with it — each one whole, `accountId` included, or an identity scoped to one channel
   *  account would come back as an unscoped `"*"` match the next time any channel is added to that
   *  row (final review I7). Any identity for the same channel is replaced rather than duplicated:
   *  one id per channel. The `c.senderId` guard is never live here — this only runs behind
   *  `canAdmin`, where `duties.team.get` returns every sender id in full — but it keeps this
   *  function honest against `TeamMemberView`'s optional field. */
  const addTeamChannel = async (memberId: string): Promise<void> => {
    const member = getTeam()?.members.find((m) => m.id === memberId);
    const channel =
      root.querySelector<HTMLSelectElement>(`[data-team-row-channel="${memberId}"]`)?.value ?? "";
    const senderId =
      root.querySelector<HTMLInputElement>(`[data-team-row-sender="${memberId}"]`)?.value.trim() ??
      "";
    if (!member || !channel || !senderId) {
      fail(new Error("Choose a channel and enter their id on it."), () => undefined);
      return;
    }
    const kept: Array<{ channel: string; senderId: string; accountId?: string }> = [];
    for (const c of member.channels) {
      if (c.channel === channel || !c.senderId) continue;
      kept.push({
        channel: c.channel,
        senderId: c.senderId,
        ...(c.accountId ? { accountId: c.accountId } : {}),
      });
    }
    const channels = [...kept, { channel, senderId }];
    try {
      await host.request("duties.team.setChannels", { memberId, channels });
      if (getContext().signal.aborted) {
        return;
      }
      clearError();
      await loadTeam();
    } catch (error) {
      fail(error, () => undefined);
    }
  };

  /**
   * The empty-roster path: "Tell Vasu where to reach you" makes the very first person the owner.
   *
   * `teamPanel`'s `ownerSettingsForm` renders on THIS page now (Task 10 moved it here with the rest
   * of Team), so the save it needs lives here too — the Duties page's own `saveSettings` read its
   * own DOM root, which no longer contains this form, leaving a brand-new desk with no way at all to
   * set its owner (final review C3). `duties.settings.set` is the same one owner of "who the desk
   * reports to" that form has always written to; it also seeds the roster's owner row, so reloading
   * the team afterwards replaces the form with the roster.
   */
  const saveOwnerSettings = async (): Promise<void> => {
    const channel = root.querySelector<HTMLSelectElement>("[data-settings-channel]")?.value ?? "";
    const target =
      root.querySelector<HTMLInputElement>("[data-settings-target]")?.value.trim() ?? "";
    if (!channel || !target) {
      fail(new Error("Choose a channel and enter a target."), () => undefined);
      return;
    }
    try {
      await host.request("duties.settings.set", { owner: { channel, target } });
      if (getContext().signal.aborted) {
        return;
      }
      clearError();
      await loadTeam();
    } catch (error) {
      fail(error, () => void saveOwnerSettings());
    }
  };

  return {
    addTeamMember,
    removeTeamMember,
    transferTeamOwnership,
    addTeamChannel,
    saveOwnerSettings,
  };
}
