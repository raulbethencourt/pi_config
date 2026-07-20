import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "../extensions/mcp-server/truncate.ts";

describe("truncate.ts constants", () => {
  it("DEFAULT_MAX_LINES is 2000", () => {
    expect(DEFAULT_MAX_LINES).toBe(2000);
  });

  it("DEFAULT_MAX_BYTES is 50 * 1024 (51200)", () => {
    expect(DEFAULT_MAX_BYTES).toBe(51200);
    expect(DEFAULT_MAX_BYTES).toBe(50 * 1024);
  });
});

describe("truncateHead", () => {
  it("returns content unchanged when within both limits", () => {
    const content = "line1\nline2\nline3";
    const result = truncateHead(content, { maxLines: 10, maxBytes: 1000 });
    expect(result.truncated).toBe(false);
    expect(result.content).toBe(content);
  });

  it("keeps the first N lines and drops the tail when exceeding maxLines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    const content = lines.join("\n");
    const result = truncateHead(content, { maxLines: 10, maxBytes: 1_000_000 });

    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("lines");
    const outputLines = result.content.split("\n");
    expect(outputLines).toEqual(lines.slice(0, 10));
    expect(outputLines.length).toBe(10);
  });

  it("never splits a partial line — truncated content only contains whole lines from the head", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `payload-line-number-${i}-${"x".repeat(50)}`);
    const content = lines.join("\n");
    // Force a byte-based truncation partway through the line set.
    const maxBytes = Buffer.byteLength(lines.slice(0, 5).join("\n"), "utf-8") + 10;
    const result = truncateHead(content, { maxLines: 1000, maxBytes });

    expect(result.truncated).toBe(true);
    expect(result.lastLinePartial).toBe(false);
    const outputLines = result.content.split("\n");
    // Every output line must be an exact, complete line from the original set.
    for (const line of outputLines) {
      expect(lines).toContain(line);
    }
    // Output must be a strict, ordered prefix of the original lines (the "head").
    expect(outputLines).toEqual(lines.slice(0, outputLines.length));
    expect(outputLines.length).toBeLessThan(lines.length);
  });

  it("uses the default constants when no options are passed and content exceeds them", () => {
    const manyLines = Array.from({ length: DEFAULT_MAX_LINES + 500 }, (_, i) => `l${i}`).join("\n");
    const result = truncateHead(manyLines);
    expect(result.truncated).toBe(true);
    expect(result.content.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
  });
});
