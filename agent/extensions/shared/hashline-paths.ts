/**
 * Shared ¶path#tag hashline edit-input parsing utilities.
 *
 * Consolidates logic that used to be duplicated between `hashline`'s own
 * `path-utils.ts` and a hand-maintained copy inside `rules-loader/index.ts`
 * (see that extension's README for the "why duplicated" history this module
 * replaces). Both extensions now import from here instead.
 */

import path from "node:path";
import { homedir } from "node:os";

const SELECTOR_SUFFIX_RE = /:(?:\d+-\d+|raw|conflicts|sel)$/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Strips a trailing hashline-style selector suffix (`:14-20`, `:raw`,
 * `:conflicts`, `:sel`) from a raw path string.
 */
export function stripSelector(rawPath: string): string {
	return rawPath.replace(SELECTOR_SUFFIX_RE, "");
}

// Note: this resolver intentionally does not enforce any containment boundary relative to cwd.
// It accepts ~-relative paths, absolute paths, and relative paths that can escape via ../.. .
// Security therefore relies on the underlying read/write tools' own access controls.
// A future configurable allowlist root could harden this by constraining resolved paths.
export function resolveAbsolutePath(rawPath: string, cwd: string): string | undefined {
	const trimmed = rawPath.trim();
	if (!trimmed || trimmed.startsWith("pi://") || URL_RE.test(trimmed)) {
		return undefined;
	}

	if (trimmed === "~") {
		return homedir();
	}

	if (trimmed.startsWith("~/")) {
		return path.join(homedir(), trimmed.slice(2));
	}

	if (path.isAbsolute(trimmed)) {
		return trimmed;
	}

	return path.resolve(cwd, trimmed);
}

/**
 * Parses one or more `¶path#tag` hashline header lines out of an edit tool's
 * `input` body, resolving each to an absolute path. Lines that don't start
 * with `¶` are ignored. Returns deduped absolute paths, in first-seen order.
 */
export function extractPathsFromEditInput(input: string, cwd: string): string[] {
	const resolvedPaths = new Set<string>();

	for (const line of input.split(/\r?\n/)) {
		if (!line.startsWith("¶")) {
			continue;
		}

		const hashIndex = line.lastIndexOf("#");
		const rawPath = hashIndex >= 1 ? line.slice(1, hashIndex) : line.slice(1);
		const absolutePath = resolveAbsolutePath(stripSelector(rawPath), cwd);
		if (absolutePath) {
			resolvedPaths.add(absolutePath);
		}
	}

	return [...resolvedPaths];
}
