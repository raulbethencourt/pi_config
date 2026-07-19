import picomatch from "picomatch";

/**
 * True if `filePath` matches at least one of `paths` (glob patterns).
 * Patterns are compiled fresh on each call — rule counts are small and
 * this keeps the function a pure, self-contained unit with no cache
 * invalidation surface to reason about.
 *
 * `filePath` must already be relative to the same root the `paths`
 * patterns are authored against (the project root — see `agent/rules/README.md`'s
 * `src/api/**\/*.ts`-style examples), NOT an absolute filesystem path.
 * `picomatch` anchors patterns (`^...$`) by default, so a non-`**`-prefixed
 * pattern like `src/api/**\/*.ts` never matches an absolute path such as
 * `/home/user/project/src/api/foo.ts` — only `**`-prefixed patterns happen to
 * still match an absolute path, which is why this requirement can go
 * unnoticed until a plain relative-style pattern is tried. Callers (see
 * `index.ts`) are responsible for converting an absolute touched-file path to
 * project-root-relative before calling this function.
 */
export function matchesAnyPattern(paths: string[], filePath: string): boolean {
  return paths.some((pattern) => picomatch.isMatch(filePath, pattern));
}
