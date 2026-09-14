import { definePage, redirect } from "@openclaw/uirouter";
import { html } from "lit";
import { pathForRoute, routePageSpec } from "../../app-route-paths.ts";
import { FEATURES } from "../../app/brand.ts";
import type { ApplicationContext } from "../../app/context.ts";

export const page = definePage({
  ...routePageSpec("lobsterdex"),
  // A build without LobsterDex keeps the path registered and sends it home, so
  // a bookmark or an old link lands somewhere useful instead of on Not found.
  loader: (context: ApplicationContext, { location }) =>
    FEATURES.lobsterDex
      ? undefined
      : redirect({ ...location, pathname: pathForRoute("chat", context.basePath) }),
  component: () =>
    import("./lobsterdex-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-lobsterdex-page></openclaw-lobsterdex-page>`,
    })),
});
