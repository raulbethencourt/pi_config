/**
 * ZSH History Picker
 *
 * Press ctrl+r to open a searchable picker over ~/.zsh_history.
 * - Type to fuzzy-filter
 * - Tab / Shift+Tab (or ↑↓) to navigate
 * - Enter to paste the selected command (prefixed with !) into the editor
 * - Esc to cancel
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@mariozechner/pi-tui";
import { runHistoryPicker, sanitizeForDisplay as sharedSanitizeForDisplay } from "./shared/history-picker.ts";

/**
 * Parse ~/.zsh_history → deduplicated list, most recent first.
 * Handles extended format (`: timestamp:elapsed;cmd`) and backslash continuations.
 */
export function parseZshHistory(raw: string): string[] {
	const lines = raw.split("\n");
	const commands: string[] = [];
	const seen = new Set<string>();
	let current = "";

	for (const line of lines) {
		const extMatch = line.match(/^: \d+:\d+;(.*)$/);
		const cmdPart = extMatch ? extMatch[1] : line;

		if (cmdPart.endsWith("\\")) {
			current += (current ? "\n" : "") + cmdPart.slice(0, -1);
		} else {
			current += (current ? "\n" : "") + cmdPart;
			const cmd = current.trim();
			current = "";
			if (cmd && !seen.has(cmd)) {
				seen.add(cmd);
				commands.push(cmd);
			}
		}
	}

	return commands.reverse();
}

// Re-exported for existing direct importers (tests/zsh-history.test.ts predates
// the shared-module extraction). The canonical implementation now lives in
// ./shared/history-picker.ts, shared with prompt-history/index.ts (which used
// to hand-duplicate it — pi-improvement-plan item #25, Phase A; consolidated
// in item #26, Phase B). New code should import from the shared module.
export const sanitizeForDisplay = sharedSanitizeForDisplay;

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+r", {
		description: "Search zsh history",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;

			const historyPath = join(homedir(), ".zsh_history");

			if (!existsSync(historyPath)) {
				ctx.ui.notify("~/.zsh_history not found", "error");
				return;
			}

			let raw: string;
			try {
				raw = readFileSync(historyPath, "latin1");
			} catch {
				ctx.ui.notify("Failed to read ~/.zsh_history", "error");
				return;
			}

			const allCommands = parseZshHistory(raw);
			if (allCommands.length === 0) {
				ctx.ui.notify("No history entries found", "info");
				return;
			}

			// `value` stays raw (it's `!`-prefixed and pasted back for execution);
			// only `label` is sanitized for safe terminal rendering.
			const allItems: SelectItem[] = allCommands.map((cmd) => ({ value: cmd, label: sanitizeForDisplay(cmd) }));

			await runHistoryPicker({
				ui: ctx.ui,
				headerLabel: "zsh history",
				countNoun: "entries",
				items: allItems,
				pasteTransform: (rawValue) => `!${rawValue}`,
			});
		},
	});
}
