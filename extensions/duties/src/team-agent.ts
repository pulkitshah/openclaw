/**
 * Provisions one Team member's dedicated agent.
 *
 * `createAgent` (`src/agents/agent-create.ts`) is the single writer every other path funnels
 * through, so Duties calls it rather than reimplementing it — over the Gateway, as
 * `agents.create`, which re-enters the normal `authorizeGatewayMethod` scope check
 * (`operator.admin`, `src/gateway/methods/core-descriptors.ts:185`).
 *
 * `dispatchGatewayMethod` from `openclaw/plugin-sdk/gateway-method-runtime` CANNOT be used here: it
 * throws unless the caller is a plugin HTTP route that declared
 * `contracts.gatewayMethodDispatch` (`src/plugin-sdk/gateway-method-runtime.ts:50-58`, flag set only
 * at `src/plugins/registry-registrars-network.ts:180`). The trusted in-process seam this plugin
 * already uses is `api.runtime.gateway.request` (`extensions/duties/index.ts:111-112`).
 *
 * Provisioning is EAGER, at add time, never lazily on first message: lazy creation would run a
 * config mutation from the inbound hot path, which `src/agents/AGENTS.md` warns against, and two
 * simultaneous first messages would race the same write.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type GatewayRequest = <T = unknown>(
  method: string,
  params: Record<string, unknown>,
) => Promise<T>;

export type ProvisionedAgent = { agentId: string; workspace: string };

/**
 * No `workspace` and no `model` are passed, and that is the point.
 *
 * Workspace: `resolveAgentWorkspaceDir` then gives `<agents.defaults.workspace>/<agentId>` when that
 * default is set, else `<stateDir>/workspace-<agentId>` — its own AGENTS.md, SOUL.md, MEMORY.md and
 * git repo, separate from the owner's by construction.
 *
 * Model: resolved through `agents.defaults.models`, which on a desk maps every Anthropic model to
 * `agentRuntime: { id: "claude-cli" }` — so the member's agent runs on the owner's existing
 * subscription with no second login.
 *
 * Bootstrap: `createAgent` withholds the IDENTITY.md write while bootstrap is pending, so the
 * member's very first message runs the BOOTSTRAP birth sequence — their assistant asks them what to
 * call it. That ritual is not Team-specific code; it is reached by not skipping it.
 */
export async function provisionMemberAgent(params: {
  request: GatewayRequest;
  name: string;
}): Promise<ProvisionedAgent> {
  const reply = await params
    .request("agents.create", { name: params.name })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message)) {
        throw new Error(
          `There is already an agent called "${params.name}" — give this member a different name.`,
        );
      }
      throw error;
    });
  const agentId = isRecord(reply) && typeof reply.agentId === "string" ? reply.agentId : "";
  if (!agentId) {
    throw new Error(`could not create an assistant for ${params.name} — nothing was created`);
  }
  const workspace = isRecord(reply) && typeof reply.workspace === "string" ? reply.workspace : "";
  return { agentId, workspace };
}

/**
 * Whether this member's agent has still to run its first-turn naming ceremony.
 *
 * `agents.create`'s RPC reply carries no `bootstrapPending` (only `createAgent`'s in-process result
 * does, `src/agents/agent-create.ts:44-53`), and `agents.list` does not either — so it is read from
 * the workspace, where `ensureAgentWorkspace({ ensureBootstrapFiles: true })` seeds BOOTSTRAP.md and
 * the ritual deletes it when it completes.
 */
export async function readBootstrapPending(workspace: string | undefined): Promise<boolean> {
  if (!workspace) {
    return false;
  }
  const info = await stat(path.join(workspace, "BOOTSTRAP.md")).catch(() => undefined);
  return info?.isFile() === true;
}
