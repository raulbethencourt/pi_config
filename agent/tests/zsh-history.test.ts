import { describe, it, expect } from "vitest";
import { parseZshHistory, sanitizeForDisplay } from "../extensions/zsh-history.ts";

describe("parseZshHistory", () => {
  it("parses simple commands", () => {
    const raw = "ls\ncd /tmp\npwd";
    const result = parseZshHistory(raw);
    // Most recent first
    expect(result).toEqual(["pwd", "cd /tmp", "ls"]);
  });

  it("parses extended format", () => {
    const raw = ": 1234567890:0;ls\n: 1234567891:0;cd /tmp";
    const result = parseZshHistory(raw);
    expect(result).toEqual(["cd /tmp", "ls"]);
  });

  it("deduplicates commands", () => {
    const raw = "ls\ncd\nls";
    const result = parseZshHistory(raw);
    // Only one "ls", most recent position wins
    expect(result.filter(c => c === "ls").length).toBe(1);
  });

  it("handles backslash continuations", () => {
    const raw = ": 1234567890:0;echo \\\nhello";
    const result = parseZshHistory(raw);
    expect(result[0]).toContain("echo");
    expect(result[0]).toContain("hello");
  });

  it("returns empty for empty input", () => {
    expect(parseZshHistory("")).toEqual([]);
  });

  it("skips blank lines", () => {
    const raw = "ls\n\n\npwd";
    const result = parseZshHistory(raw);
    expect(result).toEqual(["pwd", "ls"]);
  });
});

// sanitizeForDisplay(text: string): string — pi-improvement-plan item #25,
// Phase A. Picker rows (label/description) are sourced from arbitrary
// shell-history text, which could contain raw ANSI escape sequences or
// control characters that would corrupt the picker's terminal rendering.
// Modeled on generate.ts's private stripControlCharacters, plus a whitespace
// collapse since a picker row must render as a single clean line.
describe("sanitizeForDisplay", () => {
  it("strips ANSI/CSI escape sequences", () => {
    const result = sanitizeForDisplay("echo \x1b[31mhello\x1b[0m world");
    expect(result).toBe("echo hello world");
  });

  it("strips C0 control characters and DEL", () => {
    const result = sanitizeForDisplay("echo\x07 hello\x00world\x7F!");
    // eslint-disable-next-line no-control-regex -- intentionally asserting absence of C0/DEL
    expect(result).not.toMatch(/[\x00-\x1F\x7F]/);
  });

  it("strips C1 control-range bytes (0x80-0x9F)", () => {
    const result = sanitizeForDisplay("echo\x9Bhello");
    // eslint-disable-next-line no-control-regex -- intentionally asserting absence of C1
    expect(result).not.toMatch(/[\x80-\x9F]/);
    expect(result).toBe("echohello");
  });

  it("collapses a multi-line command reconstructed with real newlines and tabs into a single line", () => {
    const reconstructed = "echo hello \n\tworld \nfoo";
    const result = sanitizeForDisplay(reconstructed);
    expect(result).toBe("echo hello world foo");
    expect(result).not.toContain("\n");
    expect(result).not.toContain("\t");
  });

  it("leaves ordinary printable text, including non-ASCII/Unicode, unchanged", () => {
    const text = "echo café 日本語 émigré";
    expect(sanitizeForDisplay(text)).toBe(text);
  });

  it("returns an empty string for empty input without throwing", () => {
    expect(() => sanitizeForDisplay("")).not.toThrow();
    expect(sanitizeForDisplay("")).toBe("");
  });
});
