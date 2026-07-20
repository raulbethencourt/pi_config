#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="$HOME/.config/nvm"
source "$NVM_DIR/nvm.sh" --no-use
nvm use v24.15.0 --silent
export PATH="$NVM_DIR/versions/node/v24.15.0/bin:$PATH"

cd /home/rabeta/.pi
export NODE_PATH="/home/rabeta/.config/nvm/versions/node/v24.15.0/lib/node_modules"
pi "Review the /home/rabeta/.pi project codebase. Analyze architecture quality, logic correctness, DRY violations, error handling, and code quality issues. Return a structured review with severity-ranked findings."
