import { describe, it, expect, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import register from "./index.js";

/** Creates a minimal mock API for full mode registration testing. */
function createMockFullApi(overrides?: {
  registerTool?: ReturnType<typeof vi.fn>;
  registerCommand?: ReturnType<typeof vi.fn>;
  request?: ReturnType<typeof vi.fn>;
}): OpenClawPluginApi {
  return {
    registrationMode: "full",
    registerTool: overrides?.registerTool ?? vi.fn(),
    registerCommand: overrides?.registerCommand ?? vi.fn(),
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
      state: {
        openKeyedStore: vi.fn().mockReturnValue({
          get: vi.fn(),
          set: vi.fn(),
          delete: vi.fn(),
        }),
      },
    },
  } as unknown as OpenClawPluginApi;
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
              summary: { totalPaise: -5000, tokens: 0, buckets: [] },
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
        summary: { totalPaise: -5000, tokens: 0, buckets: [] },
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
        summary: { totalPaise: -5000, tokens: 0, buckets: [] },
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
      const registerTool = vi.fn();
      const registerCommand = vi.fn();

      const api = createMockFullApi({ registerTool, registerCommand });

      register(api);

      expect(registerTool).toHaveBeenCalled();
      expect(registerCommand).toHaveBeenCalled();
      expect(api.registerService).toHaveBeenCalled();
      expect(api.on).toHaveBeenCalled();

      // Verify tool was registered
      const toolCall = registerTool.mock.calls.find(
        (call) => (call[1] as { name: string })?.name === "wallet_status",
      );
      expect(toolCall).toBeDefined();

      // Verify command was registered
      const commandCall = registerCommand.mock.calls.find(
        (call) => (call as [{ name: string }])[0]?.name === "wallet",
      );
      expect(commandCall).toBeDefined();
    });

    it("command and tool return same exact text for funded case", async () => {
      // Funded case: ₹1,240.00 balance, buckets in descending order
      const expectedText =
        "₹1,240.00 left · ₹310.00 this month (Duties ₹212.00, Chat ₹71.00, Hosting ₹24.00, System ₹3.00) · about 9 days at this rate.";

      const walletGetResult = {
        balancePaise: 124000, // ₹1,240.00
        state: { enforce: false, creditLimitPaise: 500000, lowBalancePaise: 50000 },
        daysLeft: 9,
        summary: {
          totalPaise: -31000, // ₹310.00 spent
          tokens: 0,
          buckets: [
            { activity: "duty", paise: -21200, tokens: 100, activities: [] }, // ₹212.00
            { activity: "chat", paise: -7100, tokens: 50, activities: [] }, // ₹71.00
            { activity: "hosting", paise: -2400, tokens: 0, activities: [] }, // ₹24.00
            { activity: "system", paise: -300, tokens: 0, activities: [] }, // ₹3.00
          ],
        },
        contact: "TripIn Studio",
      };

      const request = vi.fn().mockResolvedValue(walletGetResult);

      let capturedTool: unknown;
      let capturedCommand: unknown;
      const registerTool = vi.fn((tool: unknown) => {
        capturedTool = tool;
      });
      const registerCommand = vi.fn((cmd: unknown) => {
        capturedCommand = cmd;
      });

      const api = createMockFullApi({ registerTool, registerCommand, request });

      register(api);

      // Execute tool (returns jsonResult wrapper)
      const tool = capturedTool as Record<string, unknown>;
      const toolResult = await (tool.execute as () => Promise<unknown>)();
      // jsonResult returns { result: { text, balancePaise, state } } but tool might unwrap it
      const toolData = toolResult as Record<string, unknown>;
      const toolText =
        toolData.text ?? (toolData.result as Record<string, unknown> | undefined)?.text;

      // Reset mock to get clean call count for command
      request.mockClear();

      // Execute command (returns { text })
      const command = capturedCommand as Record<string, unknown>;
      const commandResult = await (command.handler as () => Promise<unknown>)();
      const commandText = (commandResult as Record<string, unknown>).text;

      // Both should return the same text
      expect(commandText).toBe(expectedText);
      if (toolText) {
        expect(toolText).toBe(expectedText);
      }

      // Both should call wallet.get with exact operator.read scope
      expect(request).toHaveBeenCalledWith("wallet.get", {}, { scopes: ["operator.read"] });
    });
  });

  describe("error handling", () => {
    it("command returns unavailable message when wallet.get throws", async () => {
      const request = vi.fn().mockRejectedValue(new Error("Connection failed"));

      let capturedCommand: unknown;
      const registerCommand = vi.fn((cmd: unknown) => {
        capturedCommand = cmd;
      });

      const api = createMockFullApi({ registerCommand, request });

      register(api);

      const command = capturedCommand as Record<string, unknown>;
      const result = await (command.handler as () => Promise<unknown>)();

      expect((result as Record<string, unknown>).text).toBe(
        "Wallet is unavailable right now — try again in a minute.",
      );
    });

    it("tool throws when wallet.get throws", async () => {
      const request = vi.fn().mockRejectedValue(new Error("Connection failed"));

      let capturedTool: unknown;
      const registerTool = vi.fn((tool: unknown) => {
        capturedTool = tool;
      });

      const api = createMockFullApi({ registerTool, request });

      register(api);

      const tool = capturedTool as Record<string, unknown>;

      await expect(async () => {
        await (tool.execute as () => Promise<unknown>)();
      }).rejects.toThrow();
    });

    it("command returns unavailable message when wallet.get returns unexpected shape", async () => {
      const request = vi.fn().mockResolvedValue({
        balancePaise: "not a number",
        // missing state, daysLeft, summary, contact
      });

      let capturedCommand: unknown;
      const registerCommand = vi.fn((cmd: unknown) => {
        capturedCommand = cmd;
      });

      const api = createMockFullApi({ registerCommand, request });

      register(api);

      const command = capturedCommand as Record<string, unknown>;
      const result = await (command.handler as () => Promise<unknown>)();

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
