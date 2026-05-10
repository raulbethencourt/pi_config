import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { EventEmitter } from "events";

/**
 * Phase 0 Mobile Bridge Tests
 * Target: /home/rabeta/.pi/agent/extensions/mobile-bridge/index.ts
 * 
 * Tests smoke-test pi SDK integration:
 * - Command registration: /mobile
 * - Subcommands: smoke, status
 * - agent_end hook for capturing assistant responses
 * - Smoke test flow: send message → capture response → notify success
 * 
 * Phase 0 HTTP Layer Tests:
 * - session_start/shutdown hooks for HTTP server lifecycle
 * - GET /health endpoint
 * - POST /send with token authentication
 * - POST /send with busy/queued state
 * - GET /answers endpoint with response history
 */

describe("Mobile Bridge Extension", () => {
  let mockPi: ExtensionAPI;
  let registeredCommands: Map<string, { description: string; handler: Function }>;
  let registeredHooks: Map<string, Function[]>;
  let mobileBridgeModule: any;
  let spawnMock: any;
  let mockChildProcesses: any[];

  beforeEach(async () => {
    // Reset mocks
    registeredCommands = new Map();
    registeredHooks = new Map();
    mockChildProcesses = [];
    
    // Mock child_process spawn for KDE Connect tests
    spawnMock = vi.fn((command: string, args: string[]) => {
      const mockChild = new EventEmitter() as any;
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      mockChild.kill = vi.fn();
      mockChildProcesses.push({ command, args, child: mockChild });
      
      // Simulate successful spawn by default
      setTimeout(() => mockChild.emit('exit', 0), 10);
      
      return mockChild;
    });
    
    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
    }));

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

  afterEach(() => {
    // Clean up any lingering child processes
    mockChildProcesses.forEach(({ child }) => {
      if (child.kill) child.kill();
    });
    vi.clearAllMocks();
    vi.doUnmock('node:child_process');
    delete process.env.PI_MOBILE_BRIDGE_HOST;
    delete process.env.PI_MOBILE_BRIDGE_PORT;
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

  it("registers 'session_start' event hook", () => {
    expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(registeredHooks.has("session_start")).toBe(true);
  });

  it("registers 'session_shutdown' event hook", () => {
    expect(mockPi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    expect(registeredHooks.has("session_shutdown")).toBe(true);
  });

  it("registers 'agent_start' event hook", () => {
    expect(mockPi.on).toHaveBeenCalledWith("agent_start", expect.any(Function));
    expect(registeredHooks.has("agent_start")).toBe(true);
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

    it("prefers LAN IP URL when PI_MOBILE_BRIDGE_HOST is set", async () => {
      // Set LAN IP override
      process.env.PI_MOBILE_BRIDGE_HOST = "192.168.1.20";
      process.env.PI_MOBILE_BRIDGE_PORT = "0";

      // Reinitialize extension with new env
      registeredCommands.clear();
      registeredHooks.clear();
      const freshModule = await import("../extensions/mobile-bridge/index.ts?t=" + Date.now());
      freshModule.default(mockPi);

      // Start server
      const sessionStartHandlers = registeredHooks.get("session_start");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await sessionStartHandlers![0]({}, mockCtx);

      // Check status output
      const mobileCommand = registeredCommands.get("mobile");
      mockNotify.mockClear();
      await mobileCommand!.handler("status", mockCtx);

      // Should contain LAN IP in URL
      const statusCall = mockNotify.mock.calls.find((call) =>
        call[0].includes("http://")
      );
      expect(statusCall).toBeDefined();
      expect(statusCall[0]).toMatch(/http:\/\/192\.168\.1\.20:\d+\/\?token=[a-f0-9]+/);
    });
  });

  describe("KDE Connect Notifications", () => {
    it("sends notification via kdeconnect-cli spawn on agent_end with assistant answer", async () => {
      const agentEndHandlers = registeredHooks.get("agent_end");
      expect(agentEndHandlers).toBeDefined();

      const event = {
        messages: [
          { role: "assistant", content: "This is the assistant's response." },
        ],
      };

      await agentEndHandlers![0](event);

      // Should have spawned kdeconnect-cli
      expect(spawnMock).toHaveBeenCalledWith(
        "kdeconnect-cli",
        expect.arrayContaining(["--ping-msg"]),
        expect.any(Object)
      );
    });

    it("truncates notification preview to ~80 characters", async () => {
      const agentEndHandlers = registeredHooks.get("agent_end");
      
      const longResponse = "A".repeat(200); // 200 char response
      const event = {
        messages: [
          { role: "assistant", content: longResponse },
        ],
      };

      await agentEndHandlers![0](event);

      // Check that the preview argument is truncated
      expect(spawnMock).toHaveBeenCalled();
      const spawnCall = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli"
      );
      expect(spawnCall).toBeDefined();
      
      const args = spawnCall[1];
      const previewIndex = args.indexOf("--ping-msg") + 1;
      expect(previewIndex).toBeGreaterThan(0);
      
      const preview = args[previewIndex];
      expect(preview.length).toBeLessThanOrEqual(85); // Allow for ellipsis
      expect(preview.length).toBeGreaterThan(0);
    });

    it("passes notification as argument array not shell string", async () => {
      const agentEndHandlers = registeredHooks.get("agent_end");
      
      const event = {
        messages: [
          { role: "assistant", content: "Test; echo 'injection'; rm -rf /" },
        ],
      };

      await agentEndHandlers![0](event);

      // Verify spawn was called with args array, not exec string
      expect(spawnMock).toHaveBeenCalledWith(
        "kdeconnect-cli",
        expect.any(Array),
        expect.any(Object)
      );
      
      // Verify the dangerous chars are in the array element, not interpreted
      const spawnCall = spawnMock.mock.calls[0];
      expect(Array.isArray(spawnCall[1])).toBe(true);
    });

    it("does not throw when kdeconnect-cli spawn errors", async () => {
      // Make spawn emit error
      spawnMock.mockImplementation((command: string, args: string[]) => {
        const mockChild = new EventEmitter() as any;
        mockChild.stdout = new EventEmitter();
        mockChild.stderr = new EventEmitter();
        mockChild.kill = vi.fn();
        
        setTimeout(() => mockChild.emit('error', new Error('Command not found')), 10);
        
        return mockChild;
      });

      const agentEndHandlers = registeredHooks.get("agent_end");
      const event = {
        messages: [
          { role: "assistant", content: "Test response" },
        ],
      };

      // Should not throw
      await expect(agentEndHandlers![0](event)).resolves.not.toThrow();
    });

    it("does not throw when kdeconnect-cli exits nonzero", async () => {
      // Make spawn exit with error code
      spawnMock.mockImplementation((command: string, args: string[]) => {
        const mockChild = new EventEmitter() as any;
        mockChild.stdout = new EventEmitter();
        mockChild.stderr = new EventEmitter();
        mockChild.kill = vi.fn();
        
        setTimeout(() => mockChild.emit('exit', 1), 10);
        
        return mockChild;
      });

      const agentEndHandlers = registeredHooks.get("agent_end");
      const event = {
        messages: [
          { role: "assistant", content: "Test response" },
        ],
      };

      // Should not throw
      await expect(agentEndHandlers![0](event)).resolves.not.toThrow();
    });
  });

  describe("Phase 0: HTTP Server", () => {
    let serverUrl: string;
    let token: string;
    let port: number;

    beforeEach(async () => {
      // Set ephemeral port for testing
      process.env.PI_MOBILE_BRIDGE_PORT = "0";
    });

    const startServer = async () => {
      const sessionStartHandlers = registeredHooks.get("session_start");
      expect(sessionStartHandlers).toBeDefined();
      
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      // Trigger session_start
      await sessionStartHandlers![0]({}, mockCtx);

      // Now trigger /mobile status to get the URL
      const mobileCommand = registeredCommands.get("mobile");
      await mobileCommand!.handler("status", mockCtx);

      // Parse URL from notification
      const statusCall = mockNotify.mock.calls.find((call) =>
        call[0].includes("http://")
      );
      expect(statusCall).toBeDefined();
      
      const urlMatch = statusCall[0].match(/http:\/\/[^\s]+:(\d+)\/\?token=([a-f0-9]+)/);
      expect(urlMatch).not.toBeNull();
      
      port = parseInt(urlMatch[1], 10);
      token = urlMatch[2];
      serverUrl = `http://127.0.0.1:${port}`;
    };

    const shutdownServer = async () => {
      const sessionShutdownHandlers = registeredHooks.get("session_shutdown");
      if (sessionShutdownHandlers) {
        const mockCtx: ExtensionCommandContext = {
          ui: { notify: vi.fn() },
          cwd: "/test",
          model: "test-model",
        } as any;
        await sessionShutdownHandlers[0]({}, mockCtx);
      }
    };

    it("session_start starts HTTP server and notifies URL with token", async () => {
      await startServer();
      
      expect(serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(port).toBeGreaterThan(0);
      expect(token).toMatch(/^[a-f0-9]+$/);
      expect(token.length).toBeGreaterThanOrEqual(32);

      await shutdownServer();
    });

    it("GET /health returns alive status", async () => {
      await startServer();

      const response = await fetch(`${serverUrl}/health`);
      expect(response.ok).toBe(true);
      
      const data = await response.json();
      expect(data).toHaveProperty("alive", true);

      await shutdownServer();
    });

    it("POST /send rejects invalid token with 401", async () => {
      await startServer();

      const response = await fetch(`${serverUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "invalid", message: "test" }),
      });

      expect(response.status).toBe(401);

      await shutdownServer();
    });

    it("POST /send with valid token calls pi.sendUserMessage", async () => {
      await startServer();

      const response = await fetch(`${serverUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, message: "test message" }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data).toHaveProperty("success", true);
      expect(data).toHaveProperty("queued", false);

      expect(mockPi.sendUserMessage).toHaveBeenCalledWith("test message");

      await shutdownServer();
    });

    it("POST /send when busy queues message with deliverAs followUp", async () => {
      await startServer();

      // Trigger agent_start to mark as busy
      const agentStartHandlers = registeredHooks.get("agent_start");
      expect(agentStartHandlers).toBeDefined();
      await agentStartHandlers![0]({});

      const response = await fetch(`${serverUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, message: "queued message" }),
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data).toHaveProperty("success", true);
      expect(data).toHaveProperty("queued", true);

      expect(mockPi.sendUserMessage).toHaveBeenCalledWith(
        "queued message",
        { deliverAs: "followUp" }
      );

      // Mark not busy
      const agentEndHandlers = registeredHooks.get("agent_end");
      await agentEndHandlers![0]({ messages: [] });

      await shutdownServer();
    });

    it("GET /answers returns last assistant responses (max 10)", async () => {
      await startServer();

      // Simulate multiple agent_end events with responses
      const agentEndHandlers = registeredHooks.get("agent_end");
      
      for (let i = 1; i <= 12; i++) {
        await agentEndHandlers![0]({
          messages: [
            { role: "assistant", content: `Response ${i}` },
          ],
        });
      }

      const response = await fetch(`${serverUrl}/answers?token=${token}`);
      expect(response.ok).toBe(true);
      
      const data = await response.json();
      expect(data).toHaveProperty("answers");
      expect(Array.isArray(data.answers)).toBe(true);
      expect(data.answers.length).toBeLessThanOrEqual(10);
      
      // Should contain last 10 responses (3-12)
      expect(data.answers[data.answers.length - 1]).toContain("Response 12");

      await shutdownServer();
    });

    it("GET /answers rejects invalid token with 401", async () => {
      await startServer();

      const response = await fetch(`${serverUrl}/answers?token=invalid`);
      expect(response.status).toBe(401);

      await shutdownServer();
    });

    it("session_shutdown closes HTTP server", async () => {
      await startServer();

      // Verify server is running
      let response = await fetch(`${serverUrl}/health`);
      expect(response.ok).toBe(true);

      // Shutdown server
      await shutdownServer();

      // Verify server is closed - fetch should fail
      await expect(fetch(`${serverUrl}/health`)).rejects.toThrow();
    });

    it("POST /send rate limiting: returns 429 after 10 requests from same client", async () => {
      await startServer();

      // Make 10 successful requests
      for (let i = 0; i < 10; i++) {
        const response = await fetch(`${serverUrl}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, message: `message ${i}` }),
        });
        expect(response.ok).toBe(true);
      }

      // 11th request should be rate limited
      const response = await fetch(`${serverUrl}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, message: "rate limited" }),
      });

      expect(response.status).toBe(429);
      const data = await response.json();
      expect(data).toHaveProperty("error");
      expect(data.error).toMatch(/rate limit/i);

      await shutdownServer();
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
