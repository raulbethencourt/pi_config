/**
 * Ghost-text editor for the ghost-suggest extension (pi-improvement-plan item #19).
 *
 * `GhostTextEditor` extends pi's `CustomEditor` (see the `StarshipEditor` pattern in
 * ../powerline.ts for the reference this was built from) to show a dim, inline
 * next-message suggestion in the otherwise-empty input box, and to accept it on
 * Tab / Right-arrow.
 *
 * Legacy Code Exemption (pi-improvement-plan #19, TDD bypass approved by
 * planner+critic review): this is tightly-coupled TUI rendering/input-handling
 * code. A meaningful automated test would require a full TUI harness (real
 * terminal dimensions, ANSI-aware assertions, a live `Editor` instance), which
 * is disproportionate for this change. Going straight to implementation with
 * manual verification instead of RED-first. No test file exists here on purpose.
 *
 * Manual verification checklist (run through this after any change to this file):
 *   [ ] First-turn suggestion: after the very first agent turn ends, a dim
 *       suggestion appears in the empty input box.
 *   [ ] Later-turn suggestion: after a subsequent turn, a new suggestion replaces
 *       the old one (no stale text, no flicker/duplication).
 *   [ ] Tab accepts the suggestion: box is empty, suggestion showing, pressing
 *       Tab fills the box with the suggestion text and the ghost text disappears;
 *       Enter still has to be pressed separately to send it.
 *   [ ] Right-arrow accepts the suggestion: same as Tab, using the Right key.
 *   [ ] Type-to-dismiss: with a suggestion showing, typing any other character
 *       clears the ghost text AND the typed character still lands in the box.
 *   [ ] Autocomplete non-regression: `/` or `@` autocomplete still opens and
 *       behaves normally; a showing suggestion never renders over/interferes
 *       with the autocomplete dropdown, and Tab still completes the
 *       autocomplete selection (not the ghost suggestion) while it's open.
 */

import { CustomEditor, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { EditorOptions, EditorTheme, TUI } from "@mariozechner/pi-tui";

type UiTheme = ExtensionContext["ui"]["theme"];

// Matches pure "─" border lines (styled or plain), same convention as
// isBorderLine() in ../powerline.ts. Duplicated locally rather than imported
// to keep this extension independent of powerline.ts being installed.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function isBorderLine(line: string): boolean {
  const plain = line.replace(ANSI_RE, "");
  return plain.length > 0 && /^─+$/.test(plain);
}

// Minimum visible columns of trailing whitespace required before we bother
// splicing in a suggestion (1 leading gap + at least 1 char of the hint).
const MIN_SUGGESTION_WIDTH = 2;

export class GhostTextEditor extends CustomEditor {
  private suggestion: string | undefined;
  private readonly uiTheme: UiTheme;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    uiTheme: UiTheme,
    options?: EditorOptions,
  ) {
    super(tui, theme, keybindings, options);
    this.uiTheme = uiTheme;
  }

  /** Set (or clear, via `undefined`) the ghost suggestion and request a re-render. */
  setSuggestion(text: string | undefined): void {
    this.suggestion = text;
    this.tui.requestRender();
  }

  /** Convenience wrapper for `setSuggestion(undefined)`. */
  clearSuggestion(): void {
    this.setSuggestion(undefined);
  }

  override render(width: number): string[] {
    const lines = super.render(width);

    if (!this.suggestion) return lines;
    if (this.getText().length > 0) return lines;
    if (this.isShowingAutocomplete()) return lines;

    // Expect the "empty box" shape: exactly [topBorder, singleContentLine, bottomBorder].
    // Anything else (scroll indicators, multi-line wrap, autocomplete rows) means our
    // assumptions about the layout don't hold — bail out rather than risk corrupting output.
    if (lines.length !== 3 || !isBorderLine(lines[0]!) || !isBorderLine(lines[2]!)) {
      return lines;
    }

    const contentLine = lines[1]!;
    const trailingMatch = contentLine.match(/ +$/);
    if (!trailingMatch) return lines;

    const availableWidth = trailingMatch[0].length;
    const leadingGap = 1;
    const usableWidth = availableWidth - leadingGap;
    if (usableWidth < MIN_SUGGESTION_WIDTH - leadingGap) return lines;

    const truncated = truncateToWidth(this.suggestion, usableWidth);
    const truncatedWidth = visibleWidth(truncated);
    const styledSuggestion = this.uiTheme.fg("dim", truncated);
    const trailingPadding = " ".repeat(Math.max(0, availableWidth - leadingGap - truncatedWidth));

    const before = contentLine.slice(0, contentLine.length - trailingMatch[0].length);
    const spliced = [...lines];
    spliced[1] = `${before}${" ".repeat(leadingGap)}${styledSuggestion}${trailingPadding}`;
    return spliced;
  }

  override handleInput(data: string): void {
    const suggestion = this.suggestion;

    if (suggestion) {
      const canAccept = this.getText().length === 0 && !this.isShowingAutocomplete();
      if (canAccept && (matchesKey(data, "tab") || matchesKey(data, "right"))) {
        this.setText(suggestion);
        this.clearSuggestion();
        return;
      }

      // Any other keystroke dismisses the suggestion, but the keystroke itself
      // still has to reach the base editor (e.g. the typed character must land).
      this.clearSuggestion();
      super.handleInput(data);
      return;
    }

    super.handleInput(data);
  }
}
