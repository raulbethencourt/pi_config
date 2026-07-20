import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAllowedPersonas } from "../extensions/mcp-server/agent-loader.ts";

const AGENTS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "extensions",
  "subagents",
  "agents",
);

describe("loadAllowedPersonas — structural guarantees", () => {
  it("loads exactly the 6 allowlisted personas", () => {
    const personas = loadAllowedPersonas();
    const names = personas.map((p) => p.name).sort();
    expect(names).toEqual(
      ["codereviewer", "codereviewer-deep", "critic", "planner", "researcher", "scout"].sort(),
    );
  });

  it("strips mcpTools from scout/researcher even though their real frontmatter declares it", () => {
    // Sanity: confirm the raw source files actually declare mcpTools, so this
    // test would fail loudly (not vacuously pass) if the fixtures changed.
    const scoutRaw = fs.readFileSync(path.join(AGENTS_DIR, "scout.md"), "utf-8");
    const researcherRaw = fs.readFileSync(path.join(AGENTS_DIR, "researcher.md"), "utf-8");
    expect(scoutRaw).toMatch(/^mcpTools:/m);
    expect(researcherRaw).toMatch(/^mcpTools:/m);

    const personas = loadAllowedPersonas();
    const scout = personas.find((p) => p.name === "scout");
    const researcher = personas.find((p) => p.name === "researcher");
    expect(scout).toBeDefined();
    expect(researcher).toBeDefined();

    expect(scout).not.toHaveProperty("mcpTools");
    expect(researcher).not.toHaveProperty("mcpTools");
    expect((scout as any).mcpTools).toBeUndefined();
    expect((researcher as any).mcpTools).toBeUndefined();
  });

  it("excludes 'memory' from scout's tools list even though the raw frontmatter includes it", () => {
    const scoutRaw = fs.readFileSync(path.join(AGENTS_DIR, "scout.md"), "utf-8");
    expect(scoutRaw).toMatch(/\bmemory\b/);

    const personas = loadAllowedPersonas();
    const scout = personas.find((p) => p.name === "scout")!;
    expect(scout.tools).not.toContain("memory");
  });

  it("excludes 'memory' from planner's tools list even though the raw frontmatter includes it", () => {
    const plannerRaw = fs.readFileSync(path.join(AGENTS_DIR, "planner.md"), "utf-8");
    expect(plannerRaw).toMatch(/\bmemory\b/);

    const personas = loadAllowedPersonas();
    const planner = personas.find((p) => p.name === "planner")!;
    expect(planner.tools).not.toContain("memory");
  });

  it("is a closed allowlist: a 7th persona .md file dropped into the agents dir is never loaded", () => {
    const extraFilePath = path.join(AGENTS_DIR, "__test-extra-persona__.md");
    const extraContent = `---
name: test-extra-persona
description: should never be loaded by the closed allowlist
tools: read
model: anthropic/claude-sonnet-4-6
---

This persona should never surface via loadAllowedPersonas().
`;
    fs.writeFileSync(extraFilePath, extraContent, "utf-8");
    try {
      const personas = loadAllowedPersonas();
      const names = personas.map((p) => p.name);
      expect(names).not.toContain("test-extra-persona");
      expect(personas).toHaveLength(6);
    } finally {
      fs.rmSync(extraFilePath, { force: true });
    }
  });
});
