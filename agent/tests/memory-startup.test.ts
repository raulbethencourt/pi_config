import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import memoryInit from "../extensions/memory/index.ts";

let beforeAgentStart: ((event: any, ctx: any) => Promise<any> | any) | null = null;

const mockPi = {
	registerTool: () => {},
	on: (eventName: string, handler: any) => {
		if (eventName === "before_agent_start") {
			beforeAgentStart = handler;
		}
	},
	registerCommand: () => {},
};

function memoryFile(dir: string, cwd: string): string {
	const hash = crypto.createHash("md5").update(cwd).digest("hex");
	return path.join(dir, `${hash}.md`);
}

describe("memory startup injection", () => {
	let tempDir: string;
	let originalEnv: string | undefined;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-startup-test-"));
		originalEnv = process.env.PI_MEMORY_DIR;
		originalCwd = process.cwd();
		process.env.PI_MEMORY_DIR = tempDir;
		beforeAgentStart = null;
		memoryInit(mockPi as any);
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
		if (originalEnv === undefined) {
			delete process.env.PI_MEMORY_DIR;
		} else {
			process.env.PI_MEMORY_DIR = originalEnv;
		}
		process.chdir(originalCwd);
	});

	it("injects project memory from ctx.cwd instead of process.cwd", async () => {
		const processDir = path.join(tempDir, "process-project");
		const ctxDir = path.join(tempDir, "ctx-project");
		fs.mkdirSync(processDir, { recursive: true });
		fs.mkdirSync(ctxDir, { recursive: true });

		fs.writeFileSync(memoryFile(tempDir, ctxDir), "- [2026-01-01T00:00:00Z] ctx memory\n", "utf-8");
		fs.writeFileSync(memoryFile(tempDir, processDir), "- [2026-01-01T00:00:00Z] process memory\n", "utf-8");

		process.chdir(processDir);

		const result = await beforeAgentStart?.(
			{ systemPrompt: "Base prompt" },
			{ cwd: ctxDir },
		);

		expect(result?.systemPrompt).toContain("ctx memory");
		expect(result?.systemPrompt).not.toContain("process memory");
	});
});
