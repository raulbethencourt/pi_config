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
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
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

function toSelectItem(entry: PromptHistoryEntry, now: number): SelectItem {
	return {
		value: entry.text,
		label: toPreviewLabel(entry.text, PREVIEW_MAX_LEN),
		description: `${formatRelativeTime(entry.timestampMs, now)} · ${entry.workspace}`,
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

			const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				// ── Search input ────────────────────────────────────────────────
				const input = new Input();
				input.focused = true;
				// Prevent Input's built-in submit/escape from firing
				// (we intercept those keys ourselves before passing to Input)
				input.onSubmit = () => {};
				input.onEscape = () => {};

				// ── List ────────────────────────────────────────────────────────
				const maxVisible = Math.min(allItems.length, 20);
				const selectList = new SelectList(allItems, maxVisible, {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				});

				// ── Filter helper ───────────────────────────────────────────────
				function applyFilter(query: string) {
					const filtered = query.trim() ? fuzzyFilter(allItems, query, (item) => item.value) : allItems;
					selectList.filteredItems = filtered;
					selectList.setSelectedIndex(0);
				}

				// ── Navigation helpers ──────────────────────────────────────────
				function moveNext() {
					const len = Math.max(1, selectList.filteredItems.length);
					selectList.setSelectedIndex((selectList.selectedIndex + 1) % len);
				}
				function movePrev() {
					const len = Math.max(1, selectList.filteredItems.length);
					selectList.setSelectedIndex((selectList.selectedIndex - 1 + len) % len);
				}

				// ── Layout ──────────────────────────────────────────────────────
				const container = new Container();
				container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
				container.addChild(
					new Text(
						" " +
							theme.fg("accent", theme.bold("prompt history")) +
							theme.fg("dim", `  ${allItems.length} prompts`),
						0,
						0,
					),
				);
				container.addChild(new DynamicBorder((s) => theme.fg("dim", s)));
				container.addChild(input);
				container.addChild(new DynamicBorder((s) => theme.fg("dim", s)));
				container.addChild(selectList);
				container.addChild(new DynamicBorder((s) => theme.fg("dim", s)));
				container.addChild(
					new Text(
						theme.fg("dim", " tab/shift+tab or ↑↓  •  type to filter  •  enter select  •  esc cancel"),
						0,
						0,
					),
				);
				container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

				return {
					render: (w) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						// Tab → next
						if (matchesKey(data, "tab")) {
							moveNext();
							tui.requestRender();
							return;
						}
						// Shift+Tab → prev
						if (matchesKey(data, "shift+tab")) {
							movePrev();
							tui.requestRender();
							return;
						}
						// Up arrow → prev
						if (matchesKey(data, "up")) {
							movePrev();
							tui.requestRender();
							return;
						}
						// Down arrow → next
						if (matchesKey(data, "down")) {
							moveNext();
							tui.requestRender();
							return;
						}
						// Enter → confirm
						if (matchesKey(data, "enter")) {
							const item = selectList.getSelectedItem();
							done(item ? item.value : null);
							return;
						}
						// Escape → cancel
						if (matchesKey(data, "escape")) {
							done(null);
							return;
						}
						// Everything else → search input
						const before = input.getValue();
						input.handleInput(data);
						const after = input.getValue();
						if (before !== after) {
							applyFilter(after);
						}
						tui.requestRender();
					},
				};
			});

			if (selected !== null) {
				// Paste the full raw prompt text as-is — no "!" prefix (that's
				// zsh-history.ts's shell-execution convention; a prompt here is
				// meant to be edited/resubmitted, not executed).
				ctx.ui.setEditorText(selected);
			}
		},
	});
}
