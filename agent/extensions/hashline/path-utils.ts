/**
 * Backward-compatible re-export shim.
 *
 * The actual ¶path#tag parsing logic (`stripSelector`, `resolveAbsolutePath`,
 * `extractPathsFromEditInput`) now lives in `../shared/hashline-paths.ts`,
 * shared with `rules-loader` (which used to hand-duplicate this logic — see
 * that extension's README). `hashline/index.ts` and `hashline/patcher.ts`
 * import from the shared module directly and do not use this file anymore.
 *
 * This file is kept only so this import path keeps working for existing
 * direct importers (`agent/tests/hashline-read-tagging.test.ts` and
 * `agent/tests/hashline-write-retagging.test.ts`, which predate the
 * shared-module extraction). `resolveAbsolutePath` here preserves this
 * module's pre-existing `string | null` return contract — the shared
 * module's canonical signature is `string | undefined` (rules-loader's prior
 * convention) — by converting `undefined` to `null` at this boundary. New
 * code should import `../shared/hashline-paths.ts` instead of this file.
 */
import {
  extractPathsFromEditInput as sharedExtractPathsFromEditInput,
  resolveAbsolutePath as sharedResolveAbsolutePath,
  stripSelector as sharedStripSelector,
} from "../shared/hashline-paths.ts";

export const stripSelector = sharedStripSelector;
export const extractPathsFromEditInput = sharedExtractPathsFromEditInput;

export function resolveAbsolutePath(rawPath: string, cwd: string): string | null {
  return sharedResolveAbsolutePath(rawPath, cwd) ?? null;
}
