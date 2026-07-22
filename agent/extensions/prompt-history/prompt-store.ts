/**
 * Cross-session, cross-workspace prompt-history store (pi-improvement-plan
 * item #24).
 *
 * Pure logic module — no pi extension wiring lives here (see index.ts for
 * that). Responsibilities:
 *
 *   - Parse a single session JSONL file into the user prompts it contains
 *     (extractUserPromptText / parseSessionFile).
 *   - Format prompts for display (toPreviewLabel / formatRelativeTime /
 *     workspaceLabelFromDirName).
 *   - Dedupe near-identical prompts, keeping the newest (dedupeMostRecent).
 *   - Maintain an on-disk cache keyed by session file path so a full re-scan
 *     of every workspace's session files isn't needed on every picker
 *     invocation (loadCache / saveCache / isFileUnchanged / computeContentHash
 *     / refreshPromptHistory).
 *   - Resolve the global sessions root and cache file path under
 *     os.homedir() (resolveSessionsRoot / resolveCacheFilePath), calling
 *     os.homedir() at call-time rather than caching it at module scope, so
 *     tests can mock it per-run (matches the convention in
 *     extensions/coordination/session-dir.ts).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const RECENT_WINDOW_MS = 5000;

/** Cap on the number of entries returned to callers for display purposes. */
const MAX_DISPLAY_ENTRIES = 5000;

export interface CacheFileEntry {
	mtimeMs: number;
	size: number;
	contentHash: string;
	prompts: { text: string; timestampMs: number }[];
}

export interface PromptHistoryCache {
	version: 1;
	files: Record<string, CacheFileEntry>;
}

export interface PromptHistoryEntry {
	text: string;
	timestampMs: number;
	workspace: string;
	sessionFile: string;
}

interface TextBlock {
	type: "text";
	text: string;
}

function isTextBlock(block: unknown): block is TextBlock {
	return (
		!!block &&
		typeof block === "object" &&
		(block as Record<string, unknown>).type === "text" &&
		typeof (block as Record<string, unknown>).text === "string"
	);
}

/**
 * Extracts the user-authored prompt text from a parsed session JSONL record,
 * or null if the record isn't a `{type:"message", message:{role:"user"}}`
 * entry, or has no text content (e.g. an image-only message).
 */
export function extractUserPromptText(record: unknown): string | null {
	if (!record || typeof record !== "object") return null;
	const top = record as Record<string, unknown>;
	if (top.type !== "message") return null;

	const message = top.message;
	if (!message || typeof message !== "object") return null;
	const msg = message as Record<string, unknown>;
	if (msg.role !== "user") return null;

	const content = msg.content;
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	if (Array.isArray(content)) {
		const textParts = content.filter(isTextBlock).map((block) => block.text);
		if (textParts.length === 0) return null;
		return textParts.join("\n\n");
	}

	return null;
}

/**
 * Derives a record's timestamp in ms: prefer the top-level ISO `timestamp`
 * field, falling back to a numeric `message.timestamp` when the top-level
 * one is missing or fails to parse.
 */
function deriveTimestampMs(record: unknown): number | null {
	if (!record || typeof record !== "object") return null;
	const top = record as Record<string, unknown>;

	if (typeof top.timestamp === "string") {
		const parsed = Date.parse(top.timestamp);
		if (!Number.isNaN(parsed)) return parsed;
	}

	const message = top.message;
	if (message && typeof message === "object") {
		const msgTimestamp = (message as Record<string, unknown>).timestamp;
		if (typeof msgTimestamp === "number" && Number.isFinite(msgTimestamp)) return msgTimestamp;
	}

	return null;
}

/**
 * Reads and JSONL-parses a session file, extracting `{text, timestampMs}`
 * for every user-prompt record. Malformed lines (bad JSON, no derivable
 * text/timestamp) are skipped individually without throwing or dropping
 * later valid lines.
 */
export function parseSessionFile(filePath: string): { text: string; timestampMs: number }[] {
	const raw = fs.readFileSync(filePath, "utf-8");
	return parseSessionContent(raw);
}

/**
 * Same as parseSessionFile, but operates on already-read file content. Lets
 * refreshPromptHistory reuse the content it already read for hashing instead
 * of having parseSessionFile read the same file a second time.
 */
export function parseSessionContent(raw: string): { text: string; timestampMs: number }[] {
	const lines = raw.split("\n");
	const results: { text: string; timestampMs: number }[] = [];

	for (const line of lines) {
		const trimmedLine = line.trim();
		if (!trimmedLine) continue;

		let record: unknown;
		try {
			record = JSON.parse(trimmedLine);
		} catch {
			continue;
		}

		const text = extractUserPromptText(record);
		if (text === null) continue;

		const timestampMs = deriveTimestampMs(record);
		if (timestampMs === null) continue;

		results.push({ text, timestampMs });
	}

	return results;
}

/**
 * Collapses all whitespace runs (including newlines) to a single space and
 * truncates to `maxLen`, appending an ellipsis when truncated.
 */
export function toPreviewLabel(text: string, maxLen: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxLen) return collapsed;
	return `${collapsed.slice(0, maxLen)}…`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Formats `timestampMs` relative to `now` as a coarse "Xm/Xh/Xd ago" bucket. */
export function formatRelativeTime(timestampMs: number, now: number): string {
	const diffMs = now - timestampMs;

	if (diffMs < MINUTE_MS) return "just now";
	if (diffMs < HOUR_MS) return `${Math.floor(diffMs / MINUTE_MS)}m ago`;
	if (diffMs < DAY_MS) return `${Math.floor(diffMs / HOUR_MS)}h ago`;
	return `${Math.floor(diffMs / DAY_MS)}d ago`;
}

/** Strips exactly one leading and one trailing "--" from a workspace dir name. */
export function workspaceLabelFromDirName(dirName: string): string {
	let result = dirName;
	if (result.startsWith("--")) result = result.slice(2);
	if (result.endsWith("--")) result = result.slice(0, -2);
	return result;
}

/**
 * Dedupes entries whose text is identical after a trim()-only comparison
 * (deliberately not the aggressive whitespace-collapsing toPreviewLabel
 * uses), keeping the entry with the greatest timestampMs per key while
 * preserving the array position of that key's first occurrence.
 */
export function dedupeMostRecent<T extends { text: string; timestampMs: number }>(entries: T[]): T[] {
	const indexByKey = new Map<string, number>();
	const kept: T[] = [];

	for (const entry of entries) {
		const key = entry.text.trim();
		const existingIndex = indexByKey.get(key);

		if (existingIndex === undefined) {
			indexByKey.set(key, kept.length);
			kept.push(entry);
		} else if (entry.timestampMs > kept[existingIndex].timestampMs) {
			kept[existingIndex] = entry;
		}
	}

	return kept;
}

/** Returns a fresh empty cache on any read/parse/version-mismatch failure. */
export function loadCache(cachePath: string): PromptHistoryCache {
	try {
		const raw = fs.readFileSync(cachePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === "object") {
			return parsed as PromptHistoryCache;
		}
	} catch {
		// fall through to the empty-cache default below
	}
	return { version: 1, files: {} };
}

/**
 * Writes the cache atomically: temp file (mode 0o600) in the same directory,
 * then rename over `cachePath`, then a defensive chmod on the final path.
 */
export function saveCache(cachePath: string, cache: PromptHistoryCache): void {
	const dir = path.dirname(cachePath);
	fs.mkdirSync(dir, { recursive: true });

	const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tempPath, JSON.stringify(cache), { mode: 0o600 });
	fs.renameSync(tempPath, cachePath);
	fs.chmodSync(cachePath, 0o600);
}

/**
 * Decides whether a session file's cached prompts can be reused as-is:
 *   - mtime/size mismatch -> definitely changed, false, no hashing.
 *   - mtime/size match AND the file is older than RECENT_WINDOW_MS -> assume
 *     unchanged, true, no hashing (cheap fast path for the common case of
 *     scanning old, untouched session files).
 *   - mtime/size match but the file was modified recently (within the
 *     window) -> hash the content to be sure, since mtime granularity can't
 *     be trusted to catch a same-tick rewrite.
 */
export function isFileUnchanged(
	stat: { mtimeMs: number; size: number },
	cached: { mtimeMs: number; size: number; contentHash: string },
	computeHash: () => string,
	now: number,
): boolean {
	if (stat.mtimeMs !== cached.mtimeMs || stat.size !== cached.size) return false;
	if (now - stat.mtimeMs > RECENT_WINDOW_MS) return true;
	return computeHash() === cached.contentHash;
}

/** Full SHA1 hex digest of `data`. */
export function computeContentHash(data: Buffer | string): string {
	return createHash("sha1").update(data).digest("hex");
}

/**
 * Walks every workspace subdirectory of `sessionsRoot`, parses (or reuses
 * cached) `*.jsonl` session files, and returns a flattened, deduped,
 * newest-first list of prompt entries.
 *
 * The returned `entries` list is capped to the newest `MAX_DISPLAY_ENTRIES`
 * for presentation purposes only — the returned `cache.files[*].prompts`
 * manifest always retains every parsed file's full prompt list, uncapped, so
 * the cap never destroys data future refreshes could otherwise reuse.
 */
export function refreshPromptHistory(
	sessionsRoot: string,
	cache: PromptHistoryCache,
	now: number = Date.now(),
): { entries: PromptHistoryEntry[]; cache: PromptHistoryCache } {
	const nextFiles: Record<string, CacheFileEntry> = {};

	let workspaceDirs: fs.Dirent[] = [];
	try {
		workspaceDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
	} catch {
		workspaceDirs = [];
	}

	const filesByWorkspace: { filePath: string; workspace: string }[] = [];

	for (const dirent of workspaceDirs) {
		const workspaceDirPath = path.join(sessionsRoot, dirent.name);
		const workspaceLabel = workspaceLabelFromDirName(dirent.name);

		let sessionFileNames: string[] = [];
		try {
			sessionFileNames = fs.readdirSync(workspaceDirPath).filter((name) => name.endsWith(".jsonl"));
		} catch {
			sessionFileNames = [];
		}

		for (const fileName of sessionFileNames) {
			filesByWorkspace.push({ filePath: path.join(workspaceDirPath, fileName), workspace: workspaceLabel });
		}
	}

	const allEntries: PromptHistoryEntry[] = [];

	for (const { filePath, workspace } of filesByWorkspace) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(filePath);
		} catch {
			continue;
		}

		const cached = cache.files[filePath];
		let prompts: { text: string; timestampMs: number }[];
		let contentHash: string;

		// A file can become unreadable between statSync above and any
		// readFileSync below (deleted, permission change, concurrent
		// truncation, EIO, ...). Track that via this flag rather than letting
		// the exception propagate, so one bad file can't abort the scan of
		// every other workspace/file.
		let unreadable = false;
		const computeHash = () => {
			try {
				return computeContentHash(fs.readFileSync(filePath));
			} catch {
				unreadable = true;
				return "";
			}
		};

		if (cached && isFileUnchanged(stat, cached, computeHash, now)) {
			if (unreadable) continue;
			prompts = cached.prompts;
			contentHash = cached.contentHash;
		} else {
			let raw: string;
			try {
				raw = fs.readFileSync(filePath, "utf-8");
			} catch {
				continue;
			}
			contentHash = computeContentHash(raw);
			prompts = parseSessionContent(raw);
		}

		nextFiles[filePath] = { mtimeMs: stat.mtimeMs, size: stat.size, contentHash, prompts };

		for (const prompt of prompts) {
			allEntries.push({ text: prompt.text, timestampMs: prompt.timestampMs, workspace, sessionFile: filePath });
		}
	}

	allEntries.sort((a, b) => b.timestampMs - a.timestampMs);
	const deduped = dedupeMostRecent(allEntries);
	const entries = deduped.slice(0, MAX_DISPLAY_ENTRIES);

	return { entries, cache: { version: 1, files: nextFiles } };
}

/**
 * Resolves the global sessions root (`~/.pi/agent/sessions`). `os.homedir()`
 * is called at use-time (never cached at module scope) so tests can mock it
 * per-run via `vi.doMock("node:os", ...)` + `vi.resetModules()` — matches the
 * convention in extensions/coordination/session-dir.ts.
 */
export function resolveSessionsRoot(): string {
	return path.join(os.homedir(), ".pi", "agent", "sessions");
}

/** Resolves the prompt-history cache file path (`~/.pi/agent/state/prompt-history/cache.json`). */
export function resolveCacheFilePath(): string {
	return path.join(os.homedir(), ".pi", "agent", "state", "prompt-history", "cache.json");
}
