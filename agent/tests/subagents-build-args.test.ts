import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiArgs } from "../extensions/subagents/build-args.ts";

// Minimal shape matching AgentConfig from ../extensions/subagents/index.ts.
// Deliberately not imported at runtime (only a type import would be erased
// anyway) so this test never depends on index.ts's value-importing module graph.
interface TestAgentConfig {
  name: string;
  description: string;
  tools: string[];
  mcpTools?: string;
  skills: string[];
  model: string;
  provider?: string;
  thinking?: string;
  systemPrompt: string;
  filePath: string;
}

const tempDirsToClean: string[] = [];

afterEach(() => {
  for (const dir of tempDirsToClean.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function scoutLikeAgent(): TestAgentConfig {
  return {
    name: "test-scout-build-args",
    description: "test scout-like agent with custom tools",
    tools: ["read", "grep", "ast_grep", "repo_map"],
    skills: [],
    model: "opencode/deepseek-v4-flash-free",
    thinking: "off",
    systemPrompt: "You are a test scout agent.",
    filePath: "/tmp/test-scout-build-args.md",
  };
}

function plannerLikeAgent(): TestAgentConfig {
  return {
    name: "test-planner-build-args",
    description: "test planner-like agent with only builtin tools",
    tools: ["read", "grep", "ls"],
    skills: [],
    model: "github-copilot/claude-sonnet-4.6",
    thinking: "minimal",
    systemPrompt: "You are a test planner agent.",
    filePath: "/tmp/test-planner-build-args.md",
  };
}

describe("buildPiArgs — extraction produced no behavior change", () => {
  it("produces a well-formed piArgs array for a persona with custom tools (scout-like)", async () => {
    const result = await buildPiArgs(scoutLikeAgent() as any, "look at some files", "/tmp");
    tempDirsToClean.push(result.tempDir);

    expect(Array.isArray(result.piArgs)).toBe(true);
    expect(result.piArgs.length).toBeGreaterThan(0);

    // First element is the resolved command; remaining are CLI args.
    const [command, ...args] = result.piArgs;
    expect(typeof command).toBe("string");

    expect(args).toContain("--mode");
    expect(args).toContain("json");
    expect(args).toContain("-p");
    expect(args).toContain("--no-session");
    expect(args).toContain("--no-skills"); // agent.skills is empty
    expect(args).toContain("--no-extensions");

    // Custom tool ast_grep + repo_map + builtins should be in the tool allowlist,
    // and their extension paths should be individually registered via --extension.
    const toolsIdx = args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    const toolsValue = args[toolsIdx + 1];
    const toolsList = toolsValue.split(",");
    expect(toolsList).toEqual(expect.arrayContaining(["read", "grep", "ast_grep", "repo_map"]));

    const extensionArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--extension") extensionArgs.push(args[i + 1]);
    }
    expect(extensionArgs.some((p) => p.includes("ast-grep"))).toBe(true);
    expect(extensionArgs.some((p) => p.includes("repo-map"))).toBe(true);

    expect(args).toContain("--models");
    const modelIdx = args.indexOf("--models");
    expect(typeof args[modelIdx + 1]).toBe("string");
    expect(args[modelIdx + 1].length).toBeGreaterThan(0);

    expect(args).toContain("--thinking");
    const thinkingIdx = args.indexOf("--thinking");
    expect(args[thinkingIdx + 1]).toBe("off");

    expect(args).toContain("--append-system-prompt");
    const promptIdx = args.indexOf("--append-system-prompt");
    const promptPath = args[promptIdx + 1];
    expect(fs.existsSync(promptPath)).toBe(true);
    expect(fs.readFileSync(promptPath, "utf-8")).toBe("You are a test scout agent.");

    // Task is appended as the final positional arg (short tasks are inlined, not written to file)
    expect(args[args.length - 1]).toBe("Task: look at some files");

    expect(typeof result.tier).toBe("string");
    expect(typeof result.usedFallback).toBe("boolean");
    expect(typeof result.routedModel).toBe("string");
    expect(result.env).toMatchObject({ PI_SUBAGENT_DEPTH: "1" });
  });

  it("produces a well-formed piArgs array for a persona with no custom tools (planner-like)", async () => {
    const result = await buildPiArgs(plannerLikeAgent() as any, "make a plan", "/tmp");
    tempDirsToClean.push(result.tempDir);

    const [, ...args] = result.piArgs;

    expect(args).toContain("--no-skills");
    expect(args).toContain("--no-extensions");

    const toolsIdx = args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    const toolsList = args[toolsIdx + 1].split(",");
    expect(toolsList).toEqual(expect.arrayContaining(["read", "grep", "ls"]));

    // No custom-tool extension paths should be registered for this agent's
    // own tools (only always-on extensions like hashline/context-mode may appear).
    const extensionArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--extension") extensionArgs.push(args[i + 1]);
    }
    expect(extensionArgs.some((p) => p.includes("ast-grep"))).toBe(false);
    expect(extensionArgs.some((p) => p.includes("repo-map"))).toBe(false);

    expect(args).toContain("--thinking");
    const thinkingIdx = args.indexOf("--thinking");
    expect(args[thinkingIdx + 1]).toBe("minimal");

    expect(args[args.length - 1]).toBe("Task: make a plan");
  });

  it("writes a long task to a file instead of inlining it", async () => {
    const longTask = "x".repeat(8001);
    const result = await buildPiArgs(plannerLikeAgent() as any, longTask, "/tmp");
    tempDirsToClean.push(result.tempDir);

    const [, ...args] = result.piArgs;
    const lastArg = args[args.length - 1];
    expect(lastArg.startsWith("@")).toBe(true);
    const taskFilePath = lastArg.slice(1);
    expect(fs.existsSync(taskFilePath)).toBe(true);
    expect(fs.readFileSync(taskFilePath, "utf-8")).toBe(`Task: ${longTask}`);
  });
});

describe("buildPiArgs — piBinOverride", () => {
  it("uses the override command/baseArgs for the spawn command regardless of process.argv[1]", async () => {
    const override = { command: "/opt/custom/pi-binary", baseArgs: ["--custom-base-flag"] };
    const result = await buildPiArgs(plannerLikeAgent() as any, "task using override", "/tmp", override);
    tempDirsToClean.push(result.tempDir);

    expect(result.piArgs[0]).toBe(override.command);
    expect(result.piArgs[1]).toBe("--custom-base-flag");
  });

  it("does not fall back to process.argv[1]-derived resolution when an override is supplied", async () => {
    const originalArgv1 = process.argv[1];
    try {
      // Point argv[1] at something that would resolve very differently
      // (a .js entry point) to prove the override wins regardless.
      process.argv[1] = path.join(os.tmpdir(), "some-other-entry.js");
      const override = { command: "pi-forced-override", baseArgs: [] };
      const result = await buildPiArgs(scoutLikeAgent() as any, "task", "/tmp", override);
      tempDirsToClean.push(result.tempDir);
      expect(result.piArgs[0]).toBe("pi-forced-override");
    } finally {
      process.argv[1] = originalArgv1;
    }
  });
});
