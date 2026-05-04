import { defineConfig } from "vitest/config";

const PI_NODE_MODULES = "/home/rabeta/.config/nvm/versions/node/v24.15.0/lib/node_modules/@mariozechner/pi-coding-agent/node_modules";
const PI_PKG = "/home/rabeta/.config/nvm/versions/node/v24.15.0/lib/node_modules/@mariozechner/pi-coding-agent";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@mariozechner/pi-coding-agent": PI_PKG,
      "@mariozechner/pi-tui": `${PI_NODE_MODULES}/@mariozechner/pi-tui`,
      "@mariozechner/pi-ai": `${PI_NODE_MODULES}/@mariozechner/pi-ai`,
      "@mariozechner/pi-agent-core": `${PI_NODE_MODULES}/@mariozechner/pi-agent-core`,
      "typebox": `${PI_NODE_MODULES}/typebox`,
      "shell-quote": "/home/rabeta/.pi/agent/extensions/bash-guard/node_modules/shell-quote",
    },
  },
});
