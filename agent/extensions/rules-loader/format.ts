import type { ParsedRule } from "./types.ts";

const ORIGIN_LABEL: Record<ParsedRule["origin"], string> = {
  global: "Global rule",
  project: "Project rule",
};

/**
 * Renders a matched rule as a directive-framed block to append to a
 * tool_result's content array. The heading is phrased as a requirement
 * ("required while working with this file") rather than a passive note,
 * since this is injected as tool output, not system-prompt space — see
 * this extension's README "Known limitation" section for why that framing
 * matters here.
 *
 * Discloses the rule's own provenance (`origin` + source file path) in the
 * injected text itself — see this extension's README "Trust boundary" note.
 * Rule `.md` files are project/repo-authored content, and a project-local
 * one is exactly the kind of thing an attacker with repo write access could
 * plant to inject directives under "required" framing; labeling the source
 * here means injected content is never indistinguishable from a
 * legitimately-authored global rule.
 */
export function formatRuleInjection(rule: ParsedRule, matchedPath: string): string {
  return [
    `[rules-loader] ${ORIGIN_LABEL[rule.origin]} — required while working with this file: ${rule.id}`,
    `Source: ${rule.origin} (${rule.filePath})`,
    `Matched path: ${matchedPath}`,
    "",
    rule.body,
    `[/rules-loader:${rule.id}]`,
  ].join("\n");
}
