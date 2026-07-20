#!/usr/bin/env bash
# lib.sh — shared helpers for the tmux orchestration skill.
# Source this from every other script:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#
# Locking model:
#   - LOCK FILE: state/registry.lock, held via flock on fd 200.
#   - registry_add / registry_update_by_id / registry_remove_by_id / registry_list
#     are SELF-CONTAINED single-operation helpers: each acquires the lock,
#     does one read-modify-write, and releases it. They are NOT reentrant —
#     do not call one of these from inside an already-held lock (self-deadlock).
#   - For multi-step transactions (e.g. launch_agent.sh's "check cap, then
#     reserve" critical section) hold the lock yourself and use the low-level
#     registry_read_raw / registry_write_raw pair instead, e.g.:
#       exec 200>"$(_cc_tmux_lock_file)"
#       flock -x 200
#       content=$(registry_read_raw)
#       ... decide ...
#       registry_write_raw "$content"
#       flock -u 200; exec 200>&-
set -uo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

tmux_skill_root() {
  # Resolves to ~/.claude/skills/tmux regardless of caller cwd.
  # Uses BASH_SOURCE of THIS file (lib.sh lives in scripts/), so it is stable
  # no matter which directory the invoking script was launched from.
  ( cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd )
}

_cc_tmux_registry_file() { printf '%s/state/registry.json' "$(tmux_skill_root)"; }
_cc_tmux_lock_file()     { printf '%s/state/registry.lock'  "$(tmux_skill_root)"; }
_cc_tmux_run_dir()       { printf '%s/run'   "$(tmux_skill_root)"; }
_cc_tmux_logs_dir()      { printf '%s/logs'  "$(tmux_skill_root)"; }

ensure_dirs() {
  local root; root=$(tmux_skill_root)
  mkdir -p "$root/state" "$root/run" "$root/logs"
  local reg; reg=$(_cc_tmux_registry_file)
  if [[ ! -f "$reg" ]]; then
    printf '{"entries": []}\n' > "$reg"
  fi
}

# ---------------------------------------------------------------------------
# tmux availability guards
# ---------------------------------------------------------------------------

require_tmux_binary() {
  if ! command -v tmux >/dev/null 2>&1; then
    echo "ERROR: tmux is not installed or not on PATH." >&2
    return 1
  fi
}

require_tmux_server() {
  require_tmux_binary || return 1
  if ! tmux list-sessions >/dev/null 2>&1; then
    echo "ERROR: no tmux server running — start one with 'session.sh new <slug>' first." >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------
# in-tmux introspection
# ---------------------------------------------------------------------------

# in_tmux: true if the CURRENT shell is itself running inside a tmux pane.
# Scripts can use this (together with current_pane_id) to treat "the pane the
# user is already in" as a natural split target instead of always requiring
# an explicit -t argument / new session.
in_tmux() {
  [[ -n "${TMUX:-}" ]]
}

current_pane_id() {
  printf '%s' "${TMUX_PANE:-}"
}

# ---------------------------------------------------------------------------
# Naming convention
# ---------------------------------------------------------------------------

require_cc_prefix() {
  local name="${1:?require_cc_prefix: name required}"
  if [[ "$name" == cc-* ]]; then
    printf '%s' "$name"
  else
    printf 'cc-%s' "$name"
  fi
}

# ---------------------------------------------------------------------------
# Registry locking primitives
# ---------------------------------------------------------------------------

# with_registry_lock <cmd> [args...]
# Runs "$@" as a command/function with an exclusive lock on the registry
# held for the duration. NOT reentrant — see header comment.
with_registry_lock() {
  ensure_dirs
  (
    flock -x 200
    "$@"
  ) 200>"$(_cc_tmux_lock_file)"
}

# registry_read_raw: print the full registry JSON. Caller must already hold
# the lock (either via with_registry_lock, or a manually-held flock fd 200).
registry_read_raw() {
  ensure_dirs
  cat "$(_cc_tmux_registry_file)"
}

# registry_write_raw <json>: atomically replace the registry contents.
# Caller must already hold the lock.
registry_write_raw() {
  local content="$1"
  local reg; reg=$(_cc_tmux_registry_file)
  local tmp
  tmp=$(mktemp "${reg}.XXXXXX")
  printf '%s' "$content" > "$tmp"
  mv "$tmp" "$reg"
}

# ---------------------------------------------------------------------------
# Registry single-operation helpers (self-contained locking)
# ---------------------------------------------------------------------------

_registry_add_impl() {
  local entry_json="$1"
  local content; content=$(registry_read_raw)
  content=$(jq --argjson entry "$entry_json" '.entries += [$entry]' <<<"$content")
  registry_write_raw "$content"
}
registry_add() {
  local entry_json="${1:?registry_add: json object required}"
  with_registry_lock _registry_add_impl "$entry_json"
}

_registry_update_impl() {
  local entry_id="$1" patch_json="$2"
  local content; content=$(registry_read_raw)
  content=$(jq --arg id "$entry_id" --argjson patch "$patch_json" \
    '.entries |= map(if .entry_id == $id then . + $patch else . end)' <<<"$content")
  registry_write_raw "$content"
}
registry_update_by_id() {
  local entry_id="${1:?registry_update_by_id: entry_id required}"
  local patch_json="${2:?registry_update_by_id: json patch required}"
  with_registry_lock _registry_update_impl "$entry_id" "$patch_json"
}

_registry_remove_impl() {
  local entry_id="$1"
  local content; content=$(registry_read_raw)
  content=$(jq --arg id "$entry_id" '.entries |= map(select(.entry_id != $id))' <<<"$content")
  registry_write_raw "$content"
}
registry_remove_by_id() {
  local entry_id="${1:?registry_remove_by_id: entry_id required}"
  with_registry_lock _registry_remove_impl "$entry_id"
}

# registry_remove_by_session <session_name>: prune every entry that
# references a given session (used by session.sh kill).
_registry_remove_by_session_impl() {
  local session="$1"
  local content; content=$(registry_read_raw)
  content=$(jq --arg s "$session" \
    '.entries |= map(select((.session // "") != $s))' <<<"$content")
  registry_write_raw "$content"
}
registry_remove_by_session() {
  local session="${1:?registry_remove_by_session: session required}"
  with_registry_lock _registry_remove_by_session_impl "$session"
}

_registry_remove_by_window_impl() {
  local window_id="$1"
  local content; content=$(registry_read_raw)
  content=$(jq --arg w "$window_id" \
    '.entries |= map(select((.window_id // "") != $w))' <<<"$content")
  registry_write_raw "$content"
}
registry_remove_by_window() {
  local window_id="${1:?registry_remove_by_window: window_id required}"
  with_registry_lock _registry_remove_by_window_impl "$window_id"
}

_registry_remove_by_pane_impl() {
  local pane_id="$1"
  local content; content=$(registry_read_raw)
  content=$(jq --arg p "$pane_id" \
    '.entries |= map(select((.pane_id // "") != $p))' <<<"$content")
  registry_write_raw "$content"
}
registry_remove_by_pane() {
  local pane_id="${1:?registry_remove_by_pane: pane_id required}"
  with_registry_lock _registry_remove_by_pane_impl "$pane_id"
}

registry_list() {
  with_registry_lock registry_read_raw
}

# ---------------------------------------------------------------------------
# Agent liveness / concurrency cap
# ---------------------------------------------------------------------------

# _agent_live_count_from_json <registry_json>: computes the live-agent count
# from an already-read registry snapshot, without touching the lock. Used
# both by count_live_agents (which acquires its own lock) and by callers
# that already hold the lock (e.g. launch_agent.sh's reservation step).
#
# Counts entries with kind=="agent" and status in {"starting","running"}:
#   - "starting" entries (registry reservation written BEFORE the tmux pane
#     exists) count UNCONDITIONALLY — they have no pane_id yet, so they
#     can't be checked against `tmux list-panes`, and treating them as
#     not-yet-counted would let concurrent launch_agent.sh invocations each
#     see an under-cap live_count and all race past CC_TMUX_MAX_AGENTS.
#   - "running" entries only count if their pane_id is still present in
#     `tmux list-panes -a` (self-healing: dead panes don't count).
_agent_live_count_from_json() {
  local content="$1"
  local live_panes
  live_panes=$(tmux list-panes -a -F '#{pane_id}' 2>/dev/null || true)
  local entries count=0
  entries=$(jq -c '.entries[] | select(.kind=="agent" and (.status=="starting" or .status=="running"))' <<<"$content")
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    local status pid
    status=$(jq -r '.status' <<<"$entry")
    if [[ "$status" == "starting" ]]; then
      count=$((count + 1))
      continue
    fi
    pid=$(jq -r '.pane_id // empty' <<<"$entry")
    if [[ -n "$pid" ]] && grep -qxF "$pid" <<<"$live_panes"; then
      count=$((count + 1))
    fi
  done <<<"$entries"
  echo "$count"
}

# _agent_live_entries_from_json <registry_json>: prints the live agent
# entries themselves (one JSON object per line) for display purposes.
# Same "starting" (unconditional) vs "running" (pane-liveness-checked) rule
# as _agent_live_count_from_json above.
_agent_live_entries_from_json() {
  local content="$1"
  local live_panes
  live_panes=$(tmux list-panes -a -F '#{pane_id}' 2>/dev/null || true)
  jq -c '.entries[] | select(.kind=="agent" and (.status=="starting" or .status=="running"))' <<<"$content" \
    | while IFS= read -r entry; do
        local status pid
        status=$(jq -r '.status' <<<"$entry")
        if [[ "$status" == "starting" ]]; then
          printf '%s\n' "$entry"
          continue
        fi
        pid=$(jq -r '.pane_id // empty' <<<"$entry")
        [[ -n "$pid" ]] || continue
        if grep -qxF "$pid" <<<"$live_panes"; then
          printf '%s\n' "$entry"
        fi
      done
}

# count_live_agents: number of registry entries with kind=="agent" and
# status=="running" whose pane_id is still present in `tmux list-panes -a`.
# Self-healing: entries whose pane no longer exists simply don't count.
# Acquires its own lock for a consistent snapshot — do not call this from
# inside an already-held lock (use _agent_live_count_from_json instead).
count_live_agents() {
  if ! require_tmux_server >/dev/null 2>&1; then
    echo 0
    return 0
  fi
  local content
  content=$(registry_list)
  _agent_live_count_from_json "$content"
}

# ---------------------------------------------------------------------------
# Payload script paths
# ---------------------------------------------------------------------------

# new_payload_path <label>: returns a fresh, unused path under run/ for the
# caller to Write a script into. Does not create the file itself.
new_payload_path() {
  local label="${1:?new_payload_path: label required}"
  local root; root=$(tmux_skill_root)
  local safe_label
  safe_label=$(printf '%s' "$label" | tr -c 'a-zA-Z0-9_-' '-')
  local candidate
  while :; do
    candidate="$root/run/cc-${safe_label}-$$-${RANDOM}.sh"
    [[ -e "$candidate" ]] || break
  done
  printf '%s' "$candidate"
}

# ---------------------------------------------------------------------------
# Window grouping — panes for related agents, one window per logical group
# ---------------------------------------------------------------------------
#
# A "group" is a set of agents that belong together conceptually (e.g. a
# scout -> planner -> critic pipeline) and should share ONE tmux window as
# side-by-side/stacked panes, rather than each getting its own window. Groups
# are tracked in the registry as kind=="window-group" entries keyed by
# (session, group). Pane order/count for rebalancing is always read live from
# tmux (`list-panes`), not cached in the registry, so it self-heals if a pane
# was closed manually.

# find_group_window <session> <group>: prints the window_id already tracked
# for this (session, group) pair IF it's still alive in live tmux state,
# otherwise prints nothing. Read-only — does not acquire the registry lock
# itself (call this from inside a critical section you already hold, or
# accept the tiny race of a concurrent group-window creation, which the
# caller's own lock in launch_agent.sh closes).
find_group_window() {
  local session="${1:?find_group_window: session required}"
  local group="${2:?find_group_window: group required}"
  local content; content=$(registry_read_raw)
  local window_id
  window_id=$(jq -r --arg s "$session" --arg g "$group" \
    '.entries[] | select(.kind=="window-group" and .session==$s and .group==$g) | .window_id' \
    <<<"$content" | tail -1)
  [[ -n "$window_id" ]] || return 0
  if tmux list-windows -t "$session" -F '#{window_id}' 2>/dev/null | grep -qxF "$window_id"; then
    printf '%s' "$window_id"
  fi
}

# find_reusable_idle_window <session>: if the session currently has EXACTLY
# one window with EXACTLY one pane, and that pane is just an idle shell
# (bash/zsh/sh/fish, nothing else running), prints "<window_id> <pane_id>"
# so the caller can repurpose it instead of leaving it as an unused window
# sitting next to a newly-created one (e.g. session.sh new's default window,
# never touched since). Prints nothing if no such window exists — callers
# must fall back to creating a new window in that case.
find_reusable_idle_window() {
  local session="${1:?find_reusable_idle_window: session required}"
  local windows; windows=$(tmux list-windows -t "$session" -F '#{window_id} #{window_panes}' 2>/dev/null)
  [[ -z "$windows" ]] && return 0
  [[ "$(wc -l <<<"$windows")" -eq 1 ]] || return 0
  local window_id panes
  read -r window_id panes <<<"$windows"
  [[ "$panes" == "1" ]] || return 0
  local pane_id cmd
  read -r pane_id cmd <<<"$(tmux list-panes -t "$window_id" -F '#{pane_id} #{pane_current_command}' 2>/dev/null)"
  case "$cmd" in
    bash|zsh|sh|-bash|-zsh|-sh|fish) printf '%s %s' "$window_id" "$pane_id" ;;
  esac
}

# rebalance_window_panes <window_id>: arrange every pane in the window into
# tmux's built-in "tiled" layout -- a grid as close to square as possible
# (2x2 for 4 panes, 2 cols x 2 rows for 3, etc.), rather than one long
# vertical stack. This is tmux's own layout algorithm, not hand-rolled
# resize-pane math, so it correctly handles any pane count.
rebalance_window_panes() {
  local window_id="${1:?rebalance_window_panes: window_id required}"
  tmux select-layout -t "$window_id" tiled 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Misc id helper
# ---------------------------------------------------------------------------

new_entry_id() {
  printf 'e-%(%s)T-%s-%s' -1 "$$" "$RANDOM"
}

now_iso() {
  date -u +'%Y-%m-%dT%H:%M:%SZ'
}
