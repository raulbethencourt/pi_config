#!/usr/bin/env bash
# status.sh — canonical "what have I created" report: cc- sessions cross-
# referenced with the registry, alive/dead per pane, and agent log lookup.
#
# Usage:
#   status.sh [--json]
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  echo "usage: status.sh [--json]" >&2
}

main() {
  local json_mode=0
  case "${1:-}" in
    --json) json_mode=1 ;;
    "") ;;
    *) usage; return 1 ;;
  esac

  require_tmux_binary || return 1
  ensure_dirs

  local sessions_json
  sessions_json=$(tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_created}' 2>/dev/null \
    | awk -F'|' '$1 ~ /^cc-/' \
    | jq -R -s '
        split("\n") | map(select(length>0)) | map(split("|"))
        | map({session: .[0], windows: (.[1] | tonumber), created: .[2]})
      ')
  [[ -z "$sessions_json" ]] && sessions_json="[]"

  local panes_json
  panes_json=$(tmux list-panes -a -F '#{pane_id}|#{session_name}|#{window_id}|#{window_name}|#{pane_current_command}' 2>/dev/null \
    | jq -R -s '
        split("\n") | map(select(length>0)) | map(split("|"))
        | map({pane_id: .[0], session: .[1], window_id: .[2], window_name: .[3], pane_current_command: .[4]})
      ')
  [[ -z "$panes_json" ]] && panes_json="[]"

  local registry_json; registry_json=$(registry_list)

  local report
  report=$(jq -n \
    --argjson sessions "$sessions_json" \
    --argjson panes "$panes_json" \
    --argjson registry "$registry_json" \
    '
    ($panes | map(.pane_id)) as $live_pane_ids
    | {
        sessions: $sessions,
        panes: $panes,
        entries: (
          $registry.entries
          | map(
              . as $e
              | ($e.pane_id // "") as $pid
              | (if $pid != "" then ($live_pane_ids | index($pid)) != null else null end) as $alive
              | $e + {alive: $alive}
            )
        )
      }
    ')

  if [[ "$json_mode" -eq 1 ]]; then
    printf '%s\n' "$report"
    return 0
  fi

  echo "== cc- sessions =="
  if [[ "$(jq '.sessions | length' <<<"$report")" -eq 0 ]]; then
    echo "  (none)"
  else
    jq -r '.sessions[] | "  \(.session)  windows=\(.windows)  created=\(.created)"' <<<"$report"
  fi

  echo
  echo "== tracked entries =="
  if [[ "$(jq '.entries | length' <<<"$report")" -eq 0 ]]; then
    echo "  (none)"
    return 0
  fi

  jq -c '.entries[]' <<<"$report" | while IFS= read -r e; do
    kind=$(jq -r '.kind' <<<"$e")
    label=$(jq -r '.label // .name // ""' <<<"$e")
    session=$(jq -r '.session // ""' <<<"$e")
    pane_id=$(jq -r '.pane_id // ""' <<<"$e")
    alive=$(jq -r '.alive' <<<"$e")
    status=$(jq -r '.status // ""' <<<"$e")
    logfile=$(jq -r '.logfile // ""' <<<"$e")

    alive_str="unknown"
    [[ "$alive" == "true" ]] && alive_str="alive"
    [[ "$alive" == "false" ]] && alive_str="dead"

    line="  kind=${kind} label=${label:-<none>} session=${session:-<none>} pane_id=${pane_id:-<none>} status=${status} ${alive_str}"

    if [[ "$kind" == "agent" ]]; then
      heuristic="idle"
      if [[ -n "$pane_id" ]]; then
        cmd=$(jq -r --arg p "$pane_id" '.[] | select(.pane_id==$p) | .pane_current_command' <<<"$panes_json" | head -1)
        if [[ -n "$cmd" && "$cmd" != "bash" && "$cmd" != "zsh" && "$cmd" != "sh" ]]; then
          heuristic="running"
        fi
      fi
      logstat="no logfile yet"
      if [[ -n "$logfile" ]]; then
        if [[ -f "$logfile" ]]; then
          logstat="$logfile"
        else
          logstat="no logfile yet ($logfile)"
        fi
      fi
      line="$line heuristic=${heuristic} log=${logstat}"
    fi
    echo "$line"
  done
}

main "$@"
