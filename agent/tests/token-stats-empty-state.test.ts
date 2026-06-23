/**
 * RED: Empty-state UX when a period-filtered query returns no rows
 * but historical (all-time) telemetry data exists.
 *
 * The command should guide the user clearly — e.g. suggesting /token_stats all —
 * rather than printing the generic "No telemetry data for selected period" message.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tempHome = "";

// Minimal runs schema matching what the command expects
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
        return {
            ...actual,
            homedir: () => tempHome,
        };
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

    return {
        ui: {
            theme,
            custom: async (fn: any) => {
                const component = fn({ requestRender: () => {} }, theme, null, () => {});
                renderedFrames.push(component.render(200));
                for (let i = 0; i < 30; i++) component.handleInput?.("j");
                renderedFrames.push(component.render(200));
            },
        },
    };
}

function getRenderedText(renderedFrames: string[][]): string {
    return renderedFrames.flat().join("\n");
}

/**
 * Seeds the analytics DB with a single run timestamped 60 days ago —
 * old enough to fall outside the default 'week' and 'today' windows.
 */
async function createDbWithOldRun() {
    const dbDir = path.join(tempHome, ".pi", "data");
    const dbPath = path.join(dbDir, "analytics.db");
    fs.mkdirSync(dbDir, { recursive: true });

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(RUNS_SCHEMA);

    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
        INSERT INTO runs (
            timestamp, session_id, agent, model, task_summary,
            input_tokens, output_tokens, cache_read, cache_write,
            cost_usd, turns, duration_ms, exit_code, cwd
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        sixtyDaysAgo,
        "old-session-1",
        "worker",
        "claude-3",
        "old task",
        5000,
        2000,
        0,
        0,
        0.42,
        4,
        12000,
        0,
        "/home/user/old-project",
    );

    db.close();
}

describe("/token_stats empty-state UX with historical data present", () => {
    beforeEach(() => {
        tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "token-stats-empty-state-"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.doUnmock("node:os");
        if (tempHome && fs.existsSync(tempHome)) {
            fs.rmSync(tempHome, { recursive: true, force: true });
        }
    });

    it("suggests /token_stats all when week period is empty but historical data exists", async () => {
        await createDbWithOldRun();
        const handler = await loadTokenStatsHandler();
        const rendered: string[][] = [];

        // Default: no args → week period; DB has data but only 60 days old (outside week window)
        await handler("", createMockCtx(rendered));

        const out = getRenderedText(rendered);

        // Must mention the suggestion command
        expect(out).toContain("/token_stats all");
    });

    it("does not show the /token_stats all hint when there is truly no data anywhere", async () => {
        // Empty DB — no rows at all
        const dbDir = path.join(tempHome, ".pi", "data");
        const dbPath = path.join(dbDir, "analytics.db");
        fs.mkdirSync(dbDir, { recursive: true });

        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(dbPath);
        db.exec(RUNS_SCHEMA);
        db.close();

        const handler = await loadTokenStatsHandler();
        const rendered: string[][] = [];

        await handler("", createMockCtx(rendered));

        const out = getRenderedText(rendered);

        // No suggestion when there really is nothing
        expect(out).not.toContain("/token_stats all");
    });

    it("suggests /token_stats all when today period is empty but historical data exists", async () => {
        await createDbWithOldRun();
        const handler = await loadTokenStatsHandler();
        const rendered: string[][] = [];

        await handler("today", createMockCtx(rendered));

        const out = getRenderedText(rendered);
        expect(out).toContain("/token_stats all");
    });

    it("does not show the hint when the 'all' period itself is empty", async () => {
        // Empty DB — 'all' period has no rows either
        const dbDir = path.join(tempHome, ".pi", "data");
        const dbPath = path.join(dbDir, "analytics.db");
        fs.mkdirSync(dbDir, { recursive: true });

        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(dbPath);
        db.exec(RUNS_SCHEMA);
        db.close();

        const handler = await loadTokenStatsHandler();
        const rendered: string[][] = [];

        await handler("all", createMockCtx(rendered));

        const out = getRenderedText(rendered);
        expect(out).not.toContain("/token_stats all");
    });
});
