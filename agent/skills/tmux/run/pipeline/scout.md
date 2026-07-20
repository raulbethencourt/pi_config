# Scout Report: /home/rabeta/.pi Configuration Bundle

## Directory Layout

```
~/.pi/
├── README.md                                 # Project overview doc
├── .gitignore
├── agent/
│   ├── AGENTS.md                             # Global agent rules (inherited by all agents)
│   ├── SYSTEM.md                             # Top-level system prompt (orchestration, depth-0 rules, TDD)
│   ├── SKILL_REFERENCE.md                    # Pipeline orchestration reference
│   ├── AGENT_EVOLUTION_PLAN.md               # Agent model routing history & decisions
│   ├── RESEARCH_AGENTIC_WORKFLOWS.md         # Research notes on agentic patterns
│   ├── settings.json                         # Pi configuration (themes, extensions, packages)
│   ├── keybindings.json                      # Custom keybindings
│   ├── tsconfig.json                         # TS compilation config
│   ├── vitest.config.ts                      # Vitest test runner config (node environment)
│   ├── package.json                          # Dev deps: vitest, typescript, @types/node
│   ├── package-lock.json
│   ├── prompts/
│   │   └── plan.md                           # Planner prompt template (ask_user_question integration)
│   ├── extensions/                           # Core extension source (TypeScript)
│   │   ├── ask-user-question.ts              # Interactive question tool (TUI)
│   │   ├── bash-guard/index.ts               # Dangerous command analyzer (shell-quote parser)
│   │   ├── btw.ts                            # "By The Way" side-session overlay (TUI)
│   │   ├── clear-screen.ts                   # /c command
│   │   ├── commands-loader.ts                # Auto-discovers prompt templates as commands
│   │   ├── context-info/index.ts             # Token/context usage breakdown widget
│   │   ├── delegation-enforcer/index.ts      # Depth-0 tool restriction enforcer
│   │   ├── hashline/                         # File edit tool with content-hash tagging
│   │   │   ├── index.ts                      # Custom edit tool registration
│   │   │   ├── patcher.ts                    # Parse/search/replace patching with tag validation
│   │   │   ├── hash.ts                       # SHA-256 content hashing (4-char tag)
│   │   │   ├── filesystem.ts                 # fs read/write wrapper
│   │   │   ├── path-utils.ts                 # Path resolution helpers
│   │   │   └── snapshot-store.ts             # In-memory file content snapshot cache
│   │   ├── memory/index.ts                   # Cross-session memory tool (file-backed)
│   │   ├── mobile-bridge/index.ts            # HTTP/HTTPS server + KDE Connect bridge
│   │   ├── notify.ts                         # Desktop notifications via notify-send
│   │   ├── persistent-cwd.ts                 # Maintains CWD across bash tool invocations
│   │   ├── powerline.ts                      # Status line widget (git, subagent count)
│   │   ├── review.ts                         # PR review session management
│   │   ├── sugar-testing.ts                  # SugarCRM test runner command
│   │   ├── tool-expander/index.ts            # Tool parameter expansion
│   │   ├── web-fetch/index.ts                # Web page fetching (Readability, Turndown, Jina)
│   │   ├── zsh-history.ts                    # ZSH history fuzzy search widget
│   │   ├── subagents/                        # Subagent orchestration (core module)
│   │   │   ├── index.ts                      # Main subagent tool (spawns child processes)
│   │   │   ├── runner.ts                     # Child process spawn + output parsing
│   │   │   ├── routing.ts                    # Complexity-based model routing
│   │   │   ├── routing.json                  # Per-agent model routing config
│   │   │   ├── fallback.ts                   # Fallback mode toggling
│   │   │   ├── agent-overrides.ts            # Per-agent model overrides
│   │   │   ├── activity.ts                   # Active subagent counter
│   │   │   ├── telemetry.ts                  # SQLite analytics DB (token usage tracking)
│   │   │   ├── transcript.ts                 # Subagent transcript logging
│   │   │   ├── resolve-mcp-tools.ts          # MCP tool resolution
│   │   │   ├── strip-child-prompt-hook.ts    # Parent prompt stripping for children
│   │   │   ├── strip-orchestration.ts        # Orchestration content removal
│   │   │   ├── sugar-guard.ts                # SugarCRM detection guard
│   │   │   └── tools/                        # Custom subagent tools
│   │   │       ├── safe-bash.ts              # Dangerous-command-blocked bash wrapper
│   │   │       ├── ast-grep.ts               # AST-based structural search
│   │   │       ├── repo-map.ts               # Codebase structure map
│   │   │       ├── repomix.ts                # AI-optimized file packing
│   │   │       ├── workspace.ts              # Workspace state tool
│   │   │       ├── test-config.ts            # Test framework detection
│   │   │       ├── git-inspect.ts            # Read-only git inspection
│   │   │       └── token-stats.ts            # Token usage statistics
│   │   ├── shared/
│   │   │   ├── content.ts                    # Text extraction helpers
│   │   │   └── format.ts                     # Token/duration formatting
│   │   └── token-stats-cmd/index.ts          # /token_stats command
│   ├── skills/                               # On-demand skill modules
│   │   ├── appmerge/SKILL.md
│   │   ├── browser/SKILL.md + scripts/       # Playwright browser automation (Python)
│   │   ├── browser-tools/SKILL.md            # CDP browser tools (JS)
│   │   ├── code-philosophy/SKILL.md
│   │   ├── delta/SKILL.md
│   │   ├── frontend-design/SKILL.md
│   │   ├── legacy-refactor/SKILL.md
│   │   ├── native-web-search/SKILL.md + search.mjs
│   │   ├── orchestrator/SKILL.md
│   │   ├── precommit-review/SKILL.md
│   │   ├── stop-slop/SKILL.md
│   │   ├── sugarcrm-testing/SKILL.md
│   │   ├── tmux/SKILL.md + run/scripts       # Tmux session orchestration
│   │   ├── translation/SKILL.md + scripts/   # Markdown translation (Python)
│   │   ├── websearch/SKILL.md
│   │   └── wrike/SKILL.md
│   ├── tests/                                # 70+ Vitest test files
│   │   ├── *.test.ts (70+ files)
│   │   └── subagents-first-render-expanded.test.ts
│   └── mcp/mcp.json                          # MCP tool configuration
├── data/                                     # Runtime data (telemetry DB, memory)
└── run/                                      # Session transcripts
```

## Module Responsibilities

**subagents/index.ts** — Core: spawns isolated pi child processes per agent type. Registers `subagent` tool. Handles parallel dispatch, progress tracking, transcript logging, telemetry.

**subagents/routing.ts** — Complexity-based model selection (simple/standard/complex tiers) using keyword scoring. Reads routing.json.

**subagents/runner.ts** — Child process spawn via `node:child_process.spawn`. Parses stdout/stderr. Detects rate-limit/retry patterns.

**subagents/telemetry.ts** — SQLite analytics database (analytics.db). Tracks runs: agent, model, provider, tokens, cost, depth.

**subagents/tools/safe-bash.ts** — Wraps built-in bash with 15+ dangerous-command block patterns (rm -rf /, sudo, curl|sh, mkfs, dd, etc.).

**hashline/index.ts** — File edit tool using content-hash tagging. Replaces built-in edit tool. Validates tags before applying patches.

**bash-guard/index.ts** — Static analysis of bash commands using shell-quote parser. Analyzes risk patterns (redirects, destructive ops, network threats).

**web-fetch/index.ts** — HTTP fetch via `fetch()` with Readability/Turndown conversion. Falls back to Jina Reader for JS-rendered pages. Handles PDFs.

**mobile-bridge/index.ts** — HTTP/HTTPS server for receiving mobile device requests via KDE Connect. Handles rate limiting, TLS, token-based auth. Starts listener on configurable port.

**review.ts** — Review session state machine. Executes git commands via `pi.exec()`, sends subagent reviews, manages approve/reject workflows.

**memory/index.ts** — File-based persistent memory (`~/.pi/data/memory/<md5>.md`). READ/WRITE filesystem operations.

**commands-loader.ts** — Scans file system for `.md` files in prompts/ directory, registers each as a command.

**persistent-cwd.ts** — Hooks bash tool spawns to maintain consistent working directory.

**notify.ts** — Desktop notifications via `execFile("notify-send", ...)`.

**context-info/index.ts** — Token estimation (heuristic), renders context usage breakdown.

**sugar-testing.ts** — SugarCRM test command (delegates to sugar-tester subagent).

## External Dependencies

### NPM Packages (production)

- `@earendil-works/pi-coding-agent` — All extensions (main pi SDK)
- `@mariozechner/pi-tui` — powerline, zsh-history, notify, btw, web-fetch, context-info, bash-guard, subagents
- `@mariozechner/pi-ai` — btw (AI session types)
- `typebox` — ask-user-question, hashline, memory, web-fetch, subagents, subagents/tools/*
- `shell-quote` — bash-guard/index.ts
- `@mozilla/readability` — web-fetch, browser-tools
- `linkedom` — web-fetch
- `turndown` + `turndown-plugin-gfm` — web-fetch, browser-tools
- `cheerio` — browser-tools
- `jsdom` — browser-tools
- `puppeteer` / `puppeteer-core` — browser-tools
- `puppeteer-extra` / `puppeteer-extra-plugin-stealth` — browser-tools

### NPM Packages (pi packages from settings.json)

- `npm:context-mode` — Context window optimization (FTS5 indexing, ctx_search tool)
- `npm:pi-mcp-adapter` — MCP tool adapter
- `npm:pi-web-access` — Web search/fetch tools
- `npm:pi-lens` — LSP navigation and AST tools

### Dev Dependencies

- vitest ^3.2.0
- typescript ^5.8.0
- @types/node ^24.0.0

### Python (skill scripts)

- playwright — browser skill
- deep-translator — translation skill

### System Dependencies

- notify-send (libnotify) — notify.ts
- git — powerline.ts, review.ts, subagents/tools/git-inspect.ts
- gh (GitHub CLI) — review.ts
- KDE Connect CLI — mobile-bridge/index.ts

## Risk Surface Callouts

### CRITICAL: Subprocess Execution (child_process)

**extensions/subagents/runner.ts** — `spawn` from `node:child_process`. Spawns isolated pi child processes. Args constructed from agent config. Moderate risk if config injection occurs.

**extensions/subagents/index.ts** — `execFile` from `node:child_process`. Used for process management.

**extensions/subagents/tools/git-inspect.ts** — `execSync` from `node:child_process`. Synchronous git command execution. Args are tool parameters.

**extensions/mobile-bridge/index.ts** — `childProcess.spawn`, `childProcess.spawnSync`. Spawns KDE Connect CLI (`kdeconnect-cli`). Args include user-provided text (notifications). Potential command injection if KDE Connect args not properly sanitized.

**extensions/notify.ts** — `execFile("notify-send", ...)`. Fixed binary, args are title + body strings. Low risk due to fixed command.

**extensions/review.ts** — `pi.exec("git", ...)`, `pi.exec("gh", ...)`. Via pi.exec SDK, not raw child_process. Git/gh args constructed from branch names, PR numbers.

### HIGH: Network Calls

**extensions/mobile-bridge/index.ts** — `createHttpServer`/`createHttpsServer` + `server.listen()`. HTTP/HTTPS server listening on network interfaces. Token-based auth, rate limiting. Network exposure risk.

**extensions/web-fetch/index.ts** — global `fetch()`. Fetches arbitrary URLs from user input. Timeout + size limits present. Risk of SSRF via user-supplied URLs.

### HIGH: File I/O

**extensions/hashline/filesystem.ts** — `readFile`/`writeFile` from `node:fs/promises`. Writes to arbitrary file paths resolved from user edit input. Tag validation provides integrity check.

**extensions/hashline/patcher.ts** — Reads file content, validates tag, applies search/replace, writes back. Tag prevents stale edits.

**extensions/memory/index.ts** — `readFileSync`/`writeFileSync`. Reads/writes to `~/.pi/data/memory/` directory. Path constructed from CWD hash.

**extensions/subagents/telemetry.ts** — SQLite via `node:sqlite`. Writes to `~/.pi/data/analytics.db`.

**extensions/subagents/transcript.ts** — File read/write for session transcripts. Writes to `~/.pi/data/runs/`.

**extensions/commands-loader.ts** — `fs.readdirSync`, `fs.statSync`. Scans prompts directory for `.md` files.

### MEDIUM: Environment Variable Access

- `extensions/mobile-bridge/index.ts` — `PI_MOBILE_BRIDGE_HTTPS`, `PI_MOBILE_BRIDGE_HOST`, `PI_MOBILE_BRIDGE_RATE_LIMIT`, `PI_MOBILE_BRIDGE_REGISTRY_DIR`
- `extensions/delegation-enforcer/index.ts` — `PI_SUBAGENT_DEPTH`
- `extensions/memory/index.ts` — `PI_MEMORY_DIR`
- `extensions/powerline.ts` — `STARSHIP_NERD`
- `extensions/subagents/fallback.ts` — `PI_FALLBACK_MODE`
- `extensions/subagents/index.ts` — `process.env.HOME` (path construction)

### MEDIUM: Dynamic Import / Module Loading

- `extensions/web-fetch/index.ts` — `import("linkedom")`, `import("turndown")`, `import("@mozilla/readability")` — ESM dynamic imports.
- `extensions/subagents/index.ts` — `buildPiArgs()` constructs CLI arguments with `--extension` paths. Dynamic path resolution to npm packages.

### LOW: Other Notable Items

- `extensions/bash-guard/index.ts` — `shellParse()` from shell-quote. Safety gate, not a risk.
- `extensions/sugar-testing.ts` — Reads `sugar_version.php` from filesystem.
- `extensions/subagents/sugar-guard.ts` — `fs.existsSync` checks. Path traversal risk if project path is unexpected.
- `extensions/subagents/tools/safe-bash.ts` — Regex-based dangerous command blocking. Protection layer.
- `extensions/persistent-cwd.ts` — `spawnHook` on bash tool. SDK-level hook, modifies env to pass CWD.
- `extensions/delegation-enforcer/index.ts` — Tool blocking based on depth. Restriction enforcement, no external risk.

## Security Observer Ratings

- **Subprocess injection** — Medium. mobile-bridge passes user text to KDE Connect CLI. runner spawns pi with controlled args.
- **SSRF** — Medium. web-fetch fetches arbitrary user-supplied URLs. Timeout/size limits in place but no blocklist for internal IPs.
- **Network exposure** — Medium. mobile-bridge listens on network interfaces (not just localhost) by default. Token auth + rate limiting mitigate.
- **File write access** — Medium. hashline edits arbitrary files (tag-validated). memory writes to controlled directory.
- **Code injection** — Low. No eval/Function/vm usage found in source. Dynamic import in tests only.
- **Auth/credentials** — Low. Token generated via `randomBytes(32)` for bridge. TLS support optional. No hardcoded credentials.
- **Dependency supply chain** — Medium. Many npm dependencies (Readability, Turndown, Puppeteer, linkedom, cheerio, jsdom). Browser-tools skill has heavy dependency footprint.

## Test Infrastructure

- **Runner**: Vitest v3.2.0 (node environment)
- **Config**: `agent/vitest.config.ts` with module aliases to pi SDK internals
- **Count**: 70+ test files in `agent/tests/`
- **Coverage areas**: subagents (dispatch, render, runner, env, transcript, badges, retry), hashline (patcher, snapshot, hash, read-tagging, write-retagging), telemetry (migration, depth-provider, write-failure, subagent-provider-backfill, runtime-provider), token-stats (cmd, empty-state, by-provider, provider-depth, orchestrator, model-family, github-copilot, polluted-provider), bash-guard, safe-bash, memory, memory-startup, delegation-enforcer, context-info, mobile-bridge, btw, review, powerline, sugar-testing, sugar-tdd-guard, git-inspect, repo-map, repomix, ast-grep, workspace, test-config, notify, zsh-history, agent-overrides, routing/complexity-router, strip-orchestration, strip-child-prompt-hook, filter-child-tools, shared-content, shared-format

## Priority Files for Security Audit

1. `agent/extensions/mobile-bridge/index.ts` — Network server, subprocess execution, env handling, auth
2. `agent/extensions/web-fetch/index.ts` — User-supplied URL fetching (SSRF surface)
3. `agent/extensions/hashline/patcher.ts` + `filesystem.ts` — File mutation with tag validation
4. `agent/extensions/subagents/index.ts` + `runner.ts` — Child process spawning orchestration
5. `agent/extensions/bash-guard/index.ts` — Dangerous command gate (what can bypass it?)
