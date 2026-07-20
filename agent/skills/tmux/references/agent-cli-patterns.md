# Agent CLI launch recipes

Concrete recipes for what to `Write` into `run/<name>.sh` before calling
`launch_agent.sh`. In every case:

1. Author the script via the `Write` tool into
   `~/.claude/skills/tmux/run/cc-<label>-<something>.sh`
   (use `lib.sh`'s `new_payload_path <label>` to get a fresh path, or let
   `launch_agent.sh`/`run_command.sh` validate whatever path you chose).
2. The script's own content redirects the agent CLI's stdout/stderr to a
   logfile under `~/.claude/skills/tmux/logs/` — this is a convention, not
   something `launch_agent.sh` parses out of the script for you. Pass
   `--logfile <path>` to `launch_agent.sh` to have that path recorded in the
   registry so `status.sh` / a later `Read` can find it.
3. Call `launch_agent.sh <session> <label> <script_path> --logfile <logpath>`.

## `claude -p` (non-interactive) — preferred for anything Claude itself drives

Best fit for `launch_agent.sh`: runs to completion, writes output to a file,
exits. No TTY interaction needed, so Claude can poll the logfile (`Read`) or
`pane.sh capture` to check progress/results without needing to type anything.

`run/cc-agent1-XXXX.sh`:
```sh
#!/usr/bin/env bash
set -uo pipefail
LOG=~/.claude/skills/tmux/logs/agent1-$(date +%s).log
cd /path/to/distinct/working/dir || exit 1
claude -p "Investigate the failing test in tests/foo_test.py and propose a fix. Do not commit." \
  2>&1 | tee "$LOG"
echo "EXIT_CODE=${PIPESTATUS[0]}" >> "$LOG"
```

**Use `2>&1 | tee "$LOG"`, not `> "$LOG" 2>&1`.** Plain redirection sends
every byte straight to the logfile and leaves the pane showing nothing at
all — someone attaching with `tmux attach` (or `pane.sh capture`) sees a
blank pane the whole time, even mid-run. `tee` duplicates the stream to both
the pane (so a human watching live sees real progress) and the logfile (so
`Read`/durable lookup still works). Combined with `session.sh new` setting
`remain-on-exit on` for the session, the pane also stays visible with its
final output after the command exits instead of tmux closing the window the
instant the process ends.

Then:
```sh
launch_agent.sh cc-mysession agent1 ~/.claude/skills/tmux/run/cc-agent1-XXXX.sh \
  --logfile ~/.claude/skills/tmux/logs/agent1-<ts>.log
```

Notes:
- Give the spawned agent a **distinct working directory** (`cd` in the
  script) when it runs alongside your own concurrent edits — two agents (or
  an agent and your own main-loop edits) touching the same files at the same
  time is a real conflict risk since each has its own real tool access.
- Add `--dangerously-skip-permissions` or other flags only if you understand
  the trust implications; prefer the default sandboxing behavior.
- `echo "EXIT_CODE=$?"` (or similar) at the end of the logfile gives a cheap
  way to detect completion by tailing/reading the log, without needing to
  poll `pane_current_command`.

## `claude` interactive mode — only if a human will attach and type

Only launch plain interactive `claude` (no `-p`) into a pane if the user
intends to attach to that pane themselves and drive it. Claude itself has no
way to type into an interactive prompt running in another pane beyond
`run_command.sh`'s single "run this one command" send-keys, so interactive
mode is a poor fit for anything Claude needs to drive or check on
autonomously — prefer `-p` mode for that.

```sh
launch_agent.sh cc-mysession watch-shell ~/.claude/skills/tmux/run/cc-shell-XXXX.sh
```
where the script just `exec`s a shell or the bare `claude` command, and the
human attaches with `tmux attach -t cc-mysession`.

## `aider`

Aider is normally interactive (confirms edits) — for unattended runs use its
non-interactive/yes flags and point it at a specific set of files.

```sh
#!/usr/bin/env bash
set -uo pipefail
LOG=~/.claude/skills/tmux/logs/aider-$(date +%s).log
cd /path/to/distinct/working/dir || exit 1
aider --yes --no-auto-commits --message "Fix the null pointer in src/parser.rs" src/parser.rs \
  2>&1 | tee "$LOG"
echo "EXIT_CODE=${PIPESTATUS[0]}" >> "$LOG"
```

`--yes` avoids interactive confirmation prompts; still review its diff/commit
behavior for your aider version before relying on it unattended.

## `codex`

Codex CLI's non-interactive invocation varies by version/provider — check
`codex --help` for the current flag (commonly an `exec`/non-interactive
subcommand or a `--quiet`/`--full-auto`-style flag) before assuming the exact
syntax; the shape of the recipe is identical to the above:

```sh
#!/usr/bin/env bash
set -uo pipefail
LOG=~/.claude/skills/tmux/logs/codex-$(date +%s).log
cd /path/to/distinct/working/dir || exit 1
codex exec "Refactor the retry logic in src/retry.py" \
  2>&1 | tee "$LOG"
echo "EXIT_CODE=${PIPESTATUS[0]}" >> "$LOG"
```

## Reading results back

- **On-screen-now, quick glance**: `pane.sh capture -t <pane_id>` — shows
  whatever's currently rendered in that pane (bounded by terminal
  height/scrollback requested).
- **Durable / full history**: `Read` the logfile path you passed via
  `--logfile`. This is the reliable way to get the entire output of a
  finished (or long-running) agent process, since panes can be resized/
  scrolled and captured text has line-wrapping artifacts.
