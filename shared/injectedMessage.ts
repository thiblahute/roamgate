/**
 * Messages Claude Code puts in the user's turn that the user did not type:
 * a subagent's report, another session's or a teammate's message, a
 * background task ending, reminders to the model. The chat shows each as a
 * one-line notice in its place (reminders not at all), voice never reads
 * them, and none counts as the user's own message.
 */

export type InjectedKind = "report" | "agent" | "session" | "teammate" | "task";

export type InjectedNotice = {
  kind: InjectedKind;
  /** The notice's one line: "Report from voice-overlay". */
  label: string;
  /** What it says, shown on expand. */
  body: string;
};

export type InjectedMessage = {
  notices: InjectedNotice[];
  /** Text after the injected blocks: the user's own words, if any. */
  rest: string;
};

const TAGS =
  "agent-message|teammate-message|cross-session-message|task-notification|system-reminder";
// A block closes at a closing tag on a line of its own when it has one
// (the harness indents a report's lines, so one inside it never is), else
// at the first.
const BLOCK_LINES = new RegExp(
  `^<(${TAGS})\\b([^>]*)>([\\s\\S]*?)\\n<\\/\\1>[ \\t]*(?:\\n|$)\\s*`,
);
const BLOCK = new RegExp(`^<(${TAGS})\\b([^>]*)>([\\s\\S]*?)<\\/\\1>\\s*`);
// The line Claude Code writes before another session's message.
const PREAMBLE =
  /^Another Claude session sent a message(?: while you were working)?:\s*/;

function unescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attributes(raw: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of raw.matchAll(/([\w-]+)="([^"]*)"/g))
    found[match[1]!] = unescape(match[2]!);
  return found;
}

function innerTag(body: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(body);
  return match ? match[1]!.trim() : "";
}

/** A subagent's report without the harness's frame, its indent removed. */
function handBackReport(body: string): string {
  const at = body.indexOf("The report follows:");
  if (at < 0) return body.trim();
  const lines = body.slice(at + "The report follows:".length).split("\n");
  return lines
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n")
    .trim();
}

function notice(
  tag: string,
  attrs: Record<string, string>,
  body: string,
): InjectedNotice | null {
  switch (tag) {
    case "agent-message": {
      // An unnamed subagent goes by its task id: no name to say.
      const from =
        attrs.from && !/^a[0-9a-f]{12,}$/.test(attrs.from)
          ? attrs.from
          : "a subagent";
      if (body.includes("[Subagent hand-back]"))
        return {
          kind: "report",
          label: `Report from ${from}`,
          body: handBackReport(body),
        };
      return {
        kind: "agent",
        label: `Message from ${from}`,
        body: body.trim(),
      };
    }
    case "cross-session-message":
      return {
        kind: "session",
        label: `Message from ${attrs["from-name"] || attrs.from || "another session"}`,
        body: body.trim(),
      };
    case "teammate-message": {
      const id = attrs.teammate_id || "a teammate";
      let text = body.trim();
      let idle = false;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          idle = parsed.type === "idle_notification";
          text =
            typeof parsed.result === "string"
              ? parsed.result
              : typeof parsed.summary === "string"
                ? parsed.summary
                : "";
        }
      } catch {
        // Plain text.
      }
      const summary = attrs.summary?.trim();
      return {
        kind: "teammate",
        label: idle
          ? `Teammate ${id} is idle`
          : summary
            ? `Teammate ${id}: ${summary}`
            : `Message from teammate ${id}`,
        body: text,
      };
    }
    case "task-notification": {
      const status = innerTag(body, "status");
      const summary = innerTag(body, "summary");
      const verb =
        status === "completed"
          ? "Task finished"
          : status === "failed"
            ? "Task failed"
            : status === "killed" || status === "stopped"
              ? "Task stopped"
              : "Task update";
      return {
        kind: "task",
        label: summary ? `${verb}: ${summary}` : verb,
        body: innerTag(body, "result") || summary,
      };
    }
    default:
      // A reminder to the model: never shown.
      return null;
  }
}

/**
 * The injected messages a user turn starts with, and what follows them;
 * null when it does not start with one (the user's own message).
 */
export function parseInjectedMessage(text: string): InjectedMessage | null {
  let rest = text.trim();
  const notices: InjectedNotice[] = [];
  let matched = false;
  for (;;) {
    rest = rest.replace(PREAMBLE, "");
    const match = BLOCK_LINES.exec(rest) ?? BLOCK.exec(rest);
    if (!match) break;
    matched = true;
    rest = rest.slice(match[0].length);
    const found = notice(match[1]!, attributes(match[2]!), match[3]!);
    if (found) notices.push(found);
  }
  return matched ? { notices, rest: rest.trim() } : null;
}
