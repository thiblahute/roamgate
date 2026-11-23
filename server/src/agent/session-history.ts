import { createHash } from "node:crypto";
import type { InjectedKind } from "../../../shared/injectedMessage";
import { outgoingAgentMessage } from "../../../shared/agentMessage";
import {
  createToolSummaryNotes,
  roamgateWrite,
  type ToolSummaryContext,
  toolCallSummary,
} from "../../../shared/toolSummary";
import { isDismissedResult } from "../../../shared/review";
import type { AtifTrajectory, SessionFile } from "./session-types";
import { isConversationStep } from "./session-messages";
import {
  type FileEdit,
  fileEditFromArguments,
  FILE_EDIT_TOOLS,
} from "../../../shared/fileEdits";
import { publishedArtifact } from "./session-artifacts";
import {
  type HistoryCursor,
  type HistoryEntry,
  type HistoryUpdate,
  historyWindowEntries,
} from "../../../shared/agentHistory";

export type { HistoryCursor, HistoryEntry, HistoryUpdate };

const SHELL_SHOWN = 8000;
export const HISTORY_WINDOW_LIMIT = 200;

export function historyEntriesFromTrajectory(
  file: SessionFile,
  trajectory: AtifTrajectory,
): HistoryEntry[] {
  return historyWindowEntries(
    allHistoryEntries(file, trajectory),
    HISTORY_WINDOW_LIMIT,
  );
}

/**
 * Every entry of a trajectory. `byRecord`: a message's identity is its
 * record's (uuid and block) when it has one, so it stays the same whatever
 * part of the transcript was read, as with a large one read from its end.
 */
export function allHistoryEntries(
  file: SessionFile,
  trajectory: AtifTrajectory,
  options: { byRecord?: boolean } = {},
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  const occurrences = new Map<string, number>();
  const names = new Map<string, string>();
  const artifactCalls = new Map<string, Record<string, unknown>>();
  const createCalls = new Set<string>();
  const messageCalls = new Map<string, { to: string; text: string }>();
  // What the calls' results say of their file edits: failed, or Claude
  // Code's patch.
  const editResults = new Map<string, EditResult>();
  // What each call's result says, for the calls' summaries.
  const resultTexts = new Map<string, string>();
  for (const step of trajectory.steps)
    for (const result of step.observation?.results ?? [])
      if (result.source_call_id) {
        editResults.set(result.source_call_id, {
          failed: result.extra?.is_error === true,
          ...(result.extra?.file_edit
            ? { edit: result.extra.file_edit as FileEdit }
            : {}),
        });
        if (typeof result.content === "string")
          resultTexts.set(result.source_call_id, result.content);
      }
  // Who the session's agents are and what its review threads are about,
  // so a summary can say them instead of their ids.
  const summaryNotes = createToolSummaryNotes();
  for (const step of trajectory.steps) {
    if (step.source === "user" && typeof step.message === "string")
      summaryNotes.noteMessage(step.message);
    for (const call of step.tool_calls ?? [])
      summaryNotes.noteCall(
        call.function_name,
        call.arguments,
        resultTexts.get(call.tool_call_id),
      );
  }
  for (const step of trajectory.steps) {
    for (const call of step.tool_calls ?? []) {
      names.set(call.tool_call_id, call.function_name);
      const message = outgoingAgentMessage(
        call.function_name,
        JSON.stringify(call.arguments ?? {}),
      );
      if (message) messageCalls.set(call.tool_call_id, message);
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
      : options.byRecord && entry.uuid
        ? [entry.kind, entry.role, entry.uuid, entry.block_index ?? 0]
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
        ...callSummaryField(
          call.function_name,
          call.arguments,
          summaryNotes.context(resultTexts.get(call.tool_call_id)),
        ),
        sent_at,
        ...(messageCalls.has(call.tool_call_id)
          ? { agent_message: messageCalls.get(call.tool_call_id)! }
          : {}),
        ...fileEditField(
          call.function_name,
          call.arguments,
          editResults,
          call.tool_call_id,
        ),
        ...roamgateWriteField(
          call.function_name,
          call.arguments,
          resultTexts.get(call.tool_call_id),
          editResults.get(call.tool_call_id)?.failed === true,
        ),
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
        ...(messageCalls.has(result.source_call_id ?? "")
          ? {
              agent_message_result: agentMessageResult(
                result.content ?? "",
                result.extra?.is_error === true,
              ),
            }
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
  return entries;
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

/** What `roamgate-review message` printed: sent, and to whom. */
export function agentMessageResult(
  output: string,
  isError: boolean,
): { sent: boolean; name: string | null } {
  try {
    const parsed = JSON.parse(output) as {
      sent?: unknown;
      to?: { name?: unknown };
    };
    return {
      sent: !isError && parsed?.sent === true,
      name: typeof parsed?.to?.name === "string" ? parsed.to.name : null,
    };
  } catch {
    return { sent: false, name: null };
  }
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

/**
 * What a file-editing call changed: Claude Code's patch from its result,
 * else its arguments' change while it has none; nothing once it failed.
 */
function fileEditField(
  tool: string,
  args: unknown,
  results: ReadonlyMap<string, EditResult>,
  callId: string,
): Pick<HistoryEntry, "file_edit"> {
  if (!FILE_EDIT_TOOLS.has(tool)) return {};
  const result = results.get(callId);
  if (result?.failed) return {};
  const edit = result?.edit ?? fileEditFromArguments(tool, args);
  return edit ? { file_edit: edit } : {};
}

type EditResult = { failed: boolean; edit?: FileEdit };

function callSummaryField(
  name: string,
  args: unknown,
  context: ToolSummaryContext,
) {
  const summary = toolCallSummary(name, JSON.stringify(args ?? {}), context);
  return summary && summary !== "{}" ? { summary } : {};
}

function roamgateWriteField(
  name: string,
  args: unknown,
  result: string | undefined,
  failed: boolean,
): Pick<HistoryEntry, "roamgate_write"> {
  const write = roamgateWrite(name, args ?? {}, {
    text: result ?? "",
    is_error: failed,
  });
  return write ? { roamgate_write: write } : {};
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

export function redactHistoryEntry(entry: HistoryEntry): HistoryEntry {
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

/**
 * A transcript's history epoch: the same for every process that reads the
 * same file, so a browser's cursor holds across a restart or a change of
 * the family's owner. `generation` is set once the file was rewritten
 * (cut, or changed without growing): the signature it had then.
 */
export function historyEpoch(
  agent: string,
  path: string,
  identity: string | undefined,
  generation: string | null,
): string {
  const hash = createHash("sha256");
  hash.update(["roamgate-history", agent, path, identity ?? ""].join("\0"));
  if (generation !== null) hash.update(`\0cut\0${generation}`);
  const hex = hash.digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Whether an agent's transcripts only grow: their revision is their size
 * plus one, and an earlier revision is the projection of their prefix.
 * Antigravity's SQLite store is rewritten in place: a change is a new
 * epoch, answered whole.
 */
export function appendOnlyHistory(agent: string): boolean {
  return agent !== "agy";
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
  const known =
    base?.epoch === cursor.epoch && Number.isSafeInteger(base.revision);
  if (known && base.revision === cursor.revision) {
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
  const previous = known ? versions.get(base.revision as number) : undefined;
  if (!previous || (base?.revision ?? Infinity) > cursor.revision) {
    return {
      history_version: 2,
      mode: "snapshot",
      cursor,
      window_limit: HISTORY_WINDOW_LIMIT,
      entries,
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
