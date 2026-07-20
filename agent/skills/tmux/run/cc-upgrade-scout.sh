#!/usr/bin/env bash
set -uo pipefail
SESSION_ID="c015338e-68b5-47f7-925c-1fe569b95cb1"
cd /home/rabeta/.claude || exit 1
PROJECT_SLUG=$(pwd | sed -E 's#[/.]#-#g')
TRANSCRIPT=~/.claude/projects/${PROJECT_SLUG}/${SESSION_ID}.jsonl
LOG=~/.claude/skills/tmux/logs/cc-upgrade-scout.log

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

exec claude --agent scout --session-id "$SESSION_ID" \
  "Read all files in the project at /home/rabeta/.claude (skills, agents, hooks, commands, settings, state, memory -- everything relevant; skip any huge vendor/plugin-cache blobs unless they look load-bearing). Produce a thorough, concrete map of what exists: directory structure, purpose of each major area, and anything that looks incomplete, inconsistent, outdated, undocumented, or like a good candidate for improvement. Cite exact file paths. This report is the SOLE input a planner agent will use next to design an upgrade plan, so be specific and exhaustive rather than high-level. Do not modify any files.

Note: this is a live session and the person running it may attach and chat with you further after you answer -- still give your complete initial findings as one well-organized response first."
