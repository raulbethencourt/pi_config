#!/usr/bin/env bash
set -uo pipefail
SESSION_ID="93a2aed6-cd9c-483b-85b3-1ba950288925"
SCOUT_LOG=~/.claude/skills/tmux/logs/cc-upgrade-scout.log
cd /home/rabeta/.claude || exit 1
PROJECT_SLUG=$(pwd | sed -E 's#[/.]#-#g')
TRANSCRIPT=~/.claude/projects/${PROJECT_SLUG}/${SESSION_ID}.jsonl
LOG=~/.claude/skills/tmux/logs/cc-upgrade-planner.log

echo "Waiting for scout's initial findings..."
for i in $(seq 1 540); do
  if [ -f "$SCOUT_LOG" ] && grep -q "===AGENT_DONE===" "$SCOUT_LOG"; then
    break
  fi
  sleep 5
done
if ! grep -q "===AGENT_DONE===" "$SCOUT_LOG" 2>/dev/null; then
  echo "ERROR: scout's findings never arrived (timed out after 45 min)"
  exit 1
fi
SCOUT_FINDINGS="$(sed '/===AGENT_DONE===/d' "$SCOUT_LOG")"

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

exec claude --agent planner --session-id "$SESSION_ID" \
  "Below is a scout agent's findings about the Claude Code configuration project at /home/rabeta/.claude. Based on these findings, produce a concrete, prioritized, step-by-step plan for upgrading/improving this project (skills, agents, hooks, commands, settings, conventions, test coverage, documentation -- whatever the findings suggest is worth upgrading). This is not code -- just the plan. Do not modify any files.

Note: this is a live session and the person running it may attach and chat with you further after you answer -- still give your complete initial plan as one well-organized response first.

--- SCOUT FINDINGS ---
$SCOUT_FINDINGS
--- END SCOUT FINDINGS ---"
