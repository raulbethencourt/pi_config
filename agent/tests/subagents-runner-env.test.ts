import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

import subagentsExtension from "../extensions/subagents/index.ts";

describe("subagents depth propagation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		spawnMock.mockReset();
		delete process.env.PI_SUBAGENT_DEPTH;
	});

	it("passes incremented PI_SUBAGENT_DEPTH to spawned child processes", async () => {
		process.env.PI_SUBAGENT_DEPTH = "2";

		let capturedEnv: Record<string, string | undefined> | undefined;
		const child = new EventEmitter() as any;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = vi.fn();

		spawnMock.mockImplementation((_command, _args, options) => {
			capturedEnv = options.env;
			queueMicrotask(() => child.emit("close", 0));
			return child;
		});

		let execute: ((toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => Promise<any>) | undefined;
		const pi = {
			on: vi.fn(),
			registerTool: vi.fn((tool) => {
				execute = tool.execute;
			}),
			registerCommand: vi.fn(),
		};

		subagentsExtension(pi as any);

		await execute?.("tool-1", { agent: "scout", task: "check depth", cwd: "/tmp" }, undefined, () => {}, { cwd: "/tmp" });

		expect(capturedEnv?.PI_SUBAGENT_DEPTH).toBe("3");
	});
});
