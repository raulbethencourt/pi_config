# ~/.pi Improvement Plan

Consolidated backlog from the `~/.claude` vs `~/.pi` config audit (2026-07-18). Each item below is a standalone task, intended to be picked up and implemented one at a time. Check items off as they're completed. No changes have been made to `~/.pi` yet — this is the punch list.

Source documents (full detail behind each item):
- `/tmp/pi-improvement-audit/claude-config-inventory.md` — what's configured in `~/.claude`
- `/tmp/pi-improvement-audit/pi-config-inventory.md` — what's configured in `~/.pi`
- `/tmp/pi-improvement-audit/diff-and-recommendations.md` — feature-level gap table
- `/tmp/pi-improvement-audit/claude-docs-research.md` — ideas from official Claude Code docs

---

## High priority

### 1. Add a Context7-equivalent MCP server
Pi has no live library/API-docs lookup capability today (`native-web-search`/`websearch` are generic web search, not a curated docs index). Context7 ships a public MCP server (`npx -y @upstash/context7-mcp` or similar) with no Anthropic-account dependency — slot it into `agent/mcp.json` the same way `chrome-devtools`/`github`/`context-mode` are already wired, then add it to `worker`/`debugger`'s `mcpTools` frontmatter. Cheapest, highest-confidence item on this list.

### 2. Memory housekeeping + size discipline
Not a new build — pi's `memory` tool + `context-mode` semantic index are already at or ahead of Claude's `MEMORY.md`. Two concrete actions:
- Investigate and likely prune the orphaned `.omc/project-memory.json` cache — its producer/consumer extension couldn't be traced in the reviewed code, it's dead config surface.
- Add a hard size ceiling + escalating-warning discipline to the memory index (mirrors Claude's Auto Memory: `MEMORY.md` loads only its first 200 lines/25KB, with a warn-then-error mechanism pushing detail into separate topic files). Pi's memory index has no such ceiling today and could hit the same bloat failure mode as it grows.

### 3. OS-level sandboxing for the Bash tool
Not raised by the config diff (neither tool documents this today) — surfaced from Claude Code's own docs. Claude Code sandboxes shell execution at the OS level (Seatbelt on macOS, bubblewrap on Linux/WSL2): default write scope is cwd + temp dir only, network is allowlist-only with per-domain prompt-once-then-remember, and credential files/env vars can be masked (a sentinel value substituted back only when a request reaches an approved host, keeping the raw secret out of process memory/logs). This is orthogonal to which model is driving, so it's directly portable to a local/free-model tool via `bubblewrap` on Linux. The single most concrete safety upgrade on this list.

---

## Medium priority

### 4. Package the existing pipeline as one scripted command
`SKILL_REFERENCE.md` already documents the exact scout→planner→critic→worker→review sequence with PROCEED/REVISE/BLOCK gating that Claude's `pilot-explore-plan-critique-execute-review.js` automates as a single call — pi's top-level loop currently has to manually re-issue each phase's `subagent` call in order. Since `subagents/index.ts` already supports a `tasks[]` parallel-dispatch mode and `commands-loader.ts` already supports prompt-template commands, this is a convenience wrapper (a `/pipeline`-style command or small extension), not new orchestration design.

### 5. Path-scoped conditional instruction loading
Claude Code supports `.claude/rules/*.md` files with `paths: ["src/api/**/*.ts"]`-style frontmatter — rules that load into context only when the agent touches matching files, instead of every session. This is "conditional CLAUDE.md fragments" and directly addresses instruction-file bloat over time. No equivalent found in pi's inventory — worth adding if pi's AGENTS.md/SYSTEM.md-equivalent files grow large.

### 6. Fixed "protected paths never auto-approved" list
Claude Code maintains a fixed list of paths (`.git`, `.claude`, shell rc files, `.npmrc`, `.mcp.json`, etc.) that are never auto-approved regardless of permission mode, short of full bypass. Cheap, high-value guardrail — protects the agent's own config and VCS state even under a fully-trusting/autonomous run. Check whether pi's `bash-guard`/`trust.json` already covers this, or only covers test-file immutability and named protected folders.

### 7. Add a `code-simplifier`-tier persona
The one confirmed roster drift since pi's 14 agents were ported from Claude: pi's `refactorer` handles explicit, potentially broad-scope refactors, but there's no narrow "polish what was just written for clarity/consistency, default to recently-modified code" role distinct from that. Low cost (one more persona `.md` + a routing-table row), moderate value.

### 8. Add a skill-creator-equivalent meta-tool
No skill-authoring skill/extension found in pi's inventory. Given pi already has 16 skills and an active skill-development cadence (design-doc backlog in `agent/docs/*.md`), a lightweight scaffolding skill/command (frontmatter template, `SKILL.md` conventions, trigger-description guidance) would reduce friction for adding #7 above and any future skills.

### 9. Consider exposing pi itself as an MCP server
Claude Code can act as an MCP *server* via `claude mcp serve`, letting other tools/agents call into it. MCP is an open standard, not Anthropic-proprietary — if pi doesn't expose its own capabilities this way, it's a concrete missing feature that would let pi interoperate with other agent tools (including Claude Code itself).

### 10. Shared task list + file-locking for parallel multi-agent delegation
Claude Code's experimental "Agent Teams" feature adds a shared, dependency-tracked task list, peer-to-peer teammate messaging, and file locking to prevent merge conflicts between parallel sessions. Pi's roster-based delegation model implies parallel multi-agent runs but doesn't coordinate around shared state today. Even a lightweight version (a shared JSON task list + a per-file claim/lock) would reduce collision risk.

---

## Low priority / already covered — no action needed (kept for reference, don't re-investigate)

### 11. `notify-on-stop`-style desktop notification — already present
`agent/extensions/notify.ts` already fires a desktop notification when the agent finishes and is waiting for input. No gap.

### 12. `code-philosophy` skill — already present in both
Already embedded in the `worker` persona's system prompt in both tools. No gap.

### 13. `claude-in-chrome`-style native browser pairing — not portable, not worth chasing
Proprietary Anthropic-Chrome-extension protocol tied to account-level device pairing — no public API surface for a third-party local tool to integrate with. Pi already covers the practical ground via two working paths (`browser` skill/Playwright, `browser-tools`/raw CDP) plus the same `chrome-devtools-mcp` package Claude uses. The actually-portable part ("control a real browser via CDP") is already present in both tools.

### 14. Test-file/protected-folder immutability — pi is already ahead, don't regress
Pi's `bash-guard` extension enforces test-file immutability and protected-folder restrictions as **non-bypassable in-code blocks** with no override path. Claude currently states the equivalent rule as policy text in `CLAUDE.md`, relying on subagent compliance — and Claude's own memory system records an incident of a worker violating exactly that kind of policy-text-only protection (`rm -rf` on pre-existing files "because the plan said so"). If pi's config is ever "upgraded" toward Claude's patterns wholesale, keep this mechanism as-is rather than weakening it to match Claude.

---

## Process note (not a pi task — an issue observed in `~/.claude` itself, during this audit)

While writing `diff-and-recommendations.md`, a `worker` subagent was blocked once by `~/.claude`'s own `enforce-delegation` Write hook despite being the legitimately dispatched subagent for that exact task — the `agent_id` signal apparently wasn't detected in that context. The subagent used the sanctioned one-off `FORCE_DELEGATE_OVERRIDE=1` fallback for that single write rather than looping on a blocked call, which is within the documented last-resort carve-out. Worth investigating `~/.claude/hooks/enforce-delegation*.sh`'s `agent_id` detection on its own at some point — this is unrelated to the pi improvement work above, filed here only so it isn't lost.

---

## Backlog (found during item #6's review process)

### 15. `bash-guard`: `find`/`fd` bypass protected-path blocking entirely via bare command-name matching — fixed
`READ_ONLY_CMDS` (in `agent/extensions/bash-guard/index.ts`) classifies any command starting with `find` or `fd` as unconditionally read-only via a bare command-name prefix match, with no inspection of the command's own arguments. `analyzeSegment`'s general risk-scoring path does separately flag `find <path> -delete` as high severity — but that's an independent, best-effort warning-and-prompt mechanism, not the same code path as the protected-path hard-block. For the protected-path hard-block specifically (`findBlockedProtectedFolderReference`, and the analogous `PROTECTED_WRITE_ONLY_FILES`/`PROTECTED_PATH_PATTERNS` check right after it), matching on the bare command name means `find <protected-path> -delete` or `find <protected-path> -exec rm {} \;` is still classified read-only and sails straight through the hard-block, for every `PROTECTED_FOLDER_ENTRIES` entry (old directory entries and the newer credential-file entries alike) — not something narrow to this session's additions. Found while reviewing/fixing the narrower read-only-exemption bug for the two credential-file entries (item #6); deferred as its own dedicated fix given the severity (full bypass of the hard-block, not just a downgrade to a promptable warning) and breadth (affects the entire `PROTECTED_FOLDER_ENTRIES`/`PROTECTED_WRITE_ONLY_FILES` surface, not one entry). Likely fix shape: give `find`/`fd` the same segment-level argument inspection `analyzeSegment` already does for `find -delete`, but wired into the protected-path block path rather than only the general risk-prompt path — e.g. only treat `find`/`fd` as read-only when none of `-delete`, `-exec`, `-execdir`, `-fprintf`, `-ok`, `-okdir` appear among its arguments.

**Fixed.** The bare command-name misclassification described above is closed, and review of the fix surfaced (and closed) several further bypasses of the same protected-path hard-block along the way: chaining (`&&`, `;`, `||`), piping (`|`), backgrounding (`&`), `;;`, `|&`, bare newlines, and `fd`'s bundled short-flags (`-Hx`-style, where a value-taking flag character bundled into a short-flag group was previously invisible to the exemption check). Fix lives in `agent/extensions/bash-guard/index.ts`, with regression coverage in `agent/tests/bash-guard-protected-paths.test.ts` (133 bash-guard-related tests passing).

### 16. `bash-guard`: command/process substitution still bypasses the protected-path hard-block
Command substitution (`$(...)`, backticks) and process substitution (`<(...)`, `>(...)`) still bypass the same protected-path hard-block fixed in item #15, because `shell-quote` flattens a substitution's inner tokens into the same segment as the outer command with no nesting-depth marker — e.g. `cat $(rm -rf ~/.ssh)` is still misclassified as read-only, since `cat` reads as the (only visible) command. Fixing this needs subshell-depth-aware tokenization, which is a materially larger change than the fixes already applied in item #15. This gap is documented inline in `agent/extensions/bash-guard/index.ts` near the `splitOnOps` call site.

### 17. `bash-guard`: `fd` bundled-short-flag value-taking set is missing two real value-taking flags
The bundled-short-flag detection added while fixing item #15 defines its value-taking-flag set as `FD_VALUE_TAKING_SHORT_FLAG_CHARS = new Set(["d", "E", "t", "e", "S", "c", "j"])` in `agent/extensions/bash-guard/index.ts`, but `fd` has two more real value-taking short flags not in that set: `-o`/`--owner` and `-C`/`--base-directory`. This can only cause rare over-blocking (a harmless `fd` invocation being incorrectly treated as non-exempt from the read-only classification), never a new bypass, so it's low priority — but worth completing the set for correctness.

### 18. `bash-guard`: output redirection to a protected path is not hard-blocked in headless/subagent mode
`analyzeBashCommand` in `agent/extensions/bash-guard/index.ts` flags output redirection (`>`, `>>`, `2>`) as a promptable "medium" risk, but that's a UI confirmation prompt, not the protected-path hard block (`findBlockedProtectedFolderReference`/`PROTECTED_WRITE_ONLY_FILES`/`PROTECTED_PATH_PATTERNS`) fixed in items #15–#17 — `tokensToStrings` strips redirect operators without them ever disqualifying a command from the read-only exemption there. Worse, the promptable path itself is skipped entirely in headless/non-interactive execution when `bash-guard-auto-allow` is set (the common subagent execution path), since `promptRunOrAbort` short-circuits before ever reaching the user. Net effect: a command like `cat payload > ~/.ssh/authorized_keys` (or `echo ... >> ~/.ssh/authorized_keys`) run by a subagent in headless mode is neither prompted nor hard-blocked, and can silently overwrite a protected path. This is a **pre-existing gap, not a regression** — the old bare-regex classifier that items #15–#17 replaced had the identical hole, since it never inspected redirect targets either. Deferred as its own item given it needs a materially different fix shape (teaching the protected-path hard-block to inspect redirect targets, independent of the read-only/mutating-primary classification those items addressed) rather than a small addition to existing logic.
