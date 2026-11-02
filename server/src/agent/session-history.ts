import { createHash } from "node:crypto";
import type { InjectedKind } from "../../../shared/injectedMessage";
import { isDismissedResult } from "../../../shared/review";
import type { SlashCommand } from "../../../shared/slashCommand";
import type { AtifTrajectory, SessionFile } from "./session-types";
import { isConversationStep } from "./session-messages";
import { historyWindowEntries } from "./session-history-window";
import { type PublishedArtifact, publishedArtifact } from "./session-artifacts";

export type HistoryEntry = {
  id: string;
  role: "user" | "assistant" | "tool";
  kind: "message" | "tool_call" | "tool_result" | "error";
  text: string;
  sent_at: string;
  tool_name?: string;
  source_call_id?: string;
  is_error?: boolean;
  // A message the user sent while the agent worked, still waiting in its
  // queue. Once delivered it keeps its id and loses the flag.
  queued?: boolean;
  // The summary that replaced the earlier conversation when it was compacted.
  compact_summary?: boolean;
  // An agent message that ended its turn (Claude Code): the answer, even
  // while the agent still shows working for a task in the background.
  turn_end?: boolean;
  // On an Artifact tool result: the page it published. Kept when the
  // payload is redacted, so the chat can link to it.
  artifact?: PublishedArtifact;
  // On the result of a command that opened a merge or pull request (`glab
  // mr create`, `gh pr create`): its URL as the command printed it. Kept
  // when the payload is redacted, so the chat can list it.
  created_request?: string;
  // On a tool result: the user dismissed the question or permission it
  // waited on, unanswered, from Roamgate. Kept when the payload is
  // redacted, so the chat can say so.
  dismissed?: boolean;
  // Set on redacted wire entries: UTF-8 byte length of the withheld text,
  // fetchable via agent_history.entry when the user expands the card.
  text_bytes?: number;
  // Set with text_bytes: a content hash of the withheld text, so clients can
  // tell a payload rewritten in place (even at the same length) from the one
  // they already fetched.
  text_hash?: string;
  // Claude Code: the API message id and block index of an assistant
  // message, and the transcript record's uuid, so a streamed block can be
  // matched to the entry that replaces it.
  message_id?: string;
  block_index?: number;
  uuid?: string;
  // How many images the user sent inline with this message (conversation
  // mode, a pasted image), fetchable by uuid via agent_history.image.
  images?: number;
  // A user-turn message the user did not type (Claude Code): a subagent's
  // report, another session's message, a task ending. Its text is what it
  // says; the chat shows the label, as a notice, and voice never reads it.
  injected?: { kind: InjectedKind; label: string };
  // On a rewind's notice (injected kind "rewound"): the user's messages the
  // rewind cut, as sent, so the chat can offer them back.
  rewound?: { text: string; sent_at: string }[];
  // A slash command the user typed in the terminal (Claude Code): its
  // text is the command as typed ("/exit"); the chat shows it as one.
  command?: SlashCommand;
  // What a command run in Claude Code itself printed ("Reloaded: 11
  // plugins..."), right after it: not the agent's words.
  command_output?: true;
  // A `!` line the user ran (Claude Code's bash mode), with what it
  // printed when the transcript has it. Its text is the command.
  shell?: {
    command: string;
    stdout?: string;
    stderr?: string;
    // Its output is longer than the chat shows of it (SHELL_SHOWN).
    truncated?: boolean;
    // The directory it ran in, as the transcript has it.
    cwd?: string;
    // Filled by the browser from the run it saw end (the transcript keeps
    // no exit code), and the connection's name.
    status?: "running" | "done" | "stopped" | "failed";
    exit_code?: number | null;
    started_at?: string;
    finished_at?: string;
    host?: string;
  };
};

/** What the chat shows of each stream of a `!` line from the transcript. */
const SHELL_SHOWN = 8000;
export type HistoryCursor = { epoch: string; revision: number };
export type HistoryUpdate = {
  history_version: 2;
  cursor: HistoryCursor;
  window_limit: number;
} & (
  | { mode: "snapshot"; entries: HistoryEntry[] }
  | {
      mode: "delta";
      base_revision: number;
      upserts: HistoryEntry[];
      removed: string[];
      order?: string[];
    }
);
export const HISTORY_WINDOW_LIMIT = 200;

export function historyEntriesFromTrajectory(
  file: SessionFile,
  trajectory: AtifTrajectory,
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  const occurrences = new Map<string, number>();
  const names = new Map<string, string>();
  const artifactCalls = new Map<string, Record<string, unknown>>();
  const createCalls = new Set<string>();
  for (const step of trajectory.steps) {
    for (const call of step.tool_calls ?? []) {
      names.set(call.tool_call_id, call.function_name);
      if (call.function_name === "Artifact")
        artifactCalls.set(call.tool_call_id, call.arguments);
      if (createsRequest(call.arguments?.command))
        createCalls.add(call.tool_call_id);
    }
  }
  const add = (entry: Omit<HistoryEntry, "id">) => {
    // Content identities survive step renumbering. Repeated identical items get
    // occurrence suffixes; revisions, not these IDs, define synchronization.
    const identity = entry.source_call_id
      ? [entry.kind, entry.source_call_id]
      : [entry.kind, entry.role, entry.text];
    const hash = createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex")
      .slice(0, 24);
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    entries.push({ ...entry, id: `${hash}:${occurrence}` });
  };
  for (const step of trajectory.steps) {
    const sent_at = step.timestamp ?? new Date(file.mtimeMs).toISOString();
    if (!step.observation && isConversationStep(step)) {
      add({
        kind: "message",
        role: step.source === "user" ? "user" : "assistant",
        text: step.message,
        sent_at,
        ...(step.extra?.queued === true ? { queued: true } : {}),
        ...(step.extra?.compact_summary === true
          ? { compact_summary: true }
          : {}),
        ...(step.extra?.turn_end === true ? { turn_end: true } : {}),
        ...(typeof step.extra?.message_id === "string"
          ? { message_id: step.extra.message_id }
          : {}),
        ...(typeof step.extra?.block_index === "number"
          ? { block_index: step.extra.block_index }
          : {}),
        ...(typeof step.extra?.uuid === "string"
          ? { uuid: step.extra.uuid }
          : {}),
        ...(step.source === "user" &&
        typeof step.extra?.images === "number" &&
        step.extra.images > 0
          ? { images: step.extra.images }
          : {}),
        ...injectedField(step.extra?.injected),
        ...rewoundField(step.extra?.rewound),
        ...commandField(step.extra?.command),
        ...(step.extra?.command_output === true
          ? { command_output: true as const }
          : {}),
        ...shellField(step.extra?.shell),
        ...shellCreatedRequest(step.extra?.shell),
      });
    }
    for (const call of step.tool_calls ?? []) {
      add({
        kind: "tool_call",
        role: "tool",
        tool_name: call.function_name,
        source_call_id: call.tool_call_id,
        text: JSON.stringify(call.arguments, null, 2),
        sent_at,
      });
    }
    for (const result of step.observation?.results ?? []) {
      add({
        kind: "tool_result",
        role: "tool",
        tool_name:
          typeof result.extra?.tool_name === "string"
            ? result.extra.tool_name
            : names.get(result.source_call_id ?? ""),
        source_call_id: result.source_call_id,
        text: result.content ?? step.message,
        is_error: result.extra?.is_error === true,
        sent_at,
        ...artifactField(
          artifactCalls.get(result.source_call_id ?? ""),
          result.extra?.is_error === true ? "" : (result.content ?? ""),
        ),
        ...createdRequestField(
          createCalls.has(result.source_call_id ?? "") &&
            result.extra?.is_error !== true
            ? (result.content ?? "")
            : "",
        ),
        ...(result.extra?.is_error === true &&
        isDismissedResult(result.content ?? step.message)
          ? { dismissed: true }
          : {}),
      });
    }
    if (typeof step.extra?.error_message === "string") {
      add({
        kind: "error",
        role: "assistant",
        text: step.extra.error_message,
        is_error: true,
        sent_at,
      });
    }
  }
  return historyWindowEntries(entries, HISTORY_WINDOW_LIMIT);
}

function shellField(value: unknown): Pick<HistoryEntry, "shell"> {
  if (!value || typeof value !== "object") return {};
  const { command, stdout, stderr, cwd } = value as Record<string, unknown>;
  if (typeof command !== "string") return {};
  const long = [stdout, stderr].some(
    (each) => typeof each === "string" && each.length > SHELL_SHOWN,
  );
  return {
    shell: {
      command,
      ...(typeof stdout === "string"
        ? { stdout: stdout.slice(0, SHELL_SHOWN) }
        : {}),
      ...(typeof stderr === "string"
        ? { stderr: stderr.slice(0, SHELL_SHOWN) }
        : {}),
      ...(long ? { truncated: true } : {}),
      ...(typeof cwd === "string" && cwd ? { cwd } : {}),
    },
  };
}

function rewoundField(value: unknown): Pick<HistoryEntry, "rewound"> {
  if (!Array.isArray(value)) return {};
  const messages = value.flatMap((each) =>
    each &&
    typeof each === "object" &&
    typeof each.text === "string" &&
    typeof each.sent_at === "string"
      ? [{ text: each.text as string, sent_at: each.sent_at as string }]
      : [],
  );
  return messages.length ? { rewound: messages } : {};
}

/** A shell command that opens a merge or pull request. */
export function createsRequest(command: unknown): boolean {
  return (
    typeof command === "string" &&
    /\b(?:glab\s+mr\s+create|gh\s+pr\s+create)\b/.test(command)
  );
}

const REQUEST_URL =
  /https:\/\/[^\s"'<>()]+?\/(?:-\/merge_requests|pull)\/\d{1,9}\b/;

/** The request URL `glab mr create` or `gh pr create` printed. */
export function createdRequestField(
  output: string,
): Pick<HistoryEntry, "created_request"> {
  const url = output ? REQUEST_URL.exec(output.slice(0, 200_000))?.[0] : null;
  return url ? { created_request: url } : {};
}

function shellCreatedRequest(
  value: unknown,
): Pick<HistoryEntry, "created_request"> {
  if (!value || typeof value !== "object") return {};
  const { command, stdout } = value as Record<string, unknown>;
  return createsRequest(command) && typeof stdout === "string"
    ? createdRequestField(stdout)
    : {};
}

function injectedField(value: unknown): Pick<HistoryEntry, "injected"> {
  if (!value || typeof value !== "object") return {};
  const { kind, label } = value as Record<string, unknown>;
  return typeof kind === "string" && typeof label === "string"
    ? { injected: { kind: kind as InjectedKind, label } }
    : {};
}

function commandField(value: unknown): Pick<HistoryEntry, "command"> {
  if (!value || typeof value !== "object") return {};
  const { name, args } = value as Record<string, unknown>;
  return typeof name === "string" && name
    ? { command: { name, args: typeof args === "string" ? args : "" } }
    : {};
}

function artifactField(
  args: Record<string, unknown> | undefined,
  output: string,
) {
  const artifact = args && publishedArtifact(args, output);
  return artifact ? { artifact } : {};
}

// Short content hash of a tool payload, shared by redacted entries and
// agent_history.entry replies.
export function historyTextHash(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function redactHistoryEntry(entry: HistoryEntry): HistoryEntry {
  if (entry.role !== "tool" || entry.text.length === 0) return entry;
  return {
    ...entry,
    text: "",
    text_bytes: Buffer.byteLength(entry.text, "utf8"),
    text_hash: historyTextHash(entry.text),
  };
}

// Tool payloads are bulky and rarely read, so the wire format carries only
// their metadata. The projection cache keeps full text for on-demand fetches.
export function redactHistoryUpdate(update: HistoryUpdate): HistoryUpdate {
  if (update.mode === "snapshot") {
    return { ...update, entries: update.entries.map(redactHistoryEntry) };
  }
  return { ...update, upserts: update.upserts.map(redactHistoryEntry) };
}

export function historyUpdate(
  cursor: HistoryCursor,
  entries: HistoryEntry[],
  requested: unknown,
  versions: Map<number, HistoryEntry[]>,
): HistoryUpdate {
  const base =
    typeof requested === "object" && requested !== null
      ? (requested as Partial<HistoryCursor>)
      : null;
  const previous =
    base?.epoch === cursor.epoch && Number.isSafeInteger(base.revision)
      ? versions.get(base.revision as number)
      : undefined;
  if (!previous || (base?.revision ?? Infinity) > cursor.revision) {
    return {
      history_version: 2,
      mode: "snapshot",
      cursor,
      window_limit: HISTORY_WINDOW_LIMIT,
      entries,
    };
  }
  if (base?.revision === cursor.revision) {
    return {
      history_version: 2,
      mode: "delta",
      cursor,
      base_revision: cursor.revision,
      window_limit: HISTORY_WINDOW_LIMIT,
      upserts: [],
      removed: [],
    };
  }
  const old = new Map(previous.map((entry) => [entry.id, entry]));
  const ids = new Set(entries.map((entry) => entry.id));
  const order = entries.map((entry) => entry.id);
  return {
    history_version: 2,
    mode: "delta",
    cursor,
    base_revision: base!.revision!,
    window_limit: HISTORY_WINDOW_LIMIT,
    upserts: entries.filter(
      (entry) => JSON.stringify(old.get(entry.id)) !== JSON.stringify(entry),
    ),
    removed: previous
      .filter((entry) => !ids.has(entry.id))
      .map((entry) => entry.id),
    ...(order.join() === previous.map((entry) => entry.id).join()
      ? {}
      : { order }),
  };
}
