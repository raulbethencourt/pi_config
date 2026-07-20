import { afterEach, describe, expect, it } from "vitest";
import { buildMinimalEnv } from "../extensions/mcp-server/env-allowlist.ts";

const ALLOWED_KEYS = ["PATH", "HOME", "PI_CODING_AGENT_DIR"];

describe("buildMinimalEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  it("returns only keys that are a strict subset of the allowlist, excluding secret-looking env vars", () => {
    process.env.ANTHROPIC_API_KEY = "sk-super-secret-value";
    process.env.GITHUB_TOKEN = "ghp_super_secret_value";
    process.env.PATH = "/usr/bin:/bin";
    process.env.HOME = "/home/testuser";

    const env = buildMinimalEnv();
    const keys = Object.keys(env);

    for (const key of keys) {
      expect(ALLOWED_KEYS).toContain(key);
    }

    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/testuser");
  });

  it("omits PI_CODING_AGENT_DIR entirely (not just as undefined) when it is not set", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/home/testuser";
    process.env.SOME_OTHER_SECRET = "leaky-value";

    const env = buildMinimalEnv();

    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
    expect(env).not.toHaveProperty("SOME_OTHER_SECRET");
  });

  it("includes PI_CODING_AGENT_DIR when it is set on process.env", () => {
    process.env.PI_CODING_AGENT_DIR = "/home/testuser/.pi/agent";
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/home/testuser";

    const env = buildMinimalEnv();

    expect(env.PI_CODING_AGENT_DIR).toBe("/home/testuser/.pi/agent");
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "PI_CODING_AGENT_DIR"]);
  });
});
