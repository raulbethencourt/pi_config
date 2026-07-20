---
name: skill-creator
description: Scaffolds a new pi skill (SKILL.md frontmatter, name validation, collision check, minimal body skeleton) so future skills are added correctly and consistently. Trigger on requests like "create a skill", "make a new skill", "scaffold a skill", "add a skill for X", "how do I add a skill", "set up a SKILL.md".
allowed-tools: read, write, grep
---

# Skill Creator

## Scope

This skill is **on-demand only**. It is invoked when the user wants to
create/add/scaffold a new pi skill under `agent/skills/`. It does not run
automatically in the background and is not a hook — if nothing in the
request asks for a new skill, don't reach for it.

## Step 1 — Validate name and check for collisions (do this before anything else)

Fail fast. Do not move to Step 2 until both checks below pass.

**Name rules** (pi's Agent Skills spec, `docs/skills.md` in the
`@earendil-works/pi-coding-agent` package):
- 1-64 characters
- Lowercase letters `a-z`, digits `0-9`, and hyphens only
- No leading or trailing hyphen
- No consecutive hyphens (`--`)
- Regex: `^[a-z0-9]+(-[a-z0-9]+)*$`

Reject any proposed name that fails this pattern and ask for a corrected
name before proceeding.

**Collision check**: pi allows a skill's `name:` frontmatter field to
differ from its parent directory name, so a directory-name-only check is
not sufficient. Scan the `name:` field across every existing skill instead:

```bash
grep -rn '^name:' agent/skills/*/SKILL.md
```

Compare the proposed name against every value returned. If any match is
found, **stop immediately** and report the exact conflicting file path
(e.g. `agent/skills/tmux/SKILL.md`) to the user. Do not proceed and do not
auto-rename — a collision means the user needs to pick a different name or
confirm they mean to edit the existing skill instead.

Only continue to Step 2 once the name passes the regex above AND no
`name:` collision was found.

## Step 2 — Clarify intent

Once Step 1 passes, gather (ask the user if not already given):

1. **What the skill does** — the concrete capability/workflow it packages.
2. **What user phrasing should trigger it** — concrete example requests,
   not a vague summary (see "Description quality" below). This becomes
   the `description` frontmatter field.
3. **Which tools it needs** — this determines the `allowed-tools` value
   (see below). Only list tools the skill's instructions actually call for.
4. **Whether it should be preloaded into a specific subagent's context** —
   i.e. does one particular persona (`worker`, `code-reviewer`, etc.) need
   this skill available by default, or is it fine for it to load only via
   pi's own on-demand discovery? This determines whether the "Post-creation
   checklist" below needs its optional `skills:` frontmatter step applied.

## Frontmatter reference

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | Max 64 chars. Lowercase `a-z`/`0-9`/hyphens. See Step 1 rules. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it — this is the only signal pi uses to auto-trigger the skill. |
| `license` | No | License name or reference to a bundled license file. Documented by the framework; not currently used by any skill in this repo. |
| `compatibility` | No | Max 500 chars, environment requirements. Documented by the framework; not currently used by any skill in this repo. |
| `metadata` | No | Arbitrary key-value mapping. Documented by the framework; not currently used by any skill in this repo. |
| `allowed-tools` | No | Space- or comma-delimited list of pre-approved tools (experimental). The only optional field with real precedent in this codebase today — see `agent/skills/tmux/SKILL.md`. |
| `disable-model-invocation` | No | When `true`, hides the skill from the system prompt; users must invoke it explicitly via `/skill:name`. Documented by the framework; not currently used by any skill in this repo. |

Further reading: `docs/skills.md` inside the `@earendil-works/pi-coding-agent`
npm package (no local copy of that file exists in this repo — it ships with
the pi CLI package itself).

## Description quality guidance

The `description` field is the *only* signal pi uses to decide whether to
auto-load a skill for a given request. Vague descriptions mean the skill
silently never triggers.

**Good** (specific capability + concrete trigger phrases):
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Trigger on requests like "extract text from this PDF", "fill out this PDF form", "merge these PDFs into one".
```

**Poor** (vague, no concrete trigger phrasing):
```yaml
description: Helps with PDFs.
```

Write the new skill's `description` in the same style as the "Good"
example above — name the capability, then list a few literal phrases a
user would actually type.

## Scaffolding step

Create `agent/skills/<name>/SKILL.md` with:
- The validated frontmatter from Steps 1-2 (`name`, `description`, and
  `allowed-tools` only if the skill actually needs pre-approved tools).
- A minimal body skeleton: a title, a `## Scope` section stating whether
  it's on-demand or otherwise, and a `## Usage` section with the concrete
  steps/commands the skill provides.

Only add `scripts/`, `references/`, or `assets/` subdirectories if the new
skill genuinely needs bundled helper scripts or reference docs it will
`read` or execute — don't create empty boilerplate directories.

## Post-creation checklist

This checklist applies to a **real skill being kept** — not to a dry-run
or throwaway validation pass through Step 1.

- Always add one bullet for the new skill to this repo's `README.md`,
  under the "Skills (Triggered On-Demand)" section, alphabetically ordered
  by skill name, matching the style of the existing bullets there.
- Only if the skill should be preloaded into a specific subagent's
  context (per Step 2, question 4): append the skill's name to that
  persona's `skills:` frontmatter field in
  `agent/extensions/subagents/agents/<agent>.md`.
- `agent/skills/orchestrator/SKILL.md`, `agent/extensions/subagents/routing.json`,
  and delegation-enforcer's `AVAILABLE_AGENTS` list do **not** need to be
  touched for a new skill — those are subagent-dispatch mechanisms,
  unrelated to pi's own skill auto-discovery.
- No automated test in `agent/tests/` currently enforces skill-registry/
  disk sync, so this checklist is the only safety net for keeping the
  README and the on-disk skills in agreement — be thorough rather than
  skipping steps because "nothing will catch it."

## Validate

Before finishing:
1. Re-check the new skill's `name` against the Step 1 regex and length
   limit, and its `description` against the 1024-character limit and the
   "Description quality guidance" above.
2. Suggest running pi's `/reload` and confirming no load warning appears
   for the new skill (a warning here usually means a frontmatter rule from
   this file was violated).
