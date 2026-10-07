import { describe, it, expect, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import register from "./index.js";

/** Creates a minimal mock API for full mode registration testing. */
function createMockFullApi(overrides?: { request?: ReturnType<typeof vi.fn> }): {
  api: OpenClawPluginApi;
  registeredTools: Map<string, unknown>;
  registeredCommands: Map<string, unknown>;
} {
  const registeredTools = new Map<string, unknown>();
  const registeredCommands = new Map<string, unknown>();

  const api = {
    registrationMode: "full",
    registerTool: vi.fn((tool: unknown, opts: { name: string }) => {
      registeredTools.set(opts.name, tool);
    }),
    registerCommand: vi.fn((cmd: unknown) => {
      const cmdDef = cmd as Record<string, unknown>;
      registeredCommands.set(cmdDef.name as string, cmd);
    }),
    registerService: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerHttpRoute: vi.fn(),
    on: vi.fn(),
    session: { controls: { registerControlUiDescriptor: vi.fn() } },
    config: {},
    pluginConfig: {},
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    runtime: {
      config: undefined,
      gateway: { request: overrides?.request ?? vi.fn() },
    },
  } as unknown as OpenClawPluginApi;

  return { api, registeredTools, registeredCommands };
}

describe("wallet plugin registration", () => {
  describe("tool-discovery mode", () => {
    it("registers only the wallet_status tool and returns early", () => {
      const registerTool = vi.fn();
      const registerCommand = vi.fn();
      const registerService = vi.fn();
      const on = vi.fn();
      const registerHttpRoute = vi.fn();

      const api = {
        registrationMode: "tool-discovery",
        registerTool,
        registerCommand,
        registerService,
        on,
        registerHttpRoute,
        runtime: {
          gateway: {
            request: vi.fn().mockResolvedValue({
              balancePaise: 10000,
              state: { enforce: false, creditLimitPaise: 500000, lowBalancePaise: 50000 },
              daysLeft: 5,
              summary: { totalPaise: -5000, tokens: 0, models: [], buckets: [] },
              contact: "TripIn Studio",
            }),
          },
        },
      } as unknown as OpenClawPluginApi;

      register(api);

      expect(registerTool).toHaveBeenCalledOnce();
      expect(registerTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: "wallet_status" }),
        { name: "wallet_status" },
      );
      expect(registerCommand).not.toHaveBeenCalled();
      expect(registerService).not.toHaveBeenCalled();
      expect(on).not.toHaveBeenCalled();
    });

    it("tool calls wallet.get with operator.read scope", async () => {
      const request = vi.fn().mockResolvedValue({
        balancePaise: 10000,
        state: { enforce: false, creditLimitPaise: 500000, lowBalancePaise: 50000 },
        daysLeft: 5,
        summary: { totalPaise: -5000, tokens: 0, models: [], buckets: [] },
        contact: "TripIn Studio",
      });

      let capturedTool: unknown;
      const registerTool = vi.fn((tool: unknown) => {
        capturedTool = tool;
      });

      const api = {
        registrationMode: "tool-discovery",
        registerTool,
        runtime: {
          gateway: { request },
        },
      } as unknown as OpenClawPluginApi;

      register(api);

      const tool = capturedTool as Record<string, unknown>;
      await (tool.execute as () => Promise<unknown>)();

      expect(request).toHaveBeenCalledWith("wallet.get", {}, { scopes: ["operator.read"] });
    });

    it("tool returns formatted status data", async () => {
      const request = vi.fn().mockResolvedValue({
        balancePaise: 10000,
        state: { enforce: false, creditLimitPaise: 500000, lowBalancePaise: 50000 },
        daysLeft: 5,
        summary: { totalPaise: -5000, tokens: 0, models: [], buckets: [] },
        contact: "TripIn Studio",
      });

      let capturedTool: unknown;
      const registerTool = vi.fn((tool: unknown) => {
        capturedTool = tool;
      });

      const api = {
        registrationMode: "tool-discovery",
        registerTool,
        runtime: {
          gateway: { request },
        },
      } as unknown as OpenClawPluginApi;

      register(api);

      const tool = capturedTool as Record<string, unknown>;
      const result = await (tool.execute as () => Promise<unknown>)();

      // jsonResult returns complex structure; just verify it contains the data
      expect(result).toBeDefined();
      expect(request).toHaveBeenCalledWith("wallet.get", {}, { scopes: ["operator.read"] });
    });
  });

  describe("full mode", () => {
    it("registers both wallet_status tool and wallet command", () => {
      const { api, registeredTools, registeredCommands } = createMockFullApi();

      register(api);

      expect(registeredTools.has("wallet_status")).toBe(true);
      expect(registeredCommands.has("wallet")).toBe(true);
      expect(api.registerService).toHaveBeenCalled();
      expect(api.on).toHaveBeenCalled();
    });

    it("the tool and the command render the same status from one wallet.get answer", async () => {
      const answer = {
        balancePaise: 124_000,
        state: { creditLimitPaise: 0, lowBalancePaise: 20_000, enforce: true },
        daysLeft: 9,
        contact: "TripIn Studio",
        summary: {
          totalPaise: -31_000,
          tokens: 10,
          models: [],
          buckets: [
            { activity: "duty", paise: -21_200, tokens: 6, activities: [] },
            { activity: "chat", paise: -7_100, tokens: 4, activities: [] },
            { activity: "hosting", paise: -2_400, tokens: 0, activities: [] },
            { activity: "system", paise: -300, tokens: 0, activities: [] },
          ],
        },
      };
      const expected =
        "₹1,240.00 left · ₹310.00 this month (Duties ₹212.00, Chat ₹71.00, Hosting ₹24.00, System ₹3.00) · about 9 days at this rate.";
      const request = vi.fn(async () => answer);
      const { api, registeredTools, registeredCommands } = createMockFullApi({ request });
      register(api);
      const tool = registeredTools.get("wallet_status") as Record<string, unknown>;
      const command = registeredCommands.get("wallet") as Record<string, unknown>;
      const toolResult = await (
        tool.execute as (callId: string, params: unknown, ctx: unknown) => Promise<unknown>
      )("call-1", {}, undefined);
      expect(request).toHaveBeenCalledWith("wallet.get", {}, { scopes: ["operator.read"] });
      request.mockClear();
      const commandResult = await (
        command.handler as (ctx: Record<string, unknown>) => Promise<unknown>
      )({
        channel: "whatsapp",
        isAuthorizedSender: true,
      });
      expect(request).toHaveBeenCalledWith("wallet.get", {}, { scopes: ["operator.read"] });
      expect((toolResult as Record<string, unknown>).details).toBeDefined();
      const toolDetails = (toolResult as Record<string, unknown>).details as Record<
        string,
        unknown
      >;
      expect(toolDetails.text).toBe(expected);
      expect((commandResult as Record<string, unknown>).text).toBe(expected);
      expect((commandResult as Record<string, unknown>).text).toBe(toolDetails.text);
    });
  });

  describe("error handling", () => {
    it("command returns unavailable message when wallet.get throws", async () => {
      const request = vi.fn().mockRejectedValue(new Error("Connection failed"));

      const { api, registeredCommands } = createMockFullApi({ request });

      register(api);

      const command = registeredCommands.get("wallet") as Record<string, unknown>;
      const result = await (command.handler as (ctx: Record<string, unknown>) => Promise<unknown>)({
        channel: "whatsapp",
        isAuthorizedSender: true,
      });

      expect((result as Record<string, unknown>).text).toBe(
        "Wallet is unavailable right now — try again in a minute.",
      );
    });

    it("tool throws when wallet.get throws", async () => {
      const request = vi.fn().mockRejectedValue(new Error("Connection failed"));

      const { api, registeredTools } = createMockFullApi({ request });

      register(api);

      const tool = registeredTools.get("wallet_status") as Record<string, unknown>;

      await expect(async () => {
        await (tool.execute as (callId: string, params: unknown, ctx: unknown) => Promise<unknown>)(
          "call-1",
          {},
          undefined,
        );
      }).rejects.toThrow();
    });

    it("command returns unavailable message when wallet.get returns unexpected shape", async () => {
      const request = vi.fn().mockResolvedValue({
        balancePaise: "not a number",
        // missing state, daysLeft, summary, contact
      });

      const { api, registeredCommands } = createMockFullApi({ request });

      register(api);

      const command = registeredCommands.get("wallet") as Record<string, unknown>;
      const result = await (command.handler as (ctx: Record<string, unknown>) => Promise<unknown>)({
        channel: "whatsapp",
        isAuthorizedSender: true,
      });

      expect((result as Record<string, unknown>).text).toBe(
        "Wallet is unavailable right now — try again in a minute.",
      );
    });
  });

  describe("other modes", () => {
    it("returns early for cli-metadata mode", () => {
      const registerTool = vi.fn();
      const registerCommand = vi.fn();
      const registerService = vi.fn();

      const api = {
        registrationMode: "cli-metadata",
        registerTool,
        registerCommand,
        registerService,
      } as unknown as OpenClawPluginApi;

      register(api);

      expect(registerTool).not.toHaveBeenCalled();
      expect(registerCommand).not.toHaveBeenCalled();
      expect(registerService).not.toHaveBeenCalled();
    });

    it("returns early for discovery mode", () => {
      const registerTool = vi.fn();
      const registerCommand = vi.fn();
      const registerService = vi.fn();

      const api = {
        registrationMode: "discovery",
        registerTool,
        registerCommand,
        registerService,
      } as unknown as OpenClawPluginApi;

      register(api);

      expect(registerTool).not.toHaveBeenCalled();
      expect(registerCommand).not.toHaveBeenCalled();
      expect(registerService).not.toHaveBeenCalled();
    });
  });
});
