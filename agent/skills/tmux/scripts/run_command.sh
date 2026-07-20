#!/usr/bin/env bash
# run_command.sh — run a script (already authored via Write into run/) inside
# an EXISTING pane.
#
# Usage:
#   run_command.sh <pane_id> <script_path>
#
# Safety: never interpolates arbitrary command text into tmux send-keys.
# Only the script PATH is interpolated (defensively quoted via printf %q),
# never the command content itself. The command content lives in a file
# that was authored ahead of time via the Write tool.
#
# Contrast with launch_agent.sh, which creates a brand NEW pane/window and
# passes the script path as tmux's own trailing argv (no send-keys at all).
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  echo "usage: run_command.sh <pane_id> <script_path>" >&2
}

main() {
  local pane_id="${1:-}" script_path="${2:-}"
  if [[ -z "$pane_id" || -z "$script_path" ]]; then
    usage
    return 1
  fi

  require_tmux_server || return 1

  if [[ ! -f "$script_path" ]]; then
    echo "ERROR: script_path '$script_path' does not exist" >&2
    return 1
  fi

  local run_dir; run_dir=$(_cc_tmux_run_dir)
  local resolved
  resolved=$(cd "$(dirname "$script_path")" && pwd)/$(basename "$script_path")
  case "$resolved" in
    "$run_dir"/*) ;;
    *)
      echo "ERROR: script_path must resolve to somewhere under $run_dir (got: $resolved)" >&2
      return 1
      ;;
  esac

  if ! tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qxF "$pane_id"; then
    echo "ERROR: pane '$pane_id' does not exist" >&2
    return 1
  fi

  chmod +x "$resolved"

  tmux send-keys -t "$pane_id" "bash $(printf '%q' "$resolved")" Enter
  echo "sent to $pane_id: bash $resolved"
}

main "$@"
