/**
 * Resolve MCP tool access requests against the on-disk MCP cache and config.
 *
 * Reads mcp-cache.json and mcp.json directly from ~/.pi/ to determine which MCP
 * tools a subagent should have access to. Replicates minimal prefix/format logic
 * from pi-mcp-adapter without importing from it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const EXT_BASE = path.join(os.homedir(), ".pi", "agent", "extensions");

export interface ResolvedMCPTools {
	/** Value for MCP_DIRECT_TOOLS env var: "serverName/toolName,serverName/toolName" or "__none__" */
	envValue: string;
	/** Prefixed tool names for the child tool allowlist (e.g. ["serverX/toolY"]) */
	prefixedNames: string[];
	/** Whether to load pi-mcp-adapter extension into the child process */
	loadAdapter: boolean;
}

/**
 * Get the server prefix mode from MCP settings.
 */
export function getServerPrefix(settings?: { toolPrefix?: string }): string {
	return settings?.toolPrefix ?? "server";
}

/**
 * Format a tool name with server prefix for the tool allowlist.
 *
 * - "server" mode: "normalizedServer_toolName" (dashes replaced with underscores)
 * - "none" mode: "toolName" (no prefix)
 * - "short" mode: shortened server prefix with underscore, e.g. "server_toolName"
 */
export function formatToolName(
	serverName: string,
	toolName: string,
	mode: string,
): string {
	if (mode === "server") {
		const normalizedServer = serverName.replace(/-/g, "_");
		return `${normalizedServer}_${toolName}`;
	}
	if (mode === "none") return toolName;
	// "short" mode
	const short = serverName.replace(/-mcp$/i, "").replace(/mcp$/i, "").replace(/-/g, "_");
	return `${short}_${toolName}`;
}

/**
 * Get the explicit path to the pi-mcp-adapter extension entry file.
 */
export function getMCPAdapterPath(): string {
	return path.join(EXT_BASE, "..", "npm", "node_modules", "pi-mcp-adapter", "index.ts");
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
	try {
		if (fs.existsSync(filePath)) {
			return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
		}
	} catch {
		// Parse error -- treat as empty/missing
	}
	return fallback;
}

/**
 * Resolve MCP tool access for the given agent config.
 *
 * Reads mcp-cache.json and mcp.json from disk, resolves the mcpTools spec
 * (supports "*", "serverName", "serverName/toolName"), and returns the
 * environment value, prefixed names for the tool allowlist, and whether
 * the pi-mcp-adapter extension should be loaded.
 */
export function resolveMCPTools(agent: { mcpTools?: string }): ResolvedMCPTools {
	const spec = agent.mcpTools;
	if (!spec) {
		return { envValue: "__none__", prefixedNames: [], loadAdapter: false };
	}

	const home = os.homedir();
	const cachePath = path.join(home, ".pi", "mcp-cache.json");
	const configPath = path.join(home, ".pi", "mcp.json");

	const cache = readJsonSafe<{
		servers?: Record<string, { tools?: Array<{ name: string }> }>;
	}>(cachePath, { servers: {} });
	const config = readJsonSafe<{ settings?: { toolPrefix?: string } }>(configPath, {});

	const prefixMode = getServerPrefix(config.settings);
	const servers = cache.servers ?? {};

	const matchedPairs: Array<{ server: string; tool: string }> = [];

	for (const token of spec.split(",").map(part => part.trim()).filter(Boolean)) {
		if (token === "*") {
			// All tools from all servers
			for (const [serverName, serverCache] of Object.entries(servers)) {
				for (const tool of serverCache.tools ?? []) {
					matchedPairs.push({ server: serverName, tool: tool.name });
				}
			}
		} else if (token.includes("/")) {
			// Specific tool: "serverName/toolName"
			const [serverName, toolName] = token.split("/", 2);
			const serverCache = servers[serverName];
			if (serverCache) {
				for (const tool of serverCache.tools ?? []) {
					if (tool.name === toolName) {
						matchedPairs.push({ server: serverName, tool: tool.name });
						break;
					}
				}
			}
		} else {
			// All tools from a specific server: "serverName"
			const serverCache = servers[token];
			if (serverCache) {
				for (const tool of serverCache.tools ?? []) {
					matchedPairs.push({ server: token, tool: tool.name });
				}
			}
		}
	}

	if (matchedPairs.length === 0) {
		return { envValue: "__none__", prefixedNames: [], loadAdapter: false };
	}

	// Env value always uses "serverName/toolName" format (what pi-mcp-adapter reads)
	const envValue = matchedPairs.map(p => `${p.server}/${p.tool}`).join(",");

	// Prefixed names use formatToolName (for the --tools allowlist)
	const prefixedNames = matchedPairs.map(p => formatToolName(p.server, p.tool, prefixMode));

	return { envValue, prefixedNames, loadAdapter: true };
}
