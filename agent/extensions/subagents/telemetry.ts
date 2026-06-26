/**
 * Telemetry module — logs every subagent run to a local SQLite database.
 * Gracefully degrades if SQLite is unavailable or the DB is unwritable.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DB_DIR = path.join(os.homedir(), ".pi", "data");
const DB_PATH = path.join(DB_DIR, "analytics.db");

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
CREATE INDEX IF NOT EXISTS idx_runs_provider ON runs(provider);
CREATE INDEX IF NOT EXISTS idx_runs_depth ON runs(depth);
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

function deriveProvider(model?: string | null): string | null {
	if (!model) return null;
	const provider = model.split("/")[0]?.trim();
	return provider ? provider : null;
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

export function initTelemetryDb(): void {
	if (initAttempted) return;
	initAttempted = true;
	try {
		const { DatabaseSync } = require("node:sqlite");
		fs.mkdirSync(DB_DIR, { recursive: true });
		db = new DatabaseSync(DB_PATH);
		db.exec("PRAGMA journal_mode=WAL;");
		db.exec(`
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
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
  fallback_model TEXT,
  provider TEXT,
  depth INTEGER DEFAULT 0,
  main_agent INTEGER DEFAULT 0
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
`);
		migrateRunsTableSchema(db);
		db.exec("CREATE INDEX IF NOT EXISTS idx_runs_provider ON runs(provider);");
		db.exec("CREATE INDEX IF NOT EXISTS idx_runs_depth ON runs(depth);");
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
		const provider = deriveProvider(result.model ?? null);
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
		// Never crash the orchestrator for telemetry
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
		// Never crash for telemetry
	}
}
