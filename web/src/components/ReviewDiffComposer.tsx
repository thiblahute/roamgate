import { Suspense, useEffect, useRef, useState } from "react";
import { roamgateLocalStorage } from "../browserStorage";
import { lazyWithReload } from "../lazyWithReload";
import { keepReviewDraft, takeReviewDraft } from "../reviewDrafts";
import { editorKey, editorSave, type ReviewEditor } from "../reviewSave";
import type { CommentEditorHandle } from "./ReviewCommentEditor";
import { imageUploadPending, IMAGE_UPLOADING } from "./ReviewCommentEditor";
import "./ChatThreads.css";

/*
 * The review's comment editor in Changes (plan: review into the inspector,
 * phase 4): the review pane's Vim editor drawn under the line, with its
 * save policy (reviewSave: only an explicit save sends, Esc keeps a draft,
 * a key or two is a stray, an unchanged suggestion is empty, a save waits
 * for images) and its unsent text kept (reviewDrafts). It replaces the
 * popover on "in Changes"; the popover stays for Files and Terminal.
 */

const ReviewCommentEditorLazy = lazyWithReload("review-comment-editor", () =>
  import("./ReviewCommentEditor").then((module) => ({
    default: module.ReviewCommentEditor,
  })),
);

/** Where a Changes editor's unsent text is kept: beside no review session. */
export function changesDraftSession(resourceKey: string): string {
  return `changes:${resourceKey}`;
}

/** Vim keys in comment boxes: the review's `:vim` setting. */
function vimKeys(): boolean {
  try {
    const prefs = JSON.parse(
      roamgateLocalStorage.getItem("reviewPrefs") ?? "{}",
    ) as { vim?: boolean };
    return prefs.vim !== false;
  } catch {
    return true;
  }
}

/** What a suggestion on a line says: the line as it reads, to change. */
export function suggestionBlock(lineText: string): string {
  return `\`\`\`suggestion\n${lineText}\n\`\`\``;
}

export type ReviewDiffComposerProps = {
  /** The review's anchor the comment gets, for its draft key. */
  anchor: { path: string; line: number; side: "old" | "new"; text: string };
  /** The line as it reads on the new side, a suggestion's text; or null. */
  suggestable: string | null;
  /** The first text: a suggestion asked for with `s`. */
  initial?: string;
  /** Where unsent text is kept. */
  draftSession: string;
  /** Saves the text: the comment's words. */
  onSave: (text: string) => void;
  /** Closed with nothing to save (kept as a draft if it holds words). */
  onClose: () => void;
  /** Stores a pasted image with the review; Markdown for it. */
  onAddImage?: (file: File) => Promise<string>;
  notify: (message: string) => void;
  /** A phone's keyboard has no Esc: a button for Vim's. */
  coarse?: boolean;
};

/**
 * One comment box. Typing does not render anything: the text is read from
 * a ref when saving, as the review pane does.
 */
export function ReviewDiffComposer({
  anchor,
  suggestable,
  initial,
  draftSession,
  onSave,
  onClose,
  onAddImage,
  notify,
  coarse = false,
}: ReviewDiffComposerProps) {
  const key = editorKey({
    at: 0,
    file: 0,
    kind: "discussion",
    anchor,
    text: "",
    version: 0,
  });
  const [start] = useState(() => {
    const kept = takeReviewDraft(draftSession, key);
    if (kept !== undefined)
      notify("Your unsent text is back. Cmd+Enter sends it.");
    return initial !== undefined && !kept
      ? initial
      : initial !== undefined && kept
        ? `${kept}\n${initial}`
        : (kept ?? "");
  });
  const text = useRef(start);
  const [version, setVersion] = useState(0);
  const [vim] = useState(vimKeys);
  const handle = useRef<CommentEditorHandle | null>(null);
  const done = useRef(false);

  const commit = (explicit: boolean) => {
    if (done.current) return false;
    const editor: ReviewEditor = {
      at: 0,
      file: 0,
      kind: "discussion",
      anchor,
      text: text.current,
      version,
    };
    const plan = editorSave({
      editor,
      explicit,
      uploading: imageUploadPending(text.current),
      lineText: suggestable ?? undefined,
      original: "",
      gitlab: false,
      talk: true,
      agentNamed: true,
      holdForSend: false,
    });
    if (plan.kind === "uploading") {
      notify(IMAGE_UPLOADING);
      return false;
    }
    done.current = true;
    if (plan.kind === "kept") {
      // Esc or moving away: the words wait for an explicit save.
      if (plan.notice) {
        keepReviewDraft(draftSession, key, text.current);
        notify("Not sent: reopen it to go on, Cmd+Enter or Save sends it.");
      }
      onClose();
      return true;
    }
    if (plan.kind === "write") {
      if (plan.stray !== null)
        notify(
          `Not sent: "${plan.stray}" looks like a stray key. Cmd+Enter or Save sends it.`,
        );
      if (plan.meaningful) {
        keepReviewDraft(draftSession, key, "");
        onSave(text.current);
        return true;
      }
    }
    onClose();
    return true;
  };

  // Going away with words unsent (a reload, another view, a closed tab):
  // they are kept as a draft, as the review pane keeps its open editor's.
  const keepOnUnmount = useRef(() => {});
  keepOnUnmount.current = () => {
    if (!done.current && text.current.trim())
      keepReviewDraft(draftSession, key, text.current);
  };
  useEffect(() => {
    const onPageHide = () => keepOnUnmount.current();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      keepOnUnmount.current();
    };
  }, []);

  const suggest = () => {
    if (suggestable === null) return;
    const block = suggestionBlock(suggestable);
    if (handle.current) handle.current.append(block, 5);
    else {
      text.current = `${text.current && !text.current.endsWith("\n") ? `${text.current}\n` : text.current}${block}`;
      setVersion((value) => value + 1);
    }
  };

  return (
    <div className="chat-review diff-review-composer" data-review-editor>
      <Suspense fallback={null}>
        <ReviewCommentEditorLazy
          key={version}
          value={text.current}
          vimMode={vim}
          placeholder="Your comment on this line (Cmd+Enter saves, Esc closes)"
          handleRef={handle}
          onChange={(value) => {
            text.current = value;
          }}
          onCommit={(explicit) => {
            commit(explicit);
          }}
          onCancel={() => {
            done.current = true;
            takeReviewDraft(draftSession, key);
            onClose();
          }}
          onSuggest={suggest}
          {...(onAddImage ? { onPasteImage: onAddImage } : {})}
          onBlocked={(message) => notify(message)}
        />
      </Suspense>
      <div className="diff-review-composer-bar">
        {suggestable !== null ? (
          <button
            type="button"
            className="btn ghost"
            title="Insert a suggestion for this line (:suggest)"
            onClick={suggest}
          >
            Suggest
          </button>
        ) : null}
        <span className="spacer" />
        {vim && coarse ? (
          <button
            type="button"
            className="btn ghost"
            title="Esc: Vim normal mode; again, close"
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => handle.current?.escape()}
          >
            Esc
          </button>
        ) : null}
        <button
          type="button"
          className="btn ghost"
          onClick={() => commit(true)}
        >
          Save
        </button>
      </div>
    </div>
  );
}
