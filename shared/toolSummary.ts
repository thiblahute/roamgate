import { shellWords } from "./agentMessage";

/**
 * A one-line summary of what a tool call does, for the chat's collapsed tool
 * groups, in plain words: "Read components/Chat.tsx", "To the cutover agent:
 * Holder question answered", "Replied on "the quoted words"". Shared by the
 * server (which keeps it on a call whose payload it withholds from the wire,
 * knowing the whole session) and the page (which derives it from arguments it
 * has).
 */

/** Longest summary carried, in characters. */
export const TOOL_SUMMARY_LIMIT = 160;

/** Longest quoted part of a summary (a thread, a message's start). */
const PART_LIMIT = 60;

// Keys that best identify what a call does, in priority order. Agents name
// them differently, so this covers the common spellings.
export const TOOL_ARGUMENT_KEYS = [
  "command",
  "cmd",
  "file_path",
  "filePath",
  "notebook_path",
  "path",
  "pattern",
  "query",
  "url",
  "prompt",
  "description",
];

export function parseToolArguments(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isArgumentObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function firstLine(value: string) {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function clip(value: string, limit: number) {
  return value.length > limit
    ? `${value.slice(0, limit - 1).trimEnd()}…`
    : value;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** A text's first line, short enough to sit inside a summary. */
function start(value: string, limit = PART_LIMIT) {
  return clip(firstLine(value), limit);
}

/**
 * The call's main argument's first line: the first of the usual keys that
 * holds text, else the first text value, else the arguments as JSON.
 */
export function toolArgumentHeadline(text: string): string {
  const parsed = parseToolArguments(text);
  if (!isArgumentObject(parsed)) return firstLine(text);
  return keyArgument(parsed) ?? firstLine(JSON.stringify(parsed));
}

/** The first of the usual keys that holds text, else the first text. */
function keyArgument(args: Record<string, unknown>): string | undefined {
  for (const key of TOOL_ARGUMENT_KEYS) {
    const value = nonEmptyString(args[key]);
    if (value) return firstLine(value);
  }
  const value = Object.values(args).find(
    (item): item is string => typeof item === "string" && !!item.trim(),
  );
  return value ? firstLine(value) : undefined;
}

/** A path's last two parts: enough to know the file, short enough to read. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? path : parts.slice(-2).join("/");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

function capitalize(value: string) {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function words(value: string) {
  return value.replace(/[_-]+/g, " ").trim();
}

/** An MCP tool's server and tool, from `mcp__server__tool`. */
function mcpParts(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const split = rest.indexOf("__");
  return split < 0
    ? { server: rest, tool: "" }
    : { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

/**
 * A tool's name as people read it: built-in tools keep theirs, an MCP tool
 * `mcp__claude_ai_Spotify__search` reads "Spotify: search".
 */
export function toolDisplayName(name: string): string {
  const parts = mcpParts(name);
  if (!parts) return name;
  const server = capitalize(words(parts.server.replace(/^claude_ai_/, "")));
  const tool = words(parts.tool.replace(/_mcp$/, ""));
  return tool ? `${server}: ${tool}` : server;
}

/** What the rest of the session tells about a call. All optional. */
export type ToolSummaryContext = {
  /** The call's result, when it has one. */
  result?: string;
  /** Who a background agent is ("the cutover agent"), from its id. */
  agentName?: (id: string) => string | undefined;
  /** What a review thread is about, from its id or id prefix. */
  threadLabel?: (id: string) => string | undefined;
  /** A Roamgate agent session's name, from its address. */
  sessionName?: (address: string) => string | undefined;
  /** The command a Codex terminal session runs, from its id. */
  codexCommand?: (sessionId: string) => string | undefined;
};

// An agent id Claude Code gives a background agent, or a session socket:
// meaningless to the user.
const OPAQUE_RECIPIENT = /^(?:a?[0-9a-f]{12,}|uds:.*|bridge:.*)$/i;

function recipient(to: string, context: ToolSummaryContext): string {
  if (to === "*") return "all agents";
  const known = context.agentName?.(to);
  if (known) return known;
  if (/^(?:uds|bridge):/i.test(to)) return "another session";
  if (OPAQUE_RECIPIENT.test(to)) return "an agent";
  return `the ${to} agent`;
}

/** What a review thread in a Roamgate tool's JSON output is about. */
function threadOutputLabel(
  thread: Record<string, unknown>,
): string | undefined {
  const chat = thread.on_chat_message;
  const message = thread.on_message;
  const quote =
    (isArgumentObject(chat) && nonEmptyString(chat.quote)) ||
    (isArgumentObject(message) && nonEmptyString(message.quote));
  if (quote) return start(quote);
  const path = nonEmptyString(thread.path);
  if (path) {
    const line = typeof thread.line === "number" ? `:${thread.line}` : "";
    return `${shortPath(path)}${line}`;
  }
  const comments = Array.isArray(thread.comments) ? thread.comments : [];
  const first = comments.find(isArgumentObject);
  const text = first && nonEmptyString(first.text);
  return text ? start(text) : undefined;
}

/** The review threads a Roamgate tool's output carries, by id. */
function threadsInOutput(output: string): Map<string, string> {
  const found = new Map<string, string>();
  const parsed = parseToolArguments(output);
  const visit = (value: unknown) => {
    if (!isArgumentObject(value)) return;
    const id = nonEmptyString(value.id);
    if (id && Array.isArray(value.comments)) {
      const label = threadOutputLabel(value);
      if (label) found.set(id.slice(0, 8), label);
    }
    for (const key of ["threads", "thread"]) {
      const inner = value[key];
      if (Array.isArray(inner)) inner.forEach(visit);
      else visit(inner);
    }
  };
  if (Array.isArray(parsed)) parsed.forEach(visit);
  else visit(parsed);
  return found;
}

function threadLabel(
  id: string | undefined,
  context: ToolSummaryContext,
): string | undefined {
  if (!id) return undefined;
  const key = id.trim().slice(0, 8);
  return (
    (context.result ? threadsInOutput(context.result).get(key) : undefined) ??
    context.threadLabel?.(key)
  );
}

function roamgateSummary(
  tool: string,
  args: Record<string, unknown>,
  context: ToolSummaryContext,
): string | undefined {
  // What the agent says the call does, as a Bash call's description.
  const description = nonEmptyString(args.description);
  if (description) return firstLine(description);
  const text = nonEmptyString(args.text);
  const message = nonEmptyString(args.message);
  switch (tool) {
    case "review_reply": {
      const thread = threadLabel(nonEmptyString(args.comment_id), context);
      if (thread)
        return `Replied on "${thread}"${text ? ` · ${start(text)}` : ""}`;
      return text ? `Replied: ${start(text)}` : "Replied on a thread";
    }
    case "review_add": {
      const verb =
        args.kind === "draft" ? "Drafted a review comment" : "Commented";
      const file = nonEmptyString(args.file);
      const line = typeof args.line === "number" ? `:${args.line}` : "";
      const place = file ? ` on ${shortPath(file)}${line}` : "";
      return `${verb}${place}${text ? `: ${start(text)}` : ""}`;
    }
    case "review_edit": {
      const output = context.result
        ? roamgateOutput(context.result)
        : undefined;
      const thread = output && threadOutputLabel(output);
      const place = thread ? ` on "${thread}"` : "";
      return `Edited a comment${place}${text ? `: ${start(text)}` : ""}`;
    }
    case "review_resolve":
    case "review_reopen": {
      const verb = tool === "review_resolve" ? "Resolved" : "Reopened";
      const thread = threadLabel(nonEmptyString(args.comment_id), context);
      return thread ? `${verb} "${thread}"` : `${verb} a thread`;
    }
    case "review_working": {
      const verb = args.done === true ? "Done" : "Working";
      if (message) return `${verb}: ${start(message, 100)}`;
      const thread = threadLabel(nonEmptyString(args.comment_id), context);
      return thread ? `${verb} on "${thread}"` : verb;
    }
    case "review_notify": {
      const title = nonEmptyString(args.title) ?? text;
      return title ? `Notified you: ${start(title, 100)}` : "Notified you";
    }
    case "review_update":
      return `Told the review it changed${message ? `: ${start(message)}` : ""}`;
    case "review_get":
    case "review_threads":
    case "review_summary":
      return "Read the review";
    case "agent_message": {
      const to = nonEmptyString(args.to);
      const name = (to && context.sessionName?.(to)) || "another session";
      return `Messaged ${name}${text ? `: ${start(text)}` : ""}`;
    }
    case "agent_sessions":
      return "Listed sessions";
    case "work_add":
    case "work_update":
    case "work_done":
    case "work_reopen": {
      const output = context.result
        ? roamgateOutput(context.result)
        : undefined;
      const write = workWrite(tool, args, output);
      return write ? itemWriteLine(write) : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * A Roamgate tool's output as JSON: the review client prints it, the mod
 * gives it whole, the board's tools after a line saying who wrote what in
 * it, and some clients wrap it (`{tool, result}`).
 */
export function roamgateOutput(
  result: string,
): Record<string, unknown> | undefined {
  const text = result.trim();
  let parsed = parseToolArguments(text);
  if (parsed === undefined) {
    const brace = text.indexOf("{");
    if (brace > 0) parsed = parseToolArguments(text.slice(brace));
  }
  if (!isArgumentObject(parsed)) return undefined;
  return isArgumentObject(parsed.result) ? parsed.result : parsed;
}

/** Options of the review client that take a value, by command. */
const CLIENT_VALUES = new Set([
  "--agent",
  "--session",
  "--comment",
  "--file",
  "--line",
  "--end-line",
  "--side",
  "--quote",
  "--message",
  "--title",
  "--description",
  "--timeout",
  "--on-comment",
]);

/**
 * A here-document given inline as an argument (`"$(cat <<'EOF' ... EOF
 * )"`): its text; else the word as it is.
 */
function inlineHeredoc(word: string): string {
  const match =
    /^\$\(cat <<-?\s*(['"]?)([\w-]+)\1\n([\s\S]*?)\n[ \t]*\2[ \t]*\n?\)$/.exec(
      word,
    );
  return match ? match[3]! : word;
}

/**
 * The review client's command in a shell command (`roamgate-review reply
 * --comment ID -- TEXT`, `roamgate-review work work_update 'JSON'`), as
 * the Roamgate tool it does and that tool's arguments; undefined for any
 * other command.
 */
export function reviewClientCall(
  command: string,
): { tool: string; args: Record<string, unknown> } | undefined {
  const start = command.search(/\S*roamgate-review\b/);
  if (start < 0) return undefined;
  const { words, heredoc } = shellWords(command.slice(start));
  if (!/(^|\/)roamgate-review$/.test(words[0] ?? "")) return undefined;
  const options = new Map<string, string>();
  const positional: string[] = [];
  let sub: string | undefined;
  let rest = false;
  for (let at = 1; at < words.length; at += 1) {
    const word = words[at]!;
    if (rest || !word.startsWith("--")) {
      if (!sub) sub = word;
      else positional.push(inlineHeredoc(word));
      continue;
    }
    if (word === "--") {
      rest = true;
      continue;
    }
    const equals = word.indexOf("=");
    if (equals > 0) {
      options.set(word.slice(0, equals), inlineHeredoc(word.slice(equals + 1)));
    } else if (CLIENT_VALUES.has(word)) {
      options.set(word, inlineHeredoc(words[at + 1] ?? ""));
      at += 1;
    } else {
      options.set(word, "1");
    }
  }
  if (!sub) return undefined;
  const joined = positional.join(" ");
  const text = joined === "-" || joined === "" ? (heredoc ?? "") : joined;
  const option = (name: string) => options.get(name) || undefined;
  const line = (name: string) => {
    const value = Number(option(name));
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  };
  const args: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined && value !== "") args[key] = value;
  };
  set("description", option("--description"));
  set("review", option("--session"));
  switch (sub) {
    case "reply":
    case "edit":
      set("comment_id", option("--comment"));
      set("text", text);
      return { tool: `review_${sub}`, args };
    case "add":
      set("text", text);
      set("kind", options.has("--draft") ? "draft" : undefined);
      set("file", option("--file"));
      set("line", line("--line"));
      set("end_line", line("--end-line"));
      set("side", option("--side"));
      set("quote", option("--quote"));
      set("on_comment", option("--on-comment"));
      return { tool: "review_add", args };
    case "working":
      set("comment_id", option("--comment"));
      set("message", option("--message"));
      set("done", options.has("--done") ? true : undefined);
      return { tool: "review_working", args };
    case "resolve":
    case "reopen":
      set("comment_id", option("--comment"));
      return {
        tool:
          sub === "reopen" || options.has("--unresolve")
            ? "review_reopen"
            : "review_resolve",
        args,
      };
    case "update":
      set("message", option("--message"));
      return { tool: "review_update", args };
    case "notify":
      set("title", option("--title"));
      set("text", text);
      return { tool: "review_notify", args };
    case "work": {
      // `work TOOL 'JSON'`, or its JSON on standard input.
      const [tool, params] = positional;
      if (!tool) return undefined;
      const parsed = parseToolArguments(
        params === undefined || params === "-" ? (heredoc ?? "{}") : params,
      );
      return {
        tool,
        args: {
          ...(isArgumentObject(parsed) ? parsed : {}),
          ...(args.description ? { description: args.description } : {}),
        },
      };
    }
    default:
      return undefined;
  }
}

/**
 * A call to a Roamgate tool: an MCP tool of Roamgate's server or mod, or
 * the review client run from a shell (Bash, Codex's exec_command), as the
 * tool and its arguments.
 */
export function roamgateToolCall(
  name: string,
  args: Record<string, unknown>,
): { tool: string; args: Record<string, unknown> } | undefined {
  const mcp = mcpParts(name);
  if (mcp)
    return /(?:^|_)roamgate$/.test(mcp.server)
      ? { tool: mcp.tool, args }
      : undefined;
  const command =
    name === "Bash"
      ? nonEmptyString(args.command)
      : name === "exec_command"
        ? nonEmptyString(args.cmd)
        : undefined;
  return command?.includes("roamgate-review")
    ? reviewClientCall(command)
    : undefined;
}

/**
 * What a call wrote in Roamgate: a comment in a thread, or a Work item
 * added or changed.
 */
export type RoamgateWriteAction =
  | "reply"
  | "comment"
  | "draft"
  | "edit"
  | "item_add"
  | "item_update"
  | "item_done"
  | "item_reopen";

/** The actions that wrote in a thread (the others changed a Work item). */
export function isThreadWrite(write: RoamgateWrite): boolean {
  return !write.action.startsWith("item_");
}

/**
 * What a call wrote in Roamgate, read from its arguments and its result:
 * the chat shows it as a tool row that says where it went and links there,
 * so the agent need not repeat it in the chat.
 */
export type RoamgateWrite = {
  action: RoamgateWriteAction;
  /** The call's own description argument, when it gave one. */
  description?: string;
  /** The review the thread is in, its thread and the comment written. */
  review?: string;
  thread?: string;
  comment?: string;
  /** Where it went, in a few words: the words quoted, file:line. */
  where?: string;
  /** The Work item it added or changed: its id, its title, its state. */
  item?: string;
  title?: string;
  state?: string;
  /** What a Work item's change did, in a few words ("moved to Verify"). */
  change?: string;
  /** The words written, up to ROAMGATE_WRITE_TEXT_LIMIT characters. */
  text?: string;
  /** Longer than that: the call's arguments have it whole. */
  clipped?: true;
};

/** Of the words a call wrote, how much its row keeps. */
export const ROAMGATE_WRITE_TEXT_LIMIT = 4000;

function writeText(text: string | undefined): Partial<RoamgateWrite> {
  if (!text?.trim()) return {};
  return text.length > ROAMGATE_WRITE_TEXT_LIMIT
    ? { text: text.slice(0, ROAMGATE_WRITE_TEXT_LIMIT), clipped: true }
    : { text };
}

/** The comments a review tool's output lists, in order. */
function outputComments(output: Record<string, unknown> | undefined) {
  return (Array.isArray(output?.comments) ? output.comments : []).filter(
    isArgumentObject,
  );
}

/** A review tool's write, from its arguments and its output. */
function reviewWrite(
  tool: string,
  args: Record<string, unknown>,
  output: Record<string, unknown> | undefined,
): RoamgateWrite | undefined {
  let action: RoamgateWriteAction;
  let comment: string | undefined;
  const comments = outputComments(output);
  switch (tool) {
    case "review_reply":
      action = "reply";
      comment = nonEmptyString(comments[comments.length - 1]?.id);
      break;
    case "review_add":
      action = args.kind === "draft" ? "draft" : "comment";
      comment = nonEmptyString(comments[0]?.id);
      break;
    case "review_edit": {
      action = "edit";
      const asked = nonEmptyString(args.comment_id)?.trim();
      comment = asked
        ? (comments
            .map((each) => nonEmptyString(each.id))
            .find((id) => id?.startsWith(asked)) ?? undefined)
        : undefined;
      break;
    }
    default:
      return undefined;
  }
  const file = nonEmptyString(args.file);
  const where =
    (output && threadOutputLabel(output)) ||
    (file
      ? `${shortPath(file)}${typeof args.line === "number" ? `:${args.line}` : ""}`
      : undefined);
  const description = nonEmptyString(args.description);
  const review = nonEmptyString(output?.session);
  const thread = nonEmptyString(output?.id);
  return {
    action,
    ...(description ? { description: firstLine(description) } : {}),
    ...(review ? { review } : {}),
    ...(thread ? { thread } : {}),
    ...(comment ? { comment } : {}),
    ...(where ? { where } : {}),
    ...writeText(nonEmptyString(args.text)),
  };
}

/**
 * What a call wrote in Roamgate (a reply, a new thread, an edit), from its
 * name, its arguments (an object or their JSON) and its result; undefined
 * for any other call, and for one that failed.
 */
export function roamgateWrite(
  name: string,
  args: unknown,
  result?: { text: string; is_error?: boolean },
): RoamgateWrite | undefined {
  if (result?.is_error) return undefined;
  const input = typeof args === "string" ? parseToolArguments(args) : args;
  if (!isArgumentObject(input)) return undefined;
  const call = roamgateToolCall(name, input);
  if (!call) return undefined;
  const output = result?.text ? roamgateOutput(result.text) : undefined;
  return (
    reviewWrite(call.tool, call.args, output) ??
    workWrite(call.tool, call.args, output)
  );
}

/** How the Work board names a state. */
const WORK_STATE_NAMES: Record<string, string> = {
  you: "For you",
  doing: "Doing",
  verify: "Verify",
  open: "Open",
  done: "Done",
};

function stateName(state: unknown): string | undefined {
  const name = nonEmptyString(state);
  return name ? (WORK_STATE_NAMES[name] ?? name) : undefined;
}

/** What a work_update did, in a few words, from its arguments. */
function itemChange(args: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const state = stateName(args.state);
  if (state) parts.push(`moved to ${state}`);
  const title = nonEmptyString(args.title);
  if (title) parts.push(`retitled "${start(title)}"`);
  if (nonEmptyString(args.text)) parts.push("rewrote its description");
  const tick = Array.isArray(args.tick)
    ? args.tick.filter(isArgumentObject)
    : [];
  const ticked = tick
    .map((each) => nonEmptyString(each.decision))
    .filter((each): each is string => !!each);
  if (ticked.length) parts.push(`ticked ${ticked.join(", ")}`);
  if (args.owner === null) parts.push("left it");
  else if (isArgumentObject(args.owner)) parts.push("took it");
  if (
    Array.isArray(args.add_links) ||
    Array.isArray(args.links) ||
    Array.isArray(args.remove_links)
  )
    parts.push("changed its links");
  if (
    Array.isArray(args.tags) ||
    Array.isArray(args.add_tags) ||
    Array.isArray(args.remove_tags)
  )
    parts.push("changed its tags");
  return parts.length ? parts.join(", ") : undefined;
}

/** A Work board tool's write, from its arguments and its output. */
function workWrite(
  tool: string,
  args: Record<string, unknown>,
  output: Record<string, unknown> | undefined,
): RoamgateWrite | undefined {
  const actions: Record<string, RoamgateWriteAction> = {
    work_add: "item_add",
    work_update: "item_update",
    work_done: "item_done",
    work_reopen: "item_reopen",
  };
  const action = actions[tool];
  if (!action) return undefined;
  const item = isArgumentObject(output?.item) ? output.item : undefined;
  const id = nonEmptyString(item?.id) ?? nonEmptyString(args.item);
  const title = nonEmptyString(item?.title) ?? nonEmptyString(args.title);
  const state = nonEmptyString(item?.state) ?? nonEmptyString(args.state);
  const description = nonEmptyString(args.description);
  const change = action === "item_update" ? itemChange(args) : undefined;
  return {
    action,
    ...(description ? { description: firstLine(description) } : {}),
    ...(id ? { item: id } : {}),
    ...(title ? { title: firstLine(title) } : {}),
    ...(state ? { state } : {}),
    ...(change ? { change } : {}),
    ...writeText(nonEmptyString(args.text)),
  };
}

/**
 * A Work item's write in one line: "Added to Work: Fix the bar", "Kokoro
 * voices: moved to Verify", "Marked Fix the bar done".
 */
export function itemWriteLine(write: RoamgateWrite): string | undefined {
  const name = write.title
    ? `"${start(write.title)}"`
    : write.item
      ? `item ${write.item.slice(0, 8)}`
      : "an item";
  switch (write.action) {
    case "item_add": {
      const state = stateName(write.state);
      return `Added to Work: ${name}${state && state !== "Open" ? ` (${state})` : ""}`;
    }
    case "item_update": {
      const change = write.change;
      if (!change) return `Updated ${name}`;
      const moved = /^moved to ([^,]+)$/.exec(change);
      if (moved) return `Moved ${name} to ${moved[1]}`;
      if (/^retitled "[^"]*"$/.test(change))
        return `Retitled ${write.item ? `item ${write.item.slice(0, 8)}` : "an item"}: ${name}`;
      return `Updated ${name}: ${change}`;
    }
    case "item_done":
      return `Marked ${name} done`;
    case "item_reopen": {
      const state = stateName(write.state);
      return `Reopened ${name}${state ? ` (${state})` : ""}`;
    }
    default:
      return undefined;
  }
}

function todoSummary(args: Record<string, unknown>): string {
  const todos = Array.isArray(args.todos) ? args.todos : [];
  const active = todos.find(
    (todo) => isArgumentObject(todo) && todo.status === "in_progress",
  ) as Record<string, unknown> | undefined;
  const doing =
    active &&
    (nonEmptyString(active.activeForm) ?? nonEmptyString(active.content));
  return doing ? firstLine(doing) : "Updated the to-do list";
}

function questionSummary(args: Record<string, unknown>): string | undefined {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  const first = questions.find(isArgumentObject);
  const question = first && nonEmptyString(first.question);
  return question ? `Asked: ${start(question, 100)}` : undefined;
}

function toolSearchSummary(query: string): string {
  const select = /^select:(.*)$/is.exec(query.trim());
  if (!select) return `Looked for tools: "${start(query)}"`;
  const names = select[1]!
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map(toolDisplayName);
  return names.length ? `Loaded tools: ${names.join(", ")}` : "Loaded tools";
}

function pathSummary(verb: string, args: Record<string, unknown>) {
  const path =
    nonEmptyString(args.file_path) ??
    nonEmptyString(args.filePath) ??
    nonEmptyString(args.notebook_path) ??
    nonEmptyString(args.path);
  return path ? `${verb} ${shortPath(path.trim())}` : undefined;
}

function searchSummary(verb: string, args: Record<string, unknown>) {
  const pattern = nonEmptyString(args.pattern);
  if (!pattern) return undefined;
  const path = nonEmptyString(args.path);
  return `${verb} ${pattern}${path ? ` in ${shortPath(path)}` : ""}`;
}

// Codex's tools. In code mode its one `exec` tool runs JavaScript that calls
// the others (`await tools.exec_command({cmd:"git status"})`), so their
// arguments are read out of the code.

/** The JavaScript string literal `literal`'s value, quotes included. */
function jsStringValue(literal: string): string {
  if (literal.startsWith('"')) {
    try {
      return JSON.parse(literal) as string;
    } catch {
      // Fall through: unescape by hand.
    }
  }
  return literal
    .slice(1, -1)
    .replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, escape: string) => {
      if (escape.length > 1)
        return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
      return escape === "n" ? "\n" : escape === "t" ? "\t" : escape;
    });
}

const JS_STRING =
  String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|` + "`(?:[^`\\\\]|\\\\.)*`";

/** The string values of `key` in a JavaScript object literal's text. */
function jsStringArguments(code: string, key: string): string[] {
  const pattern = new RegExp(
    String.raw`(?:^|[{,\s])["']?${key}["']?\s*:\s*(${JS_STRING})`,
    "g",
  );
  return [...code.matchAll(pattern)].map((match) => jsStringValue(match[1]!));
}

function jsNumberArgument(code: string, key: string): string | undefined {
  return new RegExp(String.raw`["']?${key}["']?\s*:\s*(\d+)`).exec(code)?.[1];
}

/** The files a Codex patch adds, edits or deletes, as one line. */
function patchSummary(patch: string): string | undefined {
  const verbs = { Add: "Add", Update: "Edit", Delete: "Delete" } as const;
  const files: { verb: string; path: string }[] = [];
  // In code mode the patch is still a string literal: \n is two characters.
  for (const match of patch.matchAll(
    /\*\*\* (Add|Update|Delete) File: (.+?)(?=\\n|\n|"|$)/g,
  )) {
    files.push({
      verb: verbs[match[1] as keyof typeof verbs],
      path: shortPath(match[2]!.trim()),
    });
  }
  if (!files.length) return undefined;
  const sameVerb = files.every((file) => file.verb === files[0]!.verb);
  return sameVerb
    ? `${files[0]!.verb} ${files.map((file) => file.path).join(", ")}`
    : files.map((file) => `${file.verb} ${file.path}`).join(", ");
}

/** What writing `chars` to a Codex terminal session does. */
function writeStdinSummary(
  sessionId: string | undefined,
  chars: string,
  context: ToolSummaryContext,
): string {
  const command = sessionId ? context.codexCommand?.(sessionId) : undefined;
  const target = command
    ? firstLine(command)
    : sessionId
      ? `session ${sessionId}`
      : "a session";
  if (!chars) return `Wait for output of ${target}`;
  if (chars === "\u0003") return `Interrupt ${target}`;
  return `Type into ${target}: ${start(chars)}`;
}

function planSummary(plan: unknown): string {
  const steps = Array.isArray(plan) ? plan : [];
  const active = steps.find(
    (step) => isArgumentObject(step) && step.status === "in_progress",
  ) as Record<string, unknown> | undefined;
  const step = active && nonEmptyString(active.step);
  return step ? `Plan: ${firstLine(step)}` : "Updated the plan";
}

/** One call Codex's code makes: `tools.<name>(<arguments>)`. */
function codexCodeCallSummary(
  name: string,
  code: string,
  context: ToolSummaryContext,
): string {
  switch (name) {
    case "exec_command": {
      const command = jsStringArguments(code, "cmd")[0];
      return command ? firstLine(command) : "Run a command";
    }
    case "write_stdin":
      return writeStdinSummary(
        jsNumberArgument(code, "session_id"),
        jsStringArguments(code, "chars")[0] ?? "",
        context,
      );
    case "apply_patch":
      return patchSummary(code) ?? "Edit files";
    case "update_plan": {
      const step =
        /step\s*["']?\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*["']?status["']?\s*:\s*["']in_progress/.exec(
          code,
        )?.[1];
      return step
        ? `Plan: ${firstLine(jsStringValue(step))}`
        : "Updated the plan";
    }
    case "view_image": {
      const path = jsStringArguments(code, "path")[0];
      return path ? `View ${shortPath(path)}` : "View an image";
    }
    case "web__run": {
      const query = jsStringArguments(code, "q")[0];
      if (query) return `Search the web: ${firstLine(query)}`;
      const ref = jsStringArguments(code, "ref_id")[0];
      return ref && /^https?:/.test(ref)
        ? `Fetch ${hostOf(ref)}`
        : "Browse the web";
    }
    default:
      return capitalize(words(name.replace(/__/g, ": ")));
  }
}

/** What Codex's code-mode `exec` does: the calls its code makes. */
function codexExecSummary(
  code: string,
  context: ToolSummaryContext,
): string | undefined {
  const calls = [...code.matchAll(/\btools\.(\w+)\s*\(/g)];
  if (!calls.length) return undefined;
  return calls
    .map((call, index) =>
      codexCodeCallSummary(
        call[1]!,
        code.slice(
          call.index! + call[0].length,
          calls[index + 1]?.index ?? code.length,
        ),
        context,
      ),
    )
    .join("; ");
}

/** A Codex tool's summary, from its arguments; undefined for the others. */
function codexToolSummary(
  name: string,
  args: Record<string, unknown>,
  context: ToolSummaryContext,
): string | undefined {
  // A custom tool's input, which is not JSON, comes as `value`.
  const value = nonEmptyString(args.value);
  switch (name) {
    case "exec":
      return value ? codexExecSummary(value, context) : undefined;
    case "exec_command": {
      const command = nonEmptyString(args.cmd);
      return command ? firstLine(command) : undefined;
    }
    case "write_stdin": {
      const id = args.session_id;
      return writeStdinSummary(
        typeof id === "number" || typeof id === "string"
          ? String(id)
          : undefined,
        typeof args.chars === "string" ? args.chars : "",
        context,
      );
    }
    case "apply_patch":
      return patchSummary(value ?? nonEmptyString(args.input) ?? "");
    case "update_plan":
      return planSummary(args.plan);
    case "view_image":
      return pathSummary("View", args);
    case "spawn_agent": {
      const message = nonEmptyString(args.message);
      return message ? `Agent: ${start(message, 100)}` : undefined;
    }
    case "wait":
    case "wait_agent":
      return "Wait for agents";
    case "close_agent":
      return "Close an agent";
    default:
      return undefined;
  }
}

/**
 * The Codex terminal session a call started, as [id, command]: a command
 * still running when the call returned says its session id.
 */
function codexStartedSession(
  name: string,
  args: Record<string, unknown>,
  result: string,
): [string, string] | undefined {
  const id = /session ID (\d+)|\\?"session_id\\?"\s*:\s*(\d+)/.exec(result);
  if (!id) return undefined;
  let command: string | undefined;
  if (name === "exec_command") command = nonEmptyString(args.cmd);
  else if (name === "exec") {
    const code = nonEmptyString(args.value) ?? "";
    const calls = [...code.matchAll(/\btools\.(\w+)\s*\(/g)];
    if (calls.length === 1 && calls[0]![1] === "exec_command")
      command = jsStringArguments(code, "cmd")[0];
  }
  return command ? [id[1] ?? id[2]!, command] : undefined;
}

/** A known tool's summary, from its arguments; undefined for the others. */
function knownToolSummary(
  name: string,
  args: Record<string, unknown>,
  context: ToolSummaryContext,
): string | undefined {
  const description = nonEmptyString(args.description);
  switch (name) {
    case "SendMessage": {
      const to = nonEmptyString(args.to);
      const what =
        nonEmptyString(args.summary) ??
        (nonEmptyString(args.message)
          ? start(args.message as string)
          : undefined);
      const who = to ? recipient(to.trim(), context) : "an agent";
      return what ? `To ${who}: ${firstLine(what)}` : `Message to ${who}`;
    }
    case "Agent":
    case "Task": {
      if (description) return firstLine(description);
      const prompt = nonEmptyString(args.prompt);
      return prompt ? start(prompt, 100) : undefined;
    }
    case "Bash":
    case "Monitor": {
      if (description) return firstLine(description);
      const command = nonEmptyString(args.command);
      return command ? firstLine(command) : undefined;
    }
    case "Read":
      return pathSummary("Read", args);
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return pathSummary("Edit", args);
    case "Write":
      return pathSummary("Write", args);
    case "Grep":
      return searchSummary("Search for", args);
    case "Glob":
      return searchSummary("Find", args);
    case "WebSearch": {
      const query = nonEmptyString(args.query);
      return query ? `Search the web: ${firstLine(query)}` : undefined;
    }
    case "WebFetch": {
      const url = nonEmptyString(args.url);
      return url ? `Fetch ${hostOf(url.trim())}` : undefined;
    }
    case "ToolSearch": {
      const query = nonEmptyString(args.query);
      return query ? toolSearchSummary(query) : undefined;
    }
    case "TodoWrite":
      return todoSummary(args);
    case "Skill": {
      const skill = nonEmptyString(args.skill);
      return skill ? `Skill: ${skill}` : undefined;
    }
    case "AskUserQuestion":
      return questionSummary(args);
    default:
      return codexToolSummary(name, args, context);
  }
}

/**
 * What a call does, in one short line of plain words, from its name, its
 * arguments, and what the rest of the session tells (its result, who an
 * agent id is, what a review thread is about). A tool this does not know
 * says its `description` argument when it has one, else its main argument's
 * first line; an MCP tool's line starts with its readable name. Empty when
 * the arguments say nothing.
 */
export function toolCallSummary(
  name: string,
  text: string,
  context: ToolSummaryContext = {},
  limit = TOOL_SUMMARY_LIMIT,
): string {
  const parsed = parseToolArguments(text);
  if (!isArgumentObject(parsed)) return clip(firstLine(text), limit);
  const mcp = mcpParts(name);
  // The review client run from a shell: its own description, else the
  // shell call's, else what the tool does.
  const client = mcp ? undefined : roamgateToolCall(name, parsed);
  if (client) {
    const described =
      nonEmptyString(client.args.description) ??
      nonEmptyString(parsed.description);
    const line = described
      ? firstLine(described)
      : roamgateSummary(client.tool, client.args, context);
    if (line) return clip(line, limit);
  }
  const known = mcp
    ? /(?:^|_)roamgate$/.test(mcp.server)
      ? roamgateSummary(mcp.tool, parsed, context)
      : undefined
    : knownToolSummary(name, parsed, context);
  if (known) return clip(known, limit);
  const described = nonEmptyString(parsed.description);
  const line = described ? firstLine(described) : keyArgument(parsed);
  if (mcp) {
    const label = toolDisplayName(name);
    return clip(line ? `${label} · ${line}` : label, limit);
  }
  return clip(line ?? firstLine(JSON.stringify(parsed)), limit);
}

/**
 * What a session tells about its calls' arguments: who its background
 * agents are, what review threads are about, and the names of the Roamgate
 * sessions it talks to. Fed every user message and every call with its
 * result, in any order.
 */
export function createToolSummaryNotes() {
  const agents = new Map<string, string>();
  const threads = new Map<string, string>();
  const sessions = new Map<string, string>();
  const codexSessions = new Map<string, string>();
  return {
    /** A message the session got: Roamgate's comments, other sessions. */
    noteMessage(text: string) {
      if (!text) return;
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        const head = /^- \[([0-9a-f]{8})\] .*:\s*$/.exec(line);
        if (!head) return;
        // The thread's lines: indented, up to the next thread or paragraph.
        const rest = lines.slice(index + 1);
        const end = rest.findIndex((each) => !/^ {2}/.test(each));
        const thread = end < 0 ? rest : rest.slice(0, end);
        const quote = thread.find((each) => /^ {2}> \S/.test(each));
        const body = thread.find((each) => /^ {2}[^\s>(]/.test(each));
        const label = start(
          quote ? quote.replace(/^ {2}> /, "") : (body ?? ""),
        );
        if (label) threads.set(head[1]!, label);
      });
      for (const frame of text.matchAll(
        /<roamgate-agent-message from="([^"]+)" from-name="([^"]*)"/g,
      )) {
        const name = frame[2]!
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&");
        if (name.trim()) sessions.set(frame[1]!, name.trim());
      }
    },
    /** A call and its result, once it has one. */
    noteCall(name: string, args: unknown, result?: string) {
      const input = isArgumentObject(args) ? args : {};
      const started = result && codexStartedSession(name, input, result);
      if (started) codexSessions.set(...started);
      if ((name === "Agent" || name === "Task") && result) {
        const id = /agentId:\s*([\w-]+)/.exec(result)?.[1];
        const agentName = nonEmptyString(input.name);
        const description = nonEmptyString(input.description);
        const label = agentName
          ? `the ${agentName.trim()} agent`
          : description
            ? `the "${start(description)}" agent`
            : undefined;
        if (id && label) agents.set(id, label);
      }
      const mcp = mcpParts(name);
      if (!mcp || !/(?:^|_)roamgate$/.test(mcp.server) || !result) return;
      for (const [id, label] of threadsInOutput(result)) threads.set(id, label);
      if (mcp.tool === "agent_sessions") {
        const parsed = parseToolArguments(result);
        const list =
          isArgumentObject(parsed) && Array.isArray(parsed.sessions)
            ? parsed.sessions
            : [];
        for (const session of list) {
          if (!isArgumentObject(session)) continue;
          const address = nonEmptyString(session.address);
          const label =
            nonEmptyString(session.title) ??
            nonEmptyString(session.name) ??
            nonEmptyString(session.workspace);
          if (address && label) sessions.set(address, label.trim());
        }
      }
    },
    /** The context for one call's summary. */
    context(result?: string): ToolSummaryContext {
      return {
        ...(result ? { result } : {}),
        agentName: (id) => agents.get(id),
        threadLabel: (id) => threads.get(id.slice(0, 8)),
        sessionName: (address) => sessions.get(address),
        codexCommand: (id) => codexSessions.get(id),
      };
    },
  };
}
