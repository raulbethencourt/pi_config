import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const GLOBAL_COMMANDS_DIR = path.join(os.homedir(), ".pi", "agent", "commands");

export default function commandsLoader(pi: ExtensionAPI) {
    pi.on("resources_discover", async (event, _ctx) => {
        const promptPaths: string[] = [GLOBAL_COMMANDS_DIR];
        const localCommandsDir = path.join(event.cwd, ".pi", "commands");
        if (fs.existsSync(localCommandsDir)) {
            promptPaths.push(localCommandsDir);
        }
        return { promptPaths };
    });
}
