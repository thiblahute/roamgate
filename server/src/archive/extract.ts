/** Turn one transcript record into searchable documents. */

/** Caps, in characters. Tool output is the biggest body, so it is clipped. */
const TEXT_CAP = 20_000;
const RESULT_HEAD = 6_000;
const RESULT_TAIL = 2_000;
const INPUT_CAP = 2_000;

/**
 * Record types that carry no searchable text (bookkeeping, request mirrors,
 * duplicates of text indexed elsewhere).
 */
const IGNORED = new Set([
  "mode",
  "file-history-snapshot",
  "file-history-delta",
  "atis-latch",
  "api-request",
  "api-request-shape",
  "api-request-blob",
  "last-prompt",
  "attachment",
  "cost-state",
  "session-owner",
  "tools-used",
  "permission-mode",
  "bridge-session",
  "artifact-comment-monitor",
  "artifact-autoreact-ledger",
  "continued-in",
  "isolation-latch",
  "history-suppression",
  "fork-context-ref",
  "launched",
  "failed",
]);

export type Doc = {
  role: "user" | "assistant" | "tool" | "system" | "meta" | "agent";
  kind: string;
  tool: string | null;
  text: string;
};

/** Record types seen but not recognised, with their counts. */
export type UnknownTypes = Map<string, number>;

const LONG_TOKEN = /\S{200,}/g;

/** Drop mega-tokens (base64, hashes): not searchable words, they only bloat the index. */
function stripLong(text: string): string {
  return text.replace(LONG_TOKEN, " ");
}

/** The first `count` characters (code points) of `text`. */
function takeChars(text: string, count: number): string {
  if (text.length <= count) return text;
  let end = 0;
  let taken = 0;
  while (taken < count && end < text.length) {
    const code = text.codePointAt(end) ?? 0;
    end += code > 0xffff ? 2 : 1;
    taken += 1;
  }
  return text.slice(0, end);
}

export function clip(text: string, cap: number): string {
  return takeChars(stripLong(text), cap);
}

export function clipResult(text: string): string {
  const stripped = stripLong(text);
  if (stripped.length <= RESULT_HEAD + RESULT_TAIL) return stripped;
  const chars = Array.from(stripped);
  if (chars.length <= RESULT_HEAD + RESULT_TAIL) return stripped;
  const head = chars.slice(0, RESULT_HEAD).join("");
  const tail = chars.slice(chars.length - RESULT_TAIL).join("");
  return `${head}\n[...]\n${tail}`;
}

/** JSON with sorted keys, as serde_json prints a Value (the Rust oracle). */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(object: Json, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

const INPUT_KEYS = [
  "description",
  "command",
  "file_path",
  "path",
  "pattern",
  "url",
  "query",
  "prompt",
  "subject",
  "skill",
  "args",
  "old_string",
  "new_string",
];

/** Searchable summary of a tool call input. */
function toolInputText(input: unknown): string {
  if (!isObject(input))
    return clip(input === undefined ? "" : stableStringify(input), INPUT_CAP);
  const parts = INPUT_KEYS.map((key) => stringField(input, key)).filter(
    (part): part is string => Boolean(part),
  );
  if (parts.length === 0) parts.push(stableStringify(input));
  return clip(parts.join(" "), INPUT_CAP);
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((part) => isObject(part) && part.type === "text")
      .map((part) => stringField(part as Json, "text"))
      .filter((part): part is string => part !== undefined)
      .join(" ");
  return "";
}

function display(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : stableStringify(value);
}

/** Documents for one record. Unrecognised record types are counted in `unknown`. */
export function extract(
  record: unknown,
  thinking: boolean,
  unknown: UnknownTypes,
): Doc[] {
  const out: Doc[] = [];
  if (!isObject(record)) return out;
  const type = stringField(record, "type") ?? "";
  switch (type) {
    case "ai-title":
    case "custom-title":
    case "agent-name": {
      const value = ["aiTitle", "customTitle", "agentName"]
        .map((key) => stringField(record, key))
        .find((entry) => entry);
      if (value)
        out.push({ role: "meta", kind: "title", tool: null, text: value });
      break;
    }
    case "pr-link": {
      const text = [
        display(record.prRepository),
        display(record.prNumber),
        display(record.prUrl),
      ]
        .filter((part): part is string => part !== undefined)
        .join(" ");
      if (text) out.push({ role: "meta", kind: "pr", tool: null, text });
      break;
    }
    case "frame-link": {
      const text = [
        stringField(record, "title"),
        stringField(record, "frameUrl"),
      ]
        .filter((part): part is string => part !== undefined)
        .join(" ");
      if (text) out.push({ role: "meta", kind: "artifact", tool: null, text });
      break;
    }
    // Background workflow agents: their findings and labels are real content.
    case "result":
      if (record.result !== undefined)
        out.push({
          role: "agent",
          kind: "workflow_result",
          tool: null,
          text: clipResult(stableStringify(record.result)),
        });
      break;
    case "started": {
      const text = [stringField(record, "label"), stringField(record, "phase")]
        .filter((part): part is string => part !== undefined)
        .join(" ");
      if (text) out.push({ role: "agent", kind: "workflow", tool: null, text });
      break;
    }
    case "queue-operation": {
      const content = stringField(record, "content");
      if (content)
        out.push({
          role: "user",
          kind: "queued",
          tool: null,
          text: clip(content, TEXT_CAP),
        });
      break;
    }
    case "system": {
      const content = stringField(record, "content");
      if (content?.trim())
        out.push({
          role: "system",
          kind: "text",
          tool: null,
          text: clip(content, TEXT_CAP),
        });
      break;
    }
    case "user":
    case "assistant": {
      const role = type;
      const message = record.message;
      const content = isObject(message) ? message.content : undefined;
      if (typeof content === "string") {
        if (content.trim())
          out.push({
            role,
            kind: "text",
            tool: null,
            text: clip(content, TEXT_CAP),
          });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!isObject(block)) continue;
          switch (block.type) {
            case "text": {
              const text = stringField(block, "text");
              if (text?.trim())
                out.push({
                  role,
                  kind: "text",
                  tool: null,
                  text: clip(text, TEXT_CAP),
                });
              break;
            }
            case "tool_use":
              out.push({
                role,
                kind: "tool_use",
                tool: stringField(block, "name") ?? null,
                text: toolInputText(block.input),
              });
              break;
            case "tool_result": {
              const text = resultText(block.content);
              if (text.trim())
                out.push({
                  role: "tool",
                  kind: "tool_result",
                  tool: null,
                  text: clipResult(text.trim()),
                });
              break;
            }
            case "thinking": {
              const text = stringField(block, "thinking");
              if (thinking && text)
                out.push({
                  role,
                  kind: "thinking",
                  tool: null,
                  text: clip(text, TEXT_CAP),
                });
              break;
            }
            default:
              // Images and other block types are not indexed.
              break;
          }
        }
      }
      break;
    }
    default:
      if (!IGNORED.has(type)) unknown.set(type, (unknown.get(type) ?? 0) + 1);
  }
  return out;
}
