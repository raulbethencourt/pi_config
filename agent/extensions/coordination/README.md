# coordination

Per-file locking + a shared `tasks.json` task list for concurrently-dispatched
pi subagents.

## Why this exists

Subagents dispatched via `agent/extensions/subagents/runner.ts` are real,
separate OS processes (`child_process.spawn`), not threads or async tasks
inside one process. Two siblings racing `write`/`edit` calls against the same
file can silently clobber each other — there is no shared in-memory state to
prevent it. This extension adds:

- A per-file lock, backed by atomic on-disk lock files (the only mechanism
  that's visible across separate OS processes).
- A shared `tasks.json` per top-level session, so siblings can see what each
  other is doing.

## Loaded only into subagent child processes

This extension is appended to the subagent child's `--extension` list the
same way `hashline` already is — it is **never** loaded into the interactive
main-session process.

The reason is a specific interaction with how a blocked `tool_call` is
handled by the real pi runtime: `agent-loop.js` skips
`finalizeExecutedToolCall`/`afterToolCall` entirely for a blocked call, which
means **a blocked `tool_call` never produces a matching `tool_result`**. If
some *other* extension's `tool_call` handler blocked a call after this
extension had already granted its lock (in an earlier handler in the chain),
this extension's `tool_result` handler would never fire to release it — a
permanent leaked lock for that path, only recoverable once the holding
process itself dies. Loading only into subagent children sidesteps this
entirely: the only other co-resident hook there is `hashline`'s
`tool_result`-only handler, which never blocks a call.

## Reap model: dead-pid-only, no TTL, ever

A lock is only ever reclaimed when `process.kill(holderPid, 0)` throws
(`ESRCH`, the pid is dead). There is no elapsed-time/TTL fallback — a lock
held by a live pid is never stolen no matter how old its on-disk timestamp
is (see `coordination-lock-store.test.ts`'s explicit regression test for
this).

The SIGKILL recovery path is **"the next acquire attempt against that pid
finds it dead"** — not a signal handler. An `exit`/`SIGTERM` handler may still
be registered as a best-effort graceful-shutdown optimization (releasing
locks promptly on a clean exit), but it is never the safety net; correctness
does not depend on it firing. If a holder is SIGKILLed, its locks are only
ever recovered when another caller's next `acquireLock` attempt against that
path discovers the recorded pid is dead.

### Reaping a dead-pid lock is itself serialized behind a reap-mutex

Actually stealing a stale (dead-pid) lock is never done as an optimistic
unlink+recreate: `unlink()` is unconditional — it removes whatever currently
occupies the path, stale or not — so two racers that both observe the same
dead-pid holder and both unlink+recreate can interleave such that both end up
believing they hold the lock. Instead, the reap step itself is serialized
behind a second on-disk file, `${lockPath}.reap-mutex`, created with the same
atomic `open(path, "wx")` primitive as the main lock. At most one racer can
ever hold this mutex at a time; only that racer re-verifies (under the
mutex's exclusivity) that the main lock's holder is still dead before
unlinking it, then releases the mutex. Every other racer that loses the
reap-mutex race simply reports ordinary contention and defers to its own
caller's retry/backoff loop.

Critically, the reap-mutex file is **never itself reaped by a liveness
check** on its recorded holder pid. Doing so would reintroduce the exact same
race one layer down (two racers both seeing the same dead-pid mutex holder,
both racing to unlink+recreate the mutex, both ending up believing they hold
it). If the reap-mutex's creator crashes mid-reap and never clears it, that
one canonical path becomes permanently contended — see "Known, accepted
limitations" below.

## Multi-file atomic acquire, with rollback

`acquireLocksForPaths` (in `index.ts`) sorts all target canonical paths for
one tool call lexicographically before acquiring them — a fixed order across
every caller prevents cross-call deadlocks when two multi-file edits happen
to share some of the same files. If any single acquisition in the sorted
sequence fails after exhausting its retry/backoff budget, every lock already
acquired earlier in that same call is rolled back before reporting failure.
No partial lock state is ever left behind by a failed multi-file acquisition.

## Path canonicalization

Lock keys are canonical (symlink-resolved) paths, via `session-dir.ts`'s
`canonicalizePath`. This means a real file and a symlink pointing at it
contend for the same lock, rather than being treated as two independent
files. A not-yet-existing `write` target is canonicalized by resolving its
parent directory and rejoining the basename; if even the parent can't be
resolved, it falls back to a plain `path.resolve`.

## Stale-session pruning

`pruneStaleSessions()` is called once per top-level pi process start (at
`currentDepth === 0` in `extensions/subagents/index.ts`), not on any timer.
It removes coordination session directories (`<pid>-<timestamp>`-named)
whose leading pid is dead — the same dead-pid-only trigger as individual lock
reaping, never file age.

## Known, accepted limitations (not engineered around, v1)

- **PID reuse during the reap window.** If a holder process dies and the OS
  reassigns its exact pid to an unrelated new process before the next
  `acquireLock` attempt checks it, that unrelated process would appear
  "alive" and the stale lock would not be reaped. This is an accepted,
  extremely-low-probability limitation, not something this extension
  attempts to detect or work around.
- **No cross-session protection.** Two separate top-level `pi` invocations
  each get their own coordination session directory
  (`~/.pi/agent/state/coordination/<sessionId>/`) with no shared visibility
  between them. Locking only coordinates subagents dispatched from the *same*
  top-level session. This is explicitly out of scope for v1.
- **Local filesystem only.** Lock reliability depends on the atomicity of
  `open(..., "wx")` on the local filesystem. Network filesystems (NFS, SMB,
  etc.) are out of scope — this extension assumes `~/.pi` lives on a local
  disk.
- **Same-pid concurrent tool calls are both granted, not serialized.** Two
  concurrent tool calls (different `toolCallId`s) from the *same* subagent
  process targeting the same file are both granted immediately — the
  in-process reentrancy map in `lock-store.ts` keys purely on pid, so a
  second call from that pid is treated as reentrant rather than queued behind
  the first. This is because pi-agent-core executes a turn's prepared
  tool-call bodies concurrently by default; blocking a second same-pid call at
  acquire time would deadlock the batch (the first call can't run to release
  its lock while the second is stuck waiting for it). This is not a
  regression introduced by this extension — baseline pi has the identical
  race with no coordination extension at all — and it remains outside this
  extension's "separate OS processes" threat model. Documented here as a
  known gap, not treated as solved.
- **A reap-mutex orphaned by a reaper crashing mid-reap is never auto-cleared,
  so its canonical path can become permanently lock-unavailable.** The
  reap-mutex (`${lockPath}.reap-mutex`, see "Reaping a dead-pid lock is
  itself serialized behind a reap-mutex" above) is only ever removed by
  whichever racer created it — never by a liveness check on its recorded
  holder pid, because that would reintroduce the same double-acquire race the
  mutex exists to prevent, just one layer down. If the racer holding the
  mutex is killed between creating it and clearing it (i.e. mid-reap), the
  mutex file is left behind forever, and every future `acquireLock` attempt
  against that exact canonical path will observe it as contended and never
  succeed. This is a deliberate fail-safe tradeoff: permanent denial for an
  extremely narrow, extremely rare precondition (a reaper process crashing in
  the handful of synchronous syscalls between mutex-create and mutex-unlink)
  is preferred over any recovery mechanism that risks a silent double-grant.
  Not engineered around in v1.

## Modules

- `session-dir.ts` — resolves `~/.pi/agent/state/coordination/<sessionId>/`,
  canonicalizes paths, lists/identifies stale session directories.
- `lock-store.ts` — the actual per-file lock primitive: atomic on-disk
  exclusive creation, dead-pid reaping, and an in-process reentrancy map so
  repeated acquisitions by the same pid are free.
- `tasks.ts` — `tasks.json` read/write/upsert, guarded by the same
  lock-store primitive (a lock on `<sessionDir>/tasks.json.lock`, not a
  second bespoke locking mechanism).
- `index.ts` — the extension entry point (`write`/`edit` tool_call/tool_result
  wiring), plus the independently-testable `acquireLocksForPaths` and
  `pruneStaleSessions`.
