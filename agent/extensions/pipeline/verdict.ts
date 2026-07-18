/**
 * Pure parsers for the verdict words emitted by the `critic` and
 * `codereviewer` subagent personas.
 *
 * Both parsers are deliberately tolerant of common markdown noise (bold
 * emphasis, code fences, surrounding whitespace) since subagent output is
 * free-form prose, not a structured protocol.
 */

export type CriticVerdict = "PROCEED" | "REVISE" | "BLOCK";
export type ReviewerVerdict = "APPROVE" | "REJECT";

const MARKUP_WRAPPER = /^[`*_]+|[`*_]+$/g;

function stripMarkupWrapper(line: string): string {
	return line.trim().replace(MARKUP_WRAPPER, "").trim();
}

function nonBlankLines(text: string): string[] {
	return text.split("\n").filter((line) => line.trim().length > 0);
}

// Matches a *complete* fenced code block: an opening ``` delimiter line
// (optionally followed by a language tag) through the next line that is a
// bare closing ``` delimiter. A lone fence delimiter with no matching
// closing fence elsewhere in the text (the tolerated cases below) never
// matches this, since it requires both ends to be present.
const COMPLETE_FENCED_BLOCK = /^[ \t]*```[^\n]*\n[\s\S]*?\n[ \t]*```[ \t]*$/gm;

/**
 * The critic persona is expected to end its response with a bare
 * PROCEED / REVISE / BLOCK verdict on its own line (optionally wrapped in
 * markdown emphasis). Complete fenced code blocks (quoted content the
 * persona echoes back for context) are treated as opaque and removed before
 * scanning, so a verdict-shaped word quoted inside one can never be mistaken
 * for the model's real trailing verdict. Scans backward from the end of
 * what remains, skipping purely decorative lines that reduce to nothing
 * after markup/fence stripping (e.g. a stray trailing "```" the model left
 * after closing a fence opened earlier in its reasoning), until it finds the
 * real last substantive line. Returns null when that line isn't exactly one
 * of the three verdict words, or when there is no substantive line at all.
 */
export function parseCriticVerdict(text: string): CriticVerdict | null {
	const withoutFencedBlocks = text.replace(COMPLETE_FENCED_BLOCK, "");
	const lines = nonBlankLines(withoutFencedBlocks);
	for (let i = lines.length - 1; i >= 0; i--) {
		const candidate = stripMarkupWrapper(lines[i]);
		if (candidate.length === 0) continue;
		if (candidate === "PROCEED" || candidate === "REVISE" || candidate === "BLOCK") {
			return candidate;
		}
		return null;
	}
	return null;
}

/**
 * The code-reviewer persona is expected to lead its response with a bare
 * APPROVE / REJECT verdict, but tolerates the verdict word sharing a line
 * with a code-fence delimiter, or the fence sitting alone on the line
 * immediately before the verdict word. Complete fenced code blocks (real
 * quoted/reviewed content the persona echoes back for context) are treated
 * as opaque and removed before scanning, so a verdict-shaped word quoted
 * inside one can never be mistaken for the model's real leading verdict.
 * Scans top-down over what remains and returns the first line that reduces
 * (after stripping markdown/fence wrapper characters) to exactly one of the
 * two verdict words. Returns null — never throws or hangs — when no line
 * matches, including for blank/empty input.
 */
export function parseReviewerVerdict(text: string): ReviewerVerdict | null {
	const withoutFencedBlocks = text.replace(COMPLETE_FENCED_BLOCK, "");
	for (const line of withoutFencedBlocks.split("\n")) {
		const candidate = stripMarkupWrapper(line);
		if (candidate === "APPROVE" || candidate === "REJECT") {
			return candidate;
		}
	}
	return null;
}
