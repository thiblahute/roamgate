import type {
  ReviewAnchor,
  ReviewRenderPart,
  ReviewSession,
  ReviewSnapshot,
  ReviewThread,
} from "../../shared/review";
import {
  type NewReviewAnnotation,
  parseReviewAnnotation,
  type ReviewAnnotation,
} from "./annotations";
import { blobBase64 } from "./renderedCapture";

/*
 * Comments written in the Files preview, Changes, Commits and History are
 * review threads of the review of what they are on, as the review pane's:
 * the workspace's agent gets them as the review's settings say (sent as
 * written, or held until Send), and they are answered in their threads.
 * A terminal comment is a thread of the chat review of the agent in its
 * pane (the review its chat threads are in), held until the user's Send
 * from the workspace's threads panel. Every field of the note is kept on
 * the anchor, where the views read where it is.
 */

/**
 * The chat of the agent in a terminal pane, as its chat threads open its
 * review (ChatThreads): its agent session, the directory naming the
 * review, the agent and its pane.
 */
export type PaneChat = {
  chat: string;
  path: string;
  agent: string;
  paneId: string;
};

/** What a held comment says until the user's Send. */
export const HELD_FOR_SEND = "Waiting for Send in the workspace's threads";

export type FeedbackPlace = {
  workspaceId: string;
  /** The checkout's directory on the connection's host. */
  root: string;
  /** The workspace's agent, given to a review without one. */
  agent?: { paneId: string; name: string };
  /**
   * The chat of the agent in the terminal pane a comment is on: a terminal
   * comment goes to its review. None (no agent in the pane): the pane's
   * own review, as before.
   */
  chat?: PaneChat;
};

export type FeedbackCall = <T>(
  method: string,
  params: Record<string, unknown>,
) => Promise<T>;

/**
 * What a comment captured, not part of the note's text: a graphic's
 * region, and the source text of the (last) line a rendered file's comment
 * is on, kept as a diff's anchor keeps it, so the review pane and the
 * rendered file find the line again after the code moves.
 */
export type FeedbackCapture = { snapshot?: Blob; lineText?: string };

type Route = {
  open: Record<string, unknown>;
  anchor: (session: ReviewSession) => ReviewAnchor;
  /** A terminal comment: held until the user's Send. */
  held: boolean;
};

function firstLine(text: string): string {
  return (text.split("\n", 1)[0] ?? "").slice(0, 4000);
}

function absolute(path: string, root: string): string {
  return path.startsWith("/") ? path : `${root.replace(/\/+$/, "")}/${path}`;
}

/** Which review a comment belongs to, and where in it. */
export function feedbackRoute(
  note: NewReviewAnnotation,
  place: FeedbackPlace,
): Route {
  if (note.source === "terminal") {
    const anchor = () => ({
      terminal: { pane: note.paneId, title: note.title, quote: note.quote },
    });
    const chat = place.chat?.paneId === note.paneId ? place.chat : undefined;
    // The agent's chat review, opened as its chat threads open it.
    if (chat)
      return {
        held: true,
        open: {
          path: chat.path,
          target: { kind: "chat", chat: chat.chat },
          title: `Chat with ${chat.agent}`,
          agent: chat.agent,
          agent_pane: chat.paneId,
        },
        anchor,
      };
    return {
      held: true,
      open: {
        path: place.root,
        target: { kind: "chat", chat: note.paneId },
        title: `Terminal: ${note.title}`.slice(0, 300),
      },
      anchor,
    };
  }
  if (note.source === "diff")
    return {
      held: false,
      open: {
        path: place.root,
        // No target: the branch against Automatic's base. A base picked
        // in Compare against is its own review (plan D12).
        ...(note.kind !== "branch"
          ? { target: { kind: "worktree" } }
          : note.base
            ? { target: { kind: "range", base: note.base, head: "HEAD" } }
            : {}),
      },
      anchor: () => ({
        path: note.path,
        line: note.line,
        ...(note.endLine !== undefined &&
        note.endLine > note.line &&
        (note.endSide ?? note.side) === note.side
          ? { endLine: note.endLine }
          : {}),
        side: note.side,
        text: firstLine(note.quote),
      }),
    };
  const render: ReviewRenderPart = {
    ...note.render,
    ...(note.anchor === "quote" && note.quote && !note.render?.region
      ? { quote: note.quote.slice(0, 4000) }
      : {}),
  };
  const { line, endLine } = note;
  // A page of a site: its URL is its review.
  if (/^https?:\/\//i.test(note.path))
    return {
      held: false,
      open: {
        target: { kind: "rendered", url: note.path },
        title: note.path.slice(0, 300),
      },
      anchor: () => ({ render }),
    };
  return {
    held: false,
    open: {
      file: absolute(note.path, place.root),
      target: { kind: "rendered" },
      title: note.path.split("/").pop(),
    },
    anchor: (session) => ({
      path:
        session.target.kind === "rendered"
          ? (session.target.path ?? note.path)
          : note.path,
      ...(line !== undefined
        ? {
            line,
            ...(endLine !== undefined && endLine > line ? { endLine } : {}),
            side: "new" as const,
            text: firstLine(note.quote),
          }
        : {}),
      ...(Object.keys(render).length ? { render } : {}),
    }),
  };
}

function hash32(text: string, seed: number): number {
  let value = seed;
  for (let at = 0; at < text.length; at += 1) {
    value ^= text.charCodeAt(at);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/**
 * The thread id of a note, the same each time: writing a note again (a
 * retry, a page closed before the note was forgotten) finds its thread.
 */
export function feedbackThreadId(noteId: string): string {
  return [hash32(noteId, 0x811c9dc5), hash32(noteId, 0x1b873593)]
    .map((part) => part.toString(16).padStart(8, "0"))
    .join("");
}

/**
 * How a comment goes in a review, as the review pane writes it: to the
 * agent when the review sends comments to one, else a review comment.
 */
export function feedbackKind(session: ReviewSession): "discussion" | "draft" {
  return !session.gitlab && session.autoSend !== false && !!session.agent.paneId
    ? "discussion"
    : "draft";
}

/**
 * Writes a note as a thread of the review of what it is on, given the
 * workspace's agent when it has none (a terminal's goes to its pane's
 * agent chat); a terminal comment is held, and so is any with `hold` (a
 * note moved from this browser, still waiting for the user's Send).
 */
export async function writeFeedback(
  call: FeedbackCall,
  note: ReviewAnnotation,
  place: FeedbackPlace,
  held: number,
  capture?: FeedbackCapture,
  hold = false,
): Promise<{ threadId: string; held: boolean; snapshot: ReviewSnapshot }> {
  const route = feedbackRoute(note, place);
  const holding = route.held || hold;
  const opened = await call<ReviewSnapshot>("review.open", {
    workspace_id: place.workspaceId,
    ...route.open,
    ...(place.agent && note.source !== "terminal"
      ? { agent_pane: place.agent.paneId, agent: place.agent.name }
      : {}),
  });
  const { session } = opened;
  let anchor = route.anchor(session);
  if (
    note.source === "file" &&
    anchor.line !== undefined &&
    capture?.lineText !== undefined
  )
    anchor = { ...anchor, text: capture.lineText.slice(0, 4000) };
  if (capture?.snapshot) {
    const { path } = await call<{ path: string }>("review.image.add", {
      session_id: session.id,
      type: "image/png",
      data: await blobBase64(capture.snapshot),
    });
    anchor = { ...anchor, render: { ...anchor.render, snapshot: path } };
  }
  const { comment, ...kept } = note;
  const threadId = feedbackThreadId(note.id);
  await call("review.thread.add", {
    session_id: session.id,
    kind: holding ? "discussion" : feedbackKind(session),
    anchor: { ...anchor, feedback: JSON.stringify(kept) },
    new_thread_id: threadId,
    text: comment.trim(),
    ...(holding ? { held } : {}),
  });
  return { threadId, held: holding, snapshot: opened };
}

/**
 * The chat of the agent in a terminal pane, for its comments: the agent
 * session its chat threads hang on (`agent_session.get`, as the pane's
 * chat reads it), and the directory of that chat's review when it has one,
 * so the comment lands in the same review. None when the pane runs no
 * agent or its session cannot be told.
 */
export async function paneChat(
  read: (paneId: string, agent: string) => Promise<unknown>,
  pane: {
    pane_id: string;
    agent?: string | null;
    cwd?: string;
    foreground_cwd?: string | null;
  },
  sessions: Iterable<ReviewSnapshot>,
  connectionId: string,
): Promise<PaneChat | undefined> {
  const agent = pane.agent?.trim();
  if (!agent) return undefined;
  const summary = (await read(pane.pane_id, agent)) as {
    status?: string;
    path?: string;
    session?: { value?: string } | null;
  } | null;
  if (summary?.status !== "ok") return undefined;
  const chat = summary.session?.value ?? summary.path;
  if (!chat) return undefined;
  let path = pane.foreground_cwd ?? pane.cwd ?? "";
  for (const { session } of sessions)
    if (
      session.connectionId === connectionId &&
      session.target.kind === "chat" &&
      session.target.chat === chat
    ) {
      path = session.root;
      break;
    }
  return { chat, path, agent, paneId: pane.pane_id };
}

/** One held comment and where it lives. */
export type HeldFeedback = {
  annotation: ReviewAnnotation;
  threadId: string;
  sessionId: string;
  commentId: string;
  held: number;
  /** A picture of the region pointed at, saved with the review. */
  snapshot?: string;
};

/** The note a feedback thread was written from, by its id. */
export function feedbackNote(thread: ReviewThread): ReviewAnnotation {
  const first = thread.comments[0];
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(thread.anchor.feedback ?? "{}") as Record<string, unknown>;
  } catch {
    /* A note without its record: drawn from the anchor. */
  }
  const parsed = parseReviewAnnotation({
    ...raw,
    id: thread.id,
    comment: first?.body ?? "",
    createdAt: Date.parse(thread.createdAt) || 0,
  });
  if (parsed) return parsed;
  const { anchor } = thread;
  // A question asked in the review pane with no agent: a diff's line.
  if (anchor.path && anchor.line !== undefined && anchor.side)
    return {
      id: thread.id,
      source: "diff",
      // Not read: the review the thread is in says what it compares.
      kind: "branch",
      path: anchor.path,
      side: anchor.side,
      line: anchor.line,
      ...(anchor.endLine !== undefined ? { endLine: anchor.endLine } : {}),
      hunk: "",
      quote: anchor.text ?? "",
      comment: first?.body ?? "",
      createdAt: Date.parse(thread.createdAt) || 0,
    };
  return {
    id: thread.id,
    source: "file",
    anchor: "quote",
    path: thread.anchor.path ?? "",
    section: [],
    quote: thread.anchor.render?.quote ?? "",
    comment: first?.body ?? "",
    createdAt: Date.parse(thread.createdAt) || 0,
  };
}

/** The workspace's held comments, in their order. */
export function heldFeedback(
  sessions: Iterable<ReviewSnapshot>,
  connectionId: string | null | undefined,
  workspaceId: string | undefined,
): HeldFeedback[] {
  if (!connectionId || !workspaceId) return [];
  const found: HeldFeedback[] = [];
  for (const { session, threads } of sessions) {
    if (
      session.connectionId !== connectionId ||
      session.workspaceId !== workspaceId
    )
      continue;
    for (const thread of threads) {
      if (thread.held === undefined) continue;
      found.push({
        annotation: feedbackNote(thread),
        threadId: thread.id,
        sessionId: session.id,
        commentId: thread.comments[0]?.id ?? thread.id,
        held: thread.held,
        ...(thread.anchor.render?.snapshot
          ? { snapshot: thread.anchor.render.snapshot }
          : {}),
      });
    }
  }
  return found.sort(
    (a, b) => a.held - b.held || a.threadId.localeCompare(b.threadId),
  );
}

/**
 * The workspace's comments written in its views (not a terminal's held
 * ones), with the note each was written from: the views draw them where
 * they are.
 */
export function workspaceFeedback(
  sessions: Iterable<ReviewSnapshot>,
  connectionId: string | null | undefined,
  workspaceId: string | undefined,
): { annotation: ReviewAnnotation; thread: ReviewThread }[] {
  if (!connectionId || !workspaceId) return [];
  const found: { annotation: ReviewAnnotation; thread: ReviewThread }[] = [];
  for (const { session, threads } of sessions) {
    if (
      session.connectionId !== connectionId ||
      session.workspaceId !== workspaceId
    )
      continue;
    for (const thread of threads)
      if (thread.held === undefined && thread.anchor.feedback !== undefined)
        found.push({ annotation: feedbackNote(thread), thread });
  }
  return found;
}

/**
 * Moves notes kept in this browser to the review store, one at a time. A
 * note is forgotten only once the server has it: refused, it stays; with
 * the page closed mid-way, the rest stay, and the note written but not yet
 * forgotten is found by its id next time.
 */
export async function migrateFeedback(args: {
  notes: readonly ReviewAnnotation[];
  write: (note: ReviewAnnotation, held: number) => Promise<unknown>;
  forget: (id: string) => void;
  base: number;
}): Promise<{ moved: string[]; kept: { id: string; reason: string }[] }> {
  const moved: string[] = [];
  const kept: { id: string; reason: string }[] = [];
  let index = 0;
  for (const note of args.notes) {
    const held = args.base + index;
    index += 1;
    // A comment needs words; a blank note stays the user's draft.
    if (!note.comment.trim()) {
      kept.push({ id: note.id, reason: "no text" });
      continue;
    }
    try {
      await args.write(note, held);
    } catch (error) {
      kept.push({
        id: note.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    args.forget(note.id);
    moved.push(note.id);
  }
  return { moved, kept };
}

/** Says how to answer, after the feedback handed to an agent in one go. */
export function feedbackThreadsTrailer(
  threads: readonly { index: number; threadId: string; snapshot?: string }[],
): string {
  if (!threads.length) return "";
  const list = threads
    .map(({ index, threadId }) => `${index}: [${threadId.slice(0, 8)}]`)
    .join(", ");
  const pictures = threads
    .filter((thread) => thread.snapshot)
    .map((thread) => `\n${thread.index}: what I saw there: ${thread.snapshot}`)
    .join("");
  return `\n\nThese are Roamgate threads (${list}). Answer each in its thread: your \`review_reply\` tool (comment_id: the bracketed ID), or \`roamgate-review reply --comment ID -- TEXT\`.${pictures}`;
}
