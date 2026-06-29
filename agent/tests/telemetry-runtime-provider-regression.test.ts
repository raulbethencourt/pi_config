import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.HOME ?? "";
let tempHome = "";

async function loadTelemetry() {
	return import("../extensions/subagents/telemetry.ts");
}

function readProvider(sessionId: string): string | null {
	const dbPath = path.join(tempHome, ".pi", "data", "analytics.db");
	const { DatabaseSync } = require("node:sqlite");
	const db = new DatabaseSync(dbPath);
	const row = db.prepare("SELECT provider FROM runs WHERE session_id = ?").get(sessionId) as { provider: string | null } | undefined;
	db.close();
	return row?.provider ?? null;
}

describe("telemetry runtime provider regression", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-runtime-provider-"));
		process.env.HOME = tempHome;
	});

	afterEach(() => {
		process.env.HOME = ORIGINAL_HOME;
	});

	it("does not store a flat model id as the provider for future rows", async () => {
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();

		telemetry.logRun(
			{
				agent: "planner",
				task: "check provider normalization",
				exitCode: 0,
				model: "gpt-5.4-mini",
				provider: "gpt-5.4-mini",
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
				progress: { durationMs: 5 },
			},
			process.cwd(),
			"future-row-session",
		);

		expect(readProvider("future-row-session")).toBe("github");
	});
});
