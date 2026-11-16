import type { ReviewAnchor, ReviewThreadKind } from "../../shared/review";
import { HELD_FOR_SEND } from "./workspaceFeedback";

/*
 * Saving what is written in a review. The editor closes as you save, before
 * the server answers: a save that fails hands the text back to be kept (as
 * an unsent draft), so it is never lost, and says so.
 */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs a save. When it fails, `keep` puts the text somewhere it can be
 * found again; the answer is then why it failed, else null.
 */
export async function saveOrKeep(
  save: () => Promise<unknown>,
  keep: () => void,
): Promise<string | null> {
  try {
    await save();
    return null;
  } catch (error) {
    keep();
    return errorText(error) || "unknown error";
  }
}

/** What the status says of a save that failed: the text was kept. */
export function notSavedStatus(error: string): string {
  return `Not saved: ${error}. Your text is kept: reopen it to go on.`;
}

/** What the status says of a handoff, as it went. */
export function handoffStatus(
  agentName: string,
  error: string | null,
  open: number,
  newOverall: boolean,
): string {
  if (error) return `Not sent to ${agentName}: ${error}`;
  const discussions = `${open} open discussion${open === 1 ? "" : "s"}`;
  return `Sent to ${agentName}: ${discussions}${newOverall ? " and your overall comment" : ""}.`;
}

/** A comment being written: where it goes, and what it is. */
export type ReviewEditor = {
  /** Diff row the comment is on; null for file or whole-review comments. */
  at: number | null;
  file: number | null;
  kind: ReviewThreadKind;
  anchor: ReviewAnchor;
  /** Editing an existing comment, or answering a thread. */
  commentId?: string;
  replyTo?: string;
  /** A reply in a forge discussion: a draft of the user's review there. */
  publicReply?: boolean;
  /** The review's overall comment. */
  overall?: boolean;
  text: string;
  /** Remounts the editor when a suggestion is inserted from outside. */
  version: number;
};

/** A new comment shorter than this is only sent explicitly. */
export const STRAY_MAX = 3;

/** Where an editor's unsent text is kept (reviewDrafts), by what it writes. */
export function editorKey(editor: ReviewEditor): string {
  if (editor.overall) return "overall";
  if (editor.commentId) return `edit:${editor.commentId}`;
  if (editor.replyTo) return `reply:${editor.replyTo}`;
  return `new:${editor.kind}:${JSON.stringify(editor.anchor)}`;
}

/**
 * An editor whose text reaches someone once saved: the agent, or the
 * forge. A suggested change goes to the agent in a local review.
 */
export function sendsOut(
  editor: ReviewEditor,
  text: string,
  gitlab: boolean,
): boolean {
  if (editor.replyTo || editor.publicReply) return true;
  if (editor.kind === "discussion" || editor.kind === "merge-request")
    return true;
  return !gitlab && /```suggestion\b/.test(text);
}

/**
 * The text without its suggestions that leave the line as it reads
 * (`lineText`, the line the comment is on): they change nothing, so they
 * count as empty, as in maildesk. Trimmed.
 */
export function withoutUnchangedSuggestions(
  text: string,
  lineText: string | undefined,
): string {
  return text
    .replace(/```suggestion[^\n]*\n([\s\S]*?)\n?```/g, (block, code) =>
      lineText !== undefined && code === lineText ? "" : block,
    )
    .trim();
}

/** What saving an editor does (see editorSave). */
export type EditorSave =
  /** Saved now, an image still uploading would be lost: the editor stays. */
  | { kind: "uploading" }
  /** The overall comment: sent to the agent, else saved as the summary. */
  | { kind: "overall"; send: boolean }
  /**
   * Text that reaches someone, left without an explicit send: kept for
   * when the editor reopens (`notice`: there is something to keep).
   */
  | { kind: "kept"; notice: boolean }
  | {
      kind: "write";
      /**
       * What is written, without unchanged suggestions; "" for nothing.
       * What is sent is the editor's whole text.
       */
      meaningful: string;
      /** A new comment of a key or two, dropped as a stray keystroke. */
      stray: string | null;
      /** What you write shows: hidden comments come back. */
      showComments: boolean;
      /** Shown at once as pending (the forge's own notes are not made here). */
      pending: boolean;
      /** A new question with no agent to ask: held in the workspace's threads. */
      held: boolean;
      action: "reply" | "edit" | "delete" | "add" | "none";
    };

/**
 * The save policy of the review's editor. Only an explicit save (Cmd+Enter,
 * Save, :w) sends what reaches the agent or the forge; Esc or moving away
 * keeps it as a draft. A new comment shorter than STRAY_MAX is a stray key
 * unless saved explicitly. An unchanged suggestion is empty. An edit
 * emptied deletes its comment. An explicit save waits for images.
 */
export function editorSave(input: {
  editor: ReviewEditor;
  explicit: boolean;
  /** An image is still uploading into the text. */
  uploading: boolean;
  /** The line the comment is on, as it reads. */
  lineText: string | undefined;
  /** The text the editor started with. */
  original: string;
  gitlab: boolean;
  /** Comments go to the agent as written. */
  talk: boolean;
  /** The review's agent has a name: the overall comment can go to it. */
  agentNamed: boolean;
  /** A new question would be held for Send (the review has no agent). */
  holdForSend: boolean;
}): EditorSave {
  const { editor, explicit, gitlab } = input;
  const text = editor.text;
  if (explicit && input.uploading) return { kind: "uploading" };
  if (editor.overall)
    return {
      kind: "overall",
      send: explicit && input.talk && input.agentNamed && !!text.trim(),
    };
  const changed = withoutUnchangedSuggestions(text, input.lineText);
  if (
    !explicit &&
    (sendsOut(editor, text, gitlab) || sendsOut(editor, input.original, gitlab))
  )
    return { kind: "kept", notice: !!changed && text !== input.original };
  let meaningful = changed;
  let stray: string | null = null;
  if (
    !explicit &&
    !editor.commentId &&
    meaningful &&
    meaningful.length < STRAY_MAX
  ) {
    stray = meaningful;
    meaningful = "";
  }
  const held =
    !editor.replyTo &&
    !editor.commentId &&
    editor.kind === "discussion" &&
    input.holdForSend;
  return {
    kind: "write",
    meaningful,
    stray,
    showComments: !!meaningful && !editor.commentId,
    pending: !gitlab && !editor.publicReply,
    held,
    action: editor.replyTo
      ? meaningful
        ? "reply"
        : "none"
      : editor.commentId
        ? meaningful
          ? "edit"
          : "delete"
        : meaningful
          ? "add"
          : "none",
  };
}

/**
 * What an empty editor says it writes, by what it is and where it goes:
 * the review pane's words, in the review pane and in Changes alike.
 */
export function editorPlaceholder(
  editor: Pick<
    ReviewEditor,
    "overall" | "replyTo" | "publicReply" | "kind" | "commentId"
  >,
  delivery: {
    /** The review's agent has a name: the overall comment goes to it. */
    agentNamed: boolean;
    agentName: string;
    talk: boolean;
    gitlab: boolean;
    holdForSend: boolean;
    /** The forge a public reply is published on. */
    forge?: string;
  },
): string {
  const { agentName, talk } = delivery;
  if (editor.overall)
    return !delivery.agentNamed
      ? "Your overall comment on the review (Cmd+Enter saves, Esc closes)"
      : talk && !delivery.gitlab
        ? `Your overall comment, for ${agentName}: sent as you save (Cmd+Enter saves, Esc closes)`
        : `Your overall comment, for ${agentName}: sent when you press Send (Cmd+Enter saves, Esc closes)`;
  if (editor.replyTo)
    return editor.publicReply
      ? `Your draft reply, published with your review when you submit it on ${delivery.forge ?? "GitLab"} (Cmd+Enter saves, Esc closes)`
      : "Your reply (Cmd+Enter saves, Esc closes)";
  if (editor.kind === "discussion")
    return talk
      ? `For ${agentName}: sent as you save (Cmd+Enter saves, Esc closes)`
      : delivery.holdForSend && !editor.commentId
        ? `${HELD_FOR_SEND} (Cmd+Enter saves, Esc closes)`
        : `For ${agentName}: sent when you press Send (Cmd+Enter saves, Esc closes)`;
  return "Your comment on this line (Cmd+Enter saves, Esc closes)";
}
