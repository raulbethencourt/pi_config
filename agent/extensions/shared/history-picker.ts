/**
 * Shared scaffolding for the ctrl+r (zsh-history) and ctrl+f (prompt-history)
 * fuzzy-filtered pickers (pi-improvement-plan item #26, Phase B).
 *
 * Both pickers wire up an identical Container/DynamicBorder/Input/SelectList
 * layout, the same fuzzy-filter-against-raw-value behavior, and the same
 * tab/shift+tab/up/down navigation (with wraparound, and a no-op on a
 * single-item filtered list) — this module is the single canonical copy of
 * that scaffolding. `zsh-history.ts` and `prompt-history/index.ts` now only
 * keep what's genuinely specific to their data source: how history is
 * loaded/parsed, how each entry becomes a `SelectItem`, the paste-transform
 * applied to the selected raw value, and their own empty/error messages.
 *
 * This module also consolidates `sanitizeForDisplay`, which used to be
 * duplicated identically between the two files (pi-improvement-plan item
 * #25, Phase A).
 */

import { DynamicBorder, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

// Strips ANSI/CSI escape sequences, then any remaining ASCII C0 control
// characters (including a bare ESC, 0x1B), DEL, and the C1 control range
// (0x80-0x9F), then collapses whitespace runs (including embedded literal
// newlines/tabs) to a single space. History/prompt entries render as a
// single picker row, so raw escape sequences or embedded newlines must never
// reach the terminal render.
//
// Modeled on ghost-suggest/generate.ts's private stripControlCharacters —
// duplicated there independently since that's a separate extension with its
// own scope (pi-improvement-plan item #25, Phase A). This copy is the single
// shared implementation for the two picker extensions below.
export function sanitizeForDisplay(text: string): string {
	const collapsed = text.replace(/\s+/g, " ");
	// eslint-disable-next-line no-control-regex -- intentionally matching ANSI/C0/C1/DEL
	const withoutAnsi = collapsed.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	// eslint-disable-next-line no-control-regex -- intentionally matching ANSI/C0/C1/DEL
	return withoutAnsi.replace(/[\x00-\x1F\x7F-\x9F]/g, "").trim();
}

export interface HistoryPickerOptions {
	/** UI surface the picker is shown through — only the `custom` and `setEditorText` members are used. */
	ui: Pick<ExtensionUIContext, "custom" | "setEditorText">;
	/** Header label, e.g. "zsh history" or "prompt history". */
	headerLabel: string;
	/** Count noun shown after the entry count, e.g. "entries" or "prompts" (rendered as "4 entries" / "4 prompts"). */
	countNoun: string;
	/** Items to list, already shaped as SelectItem-compatible: raw `value` plus sanitized `label`/optional `description`. */
	items: SelectItem[];
	/** Applied to the selected item's raw `value` before it's handed to `ui.setEditorText`. */
	pasteTransform: (rawValue: string) => string;
}

/**
 * Opens the shared picker overlay (Container/DynamicBorder/Input/SelectList),
 * wires up fuzzy filtering and keyboard navigation, and — on Enter — pastes
 * the selected item's paste-transformed raw value into the editor. Escape
 * cancels without ever calling `setEditorText`.
 *
 * Callers are responsible for their own zero-entries short-circuit before
 * calling this (each picker's empty-state message is data-source-specific).
 */
export async function runHistoryPicker(options: HistoryPickerOptions): Promise<void> {
	const { ui, headerLabel, countNoun, items, pasteTransform } = options;

	const selected = await ui.custom<string | null>((tui, theme, _kb, done) => {
		// ── Search input ────────────────────────────────────────────────
		const input = new Input();
		input.focused = true;
		// Prevent Input's built-in submit/escape from firing
		// (we intercept those keys ourselves before passing to Input)
		input.onSubmit = () => {};
		input.onEscape = () => {};

		// ── List ────────────────────────────────────────────────────────
		const maxVisible = Math.min(items.length, 20);
		const selectList = new SelectList(items, maxVisible, {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});

		// ── Filter helper ───────────────────────────────────────────────
		function applyFilter(query: string) {
			const filtered = query.trim() ? fuzzyFilter(items, query, (item) => item.value) : items;
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
				" " + theme.fg("accent", theme.bold(headerLabel)) + theme.fg("dim", `  ${items.length} ${countNoun}`),
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
			new Text(theme.fg("dim", " tab/shift+tab or ↑↓  •  type to filter  •  enter select  •  esc cancel"), 0, 0),
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
		ui.setEditorText(pasteTransform(selected));
	}
}
