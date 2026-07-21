/**
 * Guard predicates for the ghost-suggest extension (pi-improvement-plan item #19).
 *
 * These decide whether a next-message suggestion should even be attempted,
 * before any (expensive) generation work happens.
 */
import type { AgentEndEvent, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";

/** Context an event handler receives; thin alias over pi's real ExtensionContext. */
export type GhostSuggestContext = ExtensionContext;

/** Re-export of pi's real agent_end event shape. */
export type { AgentEndEvent };

/** A single entry in the session timeline; thin alias over pi's real SessionEntry union. */
export type TimelineEntry = SessionEntry;

/**
 * Decide whether a ghost suggestion should be offered after an agent turn ends.
 *
 * Skips when:
 * - not running in the interactive TUI (no ghost text surface elsewhere)
 * - running inside a subagent (PI_SUBAGENT_DEPTH >= 1)
 * - the last assistant message in this turn ended with an error
 */
export function shouldOfferSuggestion(ctx: GhostSuggestContext, event: AgentEndEvent): boolean {
  if (ctx.mode !== "tui") {
    return false;
  }

  const subagentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
  if (Number.isFinite(subagentDepth) && subagentDepth >= 1) {
    return false;
  }

  const isAssistantMessage = (message: (typeof event.messages)[number]): message is AssistantMessage =>
    message.role === "assistant";
  const lastAssistantMessage = [...event.messages].reverse().find(isAssistantMessage);
  if (lastAssistantMessage?.stopReason === "error") {
    return false;
  }

  return true;
}

/**
 * Whether the current session timeline represents the first user turn.
 *
 * Compaction or branch-summary entries mean history has been condensed, so we
 * can no longer trust a low user-message count to mean "first turn" — treat
 * it as not-first-turn in that case.
 */
export function isFirstTurn(entries: TimelineEntry[]): boolean {
  if (entries.some((entry) => entry.type === "compaction" || entry.type === "branch_summary")) {
    return false;
  }

  const userMessageCount = entries.filter(
    (entry) => entry.type === "message" && entry.message.role === "user",
  ).length;

  return userMessageCount <= 1;
}
