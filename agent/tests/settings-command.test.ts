import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SETTINGS_TEMPLATE = {
  lastChangelogVersion: "0.80.2",
  defaultProvider: "github-copilot",
  defaultModel: "gpt-5.4",
  editorPaddingX: 3,
  hideThinkingBlock: false,
  quietStartup: true,
  enableInstallTelemetry: false,
  theme: "gruvbox-material",
  extensions: ["~/.pi/agent/extensions/"],
  packages: ["npm:context-mode"],
  defaultThinkingLevel: "medium",
  shellPath: "/home/rabeta/.local/bin/pi-zsh",
  terminal: { clearOnShrink: false },
  collapseChangelog: true,
  treeFilterMode: "no-tools",
};

describe("settings update command", () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "pi-settings-test-"));
    homeDir = path.join(tmpDir, "home");
    await mkdir(path.join(homeDir, ".pi", "agent"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".pi", "agent", "settings.json"),
      JSON.stringify(SETTINGS_TEMPLATE, null, 2),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses a conversational update request into model and thinking level", async () => {
    vi.stubEnv("HOME", homeDir);

    const mod = await import("../extensions/settings-command.ts");
    expect(typeof mod.parseSettingsUpdateRequest).toBe("function");

    const parsed = mod.parseSettingsUpdateRequest(
      "Set the top-level orchestrator model to anthropic/claude-sonnet-4-6 and thinking level to high",
    );

    expect(parsed).toEqual({
      defaultModel: "anthropic/claude-sonnet-4-6",
      defaultThinkingLevel: "high",
    });
  });

  it("rejects invalid thinking levels before writing settings", async () => {
    vi.stubEnv("HOME", homeDir);

    const mod = await import("../extensions/settings-command.ts");
    expect(() =>
      mod.validateSettingsUpdate({
        defaultModel: "anthropic/claude-sonnet-4-6",
        defaultThinkingLevel: "max" as any,
      }),
    ).toThrow(/thinking level/i);
  });

  it("merges only targeted keys and preserves unrelated settings", async () => {
    vi.stubEnv("HOME", homeDir);

    const mod = await import("../extensions/settings-command.ts");
    expect(typeof mod.applySettingsUpdate).toBe("function");

    await mod.applySettingsUpdate({
      defaultModel: "anthropic/claude-sonnet-4-6",
      defaultThinkingLevel: "high",
    });

    const updated = JSON.parse(
      await readFile(path.join(homeDir, ".pi", "agent", "settings.json"), "utf-8"),
    );

    expect(updated.defaultProvider).toBe("github-copilot");
    expect(updated.theme).toBe("gruvbox-material");
    expect(updated.packages).toEqual(["npm:context-mode"]);
    expect(updated.defaultModel).toBe("anthropic/claude-sonnet-4-6");
    expect(updated.defaultThinkingLevel).toBe("high");
  });
});
