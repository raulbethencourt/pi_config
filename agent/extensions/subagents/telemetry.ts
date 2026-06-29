/**
 * Telemetry module — logs every subagent run to a local SQLite database.
 * Gracefully degrades if SQLite is unavailable or the DB is unwritable.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DB_DIR = path.join(os.homedir(), ".pi", "data");
const DB_PATH = path.join(DB_DIR, "analytics.db");
const LEGACY_OPENCODE_MODEL_MARKERS = ["deepseek", "nemotron"];

let db: any = null;
let initAttempted = false;

function reportTelemetryError(context: string, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[telemetry] ${context}: ${message}`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  depth INTEGER DEFAULT 0,
  main_agent INTEGER DEFAULT 0,
  task_summary TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read INTEGER DEFAULT 0,
  cache_write INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  turns INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  exit_code INTEGER,
  cwd TEXT,
  used_fallback INTEGER DEFAULT 0,
  fallback_model TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_timestamp ON runs(timestamp);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  tool TEXT NOT NULL,
  count INTEGER DEFAULT 1,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool);
`;

function normalizeProviderValue(provider?: string | null): string | null {
	const value = typeof provider === "string" ? provider.trim() : "";
	return value ? value : null;
}

function classifyFlatProvider(modelId?: string | null): string | null {
	if (!modelId) return null;
	const normalized = modelId.trim().toLowerCase();
	if (!normalized) return null;
	if (normalized.includes("deepseek") || normalized.includes("nemotron")) return "opencode";
	return "github";
}

function deriveProvider(model?: string | null): string | null {
	if (!model) return null;
	const slash = model.indexOf("/");
	if (slash <= 0) return null;
	const provider = model.slice(0, slash).trim();
	return provider ? provider : null;
}

function resolveProvider(model?: string | null, explicitProvider?: string | null): string | null {
	const explicit = normalizeProviderValue(explicitProvider);
	if (explicit) {
		return explicit.includes("/") ? explicit.split("/")[0] : classifyFlatProvider(explicit) ?? explicit;
	}
	return deriveProvider(model) ?? null;
}

function migrateRunsTableSchema(database: any): void {
	const cols = database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
	const names = new Set(cols.map((col) => col.name));

	if (!names.has("used_fallback")) {
		database.exec("ALTER TABLE runs ADD COLUMN used_fallback INTEGER DEFAULT 0");
	}

	if (!names.has("fallback_model")) {
		database.exec("ALTER TABLE runs ADD COLUMN fallback_model TEXT");
	}

	if (!names.has("provider")) {
		database.exec("ALTER TABLE runs ADD COLUMN provider TEXT");
	}

	if (!names.has("depth")) {
		database.exec("ALTER TABLE runs ADD COLUMN depth INTEGER DEFAULT 0");
	}

	if (!names.has("main_agent")) {
		database.exec("ALTER TABLE runs ADD COLUMN main_agent INTEGER DEFAULT 0");
	}
}

function backfillLegacyMainRunProviders(database: any): void {
	const cols = database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
	if (!cols.some((col) => col.name === "provider")) return;
	const missingProviderPredicate = "(provider IS NULL OR TRIM(provider) = '' OR LOWER(TRIM(provider)) = 'unknown')";
	const flatModelPredicate = "model IS NOT NULL AND instr(model, '/') = 0 AND TRIM(model) <> ''";
	const githubStmt = database.prepare(`
		UPDATE runs
		SET provider = 'github'
		WHERE ${missingProviderPredicate}
		  AND ${flatModelPredicate}
		  AND LOWER(TRIM(model)) NOT LIKE '%deepseek%'
		  AND LOWER(TRIM(model)) NOT LIKE '%nemotron%'
	`);
	githubStmt.run();

	const opencodeStmt = database.prepare(`
		UPDATE runs
		SET provider = 'opencode'
		WHERE ${missingProviderPredicate}
		  AND ${flatModelPredicate}
		  AND (
			LOWER(TRIM(model)) LIKE '%deepseek%'
			OR LOWER(TRIM(model)) LIKE '%nemotron%'
		  )
	`);
	opencodeStmt.run();
}

export function initTelemetryDb(): void {
	if (initAttempted) return;
	initAttempted = true;
	try {
		const { DatabaseSync } = require("node:sqlite");
		fs.mkdirSync(DB_DIR, { recursive: true });
		db = new DatabaseSync(DB_PATH);
		db.exec("PRAGMA journal_mode=WAL;");
		db.exec(SCHEMA);
		migrateRunsTableSchema(db);
		backfillLegacyMainRunProviders(db);
	} catch (err: any) {
		// Graceful degradation — telemetry is optional
		reportTelemetryError("failed to initialize telemetry database", err);
		db = null;
	}
}

export function logRun(
	result: {
		agent: string;
		task: string;
		exitCode: number;
		model?: string;
		provider?: string | null;
		usedFallback?: boolean;
		usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
		progress: { durationMs: number };
	},
	cwd: string,
	sessionId: string,
	depth = 0,
	mainAgent = 0,
): number | null {
	if (!db) return null;
	try {
		const provider = resolveProvider(result.model ?? null, result.provider ?? null);
		const stmt = db.prepare(`
			INSERT INTO runs (timestamp, session_id, agent, model, provider, depth, main_agent, task_summary, input_tokens, output_tokens, cache_read, cache_write, cost_usd, turns, duration_ms, exit_code, cwd, used_fallback, fallback_model)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		stmt.run(
			new Date().toISOString(),
			sessionId,
			result.agent,
			result.model ?? null,
			provider,
			depth,
			mainAgent ? 1 : 0,
			result.task.slice(0, 200),
			result.usage.input,
			result.usage.output,
			result.usage.cacheRead,
			result.usage.cacheWrite,
			result.usage.cost,
			result.usage.turns,
			result.progress.durationMs,
			result.exitCode,
			cwd,
			result.usedFallback ? 1 : 0,
			result.usedFallback ? result.model ?? null : null,
		);
		const row = db.prepare("SELECT last_insert_rowid() as id").get();
		return row?.id ?? null;
	} catch (err) {
		reportTelemetryError("failed to write run telemetry", err);
		return null;
	}
}

export function getDb(): any {
	if (!db) initTelemetryDb();
	return db;
}

export function logToolCalls(
	runId: number,
	toolCalls: Array<{ tool: string; count: number }>,
): void {
	if (!db) return;
	try {
		const stmt = db.prepare(`INSERT INTO tool_calls (run_id, tool, count) VALUES (?, ?, ?)`);
		for (const tc of toolCalls) {
			stmt.run(runId, tc.tool, tc.count);
		}
	} catch (err) {
		reportTelemetryError("failed to write tool-call telemetry", err);
	}
}
