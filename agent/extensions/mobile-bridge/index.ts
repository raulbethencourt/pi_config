import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import type {
    AgentEndEvent,
    ExtensionAPI,
    ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

const SMOKE_TOKEN = "MOBILE_BRIDGE_SMOKE_OK";
const SMOKE_PROMPT = `Reply exactly: ${SMOKE_TOKEN}`;
const DEFAULT_PORT = 4321;
const MAX_ANSWERS = 10;
const SERVER_HOST = "0.0.0.0";
const STATUS_HOST = "127.0.0.1";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const KDECONNECT_PREFIX = "Pi finished: ";
const MAX_NOTIFICATION_PREVIEW = 80;
const KDECONNECT_TIMEOUT_MS = 5_000;
const MAX_DEBUG_VALUE_LENGTH = 72;

const KDECONNECT_DETECTION_COMMANDS = [
    { command: "kdeconnect-cli", args: ["--list-devices", "--id-only"], parser: "idOnly" },
    { command: "kdeconnect-cli", args: ["--list-devices"], parser: "list" },
    { command: "/usr/bin/kdeconnect-cli", args: ["--list-devices", "--id-only"], parser: "idOnly" },
    { command: "/usr/bin/kdeconnect-cli", args: ["--list-devices"], parser: "list" },
] as const;

type KdeConnectDetectionAttempt = {
    command: string;
    args: string[];
    status: number | null;
    stdout: string;
    stderr: string;
    error?: string;
    parsedId?: string;
};

type KdeConnectDetection = {
    deviceId?: string;
    envDeviceId?: string;
    attempts: KdeConnectDetectionAttempt[];
};

let cachedKdeConnectDetection: KdeConnectDetection | undefined;
let hasCachedKdeConnectDetection = false;

function extractAssistantText(event: AgentEndEvent): string | undefined {
    const messages = Array.isArray(event?.messages) ? event.messages : [];

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index] as {
            role?: string;
            content?: unknown;
        };

        if (message?.role !== "assistant") {
            continue;
        }

        const content = message.content;
        if (typeof content === "string") {
            return content;
        }

        if (!Array.isArray(content)) {
            return undefined;
        }

        const text = content
            .filter((part): part is { type?: string; text?: unknown } => typeof part === "object" && part !== null)
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("");

        return text || undefined;
    }

    return undefined;
}

function parsePort(value: string | undefined): number {
    if (!value) {
        return DEFAULT_PORT;
    }

    const port = Number.parseInt(value, 10);
    return Number.isInteger(port) && port >= 0 ? port : DEFAULT_PORT;
}

export function resolveStatusHost(
    envHost?: string,
    interfaces?: ReturnType<typeof networkInterfaces>,
): string {
    const host = envHost?.trim();
    if (host) {
        return host;
    }

    const resolvedInterfaces = interfaces ?? networkInterfaces();

    for (const entries of Object.values(resolvedInterfaces)) {
        for (const entry of entries || []) {
            if (!entry || entry.internal) {
                continue;
            }

            if (entry.family === "IPv4" || entry.family === 4) {
                return entry.address;
            }
        }
    }

    return STATUS_HOST;
}

function createNotificationPreview(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) {
        return KDECONNECT_PREFIX.trimEnd();
    }

    const available = MAX_NOTIFICATION_PREVIEW - KDECONNECT_PREFIX.length;
    if (normalized.length <= available) {
        return `${KDECONNECT_PREFIX}${normalized}`;
    }

    if (available <= 1) {
        return `${KDECONNECT_PREFIX.slice(0, Math.max(0, MAX_NOTIFICATION_PREVIEW - 1))}…`;
    }

    return `${KDECONNECT_PREFIX}${normalized.slice(0, available - 1).trimEnd()}…`;
}

function normalizeSpawnOutput(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (Buffer.isBuffer(value)) {
        return value.toString("utf8");
    }

    return "";
}

function parseKdeConnectIdOnly(stdout: string): string | undefined {
    return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
}

function parseKdeConnectList(stdout: string): string | undefined {
    for (const line of stdout.split(/\r?\n/)) {
        const match = line.match(/:\s*([a-f0-9]+)\s+on\s+/i);
        if (match?.[1]) {
            return match[1];
        }
    }

    return undefined;
}

function truncateDebugValue(value: string, maxLength = MAX_DEBUG_VALUE_LENGTH): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

async function detectKdeConnectDevice(options?: { refresh?: boolean }): Promise<KdeConnectDetection> {
    const envDeviceId = process.env.PI_MOBILE_BRIDGE_KDE_DEVICE_ID?.trim();
    if (envDeviceId) {
        return {
            deviceId: envDeviceId,
            envDeviceId,
            attempts: [],
        };
    }

    if (!options?.refresh && hasCachedKdeConnectDetection) {
        return cachedKdeConnectDetection || { attempts: [] };
    }

    const attempts: KdeConnectDetectionAttempt[] = [];

    try {
        const childProcess = await import("node:child_process");
        const runSpawnSync = childProcess.spawnSync || spawnSync;

        if (typeof runSpawnSync !== "function") {
            attempts.push({
                command: "spawnSync",
                args: [],
                status: null,
                stdout: "",
                stderr: "",
                error: "spawnSync unavailable",
            });
            cachedKdeConnectDetection = { attempts };
            hasCachedKdeConnectDetection = true;
            return cachedKdeConnectDetection;
        }

        for (const attempt of KDECONNECT_DETECTION_COMMANDS) {
            try {
                const result = runSpawnSync(attempt.command, [...attempt.args], {
                    encoding: "utf8",
                    timeout: KDECONNECT_TIMEOUT_MS,
                });
                const stdout = normalizeSpawnOutput(result.stdout);
                const stderr = normalizeSpawnOutput(result.stderr);
                const parsedId = attempt.parser === "idOnly"
                    ? parseKdeConnectIdOnly(stdout)
                    : parseKdeConnectList(stdout);

                attempts.push({
                    command: attempt.command,
                    args: [...attempt.args],
                    status: typeof result.status === "number" ? result.status : null,
                    stdout,
                    stderr,
                    error: result.error?.message,
                    parsedId,
                });

                if (!result.error && result.status === 0 && parsedId) {
                    cachedKdeConnectDetection = {
                        deviceId: parsedId,
                        attempts,
                    };
                    hasCachedKdeConnectDetection = true;
                    return cachedKdeConnectDetection;
                }
            } catch (error) {
                attempts.push({
                    command: attempt.command,
                    args: [...attempt.args],
                    status: null,
                    stdout: "",
                    stderr: "",
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    } catch (error) {
        attempts.push({
            command: "kdeconnect-detect",
            args: [],
            status: null,
            stdout: "",
            stderr: "",
            error: error instanceof Error ? error.message : String(error),
        });
    }

    cachedKdeConnectDetection = { attempts };
    hasCachedKdeConnectDetection = true;
    return cachedKdeConnectDetection;
}

async function getKdeConnectDeviceId(): Promise<string | undefined> {
    const detection = await detectKdeConnectDevice();
    return detection.deviceId;
}

function formatKdeDeviceInfo(deviceId: string | undefined): string {
    return deviceId ? `kde: ${deviceId}` : "kde: no KDE device";
}

function formatKdeConnectDebug(detection: KdeConnectDetection): string {
    const parts = [
        "mobile devices debug — kde debug",
        `PATH=${truncateDebugValue(process.env.PATH || "", 120)}`,
    ];

    if (detection.envDeviceId) {
        parts.push(`env=${detection.envDeviceId}`);
        parts.push("commands=skipped (env override)");
    } else {
        for (const attempt of detection.attempts) {
            const command = `${attempt.command} ${attempt.args.join(" ")}`.trim();
            const details = [
                `${command || "command"} status=${attempt.status ?? "none"}`,
            ];

            if (attempt.error) {
                details.push(`error=${truncateDebugValue(attempt.error)}`);
            }
            if (attempt.stdout) {
                details.push(`stdout=${truncateDebugValue(attempt.stdout)}`);
            }
            if (attempt.stderr) {
                details.push(`stderr=${truncateDebugValue(attempt.stderr)}`);
            }
            if (attempt.parsedId) {
                details.push(`id=${attempt.parsedId}`);
            }

            parts.push(details.join(" "));
        }

        if (!detection.attempts.length) {
            parts.push("commands=none");
        }
    }

    parts.push(`final=${detection.deviceId || "none"}`);
    return parts.join("; ");
}

async function createKdeConnectArgs(baseArgs: string[]): Promise<{ args: string[]; deviceId?: string }> {
    const deviceId = await getKdeConnectDeviceId();
    return {
        args: deviceId ? [...baseArgs, "-d", deviceId] : baseArgs,
        deviceId,
    };
}

async function createKdeConnectShareArgs(url: string): Promise<{ args: string[]; deviceId?: string }> {
    return createKdeConnectArgs(["--share", url]);
}

async function createKdeConnectPingArgs(preview: string): Promise<{ args: string[]; deviceId?: string }> {
    return createKdeConnectArgs(["--ping-msg", preview]);
}

async function notifyKdeConnect(text: string) {
    try {
        const preview = createNotificationPreview(text);
        const childProcess = await import("node:child_process");
        const { args } = await createKdeConnectPingArgs(preview);
        const child = (childProcess.spawn || spawn)("kdeconnect-cli", args, { stdio: "ignore" });
        child.on("error", () => undefined);
        child.unref?.();
    } catch {
        // Ignore notification failures.
    }
}

function consumeRateLimit(
    requestsByClient: Map<string, number[]>,
    clientIp: string,
    now = Date.now(),
): boolean {
    const recentRequests = (requestsByClient.get(clientIp) || []).filter(
        (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
    );

    if (recentRequests.length >= RATE_LIMIT_MAX_REQUESTS) {
        requestsByClient.set(clientIp, recentRequests);
        return false;
    }

    recentRequests.push(now);
    requestsByClient.set(clientIp, recentRequests);
    return true;
}

function json(response: ServerResponse, statusCode: number, body: unknown) {
    response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
}

function html(response: ServerResponse, statusCode: number, body: string) {
    response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body);
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";

        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.on("end", () => resolve(body));
        request.on("error", reject);
    });
}

function createIndexHtml() {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pi Mobile Bridge</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; background: #111827; color: #f9fafb; }
    main { max-width: 32rem; margin: 0 auto; }
    textarea, input, button { width: 100%; box-sizing: border-box; margin-top: 0.75rem; }
    textarea, input { padding: 0.75rem; border-radius: 0.75rem; border: 1px solid #374151; background: #1f2937; color: inherit; }
    button { padding: 0.9rem; border: 0; border-radius: 0.75rem; background: #2563eb; color: white; font-weight: 600; }
    pre { white-space: pre-wrap; background: #1f2937; padding: 0.75rem; border-radius: 0.75rem; }
    .muted { color: #9ca3af; }
  </style>
</head>
<body>
  <main>
    <h1>Pi Mobile Bridge</h1>
    <p class="muted">Use the token from <code>/mobile status</code> to send prompts and inspect recent answers.</p>
    <input id="token" placeholder="token" />
    <textarea id="message" rows="5" placeholder="Send a message to Pi"></textarea>
    <button id="send">Send</button>
    <pre id="result">Ready.</pre>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    const tokenInput = document.getElementById('token');
    const messageInput = document.getElementById('message');
    const result = document.getElementById('result');
    tokenInput.value = params.get('token') || '';

    document.getElementById('send').addEventListener('click', async () => {
      const token = tokenInput.value.trim();
      const message = messageInput.value.trim();
      const response = await fetch('/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, message }),
      });
      const data = await response.json().catch(() => ({}));
      result.textContent = JSON.stringify(data, null, 2);
    });
  </script>
</body>
</html>`;
}

async function notifyStatus(
    ctx: ExtensionCommandContext,
    pendingSmoke: boolean,
    lastAnswer: string | undefined,
    serverUrl: string | undefined,
    busy: boolean,
) {
    const answerText = lastAnswer?.trim() ? lastAnswer : "no answer yet";
    const bridgeText = serverUrl ? `; bridge: ${serverUrl}` : "; bridge: offline";
    const kdeText = formatKdeDeviceInfo(await getKdeConnectDeviceId());
    ctx.ui.notify(
        `mobile status — pending smoke: ${pendingSmoke ? "yes" : "no"}; busy: ${busy ? "yes" : "no"}; last answer: ${answerText}${bridgeText}; ${kdeText}`,
    );
}

async function notifyDevices(ctx: ExtensionCommandContext) {
    ctx.ui.notify(`mobile devices — ${formatKdeDeviceInfo(await getKdeConnectDeviceId())}`);
}

async function notifyDevicesDebug(ctx: ExtensionCommandContext) {
    ctx.ui.notify(formatKdeConnectDebug(await detectKdeConnectDevice({ refresh: true })));
}

function notifyHelp(ctx: ExtensionCommandContext) {
    ctx.ui.notify("mobile help — use /mobile smoke, /mobile status, /mobile devices, /mobile devices debug, or /mobile link");
}

export default function (pi: ExtensionAPI) {
    cachedKdeConnectDetection = undefined;
    hasCachedKdeConnectDetection = false;

    let pendingSmoke = false;
    let lastAnswer: string | undefined;
    let smokeCtx: ExtensionCommandContext | undefined;
    let busy = false;
    let answers: string[] = [];
    let server: Server | undefined;
    let serverPort: number | undefined;
    const token = randomBytes(32).toString("hex");
    const requestsByClient = new Map<string, number[]>();

    const getServerUrl = () => (
        serverPort
            ? `http://${resolveStatusHost(process.env.PI_MOBILE_BRIDGE_HOST, networkInterfaces())}:${serverPort}/?token=${token}`
            : undefined
    );

    const shareBridgeLink = async (url: string) => {
        try {
            const childProcess = await import("node:child_process");
            const { args, deviceId } = await createKdeConnectShareArgs(url);
            const child = (childProcess.spawn || spawn)("kdeconnect-cli", args, {
                stdio: "ignore",
            });
            child.on("error", () => undefined);
            child.on("exit", () => undefined);
            child.unref?.();
            return deviceId;
        } catch {
            // Ignore share failures.
            return undefined;
        }
    };

    const closeServer = async () => {
        if (!server) {
            serverPort = undefined;
            return;
        }

        const activeServer = server;
        server = undefined;
        serverPort = undefined;

        await new Promise<void>((resolve, reject) => {
            activeServer.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    };

    const startServer = async () => {
        if (server && server.listening) {
            return;
        }

        const requestHandler = async (request: IncomingMessage, response: ServerResponse) => {
            try {
                const url = new URL(request.url || "/", `http://${STATUS_HOST}`);

                if (request.method === "GET" && url.pathname === "/health") {
                    json(response, 200, { alive: true, timestamp: Date.now() });
                    return;
                }

                if (request.method === "GET" && url.pathname === "/answers") {
                    if (url.searchParams.get("token") !== token) {
                        json(response, 401, { error: "unauthorized" });
                        return;
                    }

                    json(response, 200, { answers });
                    return;
                }

                if (request.method === "POST" && url.pathname === "/send") {
                    const rawBody = await readBody(request);
                    const body = rawBody ? JSON.parse(rawBody) as { token?: unknown; message?: unknown } : {};

                    if (body.token !== token) {
                        json(response, 401, { error: "unauthorized" });
                        return;
                    }

                    if (typeof body.message !== "string" || !body.message.trim()) {
                        json(response, 400, { error: "message required" });
                        return;
                    }

                    const clientIp = request.socket.remoteAddress || "unknown";
                    if (!consumeRateLimit(requestsByClient, clientIp)) {
                        json(response, 429, { error: "rate limit exceeded" });
                        return;
                    }

                    if (busy) {
                        pi.sendUserMessage(body.message, { deliverAs: "followUp" });
                        json(response, 200, { success: true, queued: true });
                        return;
                    }

                    pi.sendUserMessage(body.message);
                    json(response, 200, { success: true, queued: false });
                    return;
                }

                if (request.method === "GET" && url.pathname === "/") {
                    html(response, 200, createIndexHtml());
                    return;
                }

                json(response, 404, { error: "not found" });
            } catch {
                json(response, 400, { error: "bad request" });
            }
        };

        server = createServer((request, response) => {
            void requestHandler(request, response);
        });

        const requestedPort = parsePort(process.env.PI_MOBILE_BRIDGE_PORT);

        await new Promise<void>((resolve, reject) => {
            server!.once("error", reject);
            server!.listen(requestedPort, SERVER_HOST, () => {
                const address = server!.address();
                server!.off("error", reject);

                if (!address || typeof address === "string") {
                    reject(new Error("Unable to resolve mobile bridge port"));
                    return;
                }

                serverPort = address.port;
                resolve();
            });
        });
    };

    pi.registerCommand("mobile", {
        description: "Mobile bridge smoke helpers",
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/).filter(Boolean).map((part) => part.toLowerCase());
            const subcommand = parts[0];
            const detail = parts[1];

            if (!subcommand || subcommand === "status") {
                await notifyStatus(ctx, pendingSmoke, lastAnswer, getServerUrl(), busy);
                return;
            }

            if (subcommand === "smoke") {
                smokeCtx = ctx;
                pendingSmoke = true;
                pi.sendUserMessage(SMOKE_PROMPT);
                ctx.ui.notify("mobile smoke started — waiting for assistant reply");
                return;
            }

            if (subcommand === "devices") {
                if (detail === "debug") {
                    await notifyDevicesDebug(ctx);
                    return;
                }

                await notifyDevices(ctx);
                return;
            }

            if (subcommand === "link") {
                const serverUrl = getServerUrl();
                if (!server?.listening || !serverUrl) {
                    ctx.ui.notify("mobile link not running — start a session first");
                    return;
                }

                const deviceId = await shareBridgeLink(serverUrl);
                ctx.ui.notify(
                    deviceId
                        ? `mobile link sent to ${deviceId} — ${serverUrl}`
                        : `mobile link sent — ${serverUrl}; no KDE device`,
                );
                return;
            }

            notifyHelp(ctx);
        },
    });

    pi.on("session_start", async (_event, _ctx) => {
        await startServer();
        await getKdeConnectDeviceId();
    });

    pi.on("session_shutdown", async () => {
        await closeServer();
    });

    pi.on("agent_start", async () => {
        busy = true;
    });

    pi.on("agent_end", async (event) => {
        busy = false;

        const text = extractAssistantText(event);
        if (!text) {
            return;
        }

        lastAnswer = text;
        answers = [...answers, text].slice(-MAX_ANSWERS);
        await notifyKdeConnect(text);

        if (!pendingSmoke || !text.includes(SMOKE_TOKEN)) {
            return;
        }

        pendingSmoke = false;
        smokeCtx?.ui.notify("mobile smoke success — token captured");
        smokeCtx = undefined;
    });
}
