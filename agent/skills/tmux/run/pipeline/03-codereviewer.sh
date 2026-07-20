#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="$HOME/.config/nvm"
source "$NVM_DIR/nvm.sh" --no-use
nvm use v24.15.0 --silent
export PATH="$NVM_DIR/versions/node/v24.15.0/bin:$PATH"
export NODE_PATH="/home/rabeta/.config/nvm/versions/node/v24.15.0/lib/node_modules"

PIPELINE_DIR="$HOME/.pi/agent/skills/tmux/run/pipeline"
SECURITY_HANDOFF="$PIPELINE_DIR/security.md"
HANDOFF="$PIPELINE_DIR/codereview.md"
PANE="$TMUX_PANE"

rm -f "$HANDOFF"

(
  ELAPSED=0
  while [ ! -f "$SECURITY_HANDOFF" ]; do
    sleep 2; ELAPSED=$((ELAPSED+2))
    [ "$ELAPSED" -ge 7200 ] && exit 1
  done

  SCOUT_REPORT=$(cat "$PIPELINE_DIR/scout.md")
  SECURITY_REPORT=$(cat "$SECURITY_HANDOFF")
  PROMPT_FILE=$(mktemp /tmp/pi-pipeline-codereview-XXXX.txt)

  cat > "$PROMPT_FILE" <<ENDOFPROMPT
You are the code-reviewer stage of a sequential pipeline for /home/rabeta/.pi.

Prior stages have completed. Their reports:

--- BEGIN SCOUT REPORT ---
$SCOUT_REPORT
--- END SCOUT REPORT ---

--- BEGIN SECURITY AUDIT ---
$SECURITY_REPORT
--- END SECURITY AUDIT ---

Perform a thorough code review. Focus on:
- Code quality, clarity, maintainability
- Architectural consistency with documented design
- Error handling gaps
- Test coverage gaps
- Duplication or dead code
- Agent prompt quality (clear, safe, well-scoped)
- Code-level fixes for security findings above

For each finding: HIGH / MEDIUM / LOW / INFO, file + location, concrete fix.

CRITICAL: When done, write your complete report as markdown to: $HANDOFF
The reporter stage is polling for that file.
ENDOFPROMPT

  tmux load-buffer "$PROMPT_FILE"
  tmux paste-buffer -t "$PANE"
  tmux send-keys -t "$PANE" "" Enter
  rm -f "$PROMPT_FILE"
) &

cd /home/rabeta/.pi
pi "Code reviewer standing by. Waiting for security audit to complete... The task prompt will be injected automatically once the security handoff file is ready."
