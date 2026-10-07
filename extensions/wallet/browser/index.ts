import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createWalletPageMount } from "./wallet-page.js";
import "./styles.css";

const PAGE = "wallet";

export default defineControlUiPlugin({
  id: "wallet",
  activate(host: ControlUiHost) {
    // Directly below Team (order 16): where the desk's money went, not a card inside another page.
    const unregisterNav = host.ui.registerNavigation({
      id: "wallet",
      label: "Wallet",
      page: { id: PAGE },
      icon: "coins",
      order: 17,
    });
    const unregisterPage = host.ui.registerPage({
      id: PAGE,
      label: "Wallet",
      mount: createWalletPageMount(host),
    });

    return () => {
      unregisterPage();
      unregisterNav();
    };
  },
});
