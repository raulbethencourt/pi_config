import { describe, it, expect } from "vitest";
import {
  sanitizeSuggestion,
  buildFirstTurnSeedPrompt,
  buildLaterTurnSeedPrompt,
} from "./generate.ts";

describe("sanitizeSuggestion", () => {
  it("passes normal short text through trimmed", () => {
    expect(sanitizeSuggestion("  add a test for this  ")).toBe(
      "add a test for this",
    );
  });

  it("unwraps text wrapped in double quotes", () => {
    expect(sanitizeSuggestion('"add a test for this"')).toBe(
      "add a test for this",
    );
  });

  it("unwraps text wrapped in single quotes", () => {
    expect(sanitizeSuggestion("'add a test for this'")).toBe(
      "add a test for this",
    );
  });

  it("collapses multi-line input to a single line", () => {
    expect(sanitizeSuggestion("add a test\nfor this\n\nplease")).toBe(
      "add a test for this please",
    );
  });

  it("truncates overlong input to a maximum of 80 characters", () => {
    const long = "a".repeat(200);
    const result = sanitizeSuggestion(long);
    expect(result).toBeDefined();
    expect(result!.length).toBe(80);
  });

  it("truncates at the 80-code-point boundary without splitting a surrogate pair in half", () => {
    // 79 ASCII chars + a 2-code-unit emoji lands the emoji exactly at the
    // cut point; a plain String.slice(0, 80) would keep only its leading
    // surrogate, leaving a lone/invalid unpaired surrogate in the result.
    const long = "a".repeat(79) + "\u{1F600}" + "b".repeat(20);
    const result = sanitizeSuggestion(long);
    expect(result).toBe("a".repeat(79) + "\u{1F600}");
    expect(Array.from(result!).length).toBe(80);
    // No lone surrogate half (high surrogate not followed by a low one, or
    // low surrogate not preceded by a high one) anywhere in the result.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result!)).toBe(false);
  });

  it("returns undefined for an empty string", () => {
    expect(sanitizeSuggestion("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only input", () => {
    expect(sanitizeSuggestion("   \n\t  ")).toBeUndefined();
  });

  it("returns undefined for \"I don't know\" (case-insensitive)", () => {
    expect(sanitizeSuggestion("I don't know")).toBeUndefined();
    expect(sanitizeSuggestion("I Don't Know")).toBeUndefined();
  });

  it("returns undefined for \"I'm not sure\" (case-insensitive)", () => {
    expect(sanitizeSuggestion("I'm not sure")).toBeUndefined();
    expect(sanitizeSuggestion("I'M NOT SURE")).toBeUndefined();
  });

  it('returns undefined for "no suggestion" (case-insensitive)', () => {
    expect(sanitizeSuggestion("no suggestion")).toBeUndefined();
    expect(sanitizeSuggestion("No Suggestion")).toBeUndefined();
  });

  it("strips ANSI escape sequences and other C0 control characters, since this is rendered directly into a TUI line", () => {
    const result = sanitizeSuggestion("add \x1b[31ma test\x1b[0m\x07 for this");
    expect(result).toBe("add a test for this");
    expect(result).not.toMatch(/[\x00-\x1F\x7F]/);
  });

  it("strips C1 control range characters (0x80-0x9F), which some terminals treat like an ESC-prefixed sequence", () => {
    const result = sanitizeSuggestion("add\x9Ba test for this");
    expect(result).toBe("adda test for this");
    // eslint-disable-next-line no-control-regex -- intentionally asserting absence of C0/C1/DEL
    expect(result).not.toMatch(/[\x00-\x1F\x7F-\x9F]/);
  });
});

describe("buildFirstTurnSeedPrompt", () => {
  const fixtureGitLog = [
    "commit abc123",
    "Author: Someone <someone@example.com>",
    "Date:   Mon Jan 1 00:00:00 2026 +0000",
    "",
    "    fix(scheduler): correct undefined variable in quote email job",
  ].join("\n");

  it("contains the literal git log output text in the result", () => {
    const result = buildFirstTurnSeedPrompt(fixtureGitLog);
    expect(result).toContain(fixtureGitLog);
  });

  it("contains instruction language telling the model to suggest one short next message, no preamble", () => {
    const result = buildFirstTurnSeedPrompt(fixtureGitLog).toLowerCase();
    expect(result).toContain("suggest");
    expect(result).toContain("next message");
  });
});

describe("buildLaterTurnSeedPrompt", () => {
  it("contains instruction language telling the model to suggest a next message based on the conversation", () => {
    const result = buildLaterTurnSeedPrompt().toLowerCase();
    expect(result).toContain("suggest");
    expect(result).toContain("conversation");
  });
});
