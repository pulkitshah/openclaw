import type { OpenClawPluginApi } from "../api.js";

/** Leaf contract shared by `gateway-methods.ts` and `team-gateway-methods.ts` so neither imports
 *  the other for these types — that produced a Madge-flagged import cycle even though the cross
 *  import was type-only. */
export type Ctx = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];
export type Scope = "operator.read" | "operator.write" | "operator.admin";
