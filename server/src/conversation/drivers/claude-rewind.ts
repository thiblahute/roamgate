import type { AgentChatRewindCheck } from "../../../../shared/agentChat";
import type { HeadlessProcess } from "../headless";
import { type RewindScan, scanRewind } from "./claude-rewind-scan";
import type { RewindContext, RewindDriver } from "./types";

/** Why Claude Code would not rewind the conversation, said for the user. */
const REWIND_REFUSALS: Record<string, string> = {
  turn_running: "a turn is running",
  commands_queued: "messages wait to be sent",
  prompt_pending: "a question or permission waits for an answer",
  target_not_found: "the message is not in the conversation any more",
  stale_target:
    "the conversation has moved on since the chat showed it; reload and try again",
  unseen_later_turn:
    "the conversation has a later turn the chat has not shown yet; try again",
  target_splits_tool_call: "the message is inside a tool call",
  persist_failed: "Claude Code could not save the rewind",
  state_changed: "the conversation changed meanwhile; try again",
  usage_limited: "the usage limit is reached",
  expired: "it took too long",
};

const NO_CHECKPOINTS = "File rewinding is not enabled.";
const NO_CHECKPOINT_FOR_MESSAGE = "No file checkpoint found for this message.";

/** What the code of a rewind to before a message comes to (scanRewind). */
export function rewindCheckOf(scan: RewindScan | null): AgentChatRewindCheck {
  if (!scan?.found) return { code: "unknown" };
  if (!scan.edited.length) return { code: "none" };
  return {
    code: scan.checkpoint ? "restorable" : "no_checkpoint",
    files: scan.edited,
  };
}

/** Restores the code to before `uuid`: a dry run first, unless `real`. */
async function rewindFiles(
  context: RewindContext,
  child: HeadlessProcess,
  uuid: string,
  dryRun: boolean,
): Promise<{ ok: true; files?: string[] } | { ok: false; reason: string }> {
  const answer = await context.control(child, "rewind_files", {
    user_message_id: uuid,
    ...(dryRun ? { dry_run: true } : {}),
  });
  if (!answer) return { ok: false, reason: "Claude did not answer" };
  const response = answer.response ?? {};
  const error =
    answer.error ??
    (response.canRewind === true
      ? undefined
      : typeof response.error === "string"
        ? response.error
        : "Claude Code cannot restore the code");
  if (error) return { ok: false, reason: error };
  const files = Array.isArray(response.filesChanged)
    ? response.filesChanged.filter(
        (file): file is string => typeof file === "string",
      )
    : undefined;
  return { ok: true, ...(files ? { files } : {}) };
}

/** What the transcript says of the code after `uuid`; null: unknown. */
async function scanTranscript(
  context: RewindContext,
  uuid: string,
): Promise<RewindScan | null> {
  if (!context.readTranscript) return null;
  try {
    const transcript = await context.readTranscript();
    if (transcript === null) return null;
    const scan = scanRewind(transcript, uuid);
    return scan.found ? scan : null;
  } catch (error) {
    context.log("could not read the transcript for a rewind", {
      session: context.sessionId(),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Claude Code's /rewind over its control protocol: the conversation
 * (Claude Code records the cut in the transcript, so a later resume, here
 * or in the terminal, goes on from before it), the code (from the
 * checkpoints Claude Code keeps), or both. `lastSeen` is the latest
 * message of the user's the chat shows: Claude Code refuses to cut a later
 * turn the user has not seen.
 */
export const claudeRewind: RewindDriver = {
  checkTranscript(transcript, uuid) {
    return rewindCheckOf(
      transcript === null ? null : scanRewind(transcript, uuid),
    );
  },

  async check(context, uuid) {
    return rewindCheckOf(await scanTranscript(context, uuid));
  },

  async run(context, input) {
    const refuse = (reason: string) => ({ ok: false as const, reason });
    let child = await context.ensureProcess();
    // Whether the code is restored: only when asked, and when there is
    // something to restore.
    let code = false;
    let files: string[] | undefined;
    if (input.mode !== "conversation") {
      // Checked first: a conversation rewound without its code (or the
      // other way round) is not what was asked. What the transcript says
      // (undefined: it does not) decides along with Claude Code's dry run.
      const scan = await scanTranscript(context, input.uuid);
      const edited = scan?.edited;
      const noCheckpoint = () => ({
        ok: false as const,
        no_checkpoint: true as const,
        reason:
          "Claude Code has no code checkpoint for these changes (made before checkpoints were on)",
        ...(edited?.length ? { files: edited } : {}),
      });
      // Nothing edited after the message: nothing to restore, so no
      // checkpoint is needed, nor a process that keeps them.
      const nothingEdited = edited !== undefined && !edited.length;
      let check = await rewindFiles(context, child, input.uuid, true);
      if (!check.ok && !nothingEdited && check.reason === NO_CHECKPOINTS) {
        // A process started before checkpoints were turned on for it:
        // a new one has them, and reads those already in the session;
        // unless Claude Code took none for this message (the edits were
        // made before), which no restart brings back.
        if (scan && !scan.checkpoint) return noCheckpoint();
        context.log(
          "conversation process without checkpoints; starting another",
          { session: context.sessionId() },
        );
        if (!(await context.stopProcess()))
          return refuse("Claude did not stop to restore the code");
        child = await context.ensureProcess();
        check = await rewindFiles(context, child, input.uuid, true);
      }
      if (!check.ok && !nothingEdited)
        return check.reason === NO_CHECKPOINT_FOR_MESSAGE ||
          check.reason === NO_CHECKPOINTS
          ? noCheckpoint()
          : refuse(check.reason);
      if (check.ok && check.files?.length) {
        code = true;
        files = check.files;
      }
    }
    let prefill: string | undefined;
    if (input.mode !== "code") {
      const answer = await context.control(child, "rewind_conversation", {
        target_message_uuid: input.uuid,
        ...(input.lastSeen
          ? { last_seen_user_message_uuid: input.lastSeen }
          : {}),
      });
      if (!answer) return refuse("Claude did not answer");
      const response = answer.response ?? {};
      if (answer.error || response.rewound !== true) {
        const why =
          answer.error ??
          (typeof response.reason === "string"
            ? (REWIND_REFUSALS[response.reason] ??
              (typeof response.error === "string"
                ? response.error
                : response.reason))
            : "it refused");
        return refuse(`Claude Code did not rewind: ${why}`);
      }
      if (typeof response.prefillText === "string")
        prefill = response.prefillText;
    }
    if (code) {
      const done = await rewindFiles(context, child, input.uuid, false);
      if (!done.ok)
        return refuse(
          input.mode === "both"
            ? `The conversation was rewound, but not the code: ${done.reason}`
            : done.reason,
        );
    }
    context.log("conversation rewound", {
      session: context.sessionId(),
      mode: input.mode,
      code,
    });
    return {
      ok: true,
      ...(prefill !== undefined ? { prefill } : {}),
      ...(files ? { files } : {}),
      ...(input.mode !== "conversation"
        ? { code: code ? ("restored" as const) : ("none" as const) }
        : {}),
    };
  },
};
