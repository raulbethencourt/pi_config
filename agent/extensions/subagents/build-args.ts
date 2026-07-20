/**
 * Builds the pi CLI invocation (args + env) for a subagent run.
 *
 * Extracted from index.ts so it can be imported by a standalone process
 * (the mcp-server extension) that spawns the real `pi` binary directly,
 * without pulling in the interactive-process-only parts of index.ts
 * (tool registration, rendering, telemetry wiring, etc.) or anything that
 * transitively resolves `@earendil-works/pi-coding-agent` — that package
 * is only resolvable from inside pi's own interactive process.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolve } from "node:path";
import type { AgentConfig } from "./index.ts";
import { applyAgentOverrides } from "./agent-overrides.ts";
import { resolveModel, loadRoutingConfig } from "./routing.ts";
import { resolveMCPTools, getMCPAdapterPath } from "./resolve-mcp-tools.ts";
import { filterChildTools } from "./filter-child-tools.ts";
import { stripParentOrchestrationContent } from "./strip-orchestration.ts";

// ── Vendored file-mutation queue ───────────────────────────────────────
// Copied verbatim (algorithm unchanged) from the installed
// @earendil-works/pi-coding-agent package (version 0.80.2), source:
// dist/core/tools/file-mutation-queue.js — a ~48-line pure
// node:fs/promises + node:path per-resolved-path mutex with no other
// dependencies. Vendored here because build-args.ts must not import from
// @earendil-works/pi-coding-agent, which is only resolvable inside pi's
// own interactive process. Re-check this against the installed package on
// upgrade in case the upstream algorithm changes.
const fileMutationQueues = new Map<string, Promise<unknown>>();
let registrationQueue: Promise<unknown> = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		((error as { code?: string }).code === "ENOENT" || (error as { code?: string }).code === "ENOTDIR")
	);
}

async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	try {
		return await realpath(resolvedPath);
	} catch (error) {
		if (isMissingPathError(error)) {
			return resolvedPath;
		}
		throw error;
	}
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
async function withLocalFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);
		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);
	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}

// ── Config ─────────────────────────────────────────────────────────────

const EXT_DIR = path.dirname(new URL(import.meta.url).pathname);
const AGENTS_DIR = path.join(EXT_DIR, "agents");
const AGENT_PROMPTS_SOURCE = "project:pi-agent-prompts";
const AGENT_PROMPTS_INDEX_MAX_DEPTH = 2;
const AGENT_PROMPTS_INDEX_MAX_FILES = 50;
const TOOLS_DIR = path.join(EXT_DIR, "tools");
const SKILLS_BASE = path.join(process.env.HOME || "~", ".pi", "agent", "skills");

// Built-in tools that pi provides natively (no extension needed)
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "rg"]);

// Custom tools that require loading an extension into the subagent process
const EXT_BASE = path.join(process.env.HOME || "~", ".pi", "agent", "extensions");

const HASHLINE_EXTENSION = path.resolve(EXT_DIR, "../hashline/index.ts");
const { routing: ROUTING_CONFIG, fallback: FALLBACK_CONFIG } = loadRoutingConfig(path.dirname(AGENTS_DIR));

const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
	web_search: path.join(EXT_BASE, "..", "npm", "node_modules", "pi-web-access", "index.ts"),
	web_fetch: path.join(EXT_BASE, "web-fetch", "index.ts"),
	fetch_content: path.join(EXT_BASE, "..", "npm", "node_modules", "pi-web-access", "index.ts"),
	get_search_content: path.join(EXT_BASE, "..", "npm", "node_modules", "pi-web-access", "index.ts"),
	code_search: path.join(EXT_BASE, "..", "npm", "node_modules", "pi-web-access", "index.ts"),
	safe_bash: path.join(TOOLS_DIR, "safe-bash.ts"),
	ast_grep: path.join(TOOLS_DIR, "ast-grep.ts"),
	repo_map: path.join(TOOLS_DIR, "repo-map.ts"),
	workspace: path.join(TOOLS_DIR, "workspace.ts"),
	test_config: path.join(TOOLS_DIR, "test-config.ts"),
	repomix: path.join(TOOLS_DIR, "repomix.ts"),
	video_extract: path.join(EXT_BASE, "video-extract", "index.ts"),
	token_stats: path.join(TOOLS_DIR, "token-stats.ts"),
	git_inspect: path.join(TOOLS_DIR, "git-inspect.ts"),
	memory: path.join(EXT_BASE, "memory", "index.ts"),
	youtube_search: path.join(EXT_BASE, "youtube-search", "index.ts"),
	google_image_search: path.join(EXT_BASE, "google-image-search", "index.ts"),
};

let agentPromptsIndexed = false;
let contextModeBaseDirCache: string | null | undefined;
let contextModeExtensionCache: string | null | undefined;
let contextModeCliCache: string | null | undefined;
let agentPromptsIndexPromise: Promise<boolean> | null = null;

function taskTargetsAgentPrompts(task: string): boolean {
	const normalized = task.replaceAll("\\", "/");
	return /(?:^|[\s"'`(])(?:\.\/|\.\.\/|\/?(?:[A-Za-z]:\/)?)(?:agent\/extensions\/subagents\/agents\/)[A-Za-z0-9._-]+\.md(?:$|[\s"'`),.:;\]])/.test(normalized);
}

function resolveContextModeBaseDir(): string | null {
	if (contextModeBaseDirCache !== undefined) return contextModeBaseDirCache;
	const directCandidate = path.join(EXT_BASE, "..", "npm", "node_modules", "context-mode");
	if (fs.existsSync(directCandidate)) {
		contextModeBaseDirCache = directCandidate;
		return contextModeBaseDirCache;
	}

	try {
		const entry = process.argv[1];
		if (!entry) return (contextModeBaseDirCache = null);
		const real = fs.realpathSync(entry);
		const marker = path.sep + "node_modules" + path.sep;
		const idx = real.indexOf(marker);
		if (idx === -1) return (contextModeBaseDirCache = null);
		const globalNodeModules = real.slice(0, idx + marker.length - 1);
		const candidate = path.join(globalNodeModules, "context-mode");
		contextModeBaseDirCache = fs.existsSync(candidate) ? candidate : null;
		return contextModeBaseDirCache;
	} catch {
		contextModeBaseDirCache = null;
		return contextModeBaseDirCache;
	}
}

function resolveContextModeExtension(): string | null {
	if (contextModeExtensionCache !== undefined) return contextModeExtensionCache;
	const baseDir = resolveContextModeBaseDir();
	if (!baseDir) return (contextModeExtensionCache = null);
	const packageJsonPath = path.join(baseDir, "package.json");
	try {
		const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
			pi?: { extensions?: string[] };
		};
		for (const relPath of pkg.pi?.extensions ?? []) {
			const candidate = path.join(baseDir, relPath);
			if (fs.existsSync(candidate)) return (contextModeExtensionCache = candidate);
		}
	} catch {}
	const legacyCandidates = [
		path.join(baseDir, "build", "adapters", "pi", "extension.js"),
		path.join(baseDir, "build", "pi-extension.js"),
	];
	for (const candidate of legacyCandidates) {
		if (fs.existsSync(candidate)) return (contextModeExtensionCache = candidate);
	}
	return (contextModeExtensionCache = null);
}

function resolveContextModeCli(): string | null {
	if (contextModeCliCache !== undefined) return contextModeCliCache;
	const baseDir = resolveContextModeBaseDir();
	if (!baseDir) return (contextModeCliCache = null);
	const candidate = path.join(baseDir, "cli.bundle.mjs");
	contextModeCliCache = fs.existsSync(candidate) ? candidate : null;
	return contextModeCliCache;
}

function ensureAgentPromptsIndexed(): Promise<boolean> {
	if (agentPromptsIndexed) return Promise.resolve(true);
	if (agentPromptsIndexPromise) return agentPromptsIndexPromise;
	const contextModeCli = resolveContextModeCli();
	if (!contextModeCli) return Promise.resolve(false);
	agentPromptsIndexPromise = new Promise<boolean>((resolve) => {
		execFile(
			process.execPath,
			[
				contextModeCli,
				"index",
				AGENTS_DIR,
				"--source",
				AGENT_PROMPTS_SOURCE,
				"--max-depth",
				String(AGENT_PROMPTS_INDEX_MAX_DEPTH),
				"--max-files",
				String(AGENT_PROMPTS_INDEX_MAX_FILES),
			],
			{ timeout: 15000 },
			(error) => {
				if (!error) agentPromptsIndexed = true;
				agentPromptsIndexPromise = null;
				resolve(!error);
			},
		);
	});
	return agentPromptsIndexPromise;
}

function getAgentPromptsSearchHint(agent: AgentConfig, childTools: string[]): string {
	if (!childTools.includes("ctx_search")) return "";
	const searchToolName = "ctx_search";
	const scoutLead = agent.name === "scout"
		? `Prefer ${searchToolName} first when the indexed prompt text should answer the task.`
		: `If you use ${searchToolName} for those files, scope it to that source.`;
	return `${scoutLead}
Example: ${searchToolName}({ source: "${AGENT_PROMPTS_SOURCE}", queries: ["<what you need>"] })`;
}

async function prepareTaskForIndexedAgentPrompts(agent: AgentConfig, childTools: string[], task: string): Promise<string> {
	if (!taskTargetsAgentPrompts(task)) return task;
	const searchHint = getAgentPromptsSearchHint(agent, childTools);
	if (!searchHint) return task;
	if (!(await ensureAgentPromptsIndexed())) return task;
	return `${task}

Agent prompt files in ${AGENTS_DIR} are indexed under source "${AGENT_PROMPTS_SOURCE}".
${searchHint}`;
}

// ── Pi Binary Resolution ──────────────────────────────────────────────

function resolvePiBinary(): { command: string; baseArgs: string[] } {
	// Resolve the pi entry point from process.argv[1]
	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = fs.realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry] };
			}
		} catch {}
	}
	return { command: "pi", baseArgs: [] };
}

// ── Build pi CLI args ──────────────────────────────────────────────────

export async function buildPiArgs(
	baseAgent: AgentConfig,
	task: string,
	cwd: string,
	piBinOverride?: { command: string; baseArgs: string[] },
): Promise<{ piArgs: string[]; tempDir: string; tier: string; usedFallback: boolean; routedModel: string; env: Record<string, string | undefined> }> {
	const agent = applyAgentOverrides(baseAgent, ROUTING_CONFIG.agentOverrides);
	// `resolvePiBinary()` resolves the pi entry point from `process.argv[1]`, which is
	// only meaningful when this runs inside pi's own interactive process. Callers running
	// as a standalone process (e.g. the mcp-server extension) must supply `piBinOverride`.
	const piBin = piBinOverride ?? resolvePiBinary();
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sub-"));

	const parentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const childDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
	const systemPrompt = stripParentOrchestrationContent(agent.systemPrompt);

	// Write system prompt to temp file
	const promptPath = path.join(tempDir, `${agent.name}.md`);
	await withLocalFileMutationQueue(promptPath, async () => {
		await fs.promises.writeFile(promptPath, systemPrompt, { encoding: "utf-8", mode: 0o600 });
	});

	const args = [...piBin.baseArgs, "--mode", "json", "-p", "--no-session"];

	// Load skills if specified, otherwise disable skill discovery
	if (agent.skills.length > 0) {
		for (const skillName of agent.skills) {
			const skillPath = path.join(SKILLS_BASE, skillName);
			if (fs.existsSync(path.join(skillPath, "SKILL.md"))) {
				args.push("--skill", skillPath);
			}
		}
	} else {
		args.push("--no-skills");
	}

	// Separate builtin tools from custom tools
	const contextModeExtension = resolveContextModeExtension();
	const childTools = filterChildTools(agent.tools, agent.name, childDepth);
	const effectiveTask = await prepareTaskForIndexedAgentPrompts(agent, childTools, task);
	const builtinTools: string[] = [];
	const extensionPaths = new Set<string>();

	for (const tool of childTools) {
		if (BUILTIN_TOOLS.has(tool)) {
			builtinTools.push(tool);
		} else if (CUSTOM_TOOL_EXTENSIONS[tool]) {
			extensionPaths.add(CUSTOM_TOOL_EXTENSIONS[tool]);
		}
	}

	// Use --no-extensions then add only what we need
	args.push("--no-extensions");

	// Include custom tool names in the allowlist so extension-registered tools aren't blocked
	const customToolNames = Object.keys(CUSTOM_TOOL_EXTENSIONS).filter(t => childTools.includes(t));
	const allToolNames = [...builtinTools, ...customToolNames];

	// Add only the declared context-mode tools to the allowlist when extension is loaded
	if (contextModeExtension) {
		const CONTEXT_MODE_TOOLS = childTools.filter((tool) => tool.startsWith("ctx_"));
		allToolNames.push(...CONTEXT_MODE_TOOLS);
	}

	if (allToolNames.length > 0) {
		args.push("--tools", allToolNames.join(","));
	} else {
		// No tools needed — disable defaults
		args.push("--no-tools");
	}

	for (const extPath of extensionPaths) {
		args.push("--extension", extPath);
	}

	// Always load context-mode extension for session tracking and routing if available
	if (contextModeExtension) {
		args.push("--extension", contextModeExtension);
	}

	// Always load hashline extension for consistent edit tool behavior
	if (fs.existsSync(HASHLINE_EXTENSION)) {
		args.push("--extension", HASHLINE_EXTENSION);
	}

	const { model: routedModel, tier: complexityTier, usedFallback } = resolveModel(
		agent.model,
		agent.name,
		task,
		ROUTING_CONFIG,
		FALLBACK_CONFIG,
	);
	args.push("--models", routedModel);
	if (agent.thinking) {
		args.push("--thinking", agent.thinking);
	}
	args.push("--append-system-prompt", promptPath);

	// Handle long tasks by writing to file
	const TASK_LIMIT = 8000;
	if (effectiveTask.length > TASK_LIMIT) {
		const taskPath = path.join(tempDir, "task.md");
		await withLocalFileMutationQueue(taskPath, async () => {
			await fs.promises.writeFile(taskPath, `Task: ${effectiveTask}`, { encoding: "utf-8", mode: 0o600 });
		});
		args.push(`@${taskPath}`);
	} else {
		args.push(`Task: ${effectiveTask}`);
	}

	// Resolve MCP tools
	const resolvedMCP = resolveMCPTools(agent);
	const mcpEnv: Record<string, string | undefined> = {
		MCP_DIRECT_TOOLS: resolvedMCP.envValue,
		PI_SUBAGENT_DEPTH: String(childDepth),
	};

	if (resolvedMCP.loadAdapter) {
		// Add pi-mcp-adapter extension to the load list
		const adapterPath = getMCPAdapterPath();
		if (fs.existsSync(adapterPath)) {
			extensionPaths.add(adapterPath);
		}
		// Add prefixed tool names to the tool allowlist
		for (const name of resolvedMCP.prefixedNames) {
			allToolNames.push(name);
		}
	}

	return { piArgs: [piBin.command, ...args], tempDir, usedFallback, tier: complexityTier, routedModel, env: mcpEnv };
}
