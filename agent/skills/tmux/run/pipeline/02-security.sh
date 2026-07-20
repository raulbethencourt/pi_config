#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="$HOME/.config/nvm"
source "$NVM_DIR/nvm.sh" --no-use
nvm use v24.15.0 --silent
export PATH="$NVM_DIR/versions/node/v24.15.0/bin:$PATH"
export NODE_PATH="/home/rabeta/.config/nvm/versions/node/v24.15.0/lib/node_modules"

PIPELINE_DIR="$HOME/.pi/agent/skills/tmux/run/pipeline"
SCOUT_HANDOFF="$PIPELINE_DIR/scout.md"
HANDOFF="$PIPELINE_DIR/security.md"
PANE="$TMUX_PANE"

rm -f "$HANDOFF"

# Background watcher: waits for scout handoff then injects prompt into this pane
(
  ELAPSED=0
  while [ ! -f "$SCOUT_HANDOFF" ]; do
    sleep 2; ELAPSED=$((ELAPSED+2))
    [ "$ELAPSED" -ge 7200 ] && exit 1
  done

  SCOUT_REPORT=$(cat "$SCOUT_HANDOFF")
  PROMPT_FILE=$(mktemp /tmp/pi-pipeline-security-XXXX.txt)

  cat > "$PROMPT_FILE" <<ENDOFPROMPT
You are the security-auditor stage of a sequential pipeline for /home/rabeta/.pi.

The scout stage has finished and produced this report:

--- BEGIN SCOUT REPORT ---
$SCOUT_REPORT
--- END SCOUT REPORT ---

Using the scout report as a map, perform a full security audit. Look for:
- Secrets, API keys, tokens in source or config
- Insecure subprocess/exec/eval usage and shell injection
- Path traversal in file I/O
- Dependency vulnerabilities in package.json files
- Privilege escalation or overly broad permissions
- Prompt injection surface in agent prompt construction

For each finding: CRITICAL / HIGH / MEDIUM / LOW / INFO, file + line, risk, suggested fix.
Conclude with overall verdict: PASS or FAIL.

CRITICAL: When done, write your complete report as markdown to: $HANDOFF
The next pipeline stage (code reviewer) is polling for that file.
ENDOFPROMPT

  # Paste prompt file content into the pi session running in this pane
  tmux load-buffer "$PROMPT_FILE"
  tmux paste-buffer -t "$PANE"
  tmux send-keys -t "$PANE" "" Enter
  rm -f "$PROMPT_FILE"
) &

cd /home/rabeta/.pi
pi "Security auditor standing by. Waiting for scout stage to complete its analysis... The task prompt will be injected automatically once the scout handoff file is ready."
