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
	cost_usd?: number;
};

let tempHome = "";
const RUNS_SCHEMA = `CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, session_id TEXT NOT NULL, agent TEXT NOT NULL, model TEXT, provider TEXT, cost_usd REAL DEFAULT 0);`;

async function loadTokenStatsHandler() {
	vi.resetModules();
	vi.doMock("node:os", async () => {
		const actual = await vi.importActual<typeof import("node:os")>("node:os");
		return { ...actual, homedir: () => tempHome };
	});

	let handler: any = null;
	const extension = await import("../extensions/token-stats-cmd/index.ts");
	extension.default({ registerCommand(name: string, config: any) { if (name === "token_stats") handler = config.handler; } } as any);
	return handler;
}

function createMockCtx(renderedFrames: string[][]) {
	const theme = { bold: (s: string) => s, fg: (_: string, s: string) => s };
	const rows = process.stdout.rows;
	Object.defineProperty(process.stdout, "rows", { value: 200, configurable: true });
	return { ui: { theme, custom: async (fn: any) => { const component = fn({ requestRender: () => {} }, theme, null, () => {}); renderedFrames.push(component.render(200)); } }, __restoreRows: () => Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true }) };
}

function getRenderedText(renderedFrames: string[][]): string { return renderedFrames.flat().join("\n"); }

async function createAnalyticsDb(rows: RunRow[]) {
	const dbDir = path.join(tempHome, ".pi", "data");
	const dbPath = path.join(dbDir, "analytics.db");
	fs.mkdirSync(dbDir, { recursive: true });
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(dbPath);
	db.exec(RUNS_SCHEMA);
	const stmt = db.prepare(`INSERT INTO runs (timestamp, session_id, agent, model, provider, cost_usd) VALUES (?, ?, ?, ?, ?, ?)`);
	for (const row of rows) stmt.run(row.timestamp, row.session_id ?? crypto.randomUUID(), row.agent ?? "agent", row.model ?? null, row.provider ?? null, row.cost_usd ?? 0);
	db.close();
}

describe("token-stats github-copilot regressions", () => {
	beforeEach(() => { tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "token-stats-github-copilot-")); });
	afterEach(() => { vi.restoreAllMocks(); vi.doUnmock("node:os"); if (tempHome && fs.existsSync(tempHome)) fs.rmSync(tempHome, { recursive: true, force: true }); });

	it("collapses github-copilot into github in By Provider, including when derived from the model prefix", async () => {
		await createAnalyticsDb([
			{ timestamp: new Date().toISOString(), session_id: "r1", agent: "planner", provider: "github-copilot", model: "github-copilot/gpt-5.4-mini", cost_usd: 0.1 },
			{ timestamp: new Date().toISOString(), session_id: "r2", agent: "planner", provider: null, model: "github-copilot/claude-sonnet-4.6", cost_usd: 0.2 },
		]);

		const handler = await loadTokenStatsHandler();
		const rendered: string[][] = [];
		await handler("all", createMockCtx(rendered));
		const out = getRenderedText(rendered);
		const byProvider = out.split("By Model")[0].split("By Provider").slice(1).join("By Provider");

		expect(byProvider).toMatch(/github\s+2\s+\$0\.3000/);
		expect(byProvider).not.toMatch(/github-copilot\s+2/);
	});

	it("does not render recoverable prefixed models with null provider as unknown", async () => {
		await createAnalyticsDb([
			{ timestamp: new Date().toISOString(), session_id: "r1", agent: "planner", provider: null, model: "acme/gpt-5.4", cost_usd: 0.2 },
		]);

		const handler = await loadTokenStatsHandler();
		const rendered: string[][] = [];
		await handler("all", createMockCtx(rendered));
		const out = getRenderedText(rendered);
		const byProvider = out.split("By Model")[0].split("By Provider").slice(1).join("By Provider");

		expect(byProvider).toMatch(/acme\s+1\s+\$0\.2000/);
		expect(byProvider).not.toMatch(/unknown\s+1\s+\$0\.2000/);
	});
});
