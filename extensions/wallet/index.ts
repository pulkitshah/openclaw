import type { OpenClawPluginApi } from "./api.js";
export default function register(api: OpenClawPluginApi): void {
  if (api.registrationMode !== "full") return; // tool-discovery / cli-metadata modes add nothing yet (Task 10 adds the tool)
  void api;
}
