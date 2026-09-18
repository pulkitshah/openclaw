/**
 * Whether a Gateway request came from the agent itself rather than a real operator.
 *
 * The Gateway authorizes by scope, and an agent-originated request mints its own synthetic client
 * with exactly the scopes the called method requires
 * (`src/agents/tools/in-process-gateway.ts:227`), so scopes alone cannot tell the two apart. This
 * predicate is the one place that distinction is read; `authorizeGatewayMethod`
 * (`src/gateway/server-methods.ts`) is its only consumer today.
 *
 * Both markers are host-attested and never accepted from wire params:
 *  - `agentOriginated` is stamped by built-in agent tool dispatch on the synthetic client it builds.
 *  - `agentRuntimeIdentity` is the verified `AgentRuntimeIdentity` a worker or subagent presents on
 *    connect (`src/gateway/server/ws-connection/connect-session.ts:333-389`), which only an agent
 *    runtime holds.
 *
 * A few host paths reuse the agent-tool dispatch helper for work a person triggered — question
 * resolution from a chat button (`src/infra/question-gateway-resolver.ts:107`) and agent-run waits
 * (`src/agents/run-wait.ts`) — so they are marked too. That is harmless because the marker only gates
 * the narrow denied-method table and those methods are not in it; widening that table means checking
 * these callers first.
 *
 * KNOWN GAP (deliberately out of scope this round): a request the agent makes over the loopback
 * transport while presenting the operator's own `gateway.auth.token` carries neither marker and is
 * indistinguishable from an operator here. Closing that needs the token to be unreadable from the
 * agent's exec context; see `docs/tools/exec-approvals.md`.
 */
import type { GatewayClient } from "./server-methods/client-types.js";

/** Error detail code returned when a denied method is refused because the agent asked for it. */
export const AGENT_ORIGIN_FORBIDDEN_DETAIL_CODE = "AGENT_ORIGIN_FORBIDDEN";

/** Returns true when the agent, not an operator, is the origin of this request. */
export function isAgentOriginatedGatewayRequest(client: GatewayClient | null | undefined): boolean {
  const internal = client?.internal;
  if (!internal) {
    return false;
  }
  return internal.agentOriginated === true || internal.agentRuntimeIdentity !== undefined;
}
