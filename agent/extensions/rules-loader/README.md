# rules-loader (pi extension)

Ports Claude Code's `.claude/rules/*.md` path-scoped conditional instruction loading:
`.md` files with `paths` glob frontmatter that get injected into context only when the
agent actually touches a matching file, instead of bloating `AGENTS.md`/`SYSTEM.md`
with instructions relevant to only a slice of the codebase.

For the rule-authoring guide (frontmatter schema, examples), see `agent/rules/README.md`.
This document covers the extension's own implementation.

## Module map

| File | Responsibility |
|---|---|
| `types.ts` | `ParsedRule` (loaded, validated rule, including its `origin`/source file path) |
| `matcher.ts` | `matchesAnyPattern(paths, filePath)` — glob matching via `picomatch` |
| `loader.ts` | `loadRules({globalDir, projectDir})` — discovers, parses, validates, merges `*.md` rule files |
| `format.ts` | `formatRuleInjection(rule, matchedPath)` — renders the directive-framed injected block |
| `index.ts` | Extension entry: hooks `tool_result`, wires real global/project rule directories, session-scoped dedup |

## Why `tool_result`, not `tool_call` or `before_agent_start`

- **`tool_call`** fires before a tool executes and can only block/allow it (or mutate
  `event.input` in place) — it has no content-injection channel, so it can't be used to
  surface a rule's body back to the model.
- **`before_agent_start`** fires once per agent turn, before any tool call happens that
  turn — it can't react to *which* file the model is about to touch, so it can't scope
  injection to specific matched paths within a turn that touches several files.
- **`tool_result`** fires after each `read`/`write`/`edit` call, with the actual touched
  path(s) — exactly one for `read`/`write`, one or more for `edit` (its `{ input: string }`
  hashline-formatted body can carry several `¶path#tag` header lines in one call) — and a
  `content` array the handler can append to. The only one of the three lifecycle events
  that can react per-file, after the fact, with injectable content.

## Global/project rule directories

- Global: `~/.pi/agent/rules/*.md` (via the package's own `getAgentDir()`, so it also
  respects the `PI_CODING_AGENT_DIR`/`TAU_CODING_AGENT_DIR`-style env override that
  function already honors).
- Project: `<cwd>/.pi/rules/*.md`, using the package's own project-local config dir
  name rather than a hardcoded `.pi` literal, for consistency with
  `discoverAndLoadExtensions`'s `cwd/${CONFIG_DIR_NAME}/extensions/` convention.
  Not every installed build of `@earendil-works/pi-coding-agent` re-exports that
  constant from its public entry point, though — `index.ts` reads it via a namespace
  import with a fallback to its own documented default (`.pi`) rather than a named
  import, since a named import of a genuinely-absent export throws at module-link time
  under native ESM, before any fallback logic could run.

Rules are loaded once per distinct `cwd` (lazily, on first matching `tool_result`), not
re-read from disk on every tool call — a project's rule files don't change mid-session.

## No cross-extension coupling with hashline

Both `hashline` and `rules-loader` hook `tool_result`. Early design drafts considered
importing hashline's private `resolveSessionId` and `path-utils.ts` helpers directly,
since the two extensions need near-identical logic (session-id resolution, stripping a
trailing hashline-style selector suffix like `:14-20`/`:raw`/`:conflicts`/`:sel` before
resolving a path to absolute, and — since `edit`'s tool input is hashline's own
`{ input: string }` hashline-formatted body, not a plain `path` field — parsing one or
more `¶path#tag` header lines out of that body). That was rejected: those helpers
aren't exported from `hashline/index.ts`, and importing a sibling extension's internal
files is brittle coupling — a refactor of hashline's internals could silently break
rules-loader with no type error at the boundary. `index.ts` instead implements small,
local, self-contained versions of all three (`stripSelector`/`resolveAbsolutePath`, and
`extractEditPaths`, which mirrors hashline's `extractPathsFromEditInput` closely enough
to parse the same header lines). Duplicating this logic is fine (and expected) because
the selector-suffix format and the `¶path#tag` header format are both public/observable
behavior — visible in tool call arguments — not a private API.

## Non-deterministic handler order → additive-only mutation

`emitToolResult` in the installed package threads a single, possibly-already-mutated
event through every extension's `tool_result` handler in `this.extensions` array order,
which itself comes from an unsorted `fs.readdirSync` — so there's no guarantee
`rules-loader`'s handler runs before or after `hashline`'s (or any other extension's)
`tool_result` handler in a given session. To stay correct under either ordering, the
handler here only ever *appends* new content items — it never replaces, reorders, or
drops whatever is already in `event.content` when it runs. This holds regardless of
whether an earlier handler already mutated the first content item (as hashline's read
handler does, prepending a `¶path#tag` snapshot tag).

## Dedup key: `(ruleId, filePath)`, not `(ruleId)`

The per-session dedup set stores `` `${ruleId}::${absoluteFilePath}` `` composite keys,
not just `ruleId`. This is intentional: a rule should remind the model again the first
time it touches a *different* file matching the same rule, not go silent for the rest
of the session after its first match anywhere. The intent is a per-file reminder, not a
one-shot "mentioned once, done" notice — a rule about `src/api/**/*.ts` conventions is
just as relevant on the fifth different API file touched as it was on the first.

## Trust boundary

Injected rule bodies are directive-framed instruction text ("required while working
with this file"), not sandboxed or validated content — a `.md` rule file is
project/repo-authored, so anyone with write access to `<project>/.pi/rules/*.md` (a
malicious PR, a compromised dependency, an attacker with repo write access) can inject
directives into the agent's context the same way anyone who can write to
`.pi/SYSTEM.md` or `AGENTS.md` already can. This is not a new trust boundary this
extension introduces; it's the same one those files already carry, just extended to a
new injection point. `ParsedRule.origin` (`"global"` | `"project"`) and
`ParsedRule.filePath` are threaded through `loadRules` → `formatRuleInjection` so the
injected text itself discloses its own source (see `format.ts`'s `Source: <origin>
(<filePath>)` line) — that's a provenance label for the model and for anyone reviewing
a transcript, not an isolation mechanism. It does not restrict what a rule body can say
or verify who authored it. Treat a PR touching `.pi/rules/` with the same review
scrutiny as one touching `.pi/SYSTEM.md`.

## Known limitation

This injects into `tool_result` content — ordinary tool output the model reads like any
other tool result — not system-prompt/context space the way Claude Code's own
`.claude/rules/*.md` mechanism does. That means the model may weight an injected rule
as informational tool output rather than a hard directive on the same footing as
`AGENTS.md`/`SYSTEM.md` content. The directive-framed heading (`"required while working
with this file"`) is a mitigation for that gap, not full equivalence with Claude Code's
system-prompt-level injection.
