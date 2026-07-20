#!/usr/bin/env node
/**
 * Standalone MCP server exposing 6 read-only pi subagent personas as MCP
 * tools over stdio: scout, researcher, planner, critic, codereviewer,
 * codereviewer-deep.
 *
 * This is a standalone process, NOT a pi extension — it spawns the real
 * `pi` CLI binary as a subprocess for each tool call, reusing the same
 * `buildPiArgs`/`spawnPiProcess` machinery the interactive `subagent` tool
 * uses (agent/extensions/subagents/build-args.ts and runner.ts). It must
 * never import anything that transitively pulls in
 * `@earendil-works/pi-coding-agent` as a *value* (only type-only imports,
 * which are erased at compile time, are safe) — that package is only
 * resolvable from inside pi's own interactive process, not from a
 * standalone script like this one.
 *
 * Run directly: `node agent/extensions/mcp-server/serve.ts`
 * (Node 22.6+ strips TypeScript type syntax natively; no build step needed.)
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { AgentConfig, AgentResult } from "../subagents/index.ts";
import { buildPiArgs } from "../subagents/build-args.ts";
import { spawnPiProcess } from "../subagents/runner.ts";
import { initTelemetryDb, logRun, logToolCalls } from "../subagents/telemetry.ts";
import { closeTranscript, openTranscript, writeOutput } from "../subagents/transcript.ts";
import { extractTextContent } from "../shared/content.ts";
import { loadAllowedPersonas } from "./agent-loader.ts";
import { buildMinimalEnv } from "./env-allowlist.ts";
import { Semaphore, resolveMaxConcurrency } from "./concurrency.ts";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.ts";

const EXT_DIR = path.dirname(new URL(import.meta.url).pathname);
const NPM_NODE_MODULES = path.join(EXT_DIR, "..", "..", "npm", "node_modules");
const SDK_SERVER_DIR = path.join(NPM_NODE_MODULES, "@modelcontextprotocol", "sdk", "dist", "esm", "server");
const ZOD_INDEX = path.join(NPM_NODE_MODULES, "zod", "index.js");

const DEFAULT_TOOL_TIMEOUT_MS = 300_000; // 5 minutes
const telemetryEnabled = process.env.PI_MCP_SERVER_TELEMETRY !== "0";

// subagents/telemetry.ts calls the bare identifier `require("node:sqlite")` (lazily,
// inside a try/catch, so it can gracefully degrade on Node versions without
// node:sqlite). That resolves fine when telemetry.ts runs inside pi's own
// interactive process (loaded via jiti, which injects a `require` shim), but this
// server is a plain standalone ESM process with no such shim, so the bare
// `require` identifier would otherwise fall through to nothing and throw
// "require is not defined" — which telemetry.ts's own try/catch then reports as
// a (spurious) "SQLite unavailable" condition. Installing a real `require` on
// globalThis here — without modifying telemetry.ts itself — lets that unbound
// identifier resolve correctly, since plain JS identifier lookups fall back to
// the global object when no lexical binding exists.
globalThis.require = createRequire(import.meta.url);

// Same shape as subagents/index.ts's extractToolArgsPreview, duplicated here
// (not imported) because index.ts is a value-importing entrypoint for
// @earendil-works/pi-coding-agent and must never be imported at runtime
// from this standalone process.
function extractToolArgsPreview(args: Record<string, unknown>): string {
	if (args.command) return String(args.command).slice(0, 100);
	if (args.path) return String(args.path);
	if (args.query) return `"${String(args.query).slice(0, 80)}"`;
	if (args.url) return String(args.url);
	if (args.pattern) return String(args.pattern);
	const s = JSON.stringify(args);
	return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function resolveToolTimeoutMs(): number {
	const raw = process.env.PI_MCP_SERVER_TOOL_TIMEOUT_MS;
	if (raw === undefined) return DEFAULT_TOOL_TIMEOUT_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_TIMEOUT_MS;
}

/** Resolve the real `pi` binary once at startup. Cached for the server's lifetime. */
function resolvePiBinary(): { command: string; baseArgs: string[] } {
	const override = process.env.PI_BINARY_PATH;
	if (override) return { command: override, baseArgs: [] };
	return { command: "pi", baseArgs: [] };
}

function verifyPiBinary(piBin: { command: string; baseArgs: string[] }): void {
	const result = spawnSync(piBin.command, [...piBin.baseArgs, "--version"], {
		env: buildMinimalEnv(),
		encoding: "utf-8",
		timeout: 15_000,
	});
	if (result.error || result.status !== 0) {
		const detail = result.error?.message ?? (result.stderr?.trim() || `exit code ${result.status}`);
		console.error(`[mcp-server] Startup check failed: could not run "${piBin.command} --version" (${detail}).`);
		console.error(`[mcp-server] Set PI_BINARY_PATH to an explicit path to the pi binary if it is not on PATH.`);
		process.exit(1);
	}
}

function validateCwd(cwd: string): string | null {
	if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
		return `cwd must be an absolute, existing directory: ${cwd}`;
	}
	return null;
}

interface CallToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

function errorResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

async function runPersonaTool(
	agent: AgentConfig,
	task: string,
	cwd: string,
	piBin: { command: string; baseArgs: string[] },
	semaphore: Semaphore,
	sessionId: string,
): Promise<CallToolResult> {
	const cwdError = validateCwd(cwd);
	if (cwdError) return errorResult(cwdError);

	await semaphore.acquire();
	let tempDir: string | undefined;
	try {
		const { piArgs, tempDir: builtTempDir, routedModel, env } = await buildPiArgs(agent, task, cwd, piBin);
		tempDir = builtTempDir;
		const command = piArgs[0];
		const spawnArgs = piArgs.slice(1);
		const spawnEnv = { ...buildMinimalEnv(), ...env };

		const startTime = Date.now();
		const result: AgentResult = {
			agent: agent.name,
			task,
			output: "",
			exitCode: 0,
			model: routedModel,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			progress: {
				agent: agent.name,
				status: "running",
				task,
				recentTools: [],
				toolCount: 0,
				tokens: 0,
				durationMs: 0,
				lastMessage: "",
			},
		};
		const progress = result.progress;

		const timeoutMs = resolveToolTimeoutMs();
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);

		let exitCode: number;
		try {
			({ exitCode } = await spawnPiProcess({
				command,
				spawnArgs,
				cwd,
				signal: controller.signal,
				result,
				progress,
				startTime,
				fireUpdate: () => {},
				extractToolArgsPreview,
				extractTextContent,
				env: spawnEnv,
				envMode: "replace",
			}));
		} finally {
			clearTimeout(timer);
		}
		result.exitCode = exitCode;
		progress.durationMs = Date.now() - startTime;

		if (telemetryEnabled) {
			const transcript = openTranscript(agent.name, task, routedModel);
			writeOutput(transcript, result.output || "(no output)");
			progress.status = exitCode === 0 && !progress.error ? "completed" : "failed";
			closeTranscript(transcript, progress.status, progress.tokens, progress.durationMs, result.usage.cost);
			const depth = Number(env.PI_SUBAGENT_DEPTH ?? "1");
			const runId = logRun(result, cwd, sessionId, depth, 0);
			if (runId != null) {
				const toolMap = new Map<string, number>();
				for (const t of progress.recentTools) toolMap.set(t.tool, (toolMap.get(t.tool) || 0) + 1);
				if (toolMap.size > 0) {
					logToolCalls(runId, [...toolMap.entries()].map(([tool, count]) => ({ tool, count })));
				}
			}
		}

		if (timedOut) {
			return errorResult(`Persona '${agent.name}' timed out after ${Math.round(timeoutMs / 1000)}s and was terminated.`);
		}

		// A spawn-level failure (e.g. ENOENT on the pi binary) is distinguished from a
		// normal nonzero exit by: the process never produced any tool activity or
		// output before failing, and runner.ts's spawn `error` handler recorded a message.
		const looksLikeSpawnFailure = exitCode !== 0 && progress.toolCount === 0 && result.usage.turns === 0 && !result.output && !!progress.error;
		if (looksLikeSpawnFailure) {
			return errorResult(`Failed to start pi subprocess: ${progress.error}`);
		}

		const truncated = result.output.length > DEFAULT_MAX_BYTES
			? truncateHead(result.output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES }).content
			: result.output;

		if (exitCode !== 0) {
			return errorResult(truncated || `(agent exited with code ${exitCode}, no output)`);
		}

		return { content: [{ type: "text", text: truncated || "(no output)" }] };
	} finally {
		semaphore.release();
		if (tempDir) {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {}
		}
	}
}

async function main(): Promise<void> {
	const piBin = resolvePiBinary();
	verifyPiBinary(piBin);

	if (telemetryEnabled) initTelemetryDb();
	const sessionId = `mcp-${process.pid}-${Date.now()}`;
	const semaphore = new Semaphore(resolveMaxConcurrency());
	const personas = loadAllowedPersonas();

	const { McpServer } = await import(path.join(SDK_SERVER_DIR, "mcp.js"));
	const { StdioServerTransport } = await import(path.join(SDK_SERVER_DIR, "stdio.js"));
	const zodModule = await import(ZOD_INDEX);
	const z = zodModule.z ?? zodModule.default;

	const server = new McpServer({ name: "pi-subagents-mcp-server", version: "0.1.0" });

	for (const agent of personas) {
		server.registerTool(
			agent.name,
			{
				description: `${agent.description} (read-only pi subagent persona, run as a subprocess). Both "task" and "cwd" are required; "cwd" must be an absolute, existing directory.`,
				inputSchema: {
					task: z.string().describe("Task description for the persona to work on."),
					cwd: z.string().describe("Absolute, existing working directory for the persona process."),
				},
			},
			async (args: { task: string; cwd: string }) => runPersonaTool(agent, args.task, args.cwd, piBin, semaphore, sessionId),
		);
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`[mcp-server] Ready. Registered tools: ${personas.map((a) => a.name).join(", ")}.`);
}

main().catch((err) => {
	console.error(`[mcp-server] Fatal startup error: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
