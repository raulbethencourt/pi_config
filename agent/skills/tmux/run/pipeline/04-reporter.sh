#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="$HOME/.config/nvm"
source "$NVM_DIR/nvm.sh" --no-use
nvm use v24.15.0 --silent
export PATH="$NVM_DIR/versions/node/v24.15.0/bin:$PATH"
export NODE_PATH="/home/rabeta/.config/nvm/versions/node/v24.15.0/lib/node_modules"

PIPELINE_DIR="$HOME/.pi/agent/skills/tmux/run/pipeline"
CODEREVIEW_HANDOFF="$PIPELINE_DIR/codereview.md"
FINAL_REPORT="$PIPELINE_DIR/final-report.md"
PANE="$TMUX_PANE"

rm -f "$FINAL_REPORT"

(
  ELAPSED=0
  while [ ! -f "$CODEREVIEW_HANDOFF" ]; do
    sleep 2; ELAPSED=$((ELAPSED+2))
    [ "$ELAPSED" -ge 7200 ] && exit 1
  done

  SCOUT_REPORT=$(cat "$PIPELINE_DIR/scout.md")
  SECURITY_REPORT=$(cat "$PIPELINE_DIR/security.md")
  CODEREVIEW_REPORT=$(cat "$CODEREVIEW_HANDOFF")
  PROMPT_FILE=$(mktemp /tmp/pi-pipeline-reporter-XXXX.txt)

  cat > "$PROMPT_FILE" <<ENDOFPROMPT
You are the final reporter of a 3-stage pipeline that audited /home/rabeta/.pi.

All stages are complete. Their reports:

--- SCOUT REPORT ---
$SCOUT_REPORT
--- SECURITY AUDIT ---
$SECURITY_REPORT
--- CODE REVIEW ---
$CODEREVIEW_REPORT

Produce a consolidated executive summary with:
1. **Pipeline Verdict** — one-line PASS/FAIL/WARN
2. **Critical & High Findings** — table: Stage | Severity | File | Summary | Fix
3. **Medium & Low Findings** — same table
4. **Architecture Health** — 3-5 bullets from scout
5. **Top 5 Recommended Actions** — ordered by risk/impact
6. **Stage Verdicts** — one line per stage

When done, write the full summary to: $FINAL_REPORT
ENDOFPROMPT

  tmux load-buffer "$PROMPT_FILE"
  tmux paste-buffer -t "$PANE"
  tmux send-keys -t "$PANE" "" Enter
  rm -f "$PROMPT_FILE"
) &

cd /home/rabeta/.pi
pi "Reporter standing by. Waiting for all pipeline stages to complete... The consolidated report task will be injected automatically."
