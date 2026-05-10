import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

/**
 * Phase 0 Mobile Bridge Tests
 * Target: /home/rabeta/.pi/agent/extensions/mobile-bridge/index.ts
 * 
 * Tests smoke-test pi SDK integration:
 * - Command registration: /mobile
 * - Subcommands: smoke, status
 * - agent_end hook for capturing assistant responses
 * - Smoke test flow: send message → capture response → notify success
 */

describe("Mobile Bridge Extension", () => {
  let mockPi: ExtensionAPI;
  let registeredCommands: Map<string, { description: string; handler: Function }>;
  let registeredHooks: Map<string, Function[]>;
  let mobileBridgeModule: any;

  beforeEach(async () => {
    // Reset mocks
    registeredCommands = new Map();
    registeredHooks = new Map();

    // Mock pi SDK
    mockPi = {
      registerCommand: vi.fn((name: string, opts: any) => {
        registeredCommands.set(name, opts);
      }),
      on: vi.fn((event: string, handler: Function) => {
        if (!registeredHooks.has(event)) {
          registeredHooks.set(event, []);
        }
        registeredHooks.get(event)!.push(handler);
      }),
      sendUserMessage: vi.fn(),
    } as any;

    // Import and initialize the extension
    try {
      mobileBridgeModule = await import("../extensions/mobile-bridge/index.ts");
      mobileBridgeModule.default(mockPi);
    } catch (error) {
      // Expected to fail in RED phase - extension doesn't exist yet
      mobileBridgeModule = null;
    }
  });

  it("registers 'mobile' slash command", () => {
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "mobile",
      expect.objectContaining({
        description: expect.any(String),
        handler: expect.any(Function),
      })
    );
    expect(registeredCommands.has("mobile")).toBe(true);
  });

  it("registers 'agent_end' event hook", () => {
    expect(mockPi.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    expect(registeredHooks.has("agent_end")).toBe(true);
    expect(registeredHooks.get("agent_end")!.length).toBeGreaterThan(0);
  });

  describe("/mobile smoke", () => {
    it("sends exact smoke test prompt via sendUserMessage", async () => {
      const mobileCommand = registeredCommands.get("mobile");
      expect(mobileCommand).toBeDefined();

      const mockCtx: ExtensionCommandContext = {
        ui: { notify: vi.fn() },
        cwd: "/test",
        model: "test-model",
      } as any;

      await mobileCommand!.handler("smoke", mockCtx);

      expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
        'Reply exactly: MOBILE_BRIDGE_SMOKE_OK'
      );
    });

    it("notifies user that smoke test started", async () => {
      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await mobileCommand!.handler("smoke", mockCtx);

      expect(mockNotify).toHaveBeenCalledWith(
        expect.stringContaining("smoke")
      );
    });
  });

  describe("agent_end hook", () => {
    it("extracts assistant text from string content", async () => {
      const agentEndHandlers = registeredHooks.get("agent_end");
      expect(agentEndHandlers).toBeDefined();
      
      const handler = agentEndHandlers![0];
      const event = {
        messages: [
          { role: "user", content: "test question" },
          { role: "assistant", content: "MOBILE_BRIDGE_SMOKE_OK" },
        ],
      };

      await handler(event);
      
      // Should have captured and stored the response
      // (Internal state verification - will be checked via /mobile status)
    });

    it("extracts assistant text from array content with text parts", async () => {
      const agentEndHandlers = registeredHooks.get("agent_end");
      const handler = agentEndHandlers![0];
      
      const event = {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Response: " },
              { type: "text", text: "MOBILE_BRIDGE_SMOKE_OK" },
            ],
          },
        ],
      };

      await handler(event);
      
      // Should extract and concatenate text parts
    });

    it("ignores non-assistant messages gracefully", async () => {
      const agentEndHandlers = registeredHooks.get("agent_end");
      const handler = agentEndHandlers![0];
      
      const event = {
        messages: [
          { role: "user", content: "only user message" },
          { role: "system", content: "system message" },
        ],
      };

      // Should not throw
      await expect(handler(event)).resolves.not.toThrow();
    });

    it("notifies success when smoke test token is detected", async () => {
      const agentEndHandlers = registeredHooks.get("agent_end");
      const handler = agentEndHandlers![0];

      // First trigger smoke test to set pending state
      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await mobileCommand!.handler("smoke", mockCtx);

      // Clear previous notify calls
      mockNotify.mockClear();

      // Now simulate agent_end with success response
      const event = {
        messages: [
          { role: "assistant", content: "MOBILE_BRIDGE_SMOKE_OK" },
        ],
      };

      // The extension should have access to ctx.ui.notify through closure or state
      // This tests integration - the handler should notify on success
      await handler(event);

      // Note: This test expects the extension to maintain context/state
      // to correlate agent_end with pending smoke test
    });

    it("does not notify when smoke token absent", async () => {
      const agentEndHandlers = registeredHooks.get("agent_end");
      const handler = agentEndHandlers![0];

      const event = {
        messages: [
          { role: "assistant", content: "Normal response without token" },
        ],
      };

      // Should not throw and should not notify about smoke success
      await expect(handler(event)).resolves.not.toThrow();
    });
  });

  describe("/mobile status", () => {
    it("returns status information including last captured answer", async () => {
      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      // Trigger status command
      await mobileCommand!.handler("status", mockCtx);

      expect(mockNotify).toHaveBeenCalledWith(
        expect.stringContaining("status")
      );
    });

    it("shows last captured answer after agent_end", async () => {
      const agentEndHandlers = registeredHooks.get("agent_end");
      const handler = agentEndHandlers![0];

      // Simulate agent_end with a response
      const event = {
        messages: [
          { role: "assistant", content: "Test response captured" },
        ],
      };
      await handler(event);

      // Now check status
      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await mobileCommand!.handler("status", mockCtx);

      // Should include the captured response in status
      expect(mockNotify).toHaveBeenCalledWith(
        expect.stringMatching(/Test response captured|captured/)
      );
    });

    it("handles status when no messages captured yet", async () => {
      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      // Status before any agent_end
      await mobileCommand!.handler("status", mockCtx);

      // Should not throw and should indicate no messages yet
      expect(mockNotify).toHaveBeenCalled();
    });
  });

  describe("command argument handling", () => {
    it("handles unknown subcommands gracefully", async () => {
      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      // Should not throw
      await expect(
        mobileCommand!.handler("unknown", mockCtx)
      ).resolves.not.toThrow();
    });

    it("handles empty args (shows help or status)", async () => {
      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await mobileCommand!.handler("", mockCtx);

      expect(mockNotify).toHaveBeenCalled();
    });
  });
});
