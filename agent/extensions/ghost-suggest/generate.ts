/**
 * Suggestion generation for the ghost-suggest extension (pi-improvement-plan item #19).
 *
 * Three pure functions (`sanitizeSuggestion`, `buildFirstTurnSeedPrompt`,
 * `buildLaterTurnSeedPrompt`) are covered by generate.test.ts.
 *
 * The rest of this file is the non-pure background-generation path: a cheap
 * side session that reuses the parent conversation's model (and, for later
 * turns, its message history) to ask for a short next-message suggestion.
 * Modeled on the `ensureSideSession`/`createSideSession` cache-by-model-key
 * pattern in ../btw.ts, but simplified: no tool access, no streaming
 * subscription — just a single prompt and a read of the final assistant text.
 */
import { execFile } from "node:child_process";
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  type AgentSession,
  type ExtensionContext,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { extractLastAssistantText } from "../notify.ts";

// ---------------------------------------------------------------------------
// Pure functions (generate.test.ts)
// ---------------------------------------------------------------------------

const MAX_SUGGESTION_LENGTH = 80;

// Fixed set of generic non-answers the model might emit instead of a real
// suggestion; rejected so we never show unhelpful ghost text.
const GENERIC_NONANSWERS = new Set(["i don't know", "i'm not sure", "no suggestion"]);

function unwrapQuotes(text: string): string {
  if (text.length < 2) {
    return text;
  }
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Truncate to at most `maxLength` Unicode code points. Plain `String.slice()`
 * counts UTF-16 code units, so it can cut a surrogate pair (e.g. an emoji) in
 * half and leave a lone, unpaired surrogate in the result; iterating via
 * `Array.from` (which is code-point-aware) avoids that.
 */
function truncateToCodePointLimit(text: string, maxLength: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= maxLength) {
    return text;
  }
  return codePoints.slice(0, maxLength).join("");
}

// Strips ANSI/CSI escape sequences, then any remaining ASCII C0 control
// characters (including a bare ESC, 0x1B), DEL, and the C1 control range
// (0x80-0x9F — some terminals interpret an 8-bit C1 introducer the same way
// as an ESC-prefixed sequence). The `\s+` collapse below handles
// whitespace-class control characters (newlines, tabs) but not any of these
// — this is the suggestion's only path to a rendered terminal (editor.ts
// splices it directly into a TUI line), so a model response must never be
// able to smuggle raw escape sequences into that render.
function stripControlCharacters(text: string): string {
  // eslint-disable-next-line no-control-regex -- intentionally matching ANSI/C0/C1/DEL
  const withoutAnsi = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  // eslint-disable-next-line no-control-regex -- intentionally matching ANSI/C0/C1/DEL
  return withoutAnsi.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
}

/**
 * Normalize raw model output into a short, single-line suggestion, or
 * `undefined` if the output is empty or a generic non-answer.
 */
export function sanitizeSuggestion(rawModelText: string): string | undefined {
  const normalized = stripControlCharacters(rawModelText.replace(/\s+/g, " ")).trim();
  if (!normalized) {
    return undefined;
  }

  const unwrapped = unwrapQuotes(normalized);
  if (GENERIC_NONANSWERS.has(unwrapped.toLowerCase())) {
    return undefined;
  }

  return truncateToCodePointLimit(unwrapped, MAX_SUGGESTION_LENGTH);
}

/** Seed prompt for a session's first turn: derive a suggestion from git history. */
export function buildFirstTurnSeedPrompt(gitLogOutput: string): string {
  return [
    "Here is the recent git history for this repository:",
    "",
    gitLogOutput,
    "",
    "Based on this history, suggest one short next message the user might send to continue this work.",
    "Reply with only the suggested message text: no preamble, no quotes, no explanation.",
  ].join("\n");
}

/** Seed prompt for later turns: derive a suggestion from the ongoing conversation. */
export function buildLaterTurnSeedPrompt(): string {
  return [
    "Based on the conversation so far, suggest one short next message the user might send.",
    "Reply with only the suggested message text: no preamble, no quotes, no explanation.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Git seed helper
// ---------------------------------------------------------------------------

// Read-only whitelist, mirroring the convention in
// ../subagents/tools/git-inspect.ts. Only "log" is actually issued today;
// the whitelist exists so this helper can never be pointed at a mutating
// subcommand if it grows more call sites later.
const ALLOWED_GIT_SEED_SUBCOMMANDS = new Set(["log", "diff", "status"]);
const GIT_SEED_TIMEOUT_MS = 3_000;

function runGitSeedCommand(cwd: string, subcommand: string, args: string[]): Promise<string | undefined> {
  if (!ALLOWED_GIT_SEED_SUBCOMMANDS.has(subcommand)) {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    execFile(
      "git",
      [subcommand, ...args],
      { cwd, timeout: GIT_SEED_TIMEOUT_MS, encoding: "utf-8", maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        // Not a git repo, git not installed, or the command failed/timed out —
        // resolve gracefully rather than throwing; the caller skips the
        // first-turn suggestion entirely when this resolves to undefined.
        resolve(!error && stdout.trim() ? stdout.trim() : undefined);
      },
    );
  });
}

/** Fetch recent git log output to seed a first-turn suggestion, or `undefined` if unavailable. */
export function fetchGitSeedOutput(cwd: string): Promise<string | undefined> {
  return runGitSeedCommand(cwd, "log", ["--oneline", "-20"]);
}

// ---------------------------------------------------------------------------
// Background suggestion request
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 4_000;

type CachedSuggestionSession = {
  session: AgentSession;
  modelKey: string;
};

let cachedSession: CachedSuggestionSession | null = null;

// Mirrors btw.ts's `sideBusy` guard: without it, two overlapping
// agent_end-triggered calls (however rare in practice — e.g. a very fast
// follow-up turn while a slow background request is still in flight) could
// have one call dispose/reuse `cachedSession` out from under the other.
let suggestionBusy = false;

function getModelKey(ctx: ExtensionContext): string {
  const model = ctx.model;
  return model ? `${model.provider}/${model.id}` : "none";
}

/**
 * Minimal ResourceLoader that skips skill/prompt/theme/extension discovery
 * entirely and reuses the parent conversation's current system prompt, so
 * the side session stays cheap and its system-prompt prefix matches the
 * parent's (maximizing provider-side prompt-cache reuse).
 */
function createSuggestionResourceLoader(ctx: ExtensionContext): ResourceLoader {
  const systemPrompt = ctx.getSystemPrompt();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function disposeCachedSession(): Promise<void> {
  const current = cachedSession;
  cachedSession = null;
  if (!current) {
    return;
  }
  try {
    await current.session.abort();
  } catch {
    // Ignore abort errors during cleanup.
  }
  current.session.dispose();
}

/**
 * Reset all suggestion-generation state: drop the busy guard and dispose the
 * cached side session. Call this on `session_shutdown` — the cached session
 * and its resource loader (which snapshots the parent's system prompt and
 * model at creation time, see `createSuggestionResourceLoader`) are only
 * valid for the session that created them, and this module's state persists
 * across a session switch within the same process (pi's extension loader
 * only re-runs the extension's default-export factory per session load; it
 * does not reset the module's top-level state until an actual `/reload`
 * bumps its extension cache generation).
 */
export async function resetSuggestionSession(): Promise<void> {
  suggestionBusy = false;
  await disposeCachedSession();
}

/** Reuse a cached side session for the current model, or create a new one. */
async function ensureSuggestionSession(ctx: ExtensionContext): Promise<AgentSession | undefined> {
  if (!ctx.model) {
    return undefined;
  }

  const expectedModelKey = getModelKey(ctx);
  if (cachedSession && cachedSession.modelKey === expectedModelKey) {
    return cachedSession.session;
  }

  await disposeCachedSession();

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
    thinkingLevel: "off",
    tools: [],
    resourceLoader: createSuggestionResourceLoader(ctx),
  });

  cachedSession = { session, modelKey: expectedModelKey };
  return session;
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("ghost-suggest: request timed out"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("ghost-suggest: request timed out")), { once: true });
  });
}

/**
 * Run a cheap background suggestion request against a cached side session
 * that reuses the parent conversation's model. For later turns, pass
 * `seedMessages` (from `buildSessionContext`) to seed the side session with
 * the parent conversation before prompting.
 *
 * Never throws: any error or timeout resolves to `undefined` so a slow or
 * failed background call can never block the user.
 */
export async function runSuggestionRequest(
  ctx: ExtensionContext,
  seedPrompt: string,
  seedMessages?: AgentMessage[],
): Promise<string | undefined> {
  if (suggestionBusy) {
    // An overlapping call is still using cachedSession — skip rather than
    // risk it being disposed/reused out from under that call.
    return undefined;
  }
  // Set the guard synchronously, in the same tick as the check above and
  // before the first `await` — otherwise two overlapping calls could both
  // pass the check above before either sets the flag, then both race into
  // ensureSuggestionSession() and stomp on the module-level cachedSession.
  suggestionBusy = true;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const session = await ensureSuggestionSession(ctx);
    if (!session) {
      return undefined;
    }

    if (seedMessages && seedMessages.length > 0) {
      session.agent.state.messages = seedMessages;
    }

    await Promise.race([session.prompt(seedPrompt, { source: "extension" }), rejectOnAbort(controller.signal)]);

    const rawText = extractLastAssistantText(session.state.messages);
    return rawText ? sanitizeSuggestion(rawText) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeoutHandle);
    if (controller.signal.aborted) {
      // The prompt call may still be in flight after a timeout; abort it so
      // it doesn't keep streaming into a session we're about to reuse.
      await disposeCachedSession();
    }
    suggestionBusy = false;
  }
}
