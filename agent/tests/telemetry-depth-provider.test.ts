/**
 * Regression tests for telemetry depth/main_agent/provider storage and
 * deriveProvider extraction logic.
 *
 * Coverage gaps closed:
 *   1. logRun stores depth and main_agent with correct values
 *   2. logRun derives and stores provider from slash-prefixed model strings
 *   3. logRun stores null provider when model has no slash prefix
 *   4. logRun stores null provider when model is null/undefined
 *   5. Calling logRun with mainAgent=1 stores main_agent=1 in the DB
 *   6. Calling logRun with depth>0 stores the correct depth
 *   7. Migration of a DB that lacks provider/depth/main_agent adds all three columns
 *   8. __main__ agent row renders as "orchestrator" in By Agent section of /token_stats
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

let tempHome = "";

// ── Helpers ────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<any> = {}) {
	return {
		agent: "worker",
		task: "depth-provider test run",
		exitCode: 0,
		model: "anthropic/claude-3-5-sonnet",
		usedFallback: false,
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.02, turns: 2 },
		progress: { durationMs: 800 },
		...overrides,
	};
}

async function loadTelemetry() {
	vi.resetModules();
	vi.doMock("node:os", async () => {
		const actual = await vi.importActual<typeof import("node:os")>("node:os");
		return { ...actual, homedir: () => tempHome };
	});
	return import("../extensions/subagents/telemetry.ts");
}

async function loadTokenStatsHandler() {
	vi.resetModules();
	vi.doMock("node:os", async () => {
		const actual = await vi.importActual<typeof import("node:os")>("node:os");
		return { ...actual, homedir: () => tempHome };
	});
	let handler: ((args: string, ctx: any) => Promise<void>) | null = null;
	const extension = await import("../extensions/token-stats-cmd/index.ts");
	extension.default({
		registerCommand(name: string, config: any) {
			if (name === "token_stats") handler = config.handler;
		},
	} as any);
	if (!handler) throw new Error("token_stats handler not registered");
	return handler;
}

function createMockCtx(renderedFrames: string[][]) {
	const theme = {
		bold: (s: string) => s,
		fg: (_color: string, s: string) => s,
	};
	const rows = process.stdout.rows;
	Object.defineProperty(process.stdout, "rows", { value: 200, configurable: true });
	return {
		ui: {
			theme,
			custom: async (fn: any) => {
				const component = fn({ requestRender: () => {} }, theme, null, () => {});
				renderedFrames.push(component.render(200));
			},
		},
		__restoreRows: () =>
			Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true }),
	};
}

function getRenderedText(renderedFrames: string[][]): string {
	return renderedFrames.flat().join("\n");
}

/**
 * Create a DB with only the pre-provider/depth/main_agent 16-column schema
 * (used_fallback + fallback_model present but not provider/depth/main_agent).
 */
function createPreProviderDb() {
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
`;
	const dbDir = path.join(tempHome, ".pi", "data");
	fs.mkdirSync(dbDir, { recursive: true });
	const dbPath = path.join(dbDir, "analytics.db");
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode=WAL;");
	db.exec(OLD_SCHEMA);
	db.prepare(`
		INSERT INTO runs (timestamp, session_id, agent, model, task_summary,
			input_tokens, output_tokens, cache_read, cache_write,
			cost_usd, turns, duration_ms, exit_code, cwd, used_fallback, fallback_model)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		new Date().toISOString(),
		"pre-provider-session",
		"planner",
		"openai/gpt-4",
		"old task",
		10, 20, 0, 0, 0.001, 1, 300, 0, "/tmp/old", 0, null,
	);
	db.close();
	return dbPath;
}

function seedAnalyticsDb(rows: Array<Record<string, any>>) {
	const FULL_SCHEMA = `
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
`;
	const dbDir = path.join(tempHome, ".pi", "data");
	const dbPath = path.join(dbDir, "analytics.db");
	fs.mkdirSync(dbDir, { recursive: true });
	const db = new DatabaseSync(dbPath);
	db.exec(FULL_SCHEMA);
	const stmt = db.prepare(`
		INSERT INTO runs (
			timestamp, session_id, agent, model, provider, depth, main_agent, task_summary,
			input_tokens, output_tokens, cache_read, cache_write,
			cost_usd, turns, duration_ms, exit_code, cwd
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	for (const row of rows) {
		stmt.run(
			row.timestamp ?? new Date().toISOString(),
			row.session_id ?? crypto.randomUUID(),
			row.agent ?? "worker",
			row.model ?? null,
			row.provider ?? null,
			row.depth ?? 0,
			row.main_agent ?? 0,
			row.task_summary ?? "task",
			row.input_tokens ?? 0,
			row.output_tokens ?? 0,
			row.cache_read ?? 0,
			row.cache_write ?? 0,
			row.cost_usd ?? 0,
			row.turns ?? 1,
			row.duration_ms ?? 0,
			row.exit_code ?? 0,
			row.cwd ?? "",
		);
	}
	db.close();
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("telemetry depth/main_agent/provider storage", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-depth-provider-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("node:os");
		if (tempHome && fs.existsSync(tempHome)) {
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});

	// ── depth ───────────────────────────────────────────────────────

	it("stores depth=0 when no depth argument is passed", async () => {
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();
		telemetry.logRun(makeRun(), "/tmp/project", "session-depth-default");

		const db = telemetry.getDb();
		const row = db
			.prepare("SELECT depth FROM runs WHERE session_id = ?")
			.get("session-depth-default") as { depth: number };
		expect(row).not.toBeNull();
		expect(row.depth).toBe(0);
	});

	it("stores correct depth when depth=1 is passed (subagent child)", async () => {
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();
		telemetry.logRun(makeRun(), "/tmp/project", "session-depth-1", 1, 0);

		const db = telemetry.getDb();
		const row = db
			.prepare("SELECT depth FROM runs WHERE session_id = ?")
			.get("session-depth-1") as { depth: number };
		expect(row).not.toBeNull();
		expect(row.depth).toBe(1);
	});

	it("stores correct depth when depth=3 is passed (deeply nested subagent)", async () => {
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();
		telemetry.logRun(makeRun(), "/tmp/project", "session-depth-3", 3, 0);

		const db = telemetry.getDb();
		const row = db
			.prepare("SELECT depth FROM runs WHERE session_id = ?")
			.get("session-depth-3") as { depth: number };
		expect(row).not.toBeNull();
		expect(row.depth).toBe(3);
	});

	// ── main_agent ──────────────────────────────────────────────────

	it("stores main_agent=0 when mainAgent argument is omitted", async () => {
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();
		telemetry.logRun(makeRun(), "/tmp/project", "session-mainagent-0");

		const db = telemetry.getDb();
		const row = db
			.prepare("SELECT main_agent FROM runs WHERE session_id = ?")
			.get("session-mainagent-0") as { main_agent: number };
		expect(row).not.toBeNull();
		expect(row.main_agent).toBe(0);
	});

	it("stores main_agent=1 when mainAgent=1 is passed (orchestrator __main__ run)", async () => {
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();
		telemetry.logRun(
			makeRun({ agent: "__main__" }),
			"/tmp/project",
			"session-mainagent-1",
			0,
			1,
		);

		const db = telemetry.getDb();
		const row = db
			.prepare("SELECT agent, main_agent, depth FROM runs WHERE session_id = ?")
			.get("session-mainagent-1") as { agent: string; main_agent: number; depth: number };
		expect(row).not.toBeNull();
		expect(row.agent).toBe("__main__");
		expect(row.main_agent).toBe(1);
		expect(row.depth).toBe(0);
	});

	// ── provider derivation ─────────────────────────────────────────

	it("derives and stores provider from slash-prefixed model (anthropic/...)", async () => {
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();
		telemetry.logRun(
			makeRun({ model: "anthropic/claude-3-5-sonnet" }),
			"/tmp/project",
			"session-provider-anthropic",
		);

		const db = telemetry.getDb();
		const row = db
			.prepare("SELECT provider FROM runs WHERE session_id = ?")
			.get("session-provider-anthropic") as { provider: string | null };
		expect(row).not.toBeNull();
		expect(row.provider).toBe("anthropic");
	});

	it("derives and stores provider from openai/ model string", async () => {
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();
		telemetry.logRun(
			makeRun({ model: "openai/gpt-4o" }),
			"/tmp/project",
			"session-provider-openai",
		);

		const db = telemetry.getDb();
		const row = db
			.prepare("SELECT provider FROM runs WHERE session_id = ?")
			.get("session-provider-openai") as { provider: string | null };
		expect(row).not.toBeNull();
		expect(row.provider).toBe("openai");
	});

	it("stores the model string itself as provider when model has no slash prefix", async () => {
		// deriveProvider splits on '/' and returns the first segment.
		// For "gpt-4" there is no slash, so split gives ["gpt-4"], provider = "gpt-4".
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();
		telemetry.logRun(
			makeRun({ model: "gpt-4" }),
			"/tmp/project",
			"session-provider-noslash",
		);

		const db = telemetry.getDb();
		const row = db
			.prepare("SELECT provider FROM runs WHERE session_id = ?")
			.get("session-provider-noslash") as { provider: string | null };
		expect(row).not.toBeNull();
		// No slash → provider equals the full model string
		expect(row.provider).toBe("gpt-4");
	});

	it("stores null provider when model is null", async () => {
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();
		telemetry.logRun(
			makeRun({ model: null as any }),
			"/tmp/project",
			"session-provider-null",
		);

		const db = telemetry.getDb();
		const row = db
			.prepare("SELECT provider FROM runs WHERE session_id = ?")
			.get("session-provider-null") as { provider: string | null };
		expect(row).not.toBeNull();
		expect(row.provider).toBeNull();
	});

	it("stores null provider when model is undefined", async () => {
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();
		telemetry.logRun(
			makeRun({ model: undefined }),
			"/tmp/project",
			"session-provider-undefined",
		);

		const db = telemetry.getDb();
		const row = db
			.prepare("SELECT provider FROM runs WHERE session_id = ?")
			.get("session-provider-undefined") as { provider: string | null };
		expect(row).not.toBeNull();
		expect(row.provider).toBeNull();
	});

	// ── migration: pre-provider schema ──────────────────────────────

	it("migration adds provider column to a pre-provider DB (16-col without provider/depth/main_agent)", async () => {
		createPreProviderDb();
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();

		const db = telemetry.getDb();
		const cols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
		const names = cols.map((c) => c.name);

		expect(names).toContain("provider");
		expect(names).toContain("depth");
		expect(names).toContain("main_agent");
	});

	it("migration preserves existing rows in pre-provider DB", async () => {
		createPreProviderDb();
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();

		const db = telemetry.getDb();
		const rows = db
			.prepare("SELECT session_id, agent FROM runs ORDER BY id")
			.all() as Array<{ session_id: string; agent: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].session_id).toBe("pre-provider-session");
		expect(rows[0].agent).toBe("planner");
	});

	it("logRun succeeds and stores provider after migration of pre-provider DB", async () => {
		createPreProviderDb();
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();

		const runId = telemetry.logRun(
			makeRun({ model: "anthropic/claude-3-haiku", agent: "scout" }),
			"/tmp/project",
			"session-post-migration-scout",
		);
		expect(runId).not.toBeNull();
		expect(typeof runId).toBe("number");

		const db = telemetry.getDb();
		const row = db
			.prepare("SELECT agent, provider FROM runs WHERE session_id = ?")
			.get("session-post-migration-scout") as { agent: string; provider: string | null };
		expect(row.agent).toBe("scout");
		expect(row.provider).toBe("anthropic");
	});
});

// ── token_stats rendering of __main__ agent ────────────────────────────

describe("token_stats By Agent label for __main__ orchestrator runs", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "token-stats-main-label-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("node:os");
		if (tempHome && fs.existsSync(tempHome)) {
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("renders __main__ agent as 'orchestrator' in By Agent section", async () => {
		seedAnalyticsDb([
			{
				timestamp: new Date().toISOString(),
				session_id: "main-label-s1",
				agent: "__main__",
				model: null,
				provider: null,
				depth: 0,
				main_agent: 1,
				task_summary: "orchestrate session",
				input_tokens: 500,
				output_tokens: 200,
				cost_usd: 0.15,
				duration_ms: 5000,
				exit_code: 0,
				cwd: "/home/user/project",
			},
		]);

		const handler = await loadTokenStatsHandler();
		const rendered: string[][] = [];
		await handler("all", createMockCtx(rendered));
		const out = getRenderedText(rendered);

		// By Agent table should show "orchestrator" not "__main__"
		expect(out).toContain("By Agent");
		expect(out).toContain("orchestrator");
		expect(out).not.toContain("__main__");
	});

	it("does not suppress __main__ agent from By Agent cost aggregation", async () => {
		seedAnalyticsDb([
			{
				timestamp: new Date().toISOString(),
				session_id: "main-label-s2",
				agent: "__main__",
				model: null,
				provider: null,
				depth: 0,
				main_agent: 1,
				cost_usd: 0.73,
				input_tokens: 800,
				output_tokens: 300,
			},
		]);

		const handler = await loadTokenStatsHandler();
		const rendered: string[][] = [];
		await handler("all", createMockCtx(rendered));
		const out = getRenderedText(rendered);

		// Cost must appear in the summary and By Agent table
		expect(out).toContain("$0.7300");
	});

	it("groups mixed __main__ and subagent rows correctly in By Agent", async () => {
		const ts = new Date().toISOString();
		seedAnalyticsDb([
			{
				timestamp: ts,
				session_id: "mixed-s1",
				agent: "__main__",
				model: null,
				provider: null,
				depth: 0,
				main_agent: 1,
				cost_usd: 0.5,
				input_tokens: 600,
				output_tokens: 200,
			},
			{
				timestamp: ts,
				session_id: "mixed-s2",
				agent: "worker",
				model: "anthropic/claude-3-5-sonnet",
				provider: "anthropic",
				depth: 1,
				main_agent: 0,
				cost_usd: 0.25,
				input_tokens: 300,
				output_tokens: 100,
			},
		]);

		const handler = await loadTokenStatsHandler();
		const rendered: string[][] = [];
		await handler("all", createMockCtx(rendered));
		const out = getRenderedText(rendered);

		// Both rows present; __main__ shown as orchestrator
		expect(out).toContain("orchestrator");
		expect(out).toContain("worker");
		// Total cost should be the sum
		expect(out).toContain("$0.7500");
	});
});
