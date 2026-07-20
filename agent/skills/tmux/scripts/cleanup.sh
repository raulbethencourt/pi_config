#!/usr/bin/env bash
# cleanup.sh — inspect and (optionally, explicitly) tear down cc- tmux state.
#
# Usage:
#   cleanup.sh                                # LIST ONLY, never destructive
#   cleanup.sh --kill <name>                   # kill one named session, prune registry
#   cleanup.sh --kill-all --yes-i-am-sure      # kill every cc- session
#   cleanup.sh --kill-all                      # refused (missing confirmation flag)
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat >&2 <<'EOF'
usage:
  cleanup.sh                              # list candidates only, no destructive action
  cleanup.sh --kill <name>
  cleanup.sh --kill-all --yes-i-am-sure
EOF
}

list_candidates() {
  require_tmux_binary || return 1
  ensure_dirs

  echo "== live cc- sessions =="
  local live_sessions
  live_sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | awk '$1 ~ /^cc-/')
  if [[ -z "$live_sessions" ]]; then
    echo "  (none)"
  else
    while IFS= read -r s; do
      [[ -z "$s" ]] && continue
      printf '  %s\n' "$s"
    done <<<"$live_sessions"
  fi

  echo
  echo "== dead registry entries (candidates for pruning) =="
  local live_panes
  live_panes=$(tmux list-panes -a -F '#{pane_id}' 2>/dev/null || true)
  local content; content=$(registry_list)
  local dead
  dead=$(jq -c \
    --argjson live "$(printf '%s\n' "$live_panes" | jq -R -s 'split("\n") | map(select(length>0))')" \
    '.entries[] | select((.pane_id // "") != "" and ((.pane_id as $p | $live | index($p)) == null))' \
    <<<"$content")
  if [[ -z "$dead" ]]; then
    echo "  (none)"
  else
    jq -r '"  entry_id=" + .entry_id + " kind=" + .kind + " label=" + (.label // .name // "") + " pane_id=" + (.pane_id // "")' <<<"$dead"
  fi
}

cmd_kill() {
  local name="${1:-}"
  if [[ -z "$name" ]]; then
    echo "ERROR: --kill requires <name>" >&2
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

cmd_kill_all() {
  local confirmed="$1"
  if [[ "$confirmed" -ne 1 ]]; then
    echo "ERROR: --kill-all requires --yes-i-am-sure as well (refusing to destroy all cc- sessions without explicit confirmation)." >&2
    return 1
  fi
  require_tmux_server || return 1
  local live_sessions
  live_sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | awk '$1 ~ /^cc-/')
  if [[ -z "$live_sessions" ]]; then
    echo "no cc- sessions to kill"
    return 0
  fi
  local name
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    tmux kill-session -t "$name"
    registry_remove_by_session "$name"
    echo "killed $name"
  done <<<"$live_sessions"
}

main() {
  local kill_name="" kill_all=0 yes_confirm=0

  if [[ $# -eq 0 ]]; then
    list_candidates
    return $?
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --kill) kill_name="${2:?--kill requires <name>}"; shift 2 ;;
      --kill-all) kill_all=1; shift ;;
      --yes-i-am-sure) yes_confirm=1; shift ;;
      -h|--help) usage; return 0 ;;
      *) echo "ERROR: unknown argument '$1'" >&2; usage; return 1 ;;
    esac
  done

  if [[ -n "$kill_name" ]]; then
    cmd_kill "$kill_name"
    return $?
  fi

  if [[ "$kill_all" -eq 1 ]]; then
    cmd_kill_all "$yes_confirm"
    return $?
  fi

  usage
  return 1
}

main "$@"
