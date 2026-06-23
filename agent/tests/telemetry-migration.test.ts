/**
 * RED-phase test: schema migration for the telemetry runs table.
 *
 * Bug: analytics.db files created before the used_fallback / fallback_model
 * columns were added (14-column schema) cause silent INSERT failures because
 * logRun() always writes all 16 columns.
 *
 * The fix must add an idempotent migration inside initTelemetryDb() that
 * runs ALTER TABLE … ADD COLUMN IF NOT EXISTS (or equivalent SQLite idiom)
 * for both missing columns without destroying existing rows.
 *
 * These tests MUST fail until that migration is implemented.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 14-column schema — what older analytics.db files contain */
const OLD_SCHEMA = `
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
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  tool TEXT NOT NULL,
  count INTEGER DEFAULT 1,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);
`;

let tempHome = "";

/** Create an analytics.db using the old 14-column schema and optionally seed rows. */
function createOldDb(rows: Array<{ agent: string; session_id: string }> = []) {
	const dbDir = path.join(tempHome, ".pi", "data");
	fs.mkdirSync(dbDir, { recursive: true });
	const dbPath = path.join(dbDir, "analytics.db");

	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode=WAL;");
	db.exec(OLD_SCHEMA);

	for (const row of rows) {
		db.prepare(`
			INSERT INTO runs (timestamp, session_id, agent, model, task_summary,
				input_tokens, output_tokens, cache_read, cache_write,
				cost_usd, turns, duration_ms, exit_code, cwd)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			new Date().toISOString(),
			row.session_id,
			row.agent,
			"test-model",
			"legacy task",
			10, 20, 1, 2, 0.001, 3, 500, 0, "/tmp/legacy",
		);
	}

	db.close();
	return dbPath;
}

async function loadTelemetry() {
	vi.resetModules();
	vi.doMock("node:os", async () => {
		const actual = await vi.importActual<typeof import("node:os")>("node:os");
		return { ...actual, homedir: () => tempHome };
	});
	return import("../extensions/subagents/telemetry.ts");
}

function makeRun(overrides: Partial<any> = {}) {
	return {
		agent: "tester",
		task: "migration test run",
		exitCode: 0,
		model: "gpt-migration",
		usedFallback: false,
		usage: { input: 5, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.005, turns: 1 },
		progress: { durationMs: 100 },
		...overrides,
	};
}

describe("telemetry schema migration (14-column → 16-column)", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-migration-test-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("node:os");
		if (tempHome && fs.existsSync(tempHome)) {
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("adds used_fallback column when opening an old 14-column DB", async () => {
		createOldDb();
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();

		const db = telemetry.getDb();
		const cols: Array<{ name: string }> = db
			.prepare("PRAGMA table_info(runs)")
			.all() as Array<{ name: string }>;
		const names = cols.map((c) => c.name);

		expect(names).toContain("used_fallback");
	});

	it("adds fallback_model column when opening an old 14-column DB", async () => {
		createOldDb();
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();

		const db = telemetry.getDb();
		const cols: Array<{ name: string }> = db
			.prepare("PRAGMA table_info(runs)")
			.all() as Array<{ name: string }>;
		const names = cols.map((c) => c.name);

		expect(names).toContain("fallback_model");
	});

	it("preserves existing rows after migration", async () => {
		createOldDb([
			{ agent: "planner", session_id: "legacy-session-1" },
			{ agent: "worker", session_id: "legacy-session-2" },
		]);

		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();

		const db = telemetry.getDb();
		const rows = db
			.prepare("SELECT session_id, agent FROM runs ORDER BY id")
			.all() as Array<{ session_id: string; agent: string }>;

		expect(rows).toHaveLength(2);
		expect(rows[0].session_id).toBe("legacy-session-1");
		expect(rows[0].agent).toBe("planner");
		expect(rows[1].session_id).toBe("legacy-session-2");
		expect(rows[1].agent).toBe("worker");
	});

	it("logRun succeeds on a migrated DB (no silent failure)", async () => {
		createOldDb();
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();

		// Before the fix this INSERT throws because used_fallback / fallback_model
		// columns don't exist, and the error is swallowed → returns null.
		const runId = telemetry.logRun(makeRun(), "/tmp/project", "session-post-migration");

		expect(runId).not.toBeNull();
		expect(typeof runId).toBe("number");
	});

	it("logRun with usedFallback=true writes correct values after migration", async () => {
		createOldDb();
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();

		telemetry.logRun(
			makeRun({ usedFallback: true, model: "fallback-model-x" }),
			"/tmp/project",
			"session-fallback",
		);

		const db = telemetry.getDb();
		const row = db
			.prepare("SELECT used_fallback, fallback_model FROM runs WHERE session_id = ?")
			.get("session-fallback") as { used_fallback: number; fallback_model: string | null };

		expect(row).not.toBeNull();
		expect(row.used_fallback).toBe(1);
		expect(row.fallback_model).toBe("fallback-model-x");
	});

	it("migration is idempotent — calling initTelemetryDb twice does not throw", async () => {
		createOldDb();
		const telemetry = await loadTelemetry();

		expect(() => {
			telemetry.initTelemetryDb();
			telemetry.initTelemetryDb(); // second call must not error
		}).not.toThrow();
	});

	it("new DB (no pre-existing file) still has both columns", async () => {
		// Sanity: fresh DB path — regression guard so migration doesn't break new installs.
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();

		const db = telemetry.getDb();
		const cols: Array<{ name: string }> = db
			.prepare("PRAGMA table_info(runs)")
			.all() as Array<{ name: string }>;
		const names = cols.map((c) => c.name);

		expect(names).toContain("used_fallback");
		expect(names).toContain("fallback_model");
	});
});
