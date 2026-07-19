import * as fs from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ParsedRule, RuleOrigin } from "./types.ts";

export interface LoadRulesOptions {
  globalDir: string;
  projectDir: string;
}

// Size ceiling for an individual rule body, mirroring the established
// warn/truncate pattern in `agent/extensions/memory/index.ts`
// (`MAX_MEMORY_BYTES`) rather than inventing a new one. Rule bodies are
// injected as extra tool-result content on every matching touch (see
// `agent/rules/README.md` "Keep rule bodies short"), so an oversized body —
// authoring mistake or a maliciously large planted file — is capped instead
// of injected verbatim.
export const MAX_RULE_BODY_BYTES = 4 * 1024;

function truncateBody(body: string, filePath: string): string {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes <= MAX_RULE_BODY_BYTES) return body;
  console.error(
    `rules-loader: "${filePath}" body is ${bytes} bytes, exceeding the ${MAX_RULE_BODY_BYTES}-byte cap — truncating.`,
  );
  return Buffer.from(body, "utf8").subarray(0, MAX_RULE_BODY_BYTES).toString("utf8");
}

function listRuleFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist (or isn't readable) — no rules there, non-fatal.
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function isValidPaths(paths: unknown): paths is string[] {
  return Array.isArray(paths) && paths.length > 0 && paths.every((p) => typeof p === "string");
}

/**
 * Detects whether `content` opens with a `---`-delimited frontmatter block at
 * all, mirroring `parseFrontmatter`'s own internal `extractFrontmatter`
 * detection (normalize newlines, must start with `---`, must have a closing
 * `\n---`). `parseFrontmatter` itself collapses "no block" and "empty block"
 * to the same `{}` result, so this is checked independently — it's what lets
 * `parseRuleFile` tell a plain markdown file (e.g. a bundled README with no
 * frontmatter at all — not attempting to be a rule) apart from a rule file
 * that has a frontmatter block but a missing/invalid `paths` field (a rule
 * author's mistake worth surfacing).
 */
function hasFrontmatterBlock(content: string): boolean {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.startsWith("---") && normalized.indexOf("\n---", 3) !== -1;
}

/**
 * Reads and validates a single rule file. Returns `undefined` silently for a
 * file with no frontmatter block at all (not attempting to be a rule), or
 * (after logging via `console.error`) for a file that can't be read, has a
 * frontmatter block but fails to parse as YAML, has a missing/invalid
 * `paths` field, or has a pattern picomatch cannot compile — callers must
 * treat all of these as non-fatal, skip-and-continue conditions, not a hard
 * load failure.
 */
function parseRuleFile(filePath: string, origin: RuleOrigin): ParsedRule | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    console.error(`rules-loader: skipping "${filePath}" — could not read file: ${(error as Error).message}`);
    return undefined;
  }
  if (!hasFrontmatterBlock(raw)) return undefined;

  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw));
  } catch (error) {
    console.error(
      `rules-loader: skipping "${filePath}" — invalid YAML frontmatter: ${(error as Error).message}`,
    );
    return undefined;
  }

  const basename = path.basename(filePath, path.extname(filePath));
  const id = typeof frontmatter.id === "string" && frontmatter.id.length > 0 ? frontmatter.id : basename;

  const paths = frontmatter.paths;
  if (!isValidPaths(paths)) {
    console.error(
      `rules-loader: skipping "${filePath}" — "paths" frontmatter field must be a non-empty array of glob strings.`,
    );
    return undefined;
  }

  try {
    for (const pattern of paths) {
      picomatch(pattern);
    }
  } catch (error) {
    console.error(
      `rules-loader: skipping "${filePath}" — uncompilable glob pattern: ${(error as Error).message}`,
    );
    return undefined;
  }

  return { id, paths, body: truncateBody(body, filePath), origin, filePath };
}

/**
 * Discovers and parses `*.md` rule files from `globalDir` and `projectDir`,
 * merging them into a single list keyed by filename basename — a rule file
 * present in both directories is loaded only once, with the project version
 * winning over the global one. Files that fail validation are skipped
 * (logged, non-fatal); the rest of the directory still loads.
 */
export function loadRules({ globalDir, projectDir }: LoadRulesOptions): ParsedRule[] {
  const rulesByBasename = new Map<string, ParsedRule>();
  const dirsByOrigin: [string, RuleOrigin][] = [
    [globalDir, "global"],
    [projectDir, "project"],
  ];

  for (const [dir, origin] of dirsByOrigin) {
    for (const filePath of listRuleFiles(dir)) {
      const rule = parseRuleFile(filePath, origin);
      if (!rule) continue;
      const basename = path.basename(filePath, path.extname(filePath));
      rulesByBasename.set(basename, rule);
    }
  }

  return [...rulesByBasename.values()];
}
