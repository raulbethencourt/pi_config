/**
 * Cross-session, cross-workspace prompt-history picker (pi-improvement-plan
 * item #24).
 *
 * Press ctrl+f to open a searchable picker over every prompt the user has
 * ever sent to pi, aggregated across every past session and every workspace
 * (not just the current project). This mirrors zsh-history.ts's ctrl+r
 * shell-history UX, but over pi's own JSONL session logs instead of
 * ~/.zsh_history, and deliberately does NOT reuse ctrl+r — that binding
 * belongs to zsh-history.ts and must stay untouched.
 * - Type to fuzzy-filter
 * - Tab / Shift+Tab (or ↑↓) to navigate
 * - Enter to paste the selected prompt's full raw text into the editor,
 *   unprefixed (unlike zsh-history.ts's "!" shell-execution prefix — a pasted
 *   prompt here is meant for editing/resubmission, not execution)
 * - Esc to cancel
 *
 * All parsing/caching logic lives in prompt-store.ts (a pure module, unit
 * tested directly); this file only wires that logic into pi's shortcut +
 * custom-UI extension surface.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@mariozechner/pi-tui";
import { runHistoryPicker, sanitizeForDisplay as sharedSanitizeForDisplay } from "../shared/history-picker.ts";
import {
	formatRelativeTime,
	loadCache,
	type PromptHistoryEntry,
	refreshPromptHistory,
	resolveCacheFilePath,
	resolveSessionsRoot,
	saveCache,
	toPreviewLabel,
} from "./prompt-store.ts";

// Preview labels are truncated to this length; the full untruncated prompt
// stays in SelectItem.value for both fuzzy matching and what gets pasted.
const PREVIEW_MAX_LEN = 120;

// Re-exported for existing direct importers (tests/prompt-history-index.test.ts
// predates the shared-module extraction). The canonical implementation now
// lives in ../shared/history-picker.ts, shared with zsh-history.ts (which
// used to hand-duplicate it — pi-improvement-plan item #25, Phase A;
// consolidated in item #26, Phase B). New code should import from the shared
// module.
export const sanitizeForDisplay = sharedSanitizeForDisplay;

function toSelectItem(entry: PromptHistoryEntry, now: number): SelectItem {
	return {
		// `value` stays raw (the full untruncated prompt, pasted back for
		// editing/resubmission); label/description are sanitized for safe
		// terminal rendering.
		value: entry.text,
		label: sanitizeForDisplay(toPreviewLabel(entry.text, PREVIEW_MAX_LEN)),
		description: sanitizeForDisplay(`${formatRelativeTime(entry.timestampMs, now)} · ${entry.workspace}`),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+f", {
		description: "Search prompt history (all sessions, all workspaces)",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;

			const sessionsRoot = resolveSessionsRoot();
			const cachePath = resolveCacheFilePath();
			const now = Date.now();

			const previousCache = loadCache(cachePath);
			const { entries, cache } = refreshPromptHistory(sessionsRoot, previousCache, now);
			// Best-effort write-back: persisting the cache is a pure
			// performance optimization (skip re-parsing unchanged files next
			// time), so a failure here (disk full, EACCES, ...) must not
			// prevent the picker from opening with the entries already
			// computed above.
			try {
				saveCache(cachePath, cache);
			} catch {
				// ignore — the picker still opens with in-memory entries
			}

			if (entries.length === 0) {
				ctx.ui.notify("No prompt history found", "info");
				return;
			}

			const allItems: SelectItem[] = entries.map((entry) => toSelectItem(entry, now));

			await runHistoryPicker({
				ui: ctx.ui,
				headerLabel: "prompt history",
				countNoun: "prompts",
				items: allItems,
				// Paste the full raw prompt text as-is — no "!" prefix (that's
				// zsh-history.ts's shell-execution convention; a prompt here is
				// meant to be edited/resubmitted, not executed).
				pasteTransform: (rawValue) => rawValue,
			});
		},
	});
}
