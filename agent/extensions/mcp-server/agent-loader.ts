/**
 * Loads the fixed set of read-only personas exposed as MCP tools.
 *
 * Closed allowlist, resolved by exact filename against
 * agent/extensions/subagents/agents/ — never enumerated dynamically, so no
 * persona can be exposed over MCP without an explicit code change here.
 *
 * The frontmatter in these 6 files is flat scalars / comma-separated lists
 * only, so a minimal hand-written parser is sufficient (no YAML dependency).
 *
 * Critically, this parser never reads or populates an `mcpTools` field, even
 * though scout.md/researcher.md declare one in their real frontmatter
 * (`mcpTools: github/search_repositories, github/get_file_contents`). The
 * returned object structurally lacks that field, so `resolveMCPTools()`
 * (used inside the reused `buildPiArgs`) always takes its no-op early-return
 * branch for every MCP-server-sourced call — a structural guarantee, not a
 * runtime filter that could be bypassed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../subagents/index.ts";

const AGENTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "subagents", "agents");

const ALLOWED_PERSONAS = [
	"scout.md",
	"researcher.md",
	"planner.md",
	"critic.md",
	"code-reviewer.md",
	"code-reviewer-deep.md",
] as const satisfies readonly string[];

const TOOLS_TO_EXCLUDE = new Set(["memory"]);

function splitList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

/**
 * Parse a persona markdown file's frontmatter + body.
 *
 * Frontmatter is delimited by a `---` line, flat `key: value` lines, and a
 * closing `---` line — no YAML nesting, lists, or multi-line scalars appear
 * in any of the 6 allowlisted files.
 */
function parsePersonaFile(filePath: string): AgentConfig {
	const content = fs.readFileSync(filePath, "utf-8");
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) {
		throw new Error(`mcp-server: persona file is missing frontmatter delimiters: ${filePath}`);
	}
	const [, frontmatterBlock, body] = match;

	const frontmatter: Record<string, string> = {};
	for (const line of frontmatterBlock.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const separatorIdx = line.indexOf(":");
		if (separatorIdx === -1) continue;
		const key = line.slice(0, separatorIdx).trim();
		const value = line.slice(separatorIdx + 1).trim();
		frontmatter[key] = value;
	}

	if (!frontmatter.name) {
		throw new Error(`mcp-server: persona file is missing required "name" frontmatter field: ${filePath}`);
	}

	const tools = splitList(frontmatter.tools).filter((tool) => !TOOLS_TO_EXCLUDE.has(tool));
	const skills = splitList(frontmatter.skills);

	// Deliberately does not read/populate `mcpTools` — see module doc comment.
	return {
		name: frontmatter.name,
		description: frontmatter.description || "",
		tools,
		skills,
		model: frontmatter.model || "anthropic/claude-sonnet-4-6",
		thinking: frontmatter.thinking,
		systemPrompt: body,
		filePath,
	};
}

/** Load the 6 allowlisted personas. Throws if any expected file is missing. */
export function loadAllowedPersonas(): AgentConfig[] {
	return ALLOWED_PERSONAS.map((fileName) => {
		const filePath = path.join(AGENTS_DIR, fileName);
		if (!fs.existsSync(filePath)) {
			throw new Error(`mcp-server: allowlisted persona file not found: ${filePath}`);
		}
		return parsePersonaFile(filePath);
	});
}
