# Subagents

A pi extension that registers a single `subagent` tool with ten agents:

| Agent | Tools | Model | Purpose |
|-------|-------|-------|---------|
| **scout** | read, grep, find, ls, rg, ast_grep, repo_map | grok-code-fast-1 | Fast codebase recon |
| **researcher** | web_search, web_fetch | claude-opus-4.6 | Web research |
| **planner** | read, grep, find, ls, ast_grep, repo_map, workspace | claude-opus-4.6 | Architecture planning |
| **worker** | read, write, edit, safe_bash, workspace | gpt-5.3-codex | Code changes |
| **tester** | read, write, edit, safe_bash, workspace | gpt-5.3-codex | Test writing & execution |
| **debugger** | read, grep, find, safe_bash, ast_grep, workspace | claude-opus-4.6 | Root cause analysis |
| **security-auditor** | read, grep, find, safe_bash, ast_grep, workspace | claude-sonnet-4.6 | Security scanning |
| **code-reviewer** | read, grep, find, ls, rg, workspace | claude-opus-4.6 | Git commit review |
| **doc-writer** | read, write, edit, grep, find, ls, workspace | claude-sonnet-4.6 | Documentation |
| **refactorer** | read, write, edit, grep, find, ls, safe_bash, ast_grep, workspace | gpt-5.3-codex | Code quality improvement |

## Usage

**Single mode:**
```json
{ "agent": "scout", "task": "Find all auth-related files in src/" }
```

**Parallel mode:**
```json
{ "tasks": [
  { "agent": "scout", "task": "Map the database layer" },
  { "agent": "researcher", "task": "Best practices for connection pooling" }
]}
```

Max 4 concurrent subagents (configurable). Each runs as an isolated `pi` process with no inherited context — all context must be in the task description.

## Config

Optional `config.json` next to `index.ts`:

```json
{ "maxConcurrency": 4 }
```

## Workspace Tool

The `workspace` tool is a shared JSON blackboard that persists across agent boundaries within the same orchestration session. Agents read and write structured data using dot-notation key paths; other agents in the same pipeline pick it up without any direct coupling.

**Operations:**
- `read` — read a value at a key path (or the whole document if no key)
- `write` — set a value at a key path (creates intermediate objects automatically)
- `append` — push a value onto an array at a key path (creates the array if absent)
- `clear` — delete a key path (or reset the entire workspace if no key)
- `keys` — list top-level or nested object field names

**Key paths** use dot notation: `"plan.steps"`, `"test_results.failures"`, `"files_modified"`.

**Storage:** `/tmp/pi-workspace-<md5-of-cwd>.json`

**Security:** file permissions `0o600`, prototype pollution guard, atomic writes, 1 MB total workspace limit, 64 KB per-value limit, 1 000-item array cap.

**Example — planner → worker → tester pipeline:**

```
# 1. Planner writes the plan
workspace.write("plan.steps", ["add-auth-middleware", "update-routes", "write-tests"])
workspace.write("plan.target_file", "src/middleware/auth.ts")

# 2. Worker reads the plan, writes results
workspace.read("plan")          # → { steps: [...], target_file: "..." }
workspace.append("files_modified", "src/middleware/auth.ts")
workspace.write("worker.status", "done")

# 3. Tester checks what changed and records results
workspace.read("files_modified")        # → ["src/middleware/auth.ts"]
workspace.write("test_results.passed", 42)
workspace.write("test_results.failed",  0)
workspace.append("test_results.failures", "none")
```

## UI

Default view shows medium detail (agent status, task preview, recent tools). Expand to see full task, all tool calls, complete output, and token usage.

## Registering Agents from Other Extensions

Other extensions can dynamically register and unregister agents at runtime. This is useful for domain-specific agents that should only be available when a particular extension is active.

### 1. Define agent `.md` files

Create markdown files with YAML frontmatter in your extension's directory (e.g. `my-extension/agents/my-agent.md`):

```markdown
---
name: my-agent
description: Does a specific thing
tools: web_search, video_extract
model: claude-sonnet-4-20250514
---

You are an agent that does a specific thing...
```

Frontmatter fields:
- **name** (required) — unique agent name, used in `{ agent: "my-agent" }` calls
- **description** — short description
- **tools** — comma-separated list of tools the agent needs (builtin or extension)
- **model** — model identifier (defaults to `anthropic/claude-sonnet-4-6`)

The markdown body becomes the agent's system prompt.

### 2. Register agents via `globalThis.__pi_subagents`

Pi loads extensions via jiti, which creates separate module instances. Direct imports from the subagents extension will reference a different `agents` array than the one the `subagent` tool uses. Use the `globalThis` bridge instead:

```typescript
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  model: string;
  systemPrompt: string;
  filePath: string;
}

const AGENTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "agents");

function registerMyAgents(): void {
  const subagents = (globalThis as any).__pi_subagents as
    | { registerAgent: (config: AgentConfig) => void; unregisterAgent: (name: string) => void }
    | undefined;
  if (!subagents) return; // subagents extension not loaded

  for (const entry of fs.readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(AGENTS_DIR, entry);
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name) continue;

    const tools = (frontmatter.tools || "").split(",").map(t => t.trim()).filter(Boolean);
    try {
      subagents.registerAgent({
        name: frontmatter.name,
        description: frontmatter.description || "",
        tools,
        model: frontmatter.model || "anthropic/claude-sonnet-4-6",
        systemPrompt: body,
        filePath,
      });
    } catch {
      // Already registered — skip
    }
  }
}
```

Call `registerMyAgents()` when your extension activates (e.g. in a command handler). The agents become available to the `subagent` tool immediately.

### 3. Adding custom tool support

If your agents need tools beyond the built-in set, those tools must be mapped in the `CUSTOM_TOOL_EXTENSIONS` record in `subagents/index.ts`:

```typescript
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
  web_search:  path.join(EXT_BASE, "web-search",  "index.ts"),
  web_fetch:   path.join(EXT_BASE, "web-fetch",   "index.ts"),
  safe_bash:   path.join(TOOLS_DIR, "safe-bash.ts"),
  ast_grep:    path.join(TOOLS_DIR, "ast-grep.ts"),
  repo_map:    path.join(TOOLS_DIR, "repo-map.ts"),
  workspace:   path.join(TOOLS_DIR, "workspace.ts"),
};
```

Built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) work automatically. Any other tool the agent lists in its frontmatter must have a corresponding entry here pointing to the extension's `index.ts` or tool file.

## Structure

```
subagents/
├── index.ts           # Extension entry point
├── config.json        # Configuration (maxConcurrency: 4)
├── agents/            # Agent configs (frontmatter + system prompt)
│   ├── scout.md
│   ├── researcher.md
│   ├── planner.md
│   ├── worker.md
│   ├── tester.md
│   ├── debugger.md
│   ├── security-auditor.md
│   ├── code-reviewer.md
│   ├── doc-writer.md
│   └── refactorer.md
└── tools/             # Custom tool extensions loaded into subagent processes
    ├── safe-bash.ts   # bash with dangerous command blocking
    ├── ast-grep.ts    # AST-based structural search (tree-sitter)
    ├── repo-map.ts    # compact codebase map (~2K tokens)
    └── workspace.ts   # shared inter-agent blackboard
```
