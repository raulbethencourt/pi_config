---
name: tmux
description: On-demand tmux orchestration for pi — create/reuse cc- sessions, windows and panes, run shell commands safely inside them, and launch independent agent CLI processes (claude -p, aider, codex) into their own dedicated panes. Trigger on requests like "run this in the background", "open a new pane and check on it", "launch a parallel agent / claude -p / aider / codex process", "split my terminal", "what's running in my tmux sessions", "check on that background job". Purely invoked on demand (this skill or /tmux) — never automatic/hook-driven.
allowed-tools: bash, read, write, grep
---

# tmux orchestration skill

## Scope

This skill is **on-demand only**. It is invoked explicitly (via this skill
being loaded, or the `/tmux` slash command) when the user asks for
background/parallel execution inside tmux. It is never triggered by a hook
and never runs automatically in the background of unrelated work — if
nothing in the request asks for tmux, don't reach for it.

All state lives under `~/.pi/agent/skills/tmux/`:
- `scripts/` — the wrappers described below (all executable, all safe to
  call directly with `bash`). Source shared helpers with:
  `source ~/.pi/agent/skills/tmux/scripts/lib.sh`.
- `state/registry.json` — tracks everything this skill has created
  (sessions, windows, panes, agent launches), guarded by
  `state/registry.lock` (flock) against concurrent tool calls.
- `run/` — where you `write` the actual shell script content for
  anything that needs to execute in a pane or window. **Never pass raw
  command text to `tmux send-keys` or interpolate it into a bash call** —
  author it as a file here first, then point a wrapper or tmux command at
  the file path. This is a hard safety rule, not a style preference.
- `logs/` — where launched agent CLI processes redirect their own
  stdout/stderr, by convention (see `references/agent-cli-patterns.md`).

Read `references/tmux-cheatsheet.md` for the exact tmux flags/format-strings
used here, and `references/agent-cli-patterns.md` for ready-to-use
`claude -p` / `aider` / `codex` launch recipes. Keep this file for the
decision tree; push syntax detail to those two.

## Decision tree

**Is a tmux server already relevant?**
- Check `in_tmux` (is `$TMUX` set — i.e. is the CURRENT shell/session itself
  inside a tmux pane?) via `scripts/lib.sh`. If so, `current_pane_id` gives
  `$TMUX_PANE` — that pane can be a natural split target (e.g.
  `pane.sh split -t "$TMUX_PANE" ...`) instead of always spinning up a brand
  new session.
- To check whether any tmux server is running at all, use:
  `tmux ls 2>/dev/null`.
- If no tmux server is running, create a new session with:
  `tmux new-session -d -s cc-<slug>`.

**New session vs. reuse an existing one?**
- Reuse (`cc-<slug>`) if the work belongs to an existing logical task/project
  the user is already tracking in tmux. List sessions with `tmux ls`, or use
  registry-aware helpers sourced from `~/.pi/agent/skills/tmux/scripts/lib.sh`
  if you need the skill's tracked view.
- Create a new session (`tmux new-session -d -s cc-<slug>`) for a distinct
  task, or when none exists yet. Prefer one session per logical task, not
  one per command.

**Split pane vs. new window?**
- Default layout: always use panes within a single window, never open new windows for multi-agent tasks.
- Max 4 panes per window. If a window already has 4 panes, create a new window and continue packing panes there.
- For 2-4 agents: use a 2x2 tiled layout (tmux select-layout tiled). Apply after each pane is added.
- After every tmux split-window, the newly created pane becomes active. Always target send-keys by explicit pane address (session:window.pane) — never rely on the current active pane. Use tmux list-panes -t <session> -F '#{pane_index}: #{pane_id}' to confirm addresses before sending keys.
- Canonical 4-pane creation sequence:
  - tmux new-session -d -s cc-<slug>
  - sleep 0.5
  - tmux send-keys -t cc-<slug>:1.1 "bash <script1>" Enter
  - tmux split-window -h -t cc-<slug>:1.1
  - tmux send-keys -t cc-<slug>:1.2 "bash <script2>" Enter
  - tmux split-window -v -t cc-<slug>:1.1
  - tmux send-keys -t cc-<slug>:1.3 "bash <script3>" Enter
  - tmux split-window -v -t cc-<slug>:1.2
  - tmux send-keys -t cc-<slug>:1.4 "bash <script4>" Enter
  - tmux select-layout -t cc-<slug> tiled
- Only create a new window (tmux new-window) when pane count reaches 4.

**Reading back output?**
- On-screen-now / quick glance: `pane.sh capture -t <pane_id>` (optionally
  `--lines N` for scrollback). Synchronous, no file needed.
- Durable / full history, especially for a launched agent: `read` the
  logfile path you wrote into the authored launcher script or attached to the
  process configuration — panes wrap and scroll, logs don't.

**Running a command safely:**
- Existing pane: `write` the real command into
  `run/cc-<label>-<rand>.sh` (get a fresh path from `lib.sh`'s
  `new_payload_path <label>`), then
  `scripts/run_command.sh <pane_id> <script_path>`. This only ever
  interpolates the file PATH into `send-keys`, defensively quoted — never
  the command content itself.
- Brand-new pane in the current window: write the launch script to run/ first, split with an explicit target pane, then send keys to the new pane by its explicit session:window.pane address. Never assume the active pane is still the one you want after split-window. Confirm pane addresses with tmux list-panes -t <session> -F '#{pane_index}: #{pane_id}' before each send-keys, then apply: tmux select-layout -t <window> tiled to maintain the 2x2 square layout.
- Detached-session startup note: for tmux new-session -d flows, insert a brief wait before the first send-keys so the shell is ready. Use sleep 0.5 as the default guard.

## Naming convention

Every session and every registry-tracked identity uses the `cc-` prefix
(`cc-<slug>`). `lib.sh`'s `require_cc_prefix` normalizes/validates this.
List current tmux sessions with `tmux ls` before creating something new if
you're not sure what's already there, and after any destructive action to
confirm the result.

## Guardrails

- **Concurrency cap on agent launches**: respect `CC_TMUX_MAX_AGENTS`
  (default 3) live agent processes at a time. Before spawning a new pane for an agent CLI, check the registry count first. Max 4 panes per window — if reached, create a new window with `tmux new-window -t <session>` and pack panes there. If you're at or over cap, print the currently-live agents and call `ask_user_question` before proceeding.
- **Destructive cleanup is confirm-gated**: never kill a `cc-` session
  without explicit user confirmation first. After confirmation, use
  `tmux kill-session -t cc-<name>` for a single session, then verify the
  result with `tmux ls`.
- **Ambiguous multi-agent intent**: if a request could reasonably spawn one
  agent or several, and it's not clear which, prefer `ask_user_question`
  before creating multiple tmux windows — spawned agent CLIs get their own
  real tool access, so an unintended pile of concurrent agents is not a
  trivial mistake to walk back.
- **File-conflict risk between concurrent agents and your own edits**: a
  spawned agent (running `claude -p`, `aider`, `codex`, etc. in its own pane)
  has independent tool access and can edit files while you keep working in
  the main loop. If you're going to keep editing files yourself while an
  agent runs in parallel, give the spawned agent a distinct working
  directory/scope (`cd` to it in the authored script) rather than letting it
  loose on the same files you're actively touching.
