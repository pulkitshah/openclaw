import type { OpenClawPluginApi } from "../api.js";

/** The shape `gateway-methods.ts`'s `register` closure hands every handler. */
export type Ctx = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];
export type Scope = "operator.read" | "operator.write" | "operator.admin";
