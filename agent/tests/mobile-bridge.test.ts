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
    delete process.env.PI_MOBILE_BRIDGE_KDE_DEVICE_ID;
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

  describe("/mobile link", () => {
    const startServer = async () => {
      const sessionStartHandlers = registeredHooks.get("session_start");
      expect(sessionStartHandlers).toBeDefined();
      
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await sessionStartHandlers![0]({}, mockCtx);
      return mockNotify;
    };

    beforeEach(() => {
      process.env.PI_MOBILE_BRIDGE_PORT = "0";
      process.env.PI_MOBILE_BRIDGE_HOST = "192.168.1.30";
    });

    it("sends bridge URL to phone via kdeconnect-cli with --share flag", async () => {
      await startServer();

      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await mobileCommand!.handler("link", mockCtx);

      // Assert kdeconnect-cli was spawned
      expect(spawnMock).toHaveBeenCalledWith(
        "kdeconnect-cli",
        expect.arrayContaining(["--share"]),
        expect.objectContaining({ stdio: "ignore" })
      );

      // Verify the URL format
      const spawnCall = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli" && call[1].includes("--share")
      );
      expect(spawnCall).toBeDefined();
      
      const args = spawnCall[1];
      const shareIndex = args.indexOf("--share");
      expect(shareIndex).toBeGreaterThanOrEqual(0);
      
      const url = args[shareIndex + 1];
      expect(url).toMatch(/^http:\/\/192\.168\.1\.30:\d+\/\?token=[a-f0-9]+$/);
    });

    it("uses safe spawn with arg array not shell exec", async () => {
      await startServer();

      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await mobileCommand!.handler("link", mockCtx);

      // Verify spawn was called with args array, not shell string
      const spawnCall = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli"
      );
      expect(spawnCall).toBeDefined();
      expect(Array.isArray(spawnCall[1])).toBe(true);
      
      // Verify stdio: "ignore" option
      expect(spawnCall[2]).toHaveProperty("stdio", "ignore");
    });

    it("notifies user that link was sent", async () => {
      await startServer();

      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await mobileCommand!.handler("link", mockCtx);

      expect(mockNotify).toHaveBeenCalledWith(
        expect.stringMatching(/sent|link/i)
      );
    });

    it("does not spawn if server is not running", async () => {
      // Don't start server
      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await mobileCommand!.handler("link", mockCtx);

      // Should not have spawned kdeconnect-cli
      const kdeconnectSpawn = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli" && call[1].includes("--share")
      );
      expect(kdeconnectSpawn).toBeUndefined();

      // Should notify that bridge is not running
      expect(mockNotify).toHaveBeenCalledWith(
        expect.stringMatching(/not running|bridge.*not.*running/i)
      );
    });

    it("does not throw if spawn errors", async () => {
      await startServer();

      // Make spawn throw error
      spawnMock.mockImplementationOnce((command: string, args: string[]) => {
        const mockChild = new EventEmitter() as any;
        mockChild.stdout = new EventEmitter();
        mockChild.stderr = new EventEmitter();
        mockChild.kill = vi.fn();
        
        setTimeout(() => mockChild.emit('error', new Error('kdeconnect-cli not found')), 10);
        
        return mockChild;
      });

      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      // Should not throw
      await expect(
        mobileCommand!.handler("link", mockCtx)
      ).resolves.not.toThrow();
    });

    it("does not throw if kdeconnect-cli exits nonzero", async () => {
      await startServer();

      // Make spawn exit with error code
      spawnMock.mockImplementationOnce((command: string, args: string[]) => {
        const mockChild = new EventEmitter() as any;
        mockChild.stdout = new EventEmitter();
        mockChild.stderr = new EventEmitter();
        mockChild.kill = vi.fn();
        
        setTimeout(() => mockChild.emit('exit', 1), 10);
        
        return mockChild;
      });

      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      // Should not throw
      await expect(
        mobileCommand!.handler("link", mockCtx)
      ).resolves.not.toThrow();
    });

    it("includes -d <device_id> when PI_MOBILE_BRIDGE_KDE_DEVICE_ID is set", async () => {
      process.env.PI_MOBILE_BRIDGE_KDE_DEVICE_ID = "a648fd25583644aa9c89057dfb068171";
      await startServer();

      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await mobileCommand!.handler("link", mockCtx);

      // Assert kdeconnect-cli was spawned with -d flag and device ID
      const spawnCall = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli" && call[1].includes("--share")
      );
      expect(spawnCall).toBeDefined();

      const args = spawnCall[1];
      expect(args).toContain("--share");
      expect(args).toContain("-d");
      expect(args).toContain("a648fd25583644aa9c89057dfb068171");

      // Verify the URL is still present
      const shareIndex = args.indexOf("--share");
      const url = args[shareIndex + 1];
      expect(url).toMatch(/^http:\/\/192\.168\.1\.30:\d+\/\?token=[a-f0-9]+$/);
    });
  });

  describe("KDE Connect device ID handling", () => {
    it("includes -d <device_id> in agent_end notification when PI_MOBILE_BRIDGE_KDE_DEVICE_ID is set", async () => {
      process.env.PI_MOBILE_BRIDGE_KDE_DEVICE_ID = "a648fd25583644aa9c89057dfb068171";

      const agentEndHandlers = registeredHooks.get("agent_end");
      expect(agentEndHandlers).toBeDefined();

      const event = {
        messages: [
          { role: "assistant", content: "This is the assistant's response." },
        ],
      };

      await agentEndHandlers![0](event);

      // Assert kdeconnect-cli was spawned with -d flag and device ID
      const spawnCall = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli" && call[1].includes("--ping-msg")
      );
      expect(spawnCall).toBeDefined();

      const args = spawnCall[1];
      expect(args).toContain("--ping-msg");
      expect(args).toContain("-d");
      expect(args).toContain("a648fd25583644aa9c89057dfb068171");

      // Verify the preview is still present
      const previewIndex = args.indexOf("--ping-msg") + 1;
      expect(previewIndex).toBeGreaterThan(0);
      const preview = args[previewIndex];
      expect(preview).toBeTruthy();
      expect(preview.length).toBeGreaterThan(0);
    });
  });

  describe("RED: Automatic KDE Connect Device ID Detection", () => {
    /**
     * These tests validate automatic device ID detection when
     * PI_MOBILE_BRIDGE_KDE_DEVICE_ID env var is not set.
     * 
     * Expected behavior:
     * 1. If env var is set, use it (already tested in previous blocks)
     * 2. If env var is missing, run kdeconnect-cli --list-devices --id-only via spawnSync
     * 3. Use first non-empty line as device ID
     * 4. /mobile link should include -d <autoDetectedId>
     * 5. agent_end notification should include -d <autoDetectedId>
     * 6. If detection fails/empty, fallback to no -d flag
     */

    let spawnSyncMock: any;

    beforeEach(() => {
      // Mock spawnSync in addition to spawn
      spawnSyncMock = vi.fn(() => ({
        stdout: Buffer.from("a648fd25583644aa9c89057dfb068171\n"),
        stderr: Buffer.from(""),
        status: 0,
        signal: null,
        pid: 12345,
        output: [null, Buffer.from("a648fd25583644aa9c89057dfb068171\n"), Buffer.from("")],
      }));

      vi.doMock('node:child_process', () => ({
        spawn: spawnMock,
        spawnSync: spawnSyncMock,
      }));

      // Ensure env var is NOT set for these tests
      delete process.env.PI_MOBILE_BRIDGE_KDE_DEVICE_ID;
      // Use ephemeral port for HTTP server
      process.env.PI_MOBILE_BRIDGE_PORT = "0";
      process.env.PI_MOBILE_BRIDGE_HOST = "192.168.1.30";
    });

    afterEach(async () => {
      // Clean up HTTP server if running
      const sessionShutdownHandlers = registeredHooks.get("session_shutdown");
      if (sessionShutdownHandlers && sessionShutdownHandlers.length > 0) {
        const mockCtx: ExtensionCommandContext = {
          ui: { notify: vi.fn() },
          cwd: "/test",
          model: "test-model",
        } as any;
        try {
          await sessionShutdownHandlers[0]({}, mockCtx);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    });

    it("RED: detects device ID via spawnSync when env var not set", async () => {
      // Start server to initialize extension
      const sessionStartHandlers = registeredHooks.get("session_start");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await sessionStartHandlers![0]({}, mockCtx);

      // Trigger /mobile link
      const mobileCommand = registeredCommands.get("mobile");
      mockNotify.mockClear();
      await mobileCommand!.handler("link", mockCtx);

      // Assert spawnSync was called with correct command
      expect(spawnSyncMock).toHaveBeenCalledWith(
        "kdeconnect-cli",
        ["--list-devices", "--id-only"],
        expect.any(Object)
      );
    });

    it("RED: /mobile link includes -d with auto-detected device ID", async () => {
      // Start server
      const sessionStartHandlers = registeredHooks.get("session_start");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await sessionStartHandlers![0]({}, mockCtx);

      // Trigger /mobile link
      const mobileCommand = registeredCommands.get("mobile");
      mockNotify.mockClear();
      await mobileCommand!.handler("link", mockCtx);

      // Assert spawn was called with -d and auto-detected ID
      const spawnCall = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli" && call[1].includes("--share")
      );
      expect(spawnCall).toBeDefined();

      const args = spawnCall[1];
      expect(args).toContain("-d");
      expect(args).toContain("a648fd25583644aa9c89057dfb068171");
      expect(args).toContain("--share");

      // Verify URL is still present
      const shareIndex = args.indexOf("--share");
      const url = args[shareIndex + 1];
      expect(url).toMatch(/^http:\/\//);
    });

    it("RED: agent_end notification includes -d with auto-detected device ID", async () => {
      // Initialize extension (device ID detection happens on init or first use)
      const sessionStartHandlers = registeredHooks.get("session_start");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await sessionStartHandlers![0]({}, mockCtx);

      // Clear spawn mock to focus on agent_end notification
      spawnMock.mockClear();

      // Trigger agent_end with assistant response
      const agentEndHandlers = registeredHooks.get("agent_end");
      const event = {
        messages: [
          { role: "assistant", content: "Test response for notification" },
        ],
      };

      await agentEndHandlers![0](event);

      // Assert spawn was called with -d and auto-detected ID
      const spawnCall = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli" && call[1].includes("--ping-msg")
      );
      expect(spawnCall).toBeDefined();

      const args = spawnCall[1];
      expect(args).toContain("-d");
      expect(args).toContain("a648fd25583644aa9c89057dfb068171");
      expect(args).toContain("--ping-msg");

      // Verify preview is still present
      const previewIndex = args.indexOf("--ping-msg") + 1;
      expect(previewIndex).toBeGreaterThan(0);
      const preview = args[previewIndex];
      expect(preview).toBeTruthy();
    });

    it("RED: fallback to no -d flag when spawnSync returns empty stdout", async () => {
      // Mock spawnSync to return empty output
      spawnSyncMock.mockReturnValue({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        status: 0,
        signal: null,
        pid: 12345,
        output: [null, Buffer.from(""), Buffer.from("")],
      });

      // Start server
      const sessionStartHandlers = registeredHooks.get("session_start");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await sessionStartHandlers![0]({}, mockCtx);

      // Trigger /mobile link
      const mobileCommand = registeredCommands.get("mobile");
      mockNotify.mockClear();
      await mobileCommand!.handler("link", mockCtx);

      // Assert spawn was called WITHOUT -d flag
      const spawnCall = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli" && call[1].includes("--share")
      );
      expect(spawnCall).toBeDefined();

      const args = spawnCall[1];
      expect(args).toContain("--share");
      expect(args).not.toContain("-d");
    });

    it("RED: fallback to no -d flag when spawnSync exits with error status", async () => {
      // Mock spawnSync to return error status
      spawnSyncMock.mockReturnValue({
        stdout: Buffer.from(""),
        stderr: Buffer.from("kdeconnect-cli: command not found"),
        status: 127,
        signal: null,
        pid: 12345,
        output: [null, Buffer.from(""), Buffer.from("kdeconnect-cli: command not found")],
      });

      // Start server
      const sessionStartHandlers = registeredHooks.get("session_start");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await sessionStartHandlers![0]({}, mockCtx);

      // Trigger /mobile link
      const mobileCommand = registeredCommands.get("mobile");
      mockNotify.mockClear();
      await mobileCommand!.handler("link", mockCtx);

      // Assert spawn was called WITHOUT -d flag
      const spawnCall = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli" && call[1].includes("--share")
      );
      expect(spawnCall).toBeDefined();

      const args = spawnCall[1];
      expect(args).toContain("--share");
      expect(args).not.toContain("-d");
    });

    it("RED: fallback to no -d flag in agent_end when detection fails", async () => {
      // Mock spawnSync to fail
      spawnSyncMock.mockReturnValue({
        stdout: Buffer.from(""),
        stderr: Buffer.from("error"),
        status: 1,
        signal: null,
        pid: 12345,
        output: [null, Buffer.from(""), Buffer.from("error")],
      });

      // Initialize extension
      const sessionStartHandlers = registeredHooks.get("session_start");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await sessionStartHandlers![0]({}, mockCtx);

      // Clear spawn mock
      spawnMock.mockClear();

      // Trigger agent_end
      const agentEndHandlers = registeredHooks.get("agent_end");
      const event = {
        messages: [
          { role: "assistant", content: "Test response" },
        ],
      };

      await agentEndHandlers![0](event);

      // Assert spawn was called WITHOUT -d flag
      const spawnCall = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli" && call[1].includes("--ping-msg")
      );
      expect(spawnCall).toBeDefined();

      const args = spawnCall[1];
      expect(args).toContain("--ping-msg");
      expect(args).not.toContain("-d");
    });

    it("RED: uses first non-empty line from spawnSync output with multiple lines", async () => {
      // Mock spawnSync to return multiple device IDs (edge case)
      spawnSyncMock.mockReturnValue({
        stdout: Buffer.from("a648fd25583644aa9c89057dfb068171\nb12345678901234567890123456789ab\n"),
        stderr: Buffer.from(""),
        status: 0,
        signal: null,
        pid: 12345,
        output: [null, Buffer.from("a648fd25583644aa9c89057dfb068171\nb12345678901234567890123456789ab\n"), Buffer.from("")],
      });

      // Start server
      const sessionStartHandlers = registeredHooks.get("session_start");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await sessionStartHandlers![0]({}, mockCtx);

      // Trigger /mobile link
      const mobileCommand = registeredCommands.get("mobile");
      mockNotify.mockClear();
      await mobileCommand!.handler("link", mockCtx);

      // Assert spawn was called with FIRST device ID only
      const spawnCall = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli" && call[1].includes("--share")
      );
      expect(spawnCall).toBeDefined();

      const args = spawnCall[1];
      expect(args).toContain("-d");
      expect(args).toContain("a648fd25583644aa9c89057dfb068171");
      expect(args).not.toContain("b12345678901234567890123456789ab");
    });

    it("RED: does not throw when spawnSync throws exception", async () => {
      // Mock spawnSync to throw exception
      spawnSyncMock.mockImplementation(() => {
        throw new Error("ENOENT: kdeconnect-cli not found");
      });

      // Start server
      const sessionStartHandlers = registeredHooks.get("session_start");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      // Should not throw
      await expect(sessionStartHandlers![0]({}, mockCtx)).resolves.not.toThrow();

      // Trigger /mobile link - should work without -d
      const mobileCommand = registeredCommands.get("mobile");
      await expect(mobileCommand!.handler("link", mockCtx)).resolves.not.toThrow();
    });
  });

  describe("RED: KDE Device Diagnostics in Status and Notifications", () => {
    /**
     * These tests validate KDE device information surfacing in commands.
     * 
     * Expected behavior:
     * 1. /mobile status notification includes KDE device ID when detected (env or auto-detect)
     * 2. /mobile link notification includes target device ID being used
     * 3. New /mobile devices command shows detected KDE device ID or "no KDE device" message
     * 
     * Use PI_MOBILE_BRIDGE_KDE_DEVICE_ID=a648fd25583644aa9c89057dfb068171 for deterministic tests
     */

    it("RED: /mobile status includes KDE device ID when PI_MOBILE_BRIDGE_KDE_DEVICE_ID is set", async () => {
      process.env.PI_MOBILE_BRIDGE_KDE_DEVICE_ID = "a648fd25583644aa9c89057dfb068171";
      process.env.PI_MOBILE_BRIDGE_PORT = "0";

      // Start server
      const sessionStartHandlers = registeredHooks.get("session_start");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await sessionStartHandlers![0]({}, mockCtx);

      // Trigger /mobile status
      const mobileCommand = registeredCommands.get("mobile");
      mockNotify.mockClear();
      await mobileCommand!.handler("status", mockCtx);

      // Assert notification includes device ID
      expect(mockNotify).toHaveBeenCalled();
      const statusNotification = mockNotify.mock.calls.find((call: any[]) =>
        call[0].toLowerCase().includes("kde") || call[0].includes("a648fd25583644aa9c89057dfb068171")
      );
      expect(statusNotification).toBeDefined();
      expect(statusNotification[0]).toMatch(/kde.*a648fd25583644aa9c89057dfb068171|a648fd25583644aa9c89057dfb068171/i);
    });

    it("RED: /mobile status includes auto-detected KDE device ID when env not set", async () => {
      delete process.env.PI_MOBILE_BRIDGE_KDE_DEVICE_ID;
      process.env.PI_MOBILE_BRIDGE_PORT = "0";

      // Mock spawnSync to return device ID
      const spawnSyncMock = vi.fn(() => ({
        stdout: Buffer.from("a648fd25583644aa9c89057dfb068171\n"),
        stderr: Buffer.from(""),
        status: 0,
        signal: null,
        pid: 12345,
        output: [null, Buffer.from("a648fd25583644aa9c89057dfb068171\n"), Buffer.from("")],
      }));

      vi.doMock('node:child_process', () => ({
        spawn: spawnMock,
        spawnSync: spawnSyncMock,
      }));

      // Reinitialize extension
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

      // Trigger /mobile status
      const mobileCommand = registeredCommands.get("mobile");
      mockNotify.mockClear();
      await mobileCommand!.handler("status", mockCtx);

      // Assert notification includes auto-detected device ID
      expect(mockNotify).toHaveBeenCalled();
      const statusNotification = mockNotify.mock.calls.find((call: any[]) =>
        call[0].toLowerCase().includes("kde") || call[0].includes("a648fd25583644aa9c89057dfb068171")
      );
      expect(statusNotification).toBeDefined();
      expect(statusNotification[0]).toMatch(/kde.*a648fd25583644aa9c89057dfb068171|a648fd25583644aa9c89057dfb068171/i);
    });

    it("RED: /mobile status shows 'no KDE device' when detection fails", async () => {
      delete process.env.PI_MOBILE_BRIDGE_KDE_DEVICE_ID;
      process.env.PI_MOBILE_BRIDGE_PORT = "0";

      // Mock spawnSync to return empty
      const spawnSyncMock = vi.fn(() => ({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        status: 0,
        signal: null,
        pid: 12345,
        output: [null, Buffer.from(""), Buffer.from("")],
      }));

      vi.doMock('node:child_process', () => ({
        spawn: spawnMock,
        spawnSync: spawnSyncMock,
      }));

      // Reinitialize extension
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

      // Trigger /mobile status
      const mobileCommand = registeredCommands.get("mobile");
      mockNotify.mockClear();
      await mobileCommand!.handler("status", mockCtx);

      // Assert notification indicates no KDE device
      expect(mockNotify).toHaveBeenCalled();
      const statusNotification = mockNotify.mock.calls.find((call: any[]) =>
        call[0].toLowerCase().includes("kde")
      );
      expect(statusNotification).toBeDefined();
      expect(statusNotification[0]).toMatch(/no kde device|kde.*none|kde.*not.*detected/i);
    });

    it("RED: /mobile link notification includes target device ID", async () => {
      process.env.PI_MOBILE_BRIDGE_KDE_DEVICE_ID = "a648fd25583644aa9c89057dfb068171";
      process.env.PI_MOBILE_BRIDGE_PORT = "0";
      process.env.PI_MOBILE_BRIDGE_HOST = "192.168.1.30";

      // Start server
      const sessionStartHandlers = registeredHooks.get("session_start");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await sessionStartHandlers![0]({}, mockCtx);

      // Trigger /mobile link
      const mobileCommand = registeredCommands.get("mobile");
      mockNotify.mockClear();
      await mobileCommand!.handler("link", mockCtx);

      // Assert notification includes device ID
      expect(mockNotify).toHaveBeenCalled();
      const linkNotification = mockNotify.mock.calls.find((call: any[]) =>
        call[0].includes("a648fd25583644aa9c89057dfb068171")
      );
      expect(linkNotification).toBeDefined();
      expect(linkNotification[0]).toContain("a648fd25583644aa9c89057dfb068171");
    });

    it("RED: /mobile devices command shows detected KDE device ID", async () => {
      process.env.PI_MOBILE_BRIDGE_KDE_DEVICE_ID = "a648fd25583644aa9c89057dfb068171";

      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      // Trigger /mobile devices
      await mobileCommand!.handler("devices", mockCtx);

      // Assert notification shows device ID
      expect(mockNotify).toHaveBeenCalled();
      expect(mockNotify).toHaveBeenCalledWith(
        expect.stringMatching(/a648fd25583644aa9c89057dfb068171|kde.*device/i)
      );
      
      // Verify it contains the actual device ID
      const devicesNotification = mockNotify.mock.calls[0][0];
      expect(devicesNotification).toContain("a648fd25583644aa9c89057dfb068171");
    });

    it("RED: /mobile devices shows 'no KDE device' when none detected", async () => {
      delete process.env.PI_MOBILE_BRIDGE_KDE_DEVICE_ID;

      // Mock spawnSync to return empty
      const spawnSyncMock = vi.fn(() => ({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        status: 0,
        signal: null,
        pid: 12345,
        output: [null, Buffer.from(""), Buffer.from("")],
      }));

      vi.doMock('node:child_process', () => ({
        spawn: spawnMock,
        spawnSync: spawnSyncMock,
      }));

      // Reinitialize extension
      registeredCommands.clear();
      registeredHooks.clear();
      const freshModule = await import("../extensions/mobile-bridge/index.ts?t=" + Date.now());
      freshModule.default(mockPi);

      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      // Trigger /mobile devices
      await mobileCommand!.handler("devices", mockCtx);

      // Assert notification indicates no device
      expect(mockNotify).toHaveBeenCalled();
      expect(mockNotify).toHaveBeenCalledWith(
        expect.stringMatching(/no kde device|kde.*none|not.*detected/i)
      );
    });

    it("RED: /mobile devices with auto-detected device ID shows the ID", async () => {
      delete process.env.PI_MOBILE_BRIDGE_KDE_DEVICE_ID;

      // Mock spawnSync to return device ID
      const spawnSyncMock = vi.fn(() => ({
        stdout: Buffer.from("a648fd25583644aa9c89057dfb068171\n"),
        stderr: Buffer.from(""),
        status: 0,
        signal: null,
        pid: 12345,
        output: [null, Buffer.from("a648fd25583644aa9c89057dfb068171\n"), Buffer.from("")],
      }));

      vi.doMock('node:child_process', () => ({
        spawn: spawnMock,
        spawnSync: spawnSyncMock,
      }));

      // Reinitialize extension
      registeredCommands.clear();
      registeredHooks.clear();
      const freshModule = await import("../extensions/mobile-bridge/index.ts?t=" + Date.now());
      freshModule.default(mockPi);

      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      // Trigger /mobile devices
      await mobileCommand!.handler("devices", mockCtx);

      // Assert notification shows auto-detected device ID
      expect(mockNotify).toHaveBeenCalled();
      const devicesNotification = mockNotify.mock.calls[0][0];
      expect(devicesNotification).toContain("a648fd25583644aa9c89057dfb068171");
    });
  });

  describe("RED: Automatic LAN IP Detection", () => {
    /**
     * These tests validate the new resolveStatusHost() helper function
     * that automatically detects LAN IP addresses from network interfaces.
     * 
     * Expected behavior:
     * 1. If PI_MOBILE_BRIDGE_HOST env is set, use that (override)
     * 2. Otherwise, detect first non-internal IPv4 from os.networkInterfaces()
     * 3. If no LAN IPv4 exists, fallback to 127.0.0.1
     */

    let resolveStatusHost: (envHost?: string, networkInterfaces?: any) => string;

    beforeEach(async () => {
      // Attempt to import the helper function
      try {
        const module = await import("../extensions/mobile-bridge/index.ts");
        resolveStatusHost = module.resolveStatusHost;
      } catch {
        // Expected to fail in RED phase - function doesn't exist yet
        resolveStatusHost = undefined as any;
      }
    });

    it("RED: env override wins - returns PI_MOBILE_BRIDGE_HOST when set", () => {
      expect(resolveStatusHost).toBeDefined();
      expect(typeof resolveStatusHost).toBe("function");

      const result = resolveStatusHost("192.168.1.99", {
        lo: [
          {
            address: "127.0.0.1",
            netmask: "255.0.0.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "127.0.0.1/8",
          },
        ],
        enp8s0f1: [
          {
            address: "192.168.1.30",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "ab:cd:ef:12:34:56",
            internal: false,
            cidr: "192.168.1.30/24",
          },
        ],
      });

      expect(result).toBe("192.168.1.99");
    });

    it("RED: auto-detect LAN IP - returns first non-internal IPv4 from network interfaces", () => {
      expect(resolveStatusHost).toBeDefined();
      expect(typeof resolveStatusHost).toBe("function");

      const mockNetworkInterfaces = {
        lo: [
          {
            address: "127.0.0.1",
            netmask: "255.0.0.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "127.0.0.1/8",
          },
          {
            address: "::1",
            netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
            family: "IPv6",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "::1/128",
            scopeid: 0,
          },
        ],
        enp8s0f1: [
          {
            address: "fe80::1234:5678:abcd:ef01",
            netmask: "ffff:ffff:ffff:ffff::",
            family: "IPv6",
            mac: "ab:cd:ef:12:34:56",
            internal: false,
            cidr: "fe80::1234:5678:abcd:ef01/64",
            scopeid: 2,
          },
          {
            address: "192.168.1.30",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "ab:cd:ef:12:34:56",
            internal: false,
            cidr: "192.168.1.30/24",
          },
        ],
      };

      const result = resolveStatusHost(undefined, mockNetworkInterfaces);

      expect(result).toBe("192.168.1.30");
    });

    it("RED: fallback to 127.0.0.1 - returns localhost when only internal interfaces exist", () => {
      expect(resolveStatusHost).toBeDefined();
      expect(typeof resolveStatusHost).toBe("function");

      const mockNetworkInterfaces = {
        lo: [
          {
            address: "127.0.0.1",
            netmask: "255.0.0.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "127.0.0.1/8",
          },
          {
            address: "::1",
            netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
            family: "IPv6",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "::1/128",
            scopeid: 0,
          },
        ],
      };

      const result = resolveStatusHost(undefined, mockNetworkInterfaces);

      expect(result).toBe("127.0.0.1");
    });

    it("RED: fallback to 127.0.0.1 - returns localhost when no interfaces provided", () => {
      expect(resolveStatusHost).toBeDefined();
      expect(typeof resolveStatusHost).toBe("function");

      const result = resolveStatusHost(undefined, {});

      expect(result).toBe("127.0.0.1");
    });

    it("RED: ignores IPv6 addresses - only considers IPv4", () => {
      expect(resolveStatusHost).toBeDefined();
      expect(typeof resolveStatusHost).toBe("function");

      const mockNetworkInterfaces = {
        eth0: [
          {
            address: "fe80::1234:5678:abcd:ef01",
            netmask: "ffff:ffff:ffff:ffff::",
            family: "IPv6",
            mac: "ab:cd:ef:12:34:56",
            internal: false,
            cidr: "fe80::1234:5678:abcd:ef01/64",
            scopeid: 2,
          },
          {
            address: "2001:db8::1",
            netmask: "ffff:ffff:ffff:ffff::",
            family: "IPv6",
            mac: "ab:cd:ef:12:34:56",
            internal: false,
            cidr: "2001:db8::1/64",
            scopeid: 0,
          },
        ],
        lo: [
          {
            address: "127.0.0.1",
            netmask: "255.0.0.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "127.0.0.1/8",
          },
        ],
      };

      const result = resolveStatusHost(undefined, mockNetworkInterfaces);

      // Should fallback to 127.0.0.1 since no non-internal IPv4 exists
      expect(result).toBe("127.0.0.1");
    });

    it("RED: returns first available LAN IP when multiple interfaces exist", () => {
      expect(resolveStatusHost).toBeDefined();
      expect(typeof resolveStatusHost).toBe("function");

      const mockNetworkInterfaces = {
        lo: [
          {
            address: "127.0.0.1",
            netmask: "255.0.0.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "127.0.0.1/8",
          },
        ],
        eth0: [
          {
            address: "10.0.1.50",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "11:22:33:44:55:66",
            internal: false,
            cidr: "10.0.1.50/24",
          },
        ],
        wlan0: [
          {
            address: "192.168.1.100",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "aa:bb:cc:dd:ee:ff",
            internal: false,
            cidr: "192.168.1.100/24",
          },
        ],
      };

      const result = resolveStatusHost(undefined, mockNetworkInterfaces);

      // Should return one of the non-internal IPv4 addresses
      expect(["10.0.1.50", "192.168.1.100"]).toContain(result);
    });
  });

  describe("RED: Robust KDE Connect Detection Diagnostics", () => {
    /**
     * These tests validate fallback mechanisms for device ID detection:
     * 1. Parse normal --list-devices output when --id-only returns empty
     * 2. Try /usr/bin/kdeconnect-cli as absolute path fallback
     * 3. New /mobile devices debug command for diagnostics
     */

    let spawnSyncMock: any;

    beforeEach(() => {
      delete process.env.PI_MOBILE_BRIDGE_KDE_DEVICE_ID;
      process.env.PI_MOBILE_BRIDGE_PORT = "0";

      spawnSyncMock = vi.fn();
      vi.doMock('node:child_process', () => ({
        spawn: spawnMock,
        spawnSync: spawnSyncMock,
      }));
    });

    it("RED: fallback to parsing normal --list-devices output when --id-only returns empty", async () => {
      // First call to --id-only returns empty
      // Second call to --list-devices returns normal output with device info
      let callCount = 0;
      spawnSyncMock.mockImplementation((command: string, args: string[]) => {
        callCount++;
        if (callCount === 1 && args.includes("--id-only")) {
          // First call: --id-only returns empty
          return {
            stdout: Buffer.from(""),
            stderr: Buffer.from(""),
            status: 0,
            signal: null,
            pid: 12345,
            output: [null, Buffer.from(""), Buffer.from("")],
          };
        } else if (callCount === 2 && !args.includes("--id-only")) {
          // Second call: normal --list-devices with parseable output
          return {
            stdout: Buffer.from(
              "- Pixel 3a XL: a648fd25583644aa9c89057dfb068171 on 192.168.1.19 via LAN (paired and reachable)\n"
            ),
            stderr: Buffer.from(""),
            status: 0,
            signal: null,
            pid: 12345,
            output: [
              null,
              Buffer.from(
                "- Pixel 3a XL: a648fd25583644aa9c89057dfb068171 on 192.168.1.19 via LAN (paired and reachable)\n"
              ),
              Buffer.from(""),
            ],
          };
        }
        return {
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          status: 1,
          signal: null,
          pid: 12345,
          output: [null, Buffer.from(""), Buffer.from("")],
        };
      });

      // Reinitialize extension
      registeredCommands.clear();
      registeredHooks.clear();
      const freshModule = await import("../extensions/mobile-bridge/index.ts?t=" + Date.now());
      freshModule.default(mockPi);

      // Start server to trigger detection
      const sessionStartHandlers = registeredHooks.get("session_start");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      await sessionStartHandlers![0]({}, mockCtx);

      // Verify spawnSync was called twice: first with --id-only, then without
      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      expect(spawnSyncMock).toHaveBeenNthCalledWith(
        1,
        "kdeconnect-cli",
        ["--list-devices", "--id-only"],
        expect.any(Object)
      );
      expect(spawnSyncMock).toHaveBeenNthCalledWith(
        2,
        "kdeconnect-cli",
        ["--list-devices"],
        expect.any(Object)
      );

      // Trigger /mobile link to verify extracted device ID is used
      const mobileCommand = registeredCommands.get("mobile");
      spawnMock.mockClear();
      await mobileCommand!.handler("link", mockCtx);

      // Assert spawn includes extracted device ID
      const spawnCall = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli" && call[1].includes("--share")
      );
      expect(spawnCall).toBeDefined();
      const args = spawnCall[1];
      expect(args).toContain("-d");
      expect(args).toContain("a648fd25583644aa9c89057dfb068171");
    });

    it("RED: parses device ID from multiple device list output", async () => {
      let callCount = 0;
      spawnSyncMock.mockImplementation((command: string, args: string[]) => {
        callCount++;
        if (callCount === 1 && args.includes("--id-only")) {
          return {
            stdout: Buffer.from(""),
            stderr: Buffer.from(""),
            status: 0,
            signal: null,
            pid: 12345,
            output: [null, Buffer.from(""), Buffer.from("")],
          };
        } else if (callCount === 2 && !args.includes("--id-only")) {
          // Multiple devices in output - should extract first
          return {
            stdout: Buffer.from(
              "- Samsung Galaxy: b12345678901234567890123456789ab on 192.168.1.10 via LAN (paired)\n" +
              "- Pixel 3a XL: a648fd25583644aa9c89057dfb068171 on 192.168.1.19 via LAN (paired and reachable)\n"
            ),
            stderr: Buffer.from(""),
            status: 0,
            signal: null,
            pid: 12345,
            output: [
              null,
              Buffer.from(
                "- Samsung Galaxy: b12345678901234567890123456789ab on 192.168.1.10 via LAN (paired)\n" +
                "- Pixel 3a XL: a648fd25583644aa9c89057dfb068171 on 192.168.1.19 via LAN (paired and reachable)\n"
              ),
              Buffer.from(""),
            ],
          };
        }
        return {
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          status: 1,
          signal: null,
          pid: 12345,
          output: [null, Buffer.from(""), Buffer.from("")],
        };
      });

      // Reinitialize extension
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

      // Trigger /mobile link - should use FIRST device ID from parsed output
      const mobileCommand = registeredCommands.get("mobile");
      spawnMock.mockClear();
      await mobileCommand!.handler("link", mockCtx);

      const spawnCall = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli" && call[1].includes("--share")
      );
      expect(spawnCall).toBeDefined();
      const args = spawnCall[1];
      expect(args).toContain("-d");
      expect(args).toContain("b12345678901234567890123456789ab");
      expect(args).not.toContain("a648fd25583644aa9c89057dfb068171");
    });

    it("RED: fallback to /usr/bin/kdeconnect-cli when kdeconnect-cli fails", async () => {
      let callCount = 0;
      spawnSyncMock.mockImplementation((command: string, args: string[]) => {
        callCount++;
        if (command === "kdeconnect-cli") {
          // First attempts with kdeconnect-cli fail
          return {
            stdout: Buffer.from(""),
            stderr: Buffer.from("kdeconnect-cli: command not found"),
            status: 127,
            signal: null,
            pid: 12345,
            output: [null, Buffer.from(""), Buffer.from("kdeconnect-cli: command not found")],
          };
        } else if (command === "/usr/bin/kdeconnect-cli" && args.includes("--id-only")) {
          // Fallback to absolute path succeeds
          return {
            stdout: Buffer.from("a648fd25583644aa9c89057dfb068171\n"),
            stderr: Buffer.from(""),
            status: 0,
            signal: null,
            pid: 12345,
            output: [null, Buffer.from("a648fd25583644aa9c89057dfb068171\n"), Buffer.from("")],
          };
        }
        return {
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          status: 1,
          signal: null,
          pid: 12345,
          output: [null, Buffer.from(""), Buffer.from("")],
        };
      });

      // Reinitialize extension
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

      // Verify spawnSync was called with /usr/bin/kdeconnect-cli
      const absolutePathCall = spawnSyncMock.mock.calls.find(
        (call: any[]) => call[0] === "/usr/bin/kdeconnect-cli"
      );
      expect(absolutePathCall).toBeDefined();

      // Trigger /mobile link - should use device ID from absolute path fallback
      const mobileCommand = registeredCommands.get("mobile");
      spawnMock.mockClear();
      await mobileCommand!.handler("link", mockCtx);

      const spawnCall = spawnMock.mock.calls.find(
        (call: any[]) => call[0] === "kdeconnect-cli" && call[1].includes("--share")
      );
      expect(spawnCall).toBeDefined();
      const args = spawnCall[1];
      expect(args).toContain("-d");
      expect(args).toContain("a648fd25583644aa9c89057dfb068171");
    });

    it("RED: /mobile devices debug shows diagnostic information", async () => {
      // Mock spawnSync to simulate detection attempt
      spawnSyncMock.mockImplementation((command: string, args: string[]) => {
        if (args.includes("--id-only")) {
          return {
            stdout: Buffer.from("a648fd25583644aa9c89057dfb068171\n"),
            stderr: Buffer.from(""),
            status: 0,
            signal: null,
            pid: 12345,
            output: [null, Buffer.from("a648fd25583644aa9c89057dfb068171\n"), Buffer.from("")],
          };
        }
        return {
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          status: 0,
          signal: null,
          pid: 12345,
          output: [null, Buffer.from(""), Buffer.from("")],
        };
      });

      // Reinitialize extension
      registeredCommands.clear();
      registeredHooks.clear();
      const freshModule = await import("../extensions/mobile-bridge/index.ts?t=" + Date.now());
      freshModule.default(mockPi);

      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      // Trigger /mobile devices debug
      await mobileCommand!.handler("devices debug", mockCtx);

      // Assert notification contains diagnostic information
      expect(mockNotify).toHaveBeenCalled();
      const debugNotification = mockNotify.mock.calls.find((call: any[]) =>
        call[0].toLowerCase().includes("kde") && call[0].toLowerCase().includes("debug")
      );
      expect(debugNotification).toBeDefined();

      const notification = debugNotification[0];
      // Must contain: 'kde debug', 'PATH', and stdout/status/error info
      expect(notification.toLowerCase()).toMatch(/kde.*debug/);
      expect(notification).toMatch(/PATH/i);
      expect(notification).toMatch(/stdout|status|error|stderr|command/i);
    });

    it("RED: /mobile devices debug shows failure diagnostics when detection fails", async () => {
      // Mock spawnSync to simulate failure
      spawnSyncMock.mockImplementation((command: string, args: string[]) => {
        return {
          stdout: Buffer.from(""),
          stderr: Buffer.from("kdeconnect-cli: command not found"),
          status: 127,
          signal: null,
          pid: 12345,
          output: [null, Buffer.from(""), Buffer.from("kdeconnect-cli: command not found")],
        };
      });

      // Reinitialize extension
      registeredCommands.clear();
      registeredHooks.clear();
      const freshModule = await import("../extensions/mobile-bridge/index.ts?t=" + Date.now());
      freshModule.default(mockPi);

      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      // Trigger /mobile devices debug
      await mobileCommand!.handler("devices debug", mockCtx);

      // Assert notification shows failure details
      expect(mockNotify).toHaveBeenCalled();
      const debugNotification = mockNotify.mock.calls.find((call: any[]) =>
        call[0].toLowerCase().includes("debug")
      );
      expect(debugNotification).toBeDefined();

      const notification = debugNotification[0];
      expect(notification.toLowerCase()).toMatch(/kde.*debug/);
      expect(notification).toMatch(/PATH/i);
      // Should contain error info
      expect(notification).toMatch(/status.*127|error|stderr|command not found/i);
    });

    it("RED: /mobile devices debug includes PATH environment variable", async () => {
      spawnSyncMock.mockReturnValue({
        stdout: Buffer.from("a648fd25583644aa9c89057dfb068171\n"),
        stderr: Buffer.from(""),
        status: 0,
        signal: null,
        pid: 12345,
        output: [null, Buffer.from("a648fd25583644aa9c89057dfb068171\n"), Buffer.from("")],
      });

      // Reinitialize extension
      registeredCommands.clear();
      registeredHooks.clear();
      const freshModule = await import("../extensions/mobile-bridge/index.ts?t=" + Date.now());
      freshModule.default(mockPi);

      const mobileCommand = registeredCommands.get("mobile");
      const mockNotify = vi.fn();
      const mockCtx: ExtensionCommandContext = {
        ui: { notify: mockNotify },
        cwd: "/test",
        model: "test-model",
      } as any;

      // Trigger /mobile devices debug
      await mobileCommand!.handler("devices debug", mockCtx);

      expect(mockNotify).toHaveBeenCalled();
      const debugNotification = mockNotify.mock.calls[0][0];
      // Must include PATH environment variable value
      expect(debugNotification).toMatch(/PATH.*=/);
    });
  });
});
