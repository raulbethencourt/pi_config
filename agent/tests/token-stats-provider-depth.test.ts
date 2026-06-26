import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tempHome = "";

const RUNS_SCHEMA = `
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
`;

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
		__restoreRows: () => Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true }),
	};
}

function getRenderedText(renderedFrames: string[][]): string {
	return renderedFrames.flat().join("\n");
}

function seedDb(rows: Array<Record<string, any>>) {
	const dbDir = path.join(tempHome, ".pi", "data");
	const dbPath = path.join(dbDir, "analytics.db");
	fs.mkdirSync(dbDir, { recursive: true });
	return import("node:sqlite").then(({ DatabaseSync }) => {
		const db = new DatabaseSync(dbPath);
		db.exec(RUNS_SCHEMA);
		const stmt = db.prepare(`
			INSERT INTO runs (
				timestamp, session_id, agent, model, task_summary,
				input_tokens, output_tokens, cache_read, cache_write,
				cost_usd, turns, duration_ms, exit_code, cwd
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const row of rows) {
			stmt.run(
				row.timestamp,
				row.session_id,
				row.agent,
				row.model ?? null,
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
	});
}

describe("provider/depth telemetry and /token_stats reporting", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "token-stats-provider-depth-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("node:os");
		if (tempHome && fs.existsSync(tempHome)) fs.rmSync(tempHome, { recursive: true, force: true });
	});

	it("persists provider, depth, and main-agent usage fields in telemetry", async () => {
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();

		const db = telemetry.getDb();
		const cols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
		const names = cols.map((c) => c.name);

		expect(names).toContain("provider");
		expect(names).toContain("depth");
		expect(names).toContain("main_agent");
	});

	it("renders a By Provider section in /token_stats", async () => {
		await seedDb([
			{
				timestamp: "2026-06-01T12:00:00.000Z",
				session_id: "s1",
				agent: "planner",
				model: "m1",
				cost_usd: 0.1,
				input_tokens: 10,
				output_tokens: 20,
			},
		]);
		const handler = await loadTokenStatsHandler();
		const rendered: string[][] = [];
		await handler("all", createMockCtx(rendered));
		const out = getRenderedText(rendered);

		expect(out).toContain("By Provider");
		expect(out).toContain("provider");
	});

	it("uses UTC day buckets rather than local-time buckets", async () => {
		await seedDb([
			{
				timestamp: "2026-06-01T23:30:00.000Z",
				session_id: "late-utc",
				agent: "planner",
				model: "m1",
				cost_usd: 1,
				input_tokens: 1,
				output_tokens: 1,
			},
		]);
		const handler = await loadTokenStatsHandler();
		const rendered: string[][] = [];
		await handler("today", createMockCtx(rendered));
		const out = getRenderedText(rendered);

		expect(out).toContain("2026-06-01");
	});
});
