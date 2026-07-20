#!/usr/bin/env bash
# session.sh — manage cc- prefixed tmux sessions.
#
# Usage:
#   session.sh new <slug> [--dir <path>]
#   session.sh list
#   session.sh kill <name>
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat >&2 <<'EOF'
usage:
  session.sh new <slug> [--dir <path>]
  session.sh list
  session.sh kill <name>
EOF
}

cmd_new() {
  local slug="" dir=""
  slug="${1:-}"; shift || true
  if [[ -z "$slug" ]]; then
    echo "ERROR: session.sh new requires <slug>" >&2
    usage
    return 1
  fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir) dir="${2:?--dir requires a path}"; shift 2 ;;
      *) echo "ERROR: unknown argument '$1'" >&2; usage; return 1 ;;
    esac
  done

  require_tmux_binary || return 1
  local name; name=$(require_cc_prefix "$slug")

  if tmux has-session -t "$name" 2>/dev/null; then
    echo "ERROR: session '$name' already exists — pick a different slug or use pane.sh/window.sh to add to it." >&2
    return 1
  fi

  local created
  if [[ -n "$dir" ]]; then
    created=$(tmux new-session -d -s "$name" -c "$dir" -P -F '#{session_name}') || {
      echo "ERROR: failed to create tmux session '$name'" >&2
      return 1
    }
  else
    created=$(tmux new-session -d -s "$name" -P -F '#{session_name}') || {
      echo "ERROR: failed to create tmux session '$name'" >&2
      return 1
    }
  fi

  # Keep windows/panes visible after their command exits instead of tmux
  # auto-closing them the instant the process finishes — otherwise a fast
  # script (or one whose output is redirected to a logfile) leaves nothing
  # for the user to see even seconds later.
  tmux set-option -t "$created" remain-on-exit on 2>/dev/null || true

  ensure_dirs
  local entry
  entry=$(jq -n --arg id "$(new_entry_id)" --arg kind "session" --arg name "$created" \
    --arg session "$created" --arg dir "$dir" --arg created_at "$(now_iso)" \
    '{entry_id: $id, kind: $kind, name: $name, session: $session, dir: $dir, status: "running", created_at: $created_at}')
  registry_add "$entry"

  printf '%s\n' "$created"
}

cmd_list() {
  require_tmux_binary || return 1
  if ! tmux list-sessions >/dev/null 2>&1; then
    # No tmux server at all is not an error — just nothing to list.
    return 0
  fi
  tmux list-sessions -F '#{session_name} #{session_windows} #{session_created}' 2>/dev/null \
    | awk '$1 ~ /^cc-/'
}

cmd_kill() {
  local name="${1:-}"
  if [[ -z "$name" ]]; then
    echo "ERROR: session.sh kill requires <name>" >&2
    usage
    return 1
  fi
  if [[ "$name" != cc-* ]]; then
    echo "ERROR: refusing to kill non-cc- session '$name'" >&2
    return 1
  fi
  require_tmux_server || return 1
  if ! tmux has-session -t "$name" 2>/dev/null; then
    echo "ERROR: session '$name' does not exist" >&2
    return 1
  fi
  tmux kill-session -t "$name"
  registry_remove_by_session "$name"
  echo "killed $name"
}

main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    new) cmd_new "$@" ;;
    list) cmd_list "$@" ;;
    kill) cmd_kill "$@" ;;
    *) usage; return 1 ;;
  esac
}

main "$@"
