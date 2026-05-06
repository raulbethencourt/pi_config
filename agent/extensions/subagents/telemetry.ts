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

const SCHEMA = `
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
  cwd TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_timestamp ON runs(timestamp);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
`;

export function initTelemetryDb(): void {
	if (initAttempted) return;
	initAttempted = true;
	try {
		const { DatabaseSync } = require("node:sqlite");
		fs.mkdirSync(DB_DIR, { recursive: true });
		db = new DatabaseSync(DB_PATH);
		db.exec("PRAGMA journal_mode=WAL;");
		db.exec(SCHEMA);
	} catch (err: any) {
		// Graceful degradation — telemetry is optional
		db = null;
	}
}

export function logRun(
	result: {
		agent: string;
		task: string;
		exitCode: number;
		model?: string;
		usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
		progress: { durationMs: number };
	},
	cwd: string,
	sessionId: string,
): void {
	if (!db) return;
	try {
		const stmt = db.prepare(`
			INSERT INTO runs (timestamp, session_id, agent, model, task_summary, input_tokens, output_tokens, cache_read, cache_write, cost_usd, turns, duration_ms, exit_code, cwd)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		stmt.run(
			new Date().toISOString(),
			sessionId,
			result.agent,
			result.model ?? null,
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
		);
	} catch {
		// Never crash the orchestrator for telemetry
	}
}

export function getDb(): any {
	if (!db) initTelemetryDb();
	return db;
}
