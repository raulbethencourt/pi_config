#!/usr/bin/env bash
set -uo pipefail
SESSION_ID="bbe0f861-4fda-4a2f-880e-933158e4843b"
CRITIC_LOG=~/.claude/skills/tmux/logs/cc-upgrade-critic.log
PLANNER_LOG=~/.claude/skills/tmux/logs/cc-upgrade-planner.log
cd /home/rabeta/.claude || exit 1
PROJECT_SLUG=$(pwd | sed -E 's#[/.]#-#g')
TRANSCRIPT=~/.claude/projects/${PROJECT_SLUG}/${SESSION_ID}.jsonl
LOG=~/.claude/skills/tmux/logs/cc-upgrade-auditor.log

echo "Waiting for critic's verdict..."
for i in $(seq 1 540); do
  if [ -f "$CRITIC_LOG" ] && grep -q "===AGENT_DONE===" "$CRITIC_LOG"; then
    break
  fi
  sleep 5
done
if ! grep -q "===AGENT_DONE===" "$CRITIC_LOG" 2>/dev/null; then
  echo "ERROR: critic's verdict never arrived (timed out after 45 min)"
  exit 1
fi
CRITIC_VERDICT="$(sed '/===AGENT_DONE===/d' "$CRITIC_LOG")"
PLANNER_PLAN="$(sed '/===AGENT_DONE===/d' "$PLANNER_LOG" 2>/dev/null || true)"

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

exec claude --agent security-auditor --session-id "$SESSION_ID" \
  "Below is an upgrade plan for the Claude Code configuration project at /home/rabeta/.claude, along with a critic agent's review of that plan. From a SECURITY-specific lens (credential handling, file permissions, injection risk in home-grown shell scripts, enforcement-hook bypass risk) -- not general plan quality, the critic already covered that -- review this plan and flag anything security-relevant the critic may have missed or under-weighted. Give your standard PASS/FAIL verdict with a CONFIDENCE line, categorized findings (Critical/High/Medium/Low). Do not modify any files.

Note: this is a live session and the person running it may attach and chat with you further after you answer -- still give your complete initial audit as one well-organized response first.

--- PLAN ---
$PLANNER_PLAN
--- END PLAN ---

--- CRITIC'S REVIEW ---
$CRITIC_VERDICT
--- END CRITIC'S REVIEW ---"
