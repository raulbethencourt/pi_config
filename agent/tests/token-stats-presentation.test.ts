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

async function createAnalyticsDb(rows: Array<Record<string, any>>) {
	const dbDir = path.join(tempHome, ".pi", "data");
	const dbPath = path.join(dbDir, "analytics.db");
	fs.mkdirSync(dbDir, { recursive: true });

	const { DatabaseSync } = await import("node:sqlite");
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
			row.session_id ?? crypto.randomUUID(),
			row.agent ?? "agent",
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
}

describe("token-stats presentation", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "token-stats-presentation-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("node:os");
		if (tempHome && fs.existsSync(tempHome)) {
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("adds blank-line separation between adjacent sections in the rendered dashboard", async () => {
		const handler = await loadTokenStatsHandler();
		await createAnalyticsDb([
			{
				timestamp: new Date().toISOString(),
				agent: "__main__",
				model: "m1",
				input_tokens: 1,
				output_tokens: 1,
				cost_usd: 0.01,
				duration_ms: 1,
				exit_code: 0,
				cwd: "/tmp/project",
			},
		]);

		const rendered: string[][] = [];
		await handler("all", createMockCtx(rendered));
		const lines = getRenderedText(rendered).split("\n");

		const expectBlankBefore = (section: string, previous: string) => {
			const sectionIndex = lines.indexOf(section);
			expect(sectionIndex).toBeGreaterThan(0);
			expect(lines[sectionIndex - 1]).toBe("");
			expect(lines.slice(0, sectionIndex).includes(previous)).toBe(true);
		};

		expect(lines).toContain("  By Agent");
		expect(lines).toContain("  By Provider");
		expect(lines).toContain("  By Model");
		expect(lines).toContain("  Top 5 Expensive Runs");

		expect(lines).not.toContain("__main__");

		expectBlankBefore("  By Agent", "  Summary");
		expectBlankBefore("  By Model", "  By Provider");
		expectBlankBefore("  Top 5 Expensive Runs", "  By Model");
	});
});
