import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tempHome = "";

function makeRun(overrides: Partial<any> = {}) {
	return {
		agent: "planner",
		task: "Short task",
		exitCode: 0,
		model: "gpt-test",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 1,
			cacheWrite: 2,
			cost: 0.01,
			turns: 3,
		},
		progress: {
			durationMs: 1234,
		},
		...overrides,
	};
}

async function loadTelemetry() {
	vi.resetModules();
	vi.doMock("node:os", async () => {
		const actual = await vi.importActual<typeof import("node:os")>("node:os");
		return {
			...actual,
			homedir: () => tempHome,
		};
	});
	return import("../extensions/subagents/telemetry.ts");
}

describe("telemetry write failures", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-write-failure-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock("node:os");
		if (tempHome && fs.existsSync(tempHome)) {
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("reports a visible diagnostic when logRun cannot insert a run", async () => {
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();

		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const db = telemetry.getDb();
		const originalPrepare = db.prepare.bind(db);
		vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
			if (sql.includes("INSERT INTO runs")) {
				return {
					run: () => {
						throw new Error("simulated insert failure");
					},
				} as any;
			}
			return originalPrepare(sql);
		});

		expect(telemetry.logRun(makeRun(), "/tmp/project", "session-write-failure")).toBeNull();
		expect(consoleError).toHaveBeenCalled();
		expect(consoleError.mock.calls.some((call) => String(call[0]).includes("telemetry"))).toBe(true);
	});

	it("reports a visible diagnostic when logToolCalls cannot insert tool calls", async () => {
		const telemetry = await loadTelemetry();
		telemetry.initTelemetryDb();

		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const db = telemetry.getDb();
		const originalPrepare = db.prepare.bind(db);
		vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
			if (sql.includes("INSERT INTO tool_calls")) {
				return {
					run: () => {
						throw new Error("simulated tool insert failure");
					},
				} as any;
			}
			return originalPrepare(sql);
		});

		expect(() => telemetry.logToolCalls(1, [{ tool: "fs.read", count: 1 }])).not.toThrow();
		expect(consoleError).toHaveBeenCalled();
		expect(consoleError.mock.calls.some((call) => String(call[0]).includes("telemetry"))).toBe(true);
	});
});
