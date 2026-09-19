// Gateway method authorization scope resolver.
// Maps static and plugin-defined gateway methods to operator scopes.
import { normalizeOptionalString as normalizeSessionActionParam } from "@openclaw/normalization-core/string-coerce";
import {
  isAdminOnlyNodeInvokeCommand,
  isBrowserProxyNodeInvokeCommand,
} from "../infra/node-commands.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { resolveReservedGatewayMethodScope } from "../shared/gateway-method-policy.js";
import { resolveDynamicSessionMutationRequiredScope } from "../shared/session-method-scopes.js";
import { isAgentSessionResetCommand } from "./agent-command-policy.js";
import {
  isCoreGatewayMethodClassified,
  isCoreNodeGatewayMethod,
  isDynamicOperatorGatewayMethod,
  resolveCoreOperatorGatewayMethodScope,
} from "./methods/core-descriptors.js";
import { isForbiddenBrowserProxyMutation } from "./node-browser-proxy-policy.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  TALK_SCOPE,
  TALK_SECRETS_SCOPE,
  WRITE_SCOPE,
  isOperatorScope,
  type OperatorScope,
} from "./operator-scopes.js";

export {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  TALK_SCOPE,
  WRITE_SCOPE,
  type OperatorScope,
};

/** Default scopes granted to CLI/operator clients when no narrower local policy is known. */
export const CLI_DEFAULT_OPERATOR_SCOPES: OperatorScope[] = [
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  QUESTIONS_SCOPE,
  PAIRING_SCOPE,
  TALK_SECRETS_SCOPE,
];

/**
 * How each channel-pairing Gateway method is classified for an agent-originated request.
 *
 * Channel pairing is the door a NEW PERSON walks through to start instructing the agent, so
 * approving or refusing one is the operator's decision, not the agent's. `authorizeGatewayMethod`
 * (`src/gateway/server-methods.ts`) denies the `"deny"` entries to agent-originated requests before
 * the `operator.admin` wildcard is consulted, so no scope set the agent can present reaches them —
 * not `operator.pairing`, not `operator.admin`.
 *
 * `channels.pairing.list` stays reachable on purpose: telling the owner who is waiting is useful and
 * grants nobody access. `src/gateway/method-scopes.agent-originated.test.ts` fails if a future
 * channel-pairing method is added without a classification here.
 *
 * Scope of the fence: it keys on request origin, so a bundled or trusted-official plugin's own
 * `api.runtime.gateway.request` is NOT marked and stays allowed. That is the intended line — a plugin
 * hard-codes its method and scopes, while the agent's dispatch mints whatever the method asks for.
 * `dispatchTrustedPluginGatewayMethod` (`server-plugins.ts`) is what makes that structural rather
 * than incidental: it always sets `forceSyntheticClient: true`, so the client is rebuilt from its own
 * options and cannot inherit an outer marked client through the ambient request scope. One bundled
 * plugin does use this: Team's `team.add` calls `channels.pairing.list` and then
 * `channels.pairing.approve` for a pending request whose sender the same call puts on the roster
 * (the Team plugin's team-write module), so the agent-reachable `team_add` tool ends in an approval
 * by design. Its own authority check is the owner gate in that plugin's tool surface, not this
 * table — the `team.*` methods themselves are reachable with `operator.admin` alone.
 *
 * This table is deliberately narrow. It is NOT "every `operator.pairing` method": `node.pair.approve`
 * and `device.pair.approve` share that scope but attach hardware the owner already holds, and the
 * core `nodes` agent tool approves them today (`src/agents/tools/nodes-tool.ts:213-231`). Widening
 * this to the whole scope would retire that shipped capability, which is a separate product decision.
 */
const CHANNEL_PAIRING_AGENT_ACCESS: Readonly<Record<string, "allow" | "deny">> = {
  "channels.pairing.list": "allow",
  "channels.pairing.approve": "deny",
  "channels.pairing.dismiss": "deny",
};

/** Channel-pairing methods classified above, for the exhaustiveness guard test. */
export function listAgentAccessClassifiedChannelPairingMethods(): string[] {
  return Object.keys(CHANNEL_PAIRING_AGENT_ACCESS);
}

/** Returns true when no agent-originated request may invoke this method, whatever scopes it holds. */
export function isAgentDeniedPrivilegedGatewayMethod(method: string): boolean {
  return CHANNEL_PAIRING_AGENT_ACCESS[method] === "deny";
}

function resolveScopedMethod(method: string): OperatorScope | undefined {
  // Node/dynamic sentinels are not operator scopes.
  const explicitScope = resolveCoreOperatorGatewayMethodScope(method);
  if (explicitScope) {
    return explicitScope;
  }
  const reservedScope = resolveReservedGatewayMethodScope(method);
  if (reservedScope) {
    return reservedScope;
  }
  const pluginDescriptor = getPluginRegistryForContext()?.gatewayMethodDescriptors?.find(
    (descriptor) => descriptor.name === method,
  );
  const pluginScope = pluginDescriptor?.scope;
  return pluginScope === "node" || pluginScope === "dynamic" ? undefined : pluginScope;
}

/** Returns true when a method requires the approvals operator scope. */
export function isApprovalMethod(method: string): boolean {
  return resolveScopedMethod(method) === APPROVALS_SCOPE;
}

/** Returns true when a method is reserved for node-role clients instead of operators. */
export function isNodeRoleMethod(method: string): boolean {
  return isCoreNodeGatewayMethod(method);
}

/** Resolves the required static operator scope for a gateway method, if one exists. */
function resolveRequiredOperatorScopeForMethod(method: string): OperatorScope | undefined {
  return resolveScopedMethod(method);
}

function resolveSessionActionRegisteredScopes(params: unknown): OperatorScope[] | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const pluginId = normalizeSessionActionParam((params as { pluginId?: unknown }).pluginId);
  const actionId = normalizeSessionActionParam((params as { actionId?: unknown }).actionId);
  if (!pluginId || !actionId) {
    return undefined;
  }
  const registration = getPluginRegistryForContext()?.sessionActions?.find(
    (entry) => entry.pluginId === pluginId && entry.action.id === actionId,
  );
  if (!registration) {
    return undefined;
  }
  const requiredScopes = registration.action.requiredScopes;
  // Registered session actions default to write scope when they omit a custom
  // requirement; this preserves the historical mutation boundary.
  return requiredScopes && requiredScopes.length > 0 ? [...requiredScopes] : [WRITE_SCOPE];
}

function resolveSessionActionLeastPrivilegeScopes(params: unknown): OperatorScope[] {
  const registeredScopes = resolveSessionActionRegisteredScopes(params);
  if (registeredScopes) {
    return registeredScopes;
  }
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const pluginId = normalizeSessionActionParam((params as { pluginId?: unknown }).pluginId);
    const actionId = normalizeSessionActionParam((params as { actionId?: unknown }).actionId);
    if (pluginId && actionId) {
      // A standalone CLI/tool caller may be talking to a gateway whose live
      // plugin registry is not present in this local process. Avoid under-scoping
      // valid dynamic actions when we cannot determine the exact requirement
      // locally.
      return [...CLI_DEFAULT_OPERATOR_SCOPES];
    }
  }
  return [WRITE_SCOPE];
}

function resolveDynamicLeastPrivilegeOperatorScopesForMethod(
  method: string,
  params: unknown,
): OperatorScope[] {
  // Dynamic methods derive authorization from params and live plugin registrations instead of
  // a single static method scope.
  if (method === "plugins.sessionAction") {
    return resolveSessionActionLeastPrivilegeScopes(params);
  }
  if (method === "agent") {
    const message =
      params && typeof params === "object" && !Array.isArray(params)
        ? (params as { message?: unknown }).message
        : undefined;
    return isAgentSessionResetCommand(message) ? [ADMIN_SCOPE] : [WRITE_SCOPE];
  }
  if (method === "node.invoke") {
    const record =
      params && typeof params === "object" && !Array.isArray(params)
        ? (params as { command?: unknown; params?: unknown })
        : undefined;
    const command = record?.command;
    // Invalid persistent-profile mutations must reach the handler's precise fail-closed
    // rejection instead of being disguised as an admin-scope failure.
    if (
      isBrowserProxyNodeInvokeCommand(command) &&
      isForbiddenBrowserProxyMutation(record?.params)
    ) {
      return [WRITE_SCOPE];
    }
    return isAdminOnlyNodeInvokeCommand(command) ? [ADMIN_SCOPE] : [WRITE_SCOPE];
  }
  if (method === "talk.config") {
    const includeSecrets =
      params && typeof params === "object" && !Array.isArray(params)
        ? (params as { includeSecrets?: unknown }).includeSecrets
        : undefined;
    return includeSecrets === true ? [READ_SCOPE, TALK_SECRETS_SCOPE] : [READ_SCOPE];
  }
  if (method === "environments.list") {
    const runtimeId =
      params && typeof params === "object" && !Array.isArray(params) && "runtimeId" in params
        ? params.runtimeId
        : undefined;
    // Match the handler: every nonempty runtime ID needs command eligibility access.
    return typeof runtimeId === "string" && runtimeId ? [WRITE_SCOPE] : [READ_SCOPE];
  }
  if (method === "channels.pairing.approve") {
    const bootstrapCommandOwner =
      params && typeof params === "object" && !Array.isArray(params)
        ? (params as { bootstrapCommandOwner?: unknown }).bootstrapCommandOwner
        : undefined;
    return bootstrapCommandOwner === true ? [PAIRING_SCOPE, ADMIN_SCOPE] : [PAIRING_SCOPE];
  }
  if (method === "fs.listDir") {
    const targetsNode =
      params !== null &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      Object.hasOwn(params, "nodeId");
    return [targetsNode ? ADMIN_SCOPE : WRITE_SCOPE];
  }
  if (method === "sessions.patch") {
    return [resolveDynamicSessionMutationRequiredScope(method, params) ?? WRITE_SCOPE];
  }
  if (method === "sessions.patchMany") {
    return [resolveDynamicSessionMutationRequiredScope(method, params) ?? WRITE_SCOPE];
  }
  if (method === "sessions.create") {
    return [resolveDynamicSessionMutationRequiredScope(method, params) ?? WRITE_SCOPE];
  }
  if (method === "sessions.dispatch") {
    return [resolveDynamicSessionMutationRequiredScope(method, params) ?? WRITE_SCOPE];
  }
  if (method === "sessions.move") {
    return [resolveDynamicSessionMutationRequiredScope(method, params) ?? WRITE_SCOPE];
  }
  if (method === "sessions.delete") {
    return [resolveDynamicSessionMutationRequiredScope(method, params) ?? ADMIN_SCOPE];
  }
  return [WRITE_SCOPE];
}

function findMissingOperatorScope(
  requiredScopes: readonly OperatorScope[],
  scopes: readonly string[],
): OperatorScope | undefined {
  return requiredScopes.find(
    (scope) => !authorizeOperatorScopesForRequiredScope(scope, scopes).allowed,
  );
}

/** Returns the narrowest known operator scopes needed to call a gateway method. */
export function resolveLeastPrivilegeOperatorScopesForMethod(
  method: string,
  params?: unknown,
): OperatorScope[] {
  if (isDynamicOperatorGatewayMethod(method)) {
    return resolveDynamicLeastPrivilegeOperatorScopesForMethod(method, params);
  }
  const requiredScope = resolveRequiredOperatorScopeForMethod(method);
  if (requiredScope) {
    return [requiredScope];
  }
  // Default-deny for unclassified methods.
  return [];
}

/** Checks whether a presented operator scope set authorizes a gateway method call. */
export function authorizeOperatorScopesForMethod(
  method: string,
  scopes: readonly string[],
  params?: unknown,
): { allowed: true } | { allowed: false; missingScope: OperatorScope } {
  if (scopes.includes(ADMIN_SCOPE)) {
    return { allowed: true };
  }
  if (isDynamicOperatorGatewayMethod(method)) {
    if (method === "plugins.sessionAction") {
      const registeredScopes = resolveSessionActionRegisteredScopes(params);
      if (!registeredScopes && params && typeof params === "object" && !Array.isArray(params)) {
        const pluginId = normalizeSessionActionParam((params as { pluginId?: unknown }).pluginId);
        const actionId = normalizeSessionActionParam((params as { actionId?: unknown }).actionId);
        if (!pluginId || !actionId) {
          // Malformed dynamic params cannot be matched to a plugin action. Any valid operator scope
          // may proceed so the handler can return the precise validation error.
          return scopes.some((scope) => isOperatorScope(scope))
            ? { allowed: true }
            : { allowed: false, missingScope: WRITE_SCOPE };
        }
      }
      const missingScope = findMissingOperatorScope(registeredScopes ?? [WRITE_SCOPE], scopes);
      return missingScope ? { allowed: false, missingScope } : { allowed: true };
    }
    const missingScope = findMissingOperatorScope(
      resolveDynamicLeastPrivilegeOperatorScopesForMethod(method, params),
      scopes,
    );
    return missingScope ? { allowed: false, missingScope } : { allowed: true };
  }
  const requiredScope = resolveRequiredOperatorScopeForMethod(method) ?? ADMIN_SCOPE;
  return authorizeOperatorScopesForRequiredScope(requiredScope, scopes);
}

/** Checks a method registry's already-resolved static scope against presented operator scopes. */
export function authorizeOperatorScopesForRequiredScope(
  requiredScope: OperatorScope,
  scopes: readonly string[],
): { allowed: true } | { allowed: false; missingScope: OperatorScope } {
  if (scopes.includes(ADMIN_SCOPE)) {
    return { allowed: true };
  }
  if (requiredScope === READ_SCOPE) {
    if (scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE)) {
      return { allowed: true };
    }
    return { allowed: false, missingScope: READ_SCOPE };
  }
  if (requiredScope === TALK_SCOPE) {
    if (scopes.includes(TALK_SCOPE) || scopes.includes(WRITE_SCOPE)) {
      return { allowed: true };
    }
    return { allowed: false, missingScope: TALK_SCOPE };
  }
  if (scopes.includes(requiredScope)) {
    return { allowed: true };
  }
  return { allowed: false, missingScope: requiredScope };
}

/** Returns true when a method has any core, node, dynamic, reserved, or plugin scope policy. */
export function isGatewayMethodClassified(method: string): boolean {
  if (isNodeRoleMethod(method)) {
    return true;
  }
  if (isDynamicOperatorGatewayMethod(method)) {
    return true;
  }
  return (
    isCoreGatewayMethodClassified(method) ||
    resolveRequiredOperatorScopeForMethod(method) !== undefined
  );
}
