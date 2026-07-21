/**
 * Regression test for a dormant bug that used to live in
 * `agent/extensions/btw.ts`'s (unexported) `createSideSession` function:
 *
 *   const seedMessages = buildSeedMessages(ctx, thread);
 *   if (seedMessages.length > 0) {
 *     session.agent.replaceMessages(seedMessages as typeof session.state.messages);
 *   }
 *
 * `session.agent.replaceMessages` does not exist on the real installed `Agent`
 * class from `@earendil-works/pi-agent-core` — see
 * `agent/extensions/ghost-suggest/agent-state-messages.test.ts`, which already
 * pins that down for a bare `new Agent()`. This file exercises the same
 * absence one level closer to btw.ts's actual call site: it builds a
 * `session` via `createAgentSession` — the exact same SDK function
 * `createSideSession` calls — so `session.agent` here is constructed through
 * the identical real (non-mocked) code path btw.ts relies on, not a
 * hand-built `Agent`.
 *
 * `createSideSession` itself is still not exported from btw.ts (the whole
 * extension is a default-exported factory with internal closures), but the
 * seeding assignment itself was extracted into the exported
 * `seedSideSessionMessages` helper so it could be exercised directly here
 * instead of duplicating the buggy call shape inline.
 */
import { describe, it, expect } from "vitest";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  SessionManager,
  createExtensionRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { seedSideSessionMessages } from "../extensions/btw.ts";

/** Minimal stand-in for btw.ts's own `createBtwResourceLoader`, using only the real `ResourceLoader` interface. */
function createStubResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "",
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

describe("btw.ts's seedSideSessionMessages call (real Agent, via the real createAgentSession SDK call)", () => {
  it("seeds session.agent's transcript with prior thread history without throwing (desired behavior of createSideSession's seed-message branch)", async () => {
    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      modelRegistry: ModelRegistry.create(AuthStorage.inMemory()),
      settingsManager: SettingsManager.inMemory(),
      resourceLoader: createStubResourceLoader(),
      thinkingLevel: "off",
    });

    const seedMessages = [{ role: "user", content: [{ type: "text", text: "seed" }] }] as unknown as typeof session.state.messages;

    // This is the exact call btw.ts's createSideSession makes via the
    // extracted seedSideSessionMessages helper. It should seed the side
    // session's transcript without throwing. Before the fix, the inline
    // call was `session.agent.replaceMessages(...)`, which threw a
    // TypeError because `replaceMessages` does not exist on the real
    // installed Agent class — this is the bug under test (item 19 / item 20 /
    // pi-improvement-plan.md), demonstrated here one call-shape closer to
    // btw.ts's actual code than the pre-existing bare-`new Agent()` assertion in
    // agent/extensions/ghost-suggest/agent-state-messages.test.ts.
    expect(() => {
      seedSideSessionMessages(session, seedMessages);
    }).not.toThrow();

    expect(session.state.messages).toEqual(seedMessages);
  });
});
