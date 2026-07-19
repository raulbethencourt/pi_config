# Rules — path-scoped supplementary instructions

**Rules only trigger on `read`/`write`/`edit` tool calls.** A file that's only ever
touched via `grep`/`find`/`ls`/`bash` never fires its rule, no matter how well the glob
matches — the loader hooks the `read`/`write`/`edit` `tool_result` event, not a generic
file-touch signal. If an instruction must apply regardless of *how* a file is touched,
it belongs in `AGENTS.md`/`SYSTEM.md`, not a rule.

## What this is

A rule is a `.md` file with YAML frontmatter that gets injected into the agent's
context only when it actually reads, writes, or edits a file matching the rule's glob
patterns — instead of every session, like `AGENTS.md`/`SYSTEM.md`. This keeps
project-wide instruction files lean while still surfacing narrow, path-specific
guidance (e.g. "this directory follows a stricter convention") exactly when it's
relevant.

Global rules live here, in `agent/rules/*.md`, and apply across every project.
Project-local rules live in `<project>/.pi/rules/*.md` and apply only within that
project. A rule with the same filename in both places is loaded once, with the
project version taking precedence.

## Frontmatter schema

| Field | Required | Type | Meaning |
|---|---|---|---|
| `paths` | yes | array of glob strings | File paths this rule applies to (matched with `picomatch`, e.g. `src/api/**/*.ts`) |
| `id` | no | string | Explicit rule id, shown in the injected block's heading. Defaults to the filename (without `.md`) when omitted. |

A rule file missing `paths`, or with an empty/non-array `paths`, is skipped (logged,
non-fatal) — the rest of the rules directory still loads.

## Example

```markdown
---
id: api-error-handling
paths:
  - "src/api/**/*.ts"
---
All API route handlers must return errors via the shared `ApiError` type, never a
raw thrown `Error`. See `src/api/errors.ts` for the shape.
```

## Trust boundary

A rule's body is injected into the agent's context as directive-framed, "required"
instruction text — the same way `AGENTS.md`/`SYSTEM.md` content is. That means anyone
who can write to `<project>/.pi/rules/*.md` can influence agent behavior exactly the
way anyone who can write to `<project>/.pi/SYSTEM.md` or `AGENTS.md` already can. This
isn't a new trust boundary; it's the same one those files already carry. Review a pull
request that adds or changes a file under `.pi/rules/` with the same scrutiny you'd
give one touching `.pi/SYSTEM.md` — a project-local rule file is exactly the kind of
thing a malicious PR or compromised dependency could plant to smuggle directives into
an agent's context under "required" framing. The injected block does disclose its own
source (`global` vs `project`, plus the rule file's path — see
`agent/extensions/rules-loader/format.ts`), but that's a provenance label, not a
sandbox: it doesn't stop the content from being read as a directive.

## Keep rule bodies short

Rule bodies are injected as extra tool-result content on every matching touch (once
per file per session — see `agent/extensions/rules-loader/README.md` for the dedup
rationale), so a long rule body adds up fast across a session that touches many
matching files. Keep it to the specific, narrow guidance that isn't already covered by
`AGENTS.md`/`SYSTEM.md` — the same reason those files are kept lean applies here, just
at a smaller scope.
