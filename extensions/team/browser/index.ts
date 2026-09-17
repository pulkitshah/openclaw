import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createTeamPageMount } from "./team-page.js";
import "./styles.css";

const PAGE = "team";

export default defineControlUiPlugin({
  id: "team",
  activate(host: ControlUiHost) {
    // Team's own top-level sidebar entry, directly below Duties (order 16) — a distinct concept
    // from Duties (automations), not a card inside another plugin's page. Moved here whole from
    // `extensions/duties/browser/index.ts` (Team v2 Task 1).
    const unregisterNav = host.ui.registerNavigation({
      id: "team",
      label: "Team",
      page: { id: PAGE },
      icon: "users",
      order: 16,
    });
    const unregisterPage = host.ui.registerPage({
      id: PAGE,
      label: "Team",
      mount: createTeamPageMount(host),
    });

    return () => {
      unregisterPage();
      unregisterNav();
    };
  },
});
