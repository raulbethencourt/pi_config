# Pi Configuration Bundle

This repository is a pi configuration bundle containing global rules, subagent orchestration, custom extensions, reusable skills, and prompt templates.

---

## Features

- **Subagent Orchestration**: Single-task and parallel-task delegation via the `subagent` tool.
- **Isolated Subagent Processes**: Each subagent runs in a fully isolated sandbox with no shared context with the parent or sibling processes.
- **Live Progress Updates**: Real-time progress tracking and activity indicators for active subagent tasks.
- **Per-run Telemetry**: Execution tracing, token usage tracking, and performance metrics.
- **Fallback Command Handling**: Automatic fallback routing to alternative modes when primary execution pathways fail.
- **Extension Auto-Discovery**: Custom extensions, keybindings, and prompt templates are automatically discovered and registered at startup.
- **Runtime Reloading**: Execute the `/reload` command in the pi shell to instantly apply configuration, keybindings, and extension changes without restarting.

---

## Directory Structure

```
~/.pi/
├── README.md                    # This file
└── agent/
    ├── AGENTS.md                # Global rules (all agents inherit these)
    ├── SYSTEM.md                # Top-level prompt configuration
    ├── prompts/                 # Prompt templates
    ├── skills/                  # On-demand knowledge modules (reusable skills)
    ├── tests/                   # Integration and unit tests
    └── extensions/              # Core and optional extensions
```

---

## Shipped Extensions

In addition to the orchestrator, this bundle ships with several powerful extensions:

- **hashline**: Enforces edit tool safety by tracking and verifying file hashes using the `¶path#tag` header pattern to prevent stale, concurrent, or hallucinated edits.
- **bash-guard**: Restricts and audits shell execution, warning or blocking dangerous and destructive operations (e.g., `rm -rf`, `sudo`).
- **context-info**: Injects visual token usage grids, context budget warnings, and token allocation summaries directly into prompts.
- **btw**: Delivers context-aware, non-obtrusive inline hints and workflow suggestions during active sessions.
- **clear-screen**: Adds utility commands to safely clear terminal scrollback.
- **commands-loader**: Dynamically loads custom slash commands and automation scripts defined under `agent/commands/`.

---

## Agent Catalog

Each agent is defined by a markdown specification under `agent/extensions/subagents/agents/` containing YAML frontmatter for configuration and the body for its system prompt.

| Agent | Core Purpose | Target Model |
|-------|--------------|--------------|
| **worker** | General-purpose code writing, editing, and command execution | gpt-5.3-codex |
| **scout** | High-speed codebase search, file/pattern discovery, and structure mapping | grok-code-fast-1 |
| **planner** | High-level system architecture and step-by-step implementation design | claude-opus-4.6 |
| **researcher** | Automated web research, API documentation parsing, and synthesis | claude-sonnet-4.6 |
| **tester** | Test suite generation, test execution, and automated diagnostic validation | gpt-5.3-codex |
| **debugger** | Root-cause analysis and backward tracing from error symptoms | claude-opus-4.6 |
| **refactorer** | Non-breaking code quality and structural improvements | gpt-5.3-codex |
| **code-simplifier** | Clarity/consistency polish for recently-modified code (naming, duplication-at-a-glance, readability drift) — narrower scope than refactorer | gpt-5.4-mini |
| **security-auditor** | Lightweight static security scans and dependency vulnerability analysis | claude-sonnet-4.6 |
| **security-auditor-deep** | Exhaustive multi-pass security analysis and vulnerability simulation | claude-opus-4.6 |
| **doc-writer** | Automated technical writing, markdown documentation, and changelog updates | claude-sonnet-4.6 |
| **codereviewer** | Static pull request style code review and git diff inspection | claude-sonnet-4.6 |
| **codereviewer-deep** | Deep architectural code reviews, design pattern analysis, and optimization | claude-opus-4.6 |
| **critic** | Pre-implementation plan critique and edge-case validation | claude-sonnet-4.6 |
| **sugar-tester** | Specialized SugarCRM testing (PHPUnit, `bns curl`, run-batch automation) | gpt-5.3-codex |

---

## Custom Tools & Reusable Skills

Subagents have access to custom, context-efficient tools and triggerable skills:

### Custom Tools
- **`repo_map`**: Generates a compact structural AST map (~1-2K tokens) of symbols (classes, functions) to orient agents without reading full files.
- **`repomix`**: Combines and compresses a set of files into a single AI-optimized structure with tree-sitter compression (~70% token savings).
- **`workspace`**: A shared JSON-based blackboard `/tmp/pi-workspace-<hash>.json` for structured data sharing between agents in a pipeline.
- **`safe_bash`**: Sandboxed shell executing commands safely through blocklists.
- **`ast_grep`**: AST-based structural code searching matching code patterns over raw text.
- **`test_config`**: Auto-detects and caches project-specific test runners and settings.

### Skills (Triggered On-Demand)
- **appmerge**: Post-merge integrity checks for SugarCRM upgrades.
- **browser** / **browser-tools**: Headless browser automation via Playwright/CDP.
- **code-philosophy**: Injects software design principles into editing tasks.
- **delta**: Syntax-highlighted git diff display.
- **frontend-design**: Modern aesthetic guidance and UI styling components.
- **native-web-search** / **websearch**: Multi-strategy internet search and page extraction.
- **skill-creator**: Scaffolds a new pi skill (SKILL.md frontmatter, name validation, collision check, minimal body skeleton).
- **stop-slop**: Eliminates robotic AI prose patterns from written documentation.
- **sugarcrm-testing**: Specialized testing workflows.
- **translation**: Automated Markdown document translation via deep-translator.
- **wrike**: Bi-directional task and sprint synchronization with Wrike.

---

## Usage & Best Practices

### Choosing the Right Agent
- **Reconnaissance**: Use **scout** to locate files, find patterns, or map imports.
- **Design & Planning**: Use **planner** to draft architectural changes. Use **critic** on the draft plan to flag flaws or edge cases before writing code.
- **Implementation**: Use **worker** to write or edit source code, and **tester** to author or validate test coverage.
- **Diagnostics**: Use **debugger** to trace test failures or logs back to their source code root cause.

### Subagent Isolation & Context Sharing
Because subagents are launched as entirely isolated processes, they **do not share context** with the parent shell or other concurrent subagents. 
- **Rule**: When delegating a task to a subagent, your task description prompt **must contain all context required** (file paths, exact errors, requirements, and findings from prior steps). Do not assume the subagent knows what you or other subagents did previously. Use the `workspace` tool when programmatic sharing is needed.

### Live Reloading
Configuration, prompt templates, keybindings, and extensions are automatically loaded at shell boot. If you modify any file within this configuration bundle, run the slash command:
```bash
/reload
```
This instantly re-applies changes in the active session without requiring a full shell restart.

---

## Development & Testing

Unit and integration tests for the extensions and tools are located in `agent/tests/`.

To run the test suite:
```bash
cd agent
npm test
```

To run tests with coverage reporting:
```bash
cd agent
npm run test:coverage
```
