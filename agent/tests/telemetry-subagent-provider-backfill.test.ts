import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

const ORIGINAL_HOME = process.env.HOME ?? "";
let tempHome = "";

async function loadTelemetry() {
	return import("../extensions/subagents/telemetry.ts");
}

function createPreProviderDb(): void {
	const dbPath = path.join(tempHome, ".pi", "data", "analytics.db");
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	db.exec(`
		CREATE TABLE runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp TEXT NOT NULL,
			session_id TEXT NOT NULL,
			agent TEXT NOT NULL,
			model TEXT,
			provider TEXT,
			task_summary TEXT
		);
	`);
	db.prepare("INSERT INTO runs (timestamp, session_id, agent, model, provider, task_summary) VALUES (?, ?, ?, ?, ?, ?)").run(
		new Date().toISOString(),
		"legacy-scout-github",
		"scout",
		"gpt-4.1",
		null,
		"legacy scout",
	);
	db.prepare("INSERT INTO runs (timestamp, session_id, agent, model, provider, task_summary) VALUES (?, ?, ?, ?, ?, ?)").run(
		new Date().toISOString(),
		"legacy-worker-deepseek",
		"worker",
		"deepseek-r1",
		"unknown",
		"legacy worker deepseek",
	);
	db.prepare("INSERT INTO runs (timestamp, session_id, agent, model, provider, task_summary) VALUES (?, ?, ?, ?, ?, ?)").run(
		new Date().toISOString(),
		"legacy-worker-nemotron",
		"worker",
		"nemotron-70b",
		null,
		"legacy worker nemotron",
	);
	db.close();
}

describe("legacy provider backfill for flat subagent rows", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-subagent-backfill-"));
		process.env.HOME = tempHome;
	});

	afterEach(() => {
		process.env.HOME = ORIGINAL_HOME;
	});

	it("backfills flat missing-provider subagent rows using the approved provider rule", async () => {
		createPreProviderDb();
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();

		const reloaded = telemetry.getDb();
		const githubRow = reloaded.prepare("SELECT provider FROM runs WHERE session_id = ?").get("legacy-scout-github") as { provider: string | null };
		const deepseekRow = reloaded.prepare("SELECT provider FROM runs WHERE session_id = ?").get("legacy-worker-deepseek") as { provider: string | null };
		const nemotronRow = reloaded.prepare("SELECT provider FROM runs WHERE session_id = ?").get("legacy-worker-nemotron") as { provider: string | null };

		expect(githubRow.provider).toBe("github");
		expect(deepseekRow.provider).toBe("opencode");
		expect(nemotronRow.provider).toBe("opencode");
	});
});
