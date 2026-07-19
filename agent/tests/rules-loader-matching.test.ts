import { describe, expect, it } from "vitest";
import { matchesAnyPattern } from "../extensions/rules-loader/matcher.ts";

describe("matchesAnyPattern — single glob pattern", () => {
  it("matches a file path under the glob", () => {
    expect(matchesAnyPattern(["src/api/**/*.ts"], "src/api/users.ts")).toBe(true);
  });

  it("does not match a file path outside the glob", () => {
    expect(matchesAnyPattern(["src/api/**/*.ts"], "src/web/users.ts")).toBe(false);
  });
});

// ── Regression: picomatch anchors patterns (^...$) by default, so a
// non-`**`-prefixed pattern like the README's own `src/api/**/*.ts` example
// never matches an absolute filesystem path — only a `**`-prefixed pattern
// happens to still match an absolute path, which is why this went unnoticed
// until a plain relative-style pattern was tried. `matchesAnyPattern`'s
// contract (see matcher.ts's docstring) is that `filePath` is already
// relative to the same root the patterns are authored against; callers
// (index.ts) are responsible for that conversion before calling in. ──

describe("matchesAnyPattern — anchoring contract: filePath must be project-relative, not absolute", () => {
  it("matches the README's own src/api/**/*.ts example against a project-relative path", () => {
    expect(matchesAnyPattern(["src/api/**/*.ts"], "src/api/foo.ts")).toBe(true);
  });

  it("does NOT match a non-**-prefixed pattern against an absolute filesystem path", () => {
    expect(matchesAnyPattern(["src/api/**/*.ts"], "/home/user/project/src/api/foo.ts")).toBe(false);
  });
});

describe("matchesAnyPattern — multiple glob patterns (matches if ANY pattern matches)", () => {
  it("matches when the first pattern matches", () => {
    expect(
      matchesAnyPattern(["src/api/**/*.ts", "src/web/**/*.ts"], "src/api/users.ts"),
    ).toBe(true);
  });

  it("matches when the second pattern matches", () => {
    expect(
      matchesAnyPattern(["src/api/**/*.ts", "src/web/**/*.ts"], "src/web/users.ts"),
    ).toBe(true);
  });

  it("does not match when neither pattern matches", () => {
    expect(
      matchesAnyPattern(["src/api/**/*.ts", "src/web/**/*.ts"], "src/other/users.ts"),
    ).toBe(false);
  });
});
