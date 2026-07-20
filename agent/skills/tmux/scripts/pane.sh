#!/usr/bin/env bash
# pane.sh — split/list/kill/resize/capture tmux panes.
#
# Usage:
#   pane.sh split -t <window_or_pane> [-h|-v] -p <percent> [--dir <path>]
#   pane.sh list -t <session_or_window>
#   pane.sh kill -t <pane_id>
#   pane.sh resize -t <pane_id> [-D|-U|-L|-R <n> | -x <cols> -y <rows>]
#   pane.sh capture -t <pane_id> [--lines N]
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat >&2 <<'EOF'
usage:
  pane.sh split -t <window_or_pane> [-h|-v] -p <percent> [--dir <path>]
  pane.sh list -t <session_or_window>
  pane.sh kill -t <pane_id>
  pane.sh resize -t <pane_id> [-D|-U|-L|-R <n> | -x <cols> -y <rows>]
  pane.sh capture -t <pane_id> [--lines N]
EOF
}

cmd_split() {
  local target="" dir_flag="-h" percent="" cwd=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -t) target="${2:?-t requires a target}"; shift 2 ;;
      -h) dir_flag="-h"; shift ;;
      -v) dir_flag="-v"; shift ;;
      -p) percent="${2:?-p requires a percent}"; shift 2 ;;
      --dir) cwd="${2:?--dir requires a path}"; shift 2 ;;
      *) echo "ERROR: unknown argument '$1'" >&2; usage; return 1 ;;
    esac
  done
  if [[ -z "$target" || -z "$percent" ]]; then
    echo "ERROR: pane.sh split requires -t <target> and -p <percent>" >&2
    usage
    return 1
  fi

  require_tmux_server || return 1

  local pane_id
  if [[ -n "$cwd" ]]; then
    pane_id=$(tmux split-window "$dir_flag" -p "$percent" -t "$target" -c "$cwd" -P -F '#{pane_id}') || {
      echo "ERROR: failed to split target '$target'" >&2
      return 1
    }
  else
    pane_id=$(tmux split-window "$dir_flag" -p "$percent" -t "$target" -P -F '#{pane_id}') || {
      echo "ERROR: failed to split target '$target'" >&2
      return 1
    }
  fi

  ensure_dirs
  # Best-effort lookup of the owning session, so session.sh kill's registry
  # pruning (registry_remove_by_session) can also catch panes later, not
  # just sessions/windows. Not fatal if it can't be resolved.
  local owning_session
  owning_session=$(tmux display-message -p -t "$pane_id" '#{session_name}' 2>/dev/null || true)

  local entry
  entry=$(jq -n --arg id "$(new_entry_id)" --arg kind "pane" --arg pane_id "$pane_id" \
    --arg target "$target" --arg session "$owning_session" --arg dir "$cwd" --arg created_at "$(now_iso)" \
    '{entry_id: $id, kind: $kind, pane_id: $pane_id, split_from: $target, session: $session, dir: $dir, status: "running", created_at: $created_at}')
  registry_add "$entry"

  printf '%s\n' "$pane_id"
}

cmd_list() {
  local target=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -t) target="${2:?-t requires a target}"; shift 2 ;;
      *) echo "ERROR: unknown argument '$1'" >&2; usage; return 1 ;;
    esac
  done
  if [[ -z "$target" ]]; then
    echo "ERROR: pane.sh list requires -t <session_or_window>" >&2
    usage
    return 1
  fi
  require_tmux_server || return 1
  tmux list-panes -t "$target" \
    -F '#{pane_id} #{pane_index} #{pane_current_command} #{pane_width}x#{pane_height} #{pane_active} #{pane_pid} #{pane_current_path}'
}

cmd_kill() {
  local pane_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -t) pane_id="${2:?-t requires a pane_id}"; shift 2 ;;
      *) echo "ERROR: unknown argument '$1'" >&2; usage; return 1 ;;
    esac
  done
  if [[ -z "$pane_id" ]]; then
    echo "ERROR: pane.sh kill requires -t <pane_id>" >&2
    usage
    return 1
  fi
  require_tmux_server || return 1
  tmux kill-pane -t "$pane_id"
  registry_remove_by_pane "$pane_id"
  echo "killed $pane_id"
}

cmd_resize() {
  local pane_id="" direction="" amount="" cols="" rows=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -t) pane_id="${2:?-t requires a pane_id}"; shift 2 ;;
      -D) direction="-D"; amount="${2:?-D requires an amount}"; shift 2 ;;
      -U) direction="-U"; amount="${2:?-U requires an amount}"; shift 2 ;;
      -L) direction="-L"; amount="${2:?-L requires an amount}"; shift 2 ;;
      -R) direction="-R"; amount="${2:?-R requires an amount}"; shift 2 ;;
      -x) cols="${2:?-x requires a column count}"; shift 2 ;;
      -y) rows="${2:?-y requires a row count}"; shift 2 ;;
      *) echo "ERROR: unknown argument '$1'" >&2; usage; return 1 ;;
    esac
  done
  if [[ -z "$pane_id" ]]; then
    echo "ERROR: pane.sh resize requires -t <pane_id>" >&2
    usage
    return 1
  fi
  require_tmux_server || return 1

  if [[ -n "$direction" ]]; then
    tmux resize-pane -t "$pane_id" "$direction" "$amount"
  elif [[ -n "$cols" || -n "$rows" ]]; then
    local args=(-t "$pane_id")
    [[ -n "$cols" ]] && args+=(-x "$cols")
    [[ -n "$rows" ]] && args+=(-y "$rows")
    tmux resize-pane "${args[@]}"
  else
    echo "ERROR: pane.sh resize requires -D/-U/-L/-R <n> or -x/-y <n>" >&2
    usage
    return 1
  fi
  echo "resized $pane_id"
}

cmd_capture() {
  local pane_id="" lines=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -t) pane_id="${2:?-t requires a pane_id}"; shift 2 ;;
      --lines) lines="${2:?--lines requires a number}"; shift 2 ;;
      *) echo "ERROR: unknown argument '$1'" >&2; usage; return 1 ;;
    esac
  done
  if [[ -z "$pane_id" ]]; then
    echo "ERROR: pane.sh capture requires -t <pane_id>" >&2
    usage
    return 1
  fi
  require_tmux_server || return 1
  if [[ -n "$lines" ]]; then
    tmux capture-pane -p -t "$pane_id" -S "-$lines"
  else
    tmux capture-pane -p -t "$pane_id"
  fi
}

main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    split) cmd_split "$@" ;;
    list) cmd_list "$@" ;;
    kill) cmd_kill "$@" ;;
    resize) cmd_resize "$@" ;;
    capture) cmd_capture "$@" ;;
    *) usage; return 1 ;;
  esac
}

main "$@"
