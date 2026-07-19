import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { loadRules } from "./loader.ts";
import { matchesAnyPattern } from "./matcher.ts";
import { formatRuleInjection } from "./format.ts";
import type { ParsedRule } from "./types.ts";

const TRACKED_TOOL_NAMES = new Set(["read", "write", "edit"]);

// Reuse the package's own project-local config dir name (`.pi`) rather than
// hardcoding it, for consistency with `discoverAndLoadExtensions`'s
// `cwd/${CONFIG_DIR_NAME}/extensions/` convention. Accessed via a namespace
// import (not a named import) because not every installed build of
// `@earendil-works/pi-coding-agent` re-exports `CONFIG_DIR_NAME` from its
// public entry point — a missing named export would throw a hard SyntaxError
// under native ESM at module-link time, before any fallback logic could run,
// whereas a namespace import always resolves and simply omits the missing
// key. Falls back to the package's own documented default when absent.
const CONFIG_DIR_NAME: string =
  typeof (piCodingAgent as Record<string, unknown>).CONFIG_DIR_NAME === "string"
    ? ((piCodingAgent as Record<string, unknown>).CONFIG_DIR_NAME as string)
    : ".pi";

// Mirrors hashline's read/edit selector suffix format (`:14-20`, `:raw`,
// `:conflicts`, `:sel`) — public/observable in tool call arguments, so
// duplicating this small regex locally is fine. Importing hashline's own
// path-utils.ts would instead be brittle coupling to a sibling extension's
// internals, which aren't exported from its package entry point.
const SELECTOR_SUFFIX_RE = /:(?:\d+-\d+|raw|conflicts|sel)$/;

function stripSelector(rawPath: string): string {
  return rawPath.replace(SELECTOR_SUFFIX_RE, "");
}

function resolveAbsolutePath(rawPath: string, cwd: string): string | undefined {
  const trimmed = rawPath.trim();
  if (!trimmed) return undefined;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return path.join(homedir(), trimmed.slice(2));
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(cwd, trimmed);
}

/**
 * Local, self-contained session-id resolution — deliberately not imported
 * from hashline (`resolveSessionId` there is a private module helper, not
 * exported from `hashline/index.ts`). Tries a flat `ctx.sessionId` first
 * (test/mock contexts that provide one directly), then falls back to the
 * real `ExtensionContext` shape (`ctx.sessionManager.getSessionId()`), then
 * a per-cwd ephemeral id so dedup degrades gracefully instead of throwing
 * when neither is available.
 */
function resolveSessionId(ctx: any): string {
  const candidates: unknown[] = [
    ctx?.sessionId,
    ctx?.sessionManager?.getSessionId?.(),
    typeof ctx?.cwd === "string" ? `ephemeral:${ctx.cwd}` : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return "default";
}

function extractToolPath(event: ToolResultEvent): string | undefined {
  const rawPath = (event.input as Record<string, unknown> | undefined)?.path;
  return typeof rawPath === "string" ? rawPath : undefined;
}

/**
 * `edit`'s input shape (registered by the sibling `hashline` extension) is
 * `{ input: string }` — a hashline-formatted string that can carry ONE OR
 * MORE `¶path#tag` header lines, one per touched file/hunk — not the plain
 * `{ path: string }` shape `read`/`write` use. `extractToolPath` above
 * therefore always returns `undefined` for `edit`, which is exactly the bug
 * this function fixes: it mirrors hashline's own `extractPathsFromEditInput`
 * (`hashline/path-utils.ts`) closely enough to parse the same header lines,
 * but is deliberately NOT imported from there — see the "No cross-extension
 * coupling with hashline" rationale already in this file's header comment
 * and this extension's README (duplicating this small, public/observable
 * header-format parsing is fine; importing hashline's private internals
 * would be brittle coupling to a sibling extension that isn't exported from
 * its package entry point).
 */
function extractEditPaths(event: ToolResultEvent, cwd: string): string[] {
  const rawInput = event.input as unknown;
  const editInput =
    typeof rawInput === "string"
      ? rawInput
      : typeof (rawInput as Record<string, unknown> | undefined)?.input === "string"
        ? ((rawInput as Record<string, unknown>).input as string)
        : "";

  const resolvedPaths = new Set<string>();
  for (const line of editInput.split(/\r?\n/)) {
    if (!line.startsWith("¶")) continue;

    const hashIndex = line.lastIndexOf("#");
    const rawPath = hashIndex >= 1 ? line.slice(1, hashIndex) : line.slice(1);
    const absolutePath = resolveAbsolutePath(stripSelector(rawPath), cwd);
    if (absolutePath) resolvedPaths.add(absolutePath);
  }

  return [...resolvedPaths];
}

/**
 * Unifies `read`/`write` (always exactly one touched path, or zero if
 * unresolvable) and `edit` (one or more touched paths, from one or more
 * `¶path#tag` header lines in a single edit call) behind the same
 * `string[]` return shape, so the caller can run one matching loop instead
 * of two diverging code paths.
 */
function resolveToolPaths(event: ToolResultEvent, cwd: string): string[] {
  if (event.toolName === "edit") return extractEditPaths(event, cwd);

  const rawPath = extractToolPath(event);
  if (!rawPath) return [];

  const absolutePath = resolveAbsolutePath(stripSelector(rawPath), cwd);
  return absolutePath ? [absolutePath] : [];
}

/**
 * A rule's `paths` glob patterns are authored relative to the project root
 * (see `agent/rules/README.md`'s `src/api/**\/*.ts`-style examples), but tool
 * calls report an absolute filesystem path. `matchesAnyPattern` (via
 * `picomatch`) anchors patterns by default, so matching would silently fail
 * for any non-`**`-prefixed pattern if given the absolute path directly —
 * converting to a `cwd`-relative path here is what makes the documented
 * pattern style actually work. Uses forward slashes regardless of platform
 * `path.sep`, since glob patterns (and picomatch) are always authored/parsed
 * with `/` as the separator.
 */
function toProjectRelativePath(absolutePath: string, cwd: string): string {
  return path.relative(cwd, absolutePath).split(path.sep).join("/");
}

// Rules are read from disk at most once per project directory (cwd), not on
// every tool_result — a project's rule files don't change mid-session, and
// re-reading/re-parsing on every read/write/edit would be wasted I/O.
const rulesByCwd = new Map<string, ParsedRule[]>();

function getRulesForCwd(cwd: string): ParsedRule[] {
  const cached = rulesByCwd.get(cwd);
  if (cached) return cached;

  const globalDir = path.join(piCodingAgent.getAgentDir(), "rules");
  const projectDir = path.join(cwd, CONFIG_DIR_NAME, "rules");
  const rules = loadRules({ globalDir, projectDir });
  rulesByCwd.set(cwd, rules);
  return rules;
}

// Per-session dedup: `${ruleId}::${absoluteFilePath}` composite keys, so a
// rule reminds the model again the first time it touches a *different*
// matching file, instead of going silent for the rest of the session after
// its first match — see this extension's README for the full rationale.
const injectedBySession = new Map<string, Set<string>>();

function getInjectedSet(sessionId: string): Set<string> {
  let injected = injectedBySession.get(sessionId);
  if (!injected) {
    injected = new Set();
    injectedBySession.set(sessionId, injected);
  }
  return injected;
}

export async function handleRulesToolResult(
  event: ToolResultEvent,
  ctx: any,
): Promise<ToolResultEventResult | undefined> {
  if (event.isError === true) return undefined;
  if (!TRACKED_TOOL_NAMES.has(event.toolName)) return undefined;

  const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
  const absolutePaths = resolveToolPaths(event, cwd);
  if (absolutePaths.length === 0) return undefined;

  const rules = getRulesForCwd(cwd);
  if (rules.length === 0) return undefined;

  const sessionId = resolveSessionId(ctx);
  const injected = getInjectedSet(sessionId);

  // `edit` can touch multiple files/hunks in one call (one `¶path#tag` line
  // per touched file); `read`/`write` always resolve to exactly one path.
  // Both flow through this same per-path matching loop so a rule can inject
  // once per newly-matched file, not just for a single path.
  const newBlocks: string[] = [];
  for (const absolutePath of absolutePaths) {
    const relativePath = toProjectRelativePath(absolutePath, cwd);
    for (const rule of rules) {
      if (!matchesAnyPattern(rule.paths, relativePath)) continue;

      const dedupKey = `${rule.id}::${absolutePath}`;
      if (injected.has(dedupKey)) continue;

      injected.add(dedupKey);
      newBlocks.push(formatRuleInjection(rule, absolutePath));
    }
  }

  if (newBlocks.length === 0) return undefined;

  // Additive only: never replace or reorder event.content's existing items.
  // Handler order across extensions is not guaranteed deterministic (loader
  // discovery is unsorted fs.readdirSync order), so another tool_result
  // handler (e.g. hashline's) may have already mutated event.content before
  // this one runs — whatever is already there is preserved as-is, and this
  // extension's blocks are appended after it.
  const existingContent = Array.isArray(event.content) ? event.content : [];
  const appended = newBlocks.map((text) => ({ type: "text" as const, text }));

  return {
    content: [...existingContent, ...appended],
  };
}

export default function rulesLoader(pi: ExtensionAPI): void {
  pi.on("tool_result", handleRulesToolResult);

  // Mirrors hashline's session_shutdown cleanup (hashline/index.ts) for its
  // analogous per-session store: without this, injectedBySession entries for
  // ended sessions would accumulate for the lifetime of the process.
  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    injectedBySession.delete(sessionId);
  });
}
