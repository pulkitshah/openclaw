import type { OpenClawPluginApi } from "../api.js";

export type Ctx = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];
export type Scope = "operator.read" | "operator.write" | "operator.admin";
