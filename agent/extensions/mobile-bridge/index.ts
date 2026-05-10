import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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

function notifyStatus(
    ctx: ExtensionCommandContext,
    pendingSmoke: boolean,
    lastAnswer: string | undefined,
    serverUrl: string | undefined,
    busy: boolean,
) {
    const answerText = lastAnswer?.trim() ? lastAnswer : "no answer yet";
    const bridgeText = serverUrl ? `; bridge: ${serverUrl}` : "; bridge: offline";
    ctx.ui.notify(
        `mobile status — pending smoke: ${pendingSmoke ? "yes" : "no"}; busy: ${busy ? "yes" : "no"}; last answer: ${answerText}${bridgeText}`,
    );
}

function notifyHelp(ctx: ExtensionCommandContext) {
    ctx.ui.notify("mobile help — use /mobile smoke or /mobile status");
}

export default function (pi: ExtensionAPI) {
    let pendingSmoke = false;
    let lastAnswer: string | undefined;
    let smokeCtx: ExtensionCommandContext | undefined;
    let busy = false;
    let answers: string[] = [];
    let server: Server | undefined;
    let serverPort: number | undefined;
    const token = randomBytes(32).toString("hex");

    const getServerUrl = () => (serverPort ? `http://${STATUS_HOST}:${serverPort}/?token=${token}` : undefined);

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
            const subcommand = args.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase();

            if (!subcommand || subcommand === "status") {
                notifyStatus(ctx, pendingSmoke, lastAnswer, getServerUrl(), busy);
                return;
            }

            if (subcommand === "smoke") {
                smokeCtx = ctx;
                pendingSmoke = true;
                pi.sendUserMessage(SMOKE_PROMPT);
                ctx.ui.notify("mobile smoke started — waiting for assistant reply");
                return;
            }

            notifyHelp(ctx);
        },
    });

    pi.on("session_start", async (_event, _ctx) => {
        await startServer();
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

        if (!pendingSmoke || !text.includes(SMOKE_TOKEN)) {
            return;
        }

        pendingSmoke = false;
        smokeCtx?.ui.notify("mobile smoke success — token captured");
        smokeCtx = undefined;
    });
}
