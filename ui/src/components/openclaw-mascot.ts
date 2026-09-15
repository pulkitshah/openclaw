import { VasuOrb } from "./vasu-orb.ts";

/** The hero size the mascot shipped with; every current call site passes its own. */
const DEFAULT_SIZE = 120;

/** `<openclaw-mascot>` is the orb under the element name its surfaces already
 * use. The mascot carried a live mood (idle/thinking/sleepy) on the channels,
 * custodian and assistant panels, and the orb owns that vocabulary now, so the
 * name stays as an alias: the `mood`/`size` contract and the light-DOM CSS hooks
 * (`.custodian__mark openclaw-mascot`, `.agent-chat__welcome-clawd
 * openclaw-mascot`) keep working untouched. */
class OpenClawMascot extends VasuOrb {
  constructor() {
    super();
    this.size = DEFAULT_SIZE;
  }
}

if (!customElements.get("openclaw-mascot")) {
  customElements.define("openclaw-mascot", OpenClawMascot);
}
