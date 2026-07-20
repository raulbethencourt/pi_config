#!/usr/bin/env bash
# launch_agent.sh — launch an independent agent CLI process (claude -p "...",
# aider, codex, etc.) into its own dedicated new window/pane.
#
# Usage:
#   launch_agent.sh <session> <label> <script_path> [--confirm-over-cap] [--logfile <path>] [--group <name>]
#
# --group <name>: put this agent in a PANE inside a shared window for all
# agents launched with the same (session, group) pair, instead of giving it
# its own window. Use this for related agents that belong together (e.g. a
# scout -> planner -> critic pipeline) so they're visible side-by-side/
# stacked in one window; omit it for standalone/independent agents that don't
# need to share screen space (the default: one window per agent).
#
# The caller (Claude) is expected to have authored script_path via the Write
# tool ahead of time. That script's own content is expected to redirect the
# agent CLI's stdout/stderr to a logfile under logs/ itself, e.g.:
#   claude -p "..." > ~/.claude/skills/tmux/logs/<label>-<ts>.log 2>&1
# launch_agent.sh does NOT parse the script content for a logfile path — pass
# --logfile explicitly if you want it recorded in the registry for lookup.
#
# Concurrency / reserve-before-spawn design:
#   The cap-check AND the registry reservation happen inside ONE flock-held
#   critical section, and the reservation (status:"starting") is written
#   BEFORE the tmux window is actually spawned. This closes the window where
#   a crash between spawn and registry-write would orphan an untracked
#   process, and makes the cap check atomic against concurrent launches.
#   After the pane is created, a second (separate, non-nested) lock
#   acquisition updates the same entry with the real pane_id and
#   status:"running". If the spawn itself fails, the entry is updated to
#   status:"failed" instead of being left stuck as "starting" forever.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  echo "usage: launch_agent.sh <session> <label> <script_path> [--confirm-over-cap] [--logfile <path>] [--group <name>]" >&2
}

main() {
  local session="${1:-}" label="${2:-}" script_path="${3:-}"
  if [[ -z "$session" || -z "$label" || -z "$script_path" ]]; then
    usage
    return 1
  fi
  shift 3 || true

  local confirm_over_cap=0 logfile="" group=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --confirm-over-cap) confirm_over_cap=1; shift ;;
      --logfile) logfile="${2:?--logfile requires a path}"; shift 2 ;;
      --group) group="${2:?--group requires a name}"; shift 2 ;;
      *) echo "ERROR: unknown argument '$1'" >&2; usage; return 1 ;;
    esac
  done

  require_tmux_server || return 1

  local sess_name; sess_name=$(require_cc_prefix "$session")
  if ! tmux has-session -t "$sess_name" 2>/dev/null; then
    echo "ERROR: session '$sess_name' does not exist — create it with session.sh new first" >&2
    return 1
  fi

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
  chmod +x "$resolved"

  ensure_dirs
  local cap="${CC_TMUX_MAX_AGENTS:-3}"
  local entry_id; entry_id=$(new_entry_id)
  local lock_file; lock_file=$(_cc_tmux_lock_file)

  # --- Critical section: cap-check + reservation, atomically -----------------
  # Uses a brace GROUP (not a subshell) with fd 200 redirected onto the lock
  # file for its duration, so `decision`/`live_entries_display` assignments
  # below are visible after the group ends. flock is released automatically
  # when fd 200 closes at the end of the group.
  local decision=""   # "ok" or "over_cap"
  local live_entries_display=""
  {
    flock -x 200

    local content; content=$(registry_read_raw)
    local live_count; live_count=$(_agent_live_count_from_json "$content")

    if [[ "$live_count" -ge "$cap" && "$confirm_over_cap" -ne 1 ]]; then
      decision="over_cap"
      live_entries_display=$(_agent_live_entries_from_json "$content")
    else
      decision="ok"
      local reservation
      reservation=$(jq -n \
        --arg id "$entry_id" \
        --arg label "$label" \
        --arg session "$sess_name" \
        --arg script_path "$resolved" \
        --arg logfile "$logfile" \
        --arg group "$group" \
        --arg created_at "$(now_iso)" \
        '{entry_id: $id, kind: "agent", label: $label, session: $session,
          script_path: $script_path, logfile: $logfile, pane_id: "", window_id: "",
          group: $group, status: "starting", created_at: $created_at}')
      content=$(jq --argjson entry "$reservation" '.entries += [$entry]' <<<"$content")
      registry_write_raw "$content"
    fi
  } 200>"$lock_file"
  # --- End critical section (fd 200 closed, lock released) --------------------

  if [[ "$decision" == "over_cap" ]]; then
    echo "ERROR: at/over concurrency cap (CC_TMUX_MAX_AGENTS=${cap}); currently live agents:" >&2
    if [[ -n "$live_entries_display" ]]; then
      while IFS= read -r entry; do
        [[ -z "$entry" ]] && continue
        local l p lf
        l=$(jq -r '.label' <<<"$entry")
        p=$(jq -r '.pane_id' <<<"$entry")
        lf=$(jq -r '.logfile // ""' <<<"$entry")
        printf '  label=%s pane_id=%s logfile=%s\n' "$l" "$p" "${lf:-<none>}" >&2
      done <<<"$live_entries_display"
    fi
    echo "Pass --confirm-over-cap to launch anyway." >&2
    return 1
  fi

  # --- Spawn --------------------------------------------------------------
  # Capture both window_id and pane_id in one -P -F call so window.sh kill's
  # registry_remove_by_window can later prune this entry too (same derivation
  # pattern pane.sh uses for its own `session` field).
  local window_id="" pane_id="" spawn_ok=1 err_msg=""

  if [[ -n "$group" ]]; then
    # Group mode: reuse the (session, group)'s existing window as a PANE
    # target, or create the window if this is the first agent in the group.
    # This decide-and-spawn sequence is done under its own lock acquisition
    # (the tmux calls involved are fast local syscalls, not slow agent CLI
    # invocations, so there's no cost to locking across them) to close the
    # race where two agents joining the same group concurrently could both
    # split off the same "last pane," or both decide no group window exists
    # yet and each try to create one.
    {
      flock -x 200
      local existing_window; existing_window=$(find_group_window "$sess_name" "$group")
      if [[ -n "$existing_window" ]]; then
        local last_pane
        last_pane=$(tmux list-panes -t "$existing_window" -F '#{pane_id}' 2>/dev/null | tail -1)
        if pane_id=$(tmux split-window -t "$last_pane" -v -P -F '#{pane_id}' -- bash "$resolved" 2>&1); then
          window_id="$existing_window"
          rebalance_window_panes "$window_id"
        else
          spawn_ok=0; err_msg="$pane_id"
        fi
      else
        # First agent in a brand-new group: prefer repurposing an existing
        # idle window (e.g. the default window session.sh new always leaves
        # behind) over leaving it unused alongside a second, newly-created
        # window — an unused "do-nothing" window next to the real one is
        # confusing, not a sensible default.
        local reuse; reuse=$(find_reusable_idle_window "$sess_name")
        if [[ -n "$reuse" ]]; then
          local reuse_window reuse_pane
          read -r reuse_window reuse_pane <<<"$reuse"
          if err_msg=$(tmux rename-window -t "$reuse_window" "$group" 2>&1) && \
             err_msg=$(tmux respawn-pane -k -t "$reuse_pane" -- bash "$resolved" 2>&1); then
            window_id="$reuse_window"
            pane_id="$reuse_pane"
            err_msg=""
          else
            spawn_ok=0
          fi
        else
          local spawn_out
          if spawn_out=$(tmux new-window -t "$sess_name" -n "$group" -P -F '#{window_id} #{pane_id}' -- bash "$resolved" 2>&1); then
            window_id=$(awk '{print $1}' <<<"$spawn_out")
            pane_id=$(awk '{print $2}' <<<"$spawn_out")
          else
            spawn_ok=0; err_msg="$spawn_out"
          fi
        fi
        if [[ "$spawn_ok" -eq 1 ]]; then
          local group_entry content
          group_entry=$(jq -n --arg id "$(new_entry_id)" --arg session "$sess_name" --arg group "$group" \
            --arg window_id "$window_id" --arg created_at "$(now_iso)" \
            '{entry_id: $id, kind: "window-group", session: $session, group: $group, window_id: $window_id, created_at: $created_at}')
          content=$(registry_read_raw)
          content=$(jq --argjson e "$group_entry" '.entries += [$e]' <<<"$content")
          registry_write_raw "$content"
        fi
      fi
    } 200>"$lock_file"
  else
    local spawn_out
    if spawn_out=$(tmux new-window -t "$sess_name" -n "$label" -P -F '#{window_id} #{pane_id}' -- bash "$resolved" 2>&1); then
      window_id=$(awk '{print $1}' <<<"$spawn_out")
      pane_id=$(awk '{print $2}' <<<"$spawn_out")
    else
      spawn_ok=0; err_msg="$spawn_out"
    fi
  fi

  if [[ "$spawn_ok" -eq 1 ]]; then
    registry_update_by_id "$entry_id" "$(jq -n --arg p "$pane_id" --arg w "$window_id" '{pane_id: $p, window_id: $w, status: "running"}')"
    printf '%s\n' "$pane_id"
  else
    registry_update_by_id "$entry_id" '{"status":"failed"}'
    echo "ERROR: failed to spawn agent: $err_msg" >&2
    return 1
  fi
}

main "$@"
