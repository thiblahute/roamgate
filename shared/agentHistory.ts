/**
 * A session's History as the server sends it and the web merges it: its
 * entries, its cursor and updates, and the window both cut it to. Free of
 * Node and browser imports.
 */
import type { PublishedArtifact } from "./agentSession";
import type { FileEdit } from "./fileEdits";
import type { InjectedKind } from "./injectedMessage";
import type { SlashCommand } from "./slashCommand";
import type { RoamgateWrite } from "./toolSummary";

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
  // On a Bash call that sent another agent session a message
  // (`roamgate-review message`): to whom, and what. Kept when the payload is
  // redacted, so the chat can show the message as one.
  agent_message?: { to: string; text: string };
  // On that call's result: whether it was sent, and the receiver's name.
  agent_message_result?: { sent: boolean; name: string | null };
  // On a call that edits a file (Edit, Write...): what it changed, from
  // Claude Code's patch once its result has one, else what its arguments
  // ask. None once it failed. Kept when the payload is redacted, so the
  // chat can show the change as the terminal does.
  file_edit?: FileEdit;
  // On a tool result: the user dismissed the question or permission it
  // waited on, unanswered, from Roamgate. Kept when the payload is
  // redacted, so the chat can say so.
  dismissed?: boolean;
  // On a tool call: what it does in one short line (its description
  // argument, else its main argument's first line, about 160 characters).
  // Kept when the payload is redacted, so a collapsed tool group can show
  // progress without fetching arguments.
  summary?: string;
  // On a call that wrote in Roamgate (a reply in a thread, a new thread, an
  // edit): what it wrote and where, from its arguments and its result. Kept
  // when the payload is redacted, so the chat shows it as a row that links
  // to the thread and the agent need not say it in the chat.
  roamgate_write?: RoamgateWrite;
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

type WindowedEntry = { role: string };

// The window counts conversation entries only (user/assistant messages and
// errors). Tool calls and tool results ride along with the conversation
// entries that survive the cut, so tool-heavy turns cannot evict user
// messages from the visible history.
export function historyWindowEntries<T extends WindowedEntry>(
  entries: readonly T[],
  limit: number,
): T[] {
  let remaining = Math.max(1, Math.floor(limit));
  let start = entries.length;
  while (start > 0 && remaining > 0) {
    start -= 1;
    if (entries[start]?.role !== "tool") remaining -= 1;
  }
  return entries.slice(start);
}
