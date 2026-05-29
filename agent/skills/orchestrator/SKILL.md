---
name: orchestrator
description: Top-level session orchestration rules — subagent routing, context hygiene, and implementation discipline. Not intended for subagents.
---

# Session Orchestration

## Hard Rule: Delegate First, Always

At depth 0 you have two action tools: `subagent` and `ask_user_question`, plus the read-only KB tools `ctx_search` and `ctx_stats`.
Every other tool is BLOCKED. Do not attempt them — they will fail and waste a turn.
Your FIRST action on every user turn is one of:

- `subagent({ agent, task })` — for any read, write, search, fetch, run, test
- `ask_user_question` — only when requirements are genuinely ambiguous

Use `ctx_search` and `ctx_stats` only as supporting read-only tools, not as substitutes for the delegate-first rule.

| User intent | First action |
|---|---|
| read / look at file / grep / find | `subagent({ agent: "scout", task: ... })` |
| web docs / API reference | `subagent({ agent: "researcher", ... })` |
| write / edit / create source logic | test suitability assessment → `subagent({ agent: "tester", ... })` (or `sugar-tester`) for RED first; if legacy exemption applies, ask user or log bypass, then `worker` |
| write / edit / create docs, config, styles, or tests | `subagent({ agent: "worker", ... })` |
| delete / run / other implementation tasks | `subagent({ agent: "worker", ... })` |
| run or write tests | `subagent({ agent: "tester", ... })` (or `sugar-tester` for SugarCRM) |
| non-trivial design before code | `subagent({ agent: "planner", ... })` |

> **Delegation is enforced by the `delegation-enforcer` extension.** Use `/delegation` to toggle bypass, `/direct` for a single-use pass-through.

## Agent Selection

**Default: parallel dispatch.** When ≥2 independent subtasks exist, use `subagent({ tasks: [...] })`. Sequential is the exception.
Example: `subagent({ tasks: [{ agent: "scout", task: "..." }, { agent: "researcher", task: "..." }] })`

| Task signal | Agent |
|---|---|
| Understand code, find definitions, trace usage, check file structure | scout |
| Multiple independent areas to investigate | parallel scouts |
| API docs, library behavior, migration guides, external knowledge | researcher |
| Create/edit/delete files, run commands, install packages | worker |
| Non-trivial code change requiring design decisions | planner → worker |
| SugarCRM tests (PHPUnit, bns curl, bns run-batch) | sugar-tester |
| Non-Sugar test creation/validation | tester |
| Review git diff, validate code quality | codereviewer |
| Error analysis, test failure, stack trace | debugger |
| Security scan, vulnerability check | security-auditor |
| Validate a plan before execution | critic |
| Ambiguous or unclear request | ask_user_question |

For pipeline details (Planner→Critic→Worker, TDD loop, escalation protocols) see `SKILL_REFERENCE.md`.

## Delegation Rules

**Give goals, not instructions.** Agents know their tools — let them choose.

1. **Describe WHAT, not HOW** — "find where auth middleware validates tokens", not "run grep -rn auth src/"
2. **Never specify tools** — don't say "use grep", "use ctx_batch_execute". The agent decides.
3. **Never write commands** — no shell commands, code snippets, or step-by-step procedures in task descriptions.
4. **Provide context, not steps** — share what you know, what you need, and why.
5. **One goal per delegation** — don't bundle find + check + fix. Split into focused tasks.
6. **Trust agent output** — don't prescribe output format unless a downstream consumer needs a specific shape.

**Good**: "Find all references to the distiller agent across the pi configuration"
**Bad**: "Run `grep -rn 'distiller' /home/rabeta/.pi/` and give me every file and line number"

## TDD (Default Development Flow)

**Scope**: Features and bug fixes that change source logic use TDD by default.

**Step 0 — Test Suitability Assessment**:
- Detect existing test infrastructure/config first.
- If the target change has a practical test path, proceed with normal TDD.
- If the target is tightly coupled legacy code and adding a meaningful test would require broad unrelated refactoring, risky seam creation, or heavy environment setup, treat it as a **Legacy Code Exemption** case.

SugarCRM project → **sugar-tester** | Everything else → **tester**

Flow when suitable: existing suite check → tester writes failing tests (RED) → worker implements (GREEN) → tester verifies → if FAIL: worker fixes (max 2 retries)

**Bypass**:
- User says "skip tests", "spike", "prototype", or "no tests" → go straight to worker.
- **Legacy Code Exemption**: if no practical test path exists for the targeted legacy code, do not force TDD. Ask the user to confirm the bypass when interactive; otherwise log the reason and proceed with worker using the smallest safe change.
