import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_MEMORY_DIR = path.join(os.homedir(), ".pi", "data", "memory");
const MAX_LIST = 20;

// Size-ceiling discipline for the "## Project Memory" injection into the
// system prompt (see before_agent_start below). Below WARN_*, the full file
// is injected unchanged. At/above WARN_* but under MAX_*, the full file is
// still injected, plus a WARNING banner. At/above MAX_*, the injected content
// is truncated (first N lines, bounded by whichever ceiling binds first) and
// an ERROR banner explains that the rest was not loaded.
export const MAX_MEMORY_LINES = 200;
export const MAX_MEMORY_BYTES = 25 * 1024;
export const WARN_MEMORY_LINES = 150;
export const WARN_MEMORY_BYTES = 20 * 1024;

function getMemoryDir(): string {
    return process.env.PI_MEMORY_DIR || DEFAULT_MEMORY_DIR;
}

function getMemoryFile(cwd: string): string {
    const hash = crypto.createHash("md5").update(cwd).digest("hex");
    const dir = getMemoryDir();
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${hash}.md`);
}

function readLines(filePath: string): string[] {
    try {
        return fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    } catch {
        return [];
    }
}

function writeLines(filePath: string, lines: string[]): void {
    fs.writeFileSync(
        filePath,
        lines.join("\n") + (lines.length > 0 ? "\n" : ""),
        "utf-8",
    );
}

function formatTimestamp(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function truncateToLimits(lines: string[]): string[] {
    const kept: string[] = [];
    let bytes = 0;
    for (const line of lines) {
        if (kept.length >= MAX_MEMORY_LINES) break;
        const lineBytes = Buffer.byteLength(line, "utf-8") + 1; // +1 for join newline
        if (bytes + lineBytes > MAX_MEMORY_BYTES) break;
        kept.push(line);
        bytes += lineBytes;
    }
    return kept;
}

function formatListLine(line: string): string {
    const marker = "] ";
    const markerIndex = line.indexOf(marker);
    if (markerIndex === -1) return line;

    const prefix = line.slice(0, markerIndex + marker.length);
    const content = line.slice(markerIndex + marker.length);

    return `${prefix}${content.replace(/\b1(\d)\b/g, `\u20601$1`)}`;
}

export default function memory(pi: ExtensionAPI) {
    pi.registerTool({
        name: "memory",
        label: "Memory",
        description:
            "Persistent cross-session memory. remember/recall/forget/list facts for the current project.",
        parameters: Type.Object({
            op: Type.String({
                description: '"remember", "recall", "forget", or "list"',
            }),
            content: Type.Optional(
                Type.String({
                    description: "Fact to remember (for remember op)",
                }),
            ),
            query: Type.Optional(
                Type.String({
                    description: "Search query (for recall/forget ops)",
                }),
            ),
            cwd: Type.Optional(
                Type.String({
                    description:
                        "Project directory (defaults to process.cwd())",
                }),
            ),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const op = (params.op || "").trim().toLowerCase();
            const cwd = params.cwd || ctx?.cwd || process.cwd();
            const filePath = getMemoryFile(cwd);

            if (op === "remember") {
                const content = (params.content || "").trim();
                if (!content) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Nothing to remember — content is empty.",
                            },
                        ],
                    };
                }

                const line = `- [${formatTimestamp(new Date())}] ${content}`;
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.appendFileSync(filePath, `${line}\n`, "utf-8");

                return {
                    content: [
                        {
                            type: "text",
                            text: `Remembered: ${content}`,
                        },
                    ],
                };
            }

            if (op === "recall") {
                const query = (params.query || "").trim().toLowerCase();
                if (!query) {
                    return {
                        content: [{ type: "text", text: "No query provided." }],
                    };
                }

                const lines = readLines(filePath);
                const matches = lines.filter((line) =>
                    line.toLowerCase().includes(query),
                );

                if (matches.length === 0) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "No matching memories found.",
                            },
                        ],
                    };
                }

                return {
                    content: [{ type: "text", text: matches.join("\n") }],
                };
            }

            if (op === "forget") {
                const query = (params.query || "").trim().toLowerCase();
                if (!query) {
                    return {
                        content: [{ type: "text", text: "No query provided." }],
                    };
                }

                const lines = readLines(filePath);
                const remaining = lines.filter(
                    (line) => !line.toLowerCase().includes(query),
                );
                const removed = lines.length - remaining.length;
                writeLines(filePath, remaining);

                return {
                    content: [
                        {
                            type: "text",
                            text:
                                removed > 0
                                    ? `Forgot ${removed} memory(s).`
                                    : "No matching memories found.",
                        },
                    ],
                };
            }

            if (op === "list") {
                const lines = readLines(filePath);
                if (lines.length === 0) {
                    return {
                        content: [{ type: "text", text: "No memories stored." }],
                    };
                }

                const last = lines.slice(-MAX_LIST).map(formatListLine);
                return {
                    content: [{ type: "text", text: last.join("\n") }],
                };
            }

            return {
                content: [
                    {
                        type: "text",
                        text: `Unknown operation: ${op}. Use remember, recall, forget, or list.`,
                    },
                ],
            };
        },
    });

    pi.on("before_agent_start", async (event, ctx) => {
        const cwd = ctx?.cwd || process.cwd();
        const filePath = getMemoryFile(cwd);
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            const trimmed = content.trim();
            if (!trimmed) return;

            const lines = trimmed.split("\n");
            const lineCount = lines.length;
            const byteSize = Buffer.byteLength(trimmed, "utf-8");

            const overMax =
                lineCount >= MAX_MEMORY_LINES || byteSize >= MAX_MEMORY_BYTES;
            const overWarn =
                lineCount >= WARN_MEMORY_LINES || byteSize >= WARN_MEMORY_BYTES;

            let memoryText = trimmed;
            let banner = "";

            if (overMax) {
                const kept = truncateToLimits(lines);
                const keptText = kept.join("\n");
                const keptBytes = Buffer.byteLength(keptText, "utf-8");
                // truncateToLimits can retain every line (e.g. lineCount is
                // exactly MAX_MEMORY_LINES but still fits under the byte
                // cap) — that's not an actual truncation, so don't claim
                // content was dropped.
                const actuallyTruncated =
                    kept.length < lineCount || keptBytes < byteSize;

                if (actuallyTruncated) {
                    memoryText = keptText;
                    banner =
                        "\n\n---\n**ERROR**: Project memory exceeds the size limit " +
                        `(kept ${kept.length} of ${lineCount} lines) and was truncated. ` +
                        "Additional content was not loaded into this session.";
                } else if (overWarn) {
                    banner =
                        "\n\n---\n**WARNING**: Project memory is approaching the size limit " +
                        `(${lineCount} lines, ${byteSize} bytes). Consider pruning old facts.`;
                }
            } else if (overWarn) {
                banner =
                    "\n\n---\n**WARNING**: Project memory is approaching the size limit " +
                    `(${lineCount} lines, ${byteSize} bytes). Consider pruning old facts.`;
            }

            return {
                systemPrompt:
                    event.systemPrompt +
                    "\n\n## Project Memory\n\n" +
                    memoryText +
                    banner,
            };
        } catch {
            // file missing or unreadable — no-op
        }
    });
}
