import type {
    AgentEndEvent,
    ExtensionAPI,
    ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

const SMOKE_TOKEN = "MOBILE_BRIDGE_SMOKE_OK";
const SMOKE_PROMPT = `Reply exactly: ${SMOKE_TOKEN}`;

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

function notifyStatus(ctx: ExtensionCommandContext, pendingSmoke: boolean, lastAnswer: string | undefined) {
    const answerText = lastAnswer?.trim() ? lastAnswer : "no answer yet";
    ctx.ui.notify(`mobile status — pending smoke: ${pendingSmoke ? "yes" : "no"}; last answer: ${answerText}`);
}

function notifyHelp(ctx: ExtensionCommandContext) {
    ctx.ui.notify("mobile help — use /mobile smoke or /mobile status");
}

export default function (pi: ExtensionAPI) {
    let pendingSmoke = false;
    let lastAnswer: string | undefined;
    let smokeCtx: ExtensionCommandContext | undefined;

    pi.registerCommand("mobile", {
        description: "Mobile bridge smoke helpers",
        handler: async (args, ctx) => {
            const subcommand = args.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase();

            if (!subcommand || subcommand === "status") {
                notifyStatus(ctx, pendingSmoke, lastAnswer);
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

    pi.on("agent_end", async (event) => {
        const text = extractAssistantText(event);
        if (!text) {
            return;
        }

        lastAnswer = text;

        if (!pendingSmoke || !text.includes(SMOKE_TOKEN)) {
            return;
        }

        pendingSmoke = false;
        smokeCtx?.ui.notify("mobile smoke success — token captured");
        smokeCtx = undefined;
    });
}
