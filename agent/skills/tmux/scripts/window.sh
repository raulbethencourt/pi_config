#!/usr/bin/env bash
# window.sh — manage tmux windows inside cc- sessions, addressed by stable
# @window_id (not positional index).
#
# Usage:
#   window.sh new -t <session> -n <label> [--dir <path>]
#   window.sh list -t <session>
#   window.sh rename -t <window_id> <new-name>
#   window.sh kill -t <window_id>
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat >&2 <<'EOF'
usage:
  window.sh new -t <session> -n <label> [--dir <path>]
  window.sh list -t <session>
  window.sh rename -t <window_id> <new-name>
  window.sh kill -t <window_id>
EOF
}

cmd_new() {
  local session="" label="" dir=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -t) session="${2:?-t requires a session}"; shift 2 ;;
      -n) label="${2:?-n requires a label}"; shift 2 ;;
      --dir) dir="${2:?--dir requires a path}"; shift 2 ;;
      *) echo "ERROR: unknown argument '$1'" >&2; usage; return 1 ;;
    esac
  done
  if [[ -z "$session" || -z "$label" ]]; then
    echo "ERROR: window.sh new requires -t <session> and -n <label>" >&2
    usage
    return 1
  fi

  require_tmux_server || return 1
  local sess_name; sess_name=$(require_cc_prefix "$session")
  if ! tmux has-session -t "$sess_name" 2>/dev/null; then
    echo "ERROR: session '$sess_name' does not exist — create it with session.sh new first" >&2
    return 1
  fi

  local window_id
  if [[ -n "$dir" ]]; then
    window_id=$(tmux new-window -t "$sess_name" -n "$label" -c "$dir" -P -F '#{window_id}') || {
      echo "ERROR: failed to create window '$label' in '$sess_name'" >&2
      return 1
    }
  else
    window_id=$(tmux new-window -t "$sess_name" -n "$label" -P -F '#{window_id}') || {
      echo "ERROR: failed to create window '$label' in '$sess_name'" >&2
      return 1
    }
  fi

  ensure_dirs
  local entry
  entry=$(jq -n --arg id "$(new_entry_id)" --arg kind "window" --arg name "$label" \
    --arg session "$sess_name" --arg window_id "$window_id" --arg dir "$dir" \
    --arg created_at "$(now_iso)" \
    '{entry_id: $id, kind: $kind, name: $name, session: $session, window_id: $window_id, dir: $dir, status: "running", created_at: $created_at}')
  registry_add "$entry"

  printf '%s\n' "$window_id"
}

cmd_list() {
  local session=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -t) session="${2:?-t requires a session}"; shift 2 ;;
      *) echo "ERROR: unknown argument '$1'" >&2; usage; return 1 ;;
    esac
  done
  if [[ -z "$session" ]]; then
    echo "ERROR: window.sh list requires -t <session>" >&2
    usage
    return 1
  fi
  require_tmux_server || return 1
  local sess_name; sess_name=$(require_cc_prefix "$session")
  tmux list-windows -t "$sess_name" -F '#{window_id} #{window_index} #{window_name} #{window_panes} #{window_active}'
}

cmd_rename() {
  local window_id="" new_name=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -t) window_id="${2:?-t requires a window_id}"; shift 2 ;;
      *) new_name="$1"; shift ;;
    esac
  done
  if [[ -z "$window_id" || -z "$new_name" ]]; then
    echo "ERROR: window.sh rename requires -t <window_id> <new-name>" >&2
    usage
    return 1
  fi
  require_tmux_server || return 1
  tmux rename-window -t "$window_id" "$new_name"
  echo "renamed $window_id -> $new_name"
}

cmd_kill() {
  local window_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -t) window_id="${2:?-t requires a window_id}"; shift 2 ;;
      *) echo "ERROR: unknown argument '$1'" >&2; usage; return 1 ;;
    esac
  done
  if [[ -z "$window_id" ]]; then
    echo "ERROR: window.sh kill requires -t <window_id>" >&2
    usage
    return 1
  fi
  require_tmux_server || return 1
  tmux kill-window -t "$window_id"
  # Prune registry entries that reference this window_id (windows and any
  # panes/agents launched into it).
  registry_remove_by_window "$window_id"
  echo "killed $window_id"
}

main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    new) cmd_new "$@" ;;
    list) cmd_list "$@" ;;
    rename) cmd_rename "$@" ;;
    kill) cmd_kill "$@" ;;
    *) usage; return 1 ;;
  esac
}

main "$@"
