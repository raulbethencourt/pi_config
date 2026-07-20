# tmux 3.6b cheatsheet (as used by this skill's scripts)

Compact reference for the exact flags and format strings the `scripts/*.sh`
wrappers rely on. This is the "why does the script say that" reference —
read `SKILL.md` first for the decision tree.

## The `-P -F` print-on-create pattern

Every creation command below supports `-P` (print information after the
command) combined with `-F '<format>'` (custom format string) to return the
stable identifier of whatever was just created, instead of nothing. This
skill's scripts always capture that output rather than guessing IDs.

```sh
tmux new-session   -d -s cc-foo -P -F '#{session_name}'
tmux new-window    -t cc-foo -n build -P -F '#{window_id}'
tmux split-window  -t cc-foo -p 30 -P -F '#{pane_id}'
```

## Sessions

```sh
tmux new-session -d -s cc-foo [-c <start-dir>] -P -F '#{session_name}'
tmux has-session -t cc-foo                     # exit 0 iff it exists
tmux list-sessions -F '#{session_name} #{session_windows} #{session_created}'
tmux kill-session -t cc-foo
```

- `-d`: don't attach, just create detached (essential for scripted use).
- `has-session` is the correct existence check — cheaper and side-effect-free
  compared to grepping `list-sessions`.

## Windows

Always address by `#{window_id}` (stable, like `@3`), never by positional
index (`session:2`), since indices shift as windows are created/killed.

```sh
tmux new-window -t cc-foo -n build [-c <dir>] -P -F '#{window_id}'
tmux list-windows -t cc-foo -F '#{window_id} #{window_index} #{window_name} #{window_panes} #{window_active}'
tmux rename-window -t @3 new-name
tmux kill-window -t @3
```

## Panes

Always address by `#{pane_id}` (stable, like `%7`).

```sh
tmux split-window -h -p 30 -t @3 [-c <dir>] -P -F '#{pane_id}'
# -h  = split left/right (new pane to the right)
# -v  = split top/bottom (new pane below)
# -p N = new pane gets N percent of the space

tmux list-panes -t @3 -F '#{pane_id} #{pane_index} #{pane_current_command} #{pane_width}x#{pane_height} #{pane_active} #{pane_pid} #{pane_current_path}'
tmux list-panes -a -F '#{pane_id}'   # ALL panes across ALL sessions — used for liveness checks

tmux kill-pane -t %7
```

### Resize

```sh
tmux resize-pane -t %7 -D 5     # move border Down (shrink from top) by 5 cells
tmux resize-pane -t %7 -U 5     # Up
tmux resize-pane -t %7 -L 5     # Left
tmux resize-pane -t %7 -R 5     # Right
tmux resize-pane -t %7 -x 120 -y 40   # absolute size: 120 cols x 40 rows
```

### Capture (on-screen-now output)

```sh
tmux capture-pane -p -t %7               # just the visible screen
tmux capture-pane -p -t %7 -S -200       # include 200 lines of scrollback
```

- `-p`: print to stdout instead of a tmux paste buffer (what scripts want).
- `-S <start-line>`: negative numbers reach into scrollback history;
  `-N` in the task spec is shorthand for "N lines back" i.e. `-S -N`.
- This is a synchronous, short read of what's currently rendered — not a
  substitute for reading an agent's full logfile (see `agent-cli-patterns.md`).

## Sending input to an existing pane

```sh
tmux send-keys -t %7 "bash /path/to/script.sh" Enter
```

Only ever interpolate a file PATH here (defensively quoted via `printf %q`),
never raw command text — see `run_command.sh`.

## Launching straight into a new pane/window (no send-keys)

```sh
tmux new-window -t cc-foo -n agent1 -P -F '#{pane_id}' -- bash /path/to/script.sh
```

The `--` followed by an argv vector is tmux's own exec, not shell text typed
into the pane — immune to quoting bugs. This is what `launch_agent.sh` uses.

## Server-existence guard

`tmux list-sessions` (or almost any tmux command) fails with a raw
`error connecting to ... (No such file or directory)`-style message if no
tmux server is currently running at all. This skill's `lib.sh` wraps that in
`require_tmux_server`, which gives a clear actionable message instead of
letting the raw stderr leak through.
