#!/usr/bin/env bash
set -uo pipefail
SESSION_ID="1df60f95-0e9d-4fb0-9033-6442c9b3b58c"
PLANNER_LOG=~/.claude/skills/tmux/logs/cc-upgrade-planner.log
cd /home/rabeta/.claude || exit 1
PROJECT_SLUG=$(pwd | sed -E 's#[/.]#-#g')
TRANSCRIPT=~/.claude/projects/${PROJECT_SLUG}/${SESSION_ID}.jsonl
LOG=~/.claude/skills/tmux/logs/cc-upgrade-critic.log

echo "Waiting for planner's plan..."
for i in $(seq 1 540); do
  if [ -f "$PLANNER_LOG" ] && grep -q "===AGENT_DONE===" "$PLANNER_LOG"; then
    break
  fi
  sleep 5
done
if ! grep -q "===AGENT_DONE===" "$PLANNER_LOG" 2>/dev/null; then
  echo "ERROR: planner's plan never arrived (timed out after 45 min)"
  exit 1
fi
PLANNER_PLAN="$(sed '/===AGENT_DONE===/d' "$PLANNER_LOG")"

(
  for i in $(seq 1 150); do
    if [ -f "$TRANSCRIPT" ]; then
      hit=$(jq -c 'select(.type=="assistant" and .message.stop_reason=="end_turn" and ([.message.content[].type] | index("text")))' "$TRANSCRIPT" 2>/dev/null | head -1)
      if [ -n "$hit" ]; then
        echo "$hit" | jq -r '(.message.content // []) | map(select(.type=="text") | .text) | join("\n")' > "$LOG"
        echo "===AGENT_DONE===" >> "$LOG"
        break
      fi
    fi
    sleep 2
  done
) &

exec claude --agent critic --session-id "$SESSION_ID" \
  "Below is an upgrade plan for the Claude Code configuration project at /home/rabeta/.claude, produced by a planner agent based on a scout's findings. Critically challenge this plan for blind spots, missing edge cases, over-engineering, and unstated assumptions. Give a clear PROCEED / REVISE / BLOCK verdict with BLOCKER/WARNING/NIT findings. Do not modify any files.

Note: this is a live session and the person running it may attach and chat with you further after you answer -- still give your complete initial verdict as one well-organized response first.

--- PLAN ---
$PLANNER_PLAN
--- END PLAN ---"
