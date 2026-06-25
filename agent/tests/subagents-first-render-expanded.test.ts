import { beforeEach, describe, expect, it } from "vitest";
import subagentsInit from "../extensions/subagents/index.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("subagent block first render state", () => {
	let registeredTool: any;

	beforeEach(() => {
		registeredTool = undefined;
		subagentsInit({
			on() {},
			registerCommand() {},
			registerTool(def: any) {
				registeredTool = def;
			},
		} as any);
		Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
	});

	it("renders the first subagent block expanded by default", () => {
		const result = {
			content: [{ type: "text", text: "done" }],
			details: {
				mode: "single",
				results: [
					{
						agent: "worker",
						task: "Apply the fix",
						output: "Finished successfully",
						exitCode: 0,
						model: "openai/worker-model",
						usedFallback: false,
						usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.1234, turns: 2 },
						progress: {
							agent: "worker",
							status: "completed",
							task: "Apply the fix",
							recentTools: [{ tool: "edit", args: "agent/extensions/subagents/index.ts" }],
							toolCount: 1,
							tokens: 567,
							durationMs: 2500,
							lastMessage: "Applied the fix and verified the result",
						},
					},
				],
			},
		};

		const component = registeredTool.renderResult(result, {}, plainTheme, {});
		const output = component.render(80).join("\n");

		expect(output).toContain("Task: Apply the fix");
		expect(output).toContain("edit(agent/extensions/subagents/index.ts)");
		expect(output).toContain("Finished successfully");
	});
});
