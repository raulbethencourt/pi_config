/**
 * Ghost-text next-message suggestion extension (pi-improvement-plan item #19).
 *
 * After each agent turn ends, offers a short, grayed-out suggestion for the
 * user's next message directly in the (otherwise empty) input box — seeded
 * from recent git history on a session's first turn, and from the ongoing
 * conversation afterward. Accepted with Tab/Right-arrow, dismissed by typing.
 *
 * See guards.ts for the eligibility checks, generate.ts for prompt-building
 * and the background generation request, and editor.ts for the ghost-text
 * rendering/input-handling.
 */
import type { AgentEndEvent, ExtensionAPI, ExtensionContext, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { GhostTextEditor } from "./editor.ts";
import {
  fetchGitSeedOutput,
  buildFirstTurnSeedPrompt,
  buildLaterTurnSeedPrompt,
  resetSuggestionSession,
  runSuggestionRequest,
} from "./generate.ts";
import { isFirstTurn, shouldOfferSuggestion } from "./guards.ts";

// Installed lazily on the first eligible agent_end, then reused for every
// subsequent one — see ensureGhostTextEditor().
let ghostEditor: GhostTextEditor | undefined;

function ensureGhostTextEditor(ctx: ExtensionContext): void {
  if (ghostEditor) {
    return;
  }

  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    ghostEditor = new GhostTextEditor(tui, theme, keybindings, ctx.ui.theme);
    return ghostEditor;
  });
}

async function handleAgentEnd(event: AgentEndEvent, ctx: ExtensionContext): Promise<void> {
  if (!shouldOfferSuggestion(ctx, event)) {
    return;
  }

  // Install the custom editor synchronously, as soon as we know we're going
  // to offer a suggestion this turn — before any async work (in particular,
  // the first-turn git-log fetch, which can take a few seconds). That keeps
  // the gap between "decided to offer a suggestion" and "editor is swapped
  // in" at zero, so there's no window for a user to start typing against an
  // editor identity that's about to change mid-edit. The suggestion text
  // itself is fine to arrive later, via setSuggestion() once generation
  // finishes; pi's setCustomEditorComponent already carries the in-flight
  // text across the swap (it reads the outgoing editor's getText() and calls
  // setText() on the new one), so eligibility alone is enough to install it.
  ensureGhostTextEditor(ctx);

  let seedPrompt: string;
  let seedMessages: ReturnType<typeof buildSessionContext>["messages"] | undefined;

  if (isFirstTurn(ctx.sessionManager.getEntries())) {
    const gitLog = await fetchGitSeedOutput(ctx.cwd);
    if (!gitLog) {
      // No git history available (not a repo, git missing, etc.) — skip
      // rather than offering a suggestion with no material to draw from.
      return;
    }
    seedPrompt = buildFirstTurnSeedPrompt(gitLog);
  } else {
    seedPrompt = buildLaterTurnSeedPrompt();
    seedMessages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
  }

  const suggestion = await runSuggestionRequest(ctx, seedPrompt, seedMessages);
  if (suggestion) {
    ghostEditor?.setSuggestion(suggestion);
  }
}

/**
 * Reset this extension's module-level singletons on session shutdown.
 *
 * pi's extension loader caches the loaded module across a session switch
 * within the same process — the default-export factory below is re-invoked
 * per session load (so `agent_end`/`session_shutdown` get re-registered on
 * the new session's event bus), but top-level state like `ghostEditor` and
 * generate.ts's cached side session is NOT reset, only cleared by an actual
 * `/reload`. The host does reset its own custom-editor-component slot back
 * to the default editor before a switch (see `resetExtensionUI()` in
 * interactive-mode), but without this handler `ensureGhostTextEditor()`'s
 * `if (ghostEditor) return;` guard would still see the stale reference and
 * never re-install a fresh editor for the new session, silently breaking the
 * feature after any session switch. `session_shutdown` covers exactly the
 * "quit" / "reload" / "new" / "resume" / "fork" cases that can leave this
 * state stale.
 */
async function handleSessionShutdown(_event: SessionShutdownEvent, _ctx: ExtensionContext): Promise<void> {
  ghostEditor = undefined;
  await resetSuggestionSession();
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", handleAgentEnd);
  pi.on("session_shutdown", handleSessionShutdown);
}
