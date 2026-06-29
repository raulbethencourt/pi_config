import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type RunRow = {
	timestamp: string;
	session_id?: string;
	agent?: string;
	model?: string | null;
	provider?: string | null;
	task_summary?: string;
	input_tokens?: number;
	output_tokens?: number;
	cache_read?: number;
	cache_write?: number;
	cost_usd?: number;
	turns?: number;
	duration_ms?: number;
	exit_code?: number;
	cwd?: string;
};

let tempHome = "";

const RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  provider TEXT,
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
`;

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

async function createAnalyticsDb(rows: RunRow[]) {
	const dbDir = path.join(tempHome, ".pi", "data");
	const dbPath = path.join(dbDir, "analytics.db");
	fs.mkdirSync(dbDir, { recursive: true });

	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(dbPath);
	db.exec(RUNS_SCHEMA);

	const stmt = db.prepare(`
		INSERT INTO runs (
			timestamp, session_id, agent, model, provider, task_summary,
			input_tokens, output_tokens, cache_read, cache_write,
			cost_usd, turns, duration_ms, exit_code, cwd
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	for (const row of rows) {
		stmt.run(
			row.timestamp,
			row.session_id ?? crypto.randomUUID(),
			row.agent ?? "agent",
			row.model ?? null,
			row.provider ?? null,
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

describe("token-stats By Provider clarified regression", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "token-stats-by-provider-clarified-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("node:os");
		if (tempHome && fs.existsSync(tempHome)) {
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("aggregates __main__ github-backed runs under github and never shows orchestrator in By Provider", async () => {
		await createAnalyticsDb([
			{ timestamp: new Date().toISOString(), session_id: "r1", agent: "__main__", provider: "github", model: "github-copilot/gpt-5.4-mini", cost_usd: 0.12 },
			{ timestamp: new Date().toISOString(), session_id: "r2", agent: "__main__", provider: "github", model: "github-copilot/claude-sonnet-4.6", cost_usd: 0.18 },
			{ timestamp: new Date().toISOString(), session_id: "r3", agent: "planner", provider: "opencode", model: "deepseek-v4", cost_usd: 0.22 },
		]);

		const handler = await loadTokenStatsHandler();
		const rendered: string[][] = [];
		await handler("all", createMockCtx(rendered));
		const out = getRenderedText(rendered);
		const byProvider = out.split("By Model")[0].split("By Provider").slice(1).join("By Provider");

		expect(byProvider).toMatch(/github\s+2\s+\$0\.3000/);
		expect(byProvider).toMatch(/opencode\s+1\s+\$0\.2200/);
		expect(byProvider).not.toMatch(/orchestrator/);
	});
});
