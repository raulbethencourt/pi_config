/**
 * Which directory a rule was loaded from — `global` (`agent/rules/`, applies
 * across every project) or `project` (`<project>/.pi/rules/`, applies only
 * within that project and wins over a same-basename global rule). Carried
 * through to the injected block (see `format.ts`) so injected rule content
 * discloses its own provenance rather than being indistinguishable from a
 * legitimately-authored global rule — see this extension's README "Trust
 * boundary" note.
 */
export type RuleOrigin = "global" | "project";

/**
 * A fully loaded and validated rule: frontmatter merged with the file's
 * body text, ready to be matched against touched file paths and injected
 * into tool_result content.
 */
export interface ParsedRule {
  id: string;
  paths: string[];
  body: string;
  origin: RuleOrigin;
  /** Absolute path to the rule's own source `.md` file, for provenance. */
  filePath: string;
}
