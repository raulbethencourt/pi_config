import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";

export type SettingsUpdate = {
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
};

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function getSettingsPath(): string {
	return path.join(process.env.HOME || path.join(path.sep, "home", "rabeta"), ".pi", "agent", "settings.json");
}

function parseThinkingLevel(input: string): ThinkingLevel | null {
	const normalized = input.trim().toLowerCase();
	return (THINKING_LEVELS as string[]).includes(normalized) ? (normalized as ThinkingLevel) : null;
}

export function parseSettingsUpdateRequest(input: string): SettingsUpdate {
	const text = input.trim();
	const update: SettingsUpdate = {};

	const modelMatch = text.match(/(?:^|\b)(?:set\s+)?(?:the\s+)?(?:top-level\s+)?(?:orchestrator\s+)?model\s+(?:to|=)\s+([^,.;]+?)(?=\s+(?:and\s+)?(?:thinking\s+level|thinking|$)|[,.;&]|$)/i);
	if (modelMatch) {
		update.defaultModel = modelMatch[1].trim();
	}

	const thinkingMatch = text.match(/(?:^|\b)(?:set\s+)?(?:the\s+)?thinking\s+level\s+(?:to|=)\s+([^,.;]+?)(?=\s+(?:and\s+)?(?:model|$)|[,.;&]|$)/i);
	if (thinkingMatch) {
		const level = parseThinkingLevel(thinkingMatch[1]);
		if (level) update.defaultThinkingLevel = level;
	}

	return update;
}

export function validateSettingsUpdate(update: SettingsUpdate): void {
	if (update.defaultThinkingLevel !== undefined && !THINKING_LEVELS.includes(update.defaultThinkingLevel)) {
		throw new Error(`Invalid thinking level: ${update.defaultThinkingLevel}`);
	}

	if (update.defaultModel !== undefined && update.defaultModel.trim().length === 0) {
		throw new Error("Model must not be empty");
	}
}

function mergeSettings(existing: Record<string, unknown>, update: SettingsUpdate): Record<string, unknown> {
	return {
		...existing,
		...(update.defaultModel !== undefined ? { defaultModel: update.defaultModel } : {}),
		...(update.defaultThinkingLevel !== undefined ? { defaultThinkingLevel: update.defaultThinkingLevel } : {}),
	};
}

export async function applySettingsUpdate(update: SettingsUpdate): Promise<void> {
	validateSettingsUpdate(update);

	const settingsPath = getSettingsPath();
	await fs.mkdir(path.dirname(settingsPath), { recursive: true });

	let existing: Record<string, unknown> = {};
	try {
		const raw = await fs.readFile(settingsPath, "utf-8");
		existing = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		existing = {};
	}

	const merged = mergeSettings(existing, update);
	await fs.writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("settings", {
		description: "Update the global orchestrator model and thinking level",
		handler: async (args, ctx) => {
			const update = parseSettingsUpdateRequest(args);
			if (!update.defaultModel && !update.defaultThinkingLevel) {
				ctx.ui.notify("Usage: /settings model to <model> and thinking level to <off|minimal|low|medium|high|xhigh>", "error");
				return;
			}

			try {
				await applySettingsUpdate(update);
				ctx.ui.notify("Updated settings.json", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Failed to update settings", "error");
			}
		},
	});
}
