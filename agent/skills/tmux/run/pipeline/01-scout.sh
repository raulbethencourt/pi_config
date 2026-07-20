#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="$HOME/.config/nvm"
source "$NVM_DIR/nvm.sh" --no-use
nvm use v24.15.0 --silent
export PATH="$NVM_DIR/versions/node/v24.15.0/bin:$PATH"

cd /home/rabeta/.pi
export NODE_PATH="/home/rabeta/.config/nvm/versions/node/v24.15.0/lib/node_modules"

PIPELINE_DIR="$HOME/.pi/agent/skills/tmux/run/pipeline"
HANDOFF="$PIPELINE_DIR/scout.md"
rm -f "$HANDOFF"

pi "You are the scout stage of a sequential analysis pipeline for /home/rabeta/.pi.

Your task:
1. Map the full project: source files, entry points, key modules, extensions, skills, configuration, agent prompts, test infrastructure.
2. List all external dependencies (package.json, imports).
3. Flag files with elevated risk surface: subprocess execution, file I/O, network calls, eval/exec, env handling.
4. Produce a structured markdown report: directory layout, module responsibilities, dependency list, risk-surface callouts.

CRITICAL: When you have finished your analysis, write your complete report as markdown to this exact path using the write tool:
$HANDOFF

The next pipeline stage (security auditor) is polling for that file. Do not consider your task complete until you have written it."
