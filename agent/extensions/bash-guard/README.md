# bash-guard (pi extension)

Intercepts agent-issued `bash` tool calls and applies different protection depending on whether
the session is interactive (main session) or non-interactive (spawned subagent).

## Modes

Behaviour is determined at registration time via the `PI_SUBAGENT_DEPTH` environment variable,
which pi-subagents injects into every spawned process.

### Main session (`PI_SUBAGENT_DEPTH` = 0 or unset) — interactive prompt

- Heuristically detects destructive/questionable commands via shell-aware parsing
- Prompts for **any** `git ...` command (escalates severity for especially risky ones: `git rm`,
  `git reset --hard`, `git clean -fdx`, `git push --force`, `git reflog expire`, `git gc --prune`)
- Prompts for disk/volume tooling: `diskutil`, `hdiutil`, `mkfs*`, `newfs_*`, `wipefs`, `parted`,
  `fdisk`, `gdisk/sgdisk`, `cryptsetup`, `pvcreate/vgcreate/lvcreate`, `zpool`, `lsblk`
- Prompts for: `rm`/`rmdir`/`unlink`, `sudo`, `find -delete`, `dd`, `truncate`, `sed -i`,
  `perl -pi`, `chmod/chown -R`, `mv/cp --force`, `kill`/`pkill`/`killall`, `shutdown`/`reboot`,
  `systemctl stop/disable`, `curl|sh`/`wget|sh`, `kubectl delete`, `terraform destroy`,
  `aws s3 rm --recursive`, `gcloud delete`, shell redirections (`>`, `>>`, `2>`), pipes
- Shows a 2-option dialog: **Run** / **Abort**
- If aborted, the tool call is blocked and the model receives a clear reason
- Remembers recently aborted commands for 60 s to prevent retry loops

### Subagent (`PI_SUBAGENT_DEPTH` ≥ 1) — headless hard-block

Spawned subagents have no UI (stdin is `/dev/null`), so prompting is impossible. Instead,
a focused set of catastrophic/unrecoverable operations is hard-blocked with no user interaction:

| Pattern | Reason |
|---|---|
| `rm -r` / `-rf` / `-Rf` | Recursive deletion |
| `sudo` | Elevated privileges |
| `curl\|sh`, `wget\|sh` | Pipe to shell (remote code execution) |
| `mkfs*`, `newfs_*` | Filesystem formatting |
| `wipefs` | Disk signature wipe |
| `diskutil erase/zeroDisk/secureErase/reformat` | Destructive disk operation |
| `dd of=/dev/…` | Raw disk write |
| `parted`, `fdisk`, `gdisk`, `sgdisk` | Partition table management |
| `cryptsetup` | Disk encryption management |
| `zpool` | ZFS pool management |
| `shutdown`, `reboot`, `halt`, `poweroff` | System power operation |
| `terraform destroy` | Infrastructure teardown |
| `kubectl delete` | Kubernetes resource deletion |
| `aws s3 rm --recursive` | Bulk S3 deletion |
| `git commit` | Main-session operation |
| `git pull` | Main-session operation |
| `git push` | Main-session operation |
| `git reset --hard` | Discard all uncommitted changes |
| `git clean -f` | Delete untracked files |
| `git reflog expire` | Remove recovery history |
| `git gc --prune` | Prune unreachable objects |

All other commands (including routine git operations) pass through unaffected.

## Known limitations

- **Bash-command path detection is a best-effort textual heuristic, not a hard guarantee.**
  Whether a bash command references a protected path (`~/.ssh`, `~/personal`, `~/secure`,
  `~/Documents`, `agent/auth.json`, `~/.npmrc`, the shell rc files, `~/.gitconfig`,
  `.git/hooks`, `.git/config`) is decided by a plain substring check of the raw command
  text. It does **not** resolve symlinks, shell variable expansion (`$HOME`), or `~`
  beyond one literal substitution, and it does not track path indirection across
  commands. Ordinary shell idioms bypass it with no special effort, e.g.:
  - `cd ~/.pi/agent && ln -s auth.json /tmp/x` (splits the literal path across a `cd`)
  - `ln -s "$HOME/.pi/agent/auth.json" /tmp/x2` (uses `$HOME` instead of the literal path)
  This applies to every protected-path tier listed above, not just the most recently
  added ones — it's a pre-existing, unresolved property of the bash-detection approach.
- **The Write/Edit tool-call protection is the reliable enforcement layer.** Unlike the
  bash-command heuristic, the Write/Edit checks receive an actual resolved path argument
  and correctly follow symlinks (including symlinks whose target doesn't exist yet) before
  comparing against protected paths. Treat bash-command detection as a helpful deterrent,
  and the Write/Edit path as the actual guarantee for file-level protection.
- Closing the bash-side gap fully would require either full shell-semantics simulation
  (attempted and abandoned for a related detector during this same effort, after repeated
  review found new bypasses) or OS-level filesystem sandboxing (a separate, larger,
  deliberately deferred effort) — both considered out of scope for this heuristic layer.

## Install

Auto-discovered from `~/.pi/agent/extensions/bash-guard/`. Run `/reload` in pi.

## Notes

- Scope: `bash` tool calls only (`write`/`edit` and user `!` commands are not intercepted).
- `--bash-guard-auto-allow`: main-session flag that allows flagged commands when there is no UI
  (e.g. running pi non-interactively). Has no effect in subagent sessions.
