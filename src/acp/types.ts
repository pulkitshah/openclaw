/** ACP protocol helpers and Vasudev agent identity metadata. */
import { VERSION } from "../version.js";
export { normalizeAcpProvenanceMode } from "@openclaw/acp-core/types";

/** ACP agent identity advertised during protocol initialization. */
export const ACP_AGENT_INFO = {
  name: "openclaw-acp",
  title: "Vasudev ACP Gateway",
  version: VERSION,
};
