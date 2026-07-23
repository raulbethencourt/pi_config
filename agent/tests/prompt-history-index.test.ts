import { describe, it, expect } from "vitest";
import { sanitizeForDisplay } from "../extensions/prompt-history/index.ts";

// sanitizeForDisplay(text: string): string — pi-improvement-plan item #25,
// Phase A. Picker rows (label/description) are sourced from arbitrary
// past-prompt text, which could contain raw ANSI escape sequences or control
// characters that would corrupt the picker's terminal rendering. Modeled on
// generate.ts's private stripControlCharacters, plus a whitespace collapse
// since a picker row must render as a single clean line. This function is
// intentionally duplicated independently in zsh-history.ts (see
// tests/zsh-history.test.ts) — a later extraction phase consolidates it.
describe("sanitizeForDisplay", () => {
  it("strips ANSI/CSI escape sequences", () => {
    const result = sanitizeForDisplay("fix \x1b[31mthe bug\x1b[0m please");
    expect(result).toBe("fix the bug please");
  });

  it("strips C0 control characters and DEL", () => {
    const result = sanitizeForDisplay("fix\x07 the\x00bug\x7F!");
    // eslint-disable-next-line no-control-regex -- intentionally asserting absence of C0/DEL
    expect(result).not.toMatch(/[\x00-\x1F\x7F]/);
  });

  it("strips C1 control-range bytes (0x80-0x9F)", () => {
    const result = sanitizeForDisplay("fix\x9Bthe bug");
    // eslint-disable-next-line no-control-regex -- intentionally asserting absence of C1
    expect(result).not.toMatch(/[\x80-\x9F]/);
    expect(result).toBe("fixthe bug");
  });

  it("collapses a multi-paragraph prompt into a single line", () => {
    const multiParagraph = "Please fix the bug.\n\nIt happens when\tthe input is empty.\n\nThanks!";
    const result = sanitizeForDisplay(multiParagraph);
    expect(result).toBe("Please fix the bug. It happens when the input is empty. Thanks!");
    expect(result).not.toContain("\n");
    expect(result).not.toContain("\t");
  });

  it("leaves ordinary printable text, including non-ASCII/Unicode, unchanged", () => {
    const text = "please translate café → 日本語 for émigré users";
    expect(sanitizeForDisplay(text)).toBe(text);
  });

  it("returns an empty string for empty input without throwing", () => {
    expect(() => sanitizeForDisplay("")).not.toThrow();
    expect(sanitizeForDisplay("")).toBe("");
  });
});
