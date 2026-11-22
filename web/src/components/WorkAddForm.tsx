import { ChevronLeft } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import {
  type DraftImage,
  draftImagesNow,
  peekReviewDraft,
  readDraftImages,
} from "../reviewDrafts";
import { blobBase64 } from "../renderedCapture";
import { vimKeys } from "../vimKeys";
import { ImagePickButton } from "./ImagePickButton";
import type { CommentEditorHandle } from "./ReviewCommentEditor";
import { ReviewCommentEditorLazy } from "./ReviewCommentEditorLazy";
import { IMAGE_UPLOADING, imageUploadPending } from "./reviewImageUpload";
import { type DraftPlace, useBoxDraft } from "./ThreadEditor";

/** An image is at most this big (the review image store's limit). */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** How many images an item is added with, at most. */
export const WORK_ADD_IMAGES = 8;

/**
 * An image taken into the form, named in its text by a token: its bytes
 * read when it is taken, as a comment box's are sent then. A picked file
 * read only at Add can be unreadable by then (Chrome on Android drops
 * the picker's grant), which failed the add with nothing said.
 */
export type WorkAddImage = DraftImage;

/**
 * The words the form starts with: its kept draft's, and the words it is
 * opened with (a chat's quote, `:add WORDS`) after them unless the draft
 * has them already.
 */
export function workAddStart(kept: string | undefined, initial: string) {
  if (!kept) return initial;
  if (!initial || kept.includes(initial.trim())) return kept;
  return `${kept}\n\n${initial}`;
}

/** The highest number of the images' tokens (`work-image:N`). */
function lastImageToken(images: readonly WorkAddImage[]): number {
  let last = 0;
  for (const image of images) {
    const number = Number(/^work-image:(\d+)$/.exec(image.token)?.[1] ?? 0);
    if (number > last) last = number;
  }
  return last;
}

/** An image taken into the form: checked, and read at once. */
export async function takeWorkImage(
  file: File,
  token: string,
): Promise<WorkAddImage> {
  if (!file.type.startsWith("image/")) throw new Error("not an image");
  if (file.size > IMAGE_MAX_BYTES)
    throw new Error("an image is at most 10 MiB");
  let data: string;
  try {
    data = await blobBase64(file);
  } catch (cause) {
    throw new Error(
      `the image could not be read${cause instanceof Error && cause.message ? ` (${cause.message})` : ""}`,
      { cause },
    );
  }
  return { token, name: file.name, type: file.type, data };
}

/**
 * The Markdown for an image taken into the text: its token stands for
 * the path the server stores it at once the item is added.
 */
export function workImageMarkdown(image: WorkAddImage): string {
  const name =
    image.name && image.name !== "image.png"
      ? image.name.replace(/[[\]]/g, "")
      : "screenshot";
  return `![${name}](<${image.token}>)`;
}

/** What the add call carries: the text, and its images as base64. */
export function workAddPayload(
  text: string,
  images: readonly WorkAddImage[],
): {
  text?: string;
  images?: { token: string; type: string; data: string }[];
} {
  const kept = images.filter((image) => text.includes(image.token));
  return {
    ...(text.trim() ? { text: text.trim() } : {}),
    ...(kept.length
      ? {
          images: kept.map(({ token, type, data }) => ({ token, type, data })),
        }
      : {}),
  };
}

/**
 * Adding an item, in the view as a request's detail is: one text box,
 * the review comment editor, where the user says what needs doing in
 * their own words (images pasted, dropped or picked go with it, stored as
 * a review's are once it is added). Nothing else to fill: the item is
 * the project's coordinator's to sort (a clear title, tags, a state,
 * split when it holds several tasks), or the session's it is added for
 * (`owner`: from its chat, the words quoted in `initialText`). Cmd+Enter,
 * or Add, adds it; Esc or Back leaves, its words and images kept as its
 * `draft` (shown again when the form is opened there, after a reload
 * too); Cancel drops them.
 */
export function WorkAddForm({
  project,
  projectName,
  initialText = "",
  owner,
  onAdd,
  onCancel,
  draft,
}: {
  project: string;
  projectName: string;
  /** The words it starts with (a chat's quote). */
  initialText?: string;
  /** The session it is added for, which owns and sorts it: its name. */
  owner?: string;
  onAdd: (params: {
    text?: string;
    images?: { token: string; type: string; data: string }[];
  }) => Promise<void>;
  onCancel: () => void;
  /** Where its unsent words and images are kept. */
  draft?: DraftPlace;
}) {
  const [start] = useState(() =>
    workAddStart(
      draft ? peekReviewDraft(draft.session, draft.key) : undefined,
      initialText,
    ),
  );
  const [waiting, setWaiting] = useState("");
  /** Why the add failed: stays until dismissed or added again. */
  const [failed, setFailed] = useState("");
  const [busy, setBusy] = useState(false);
  const text = useRef(start);
  const images = useRef<WorkAddImage[]>(
    draft ? draftImagesNow(draft.session, draft.key) : [],
  );
  const taken = useRef(lastImageToken(images.current));
  const drafted = useBoxDraft(draft, text, images);
  /** The kept images, read back after a reload: Add waits for them. */
  const imagesRead = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!draft || images.current.length || !start.includes("work-image:"))
      return;
    imagesRead.current = readDraftImages(draft.session, draft.key).then(
      (read) => {
        const known = new Set(images.current.map((image) => image.token));
        images.current = [
          ...images.current,
          ...read.filter((image) => !known.has(image.token)),
        ];
        taken.current = Math.max(taken.current, lastImageToken(read));
      },
    );
    // Read once, as the form is drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const handle = useRef<CommentEditorHandle | null>(null);
  const [vim] = useState(vimKeys);
  const keepImage = async (file: File): Promise<string> => {
    if (taken.current >= WORK_ADD_IMAGES)
      throw new Error(`at most ${WORK_ADD_IMAGES} images`);
    const token = `work-image:${++taken.current}`;
    const image = await takeWorkImage(file, token);
    images.current = [...images.current, image];
    return workImageMarkdown(image);
  };
  const submit = async () => {
    if (busy) return;
    if (!text.current.trim()) {
      setWaiting("Say what needs doing");
      return;
    }
    if (imageUploadPending(text.current)) return setWaiting(IMAGE_UPLOADING);
    setWaiting("");
    setFailed("");
    setBusy(true);
    try {
      await imagesRead.current;
      const payload = workAddPayload(text.current, images.current);
      // Added: the draft goes (the form closes); not added, it stays.
      drafted.forget();
      try {
        await onAdd(payload);
      } catch (cause) {
        drafted.resume();
        throw cause;
      }
    } catch (cause) {
      setFailed(
        `Not added: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="assistant-section-heading">
        <button type="button" className="ghost" onClick={onCancel}>
          <ChevronLeft size={13} /> Back
        </button>
      </div>
      <form
        className="assistant-task-overview mr-reviews-detail work-add"
        aria-label={`Add an item to ${project}`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={(event) => {
          // Esc anywhere in the form leaves it (the editor's own Esc,
          // Vim's, is its own).
          if (
            event.key === "Escape" &&
            !(event.target as HTMLElement).closest(".cm-editor")
          ) {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <div className="assistant-task-heading">
          <h3>{owner ? `New item for ${owner}` : "New item"}</h3>
          <span className="assistant-task-state">{projectName}</span>
        </div>
        <div className="chat-thread-editor work-add-text">
          <Suspense fallback={null}>
            <ReviewCommentEditorLazy
              value={start}
              vimMode={vim}
              autoFocus
              placeholder={`What needs doing, in your own words: what, why, where; paste or drop images, or add them. ${owner ? `${owner} sorts it` : "It gets sorted"} into a title, tags and a state for you.`}
              label="What needs doing"
              handleRef={handle}
              onPasteImage={keepImage}
              onBlocked={setWaiting}
              onChange={(value) => {
                text.current = value;
                if (value.trim()) setWaiting("");
              }}
              onCommit={(explicit) => {
                if (explicit) void submit();
              }}
              onCancel={onCancel}
              onSuggest={() => {}}
            />
          </Suspense>
          <div className="chat-thread-bar">
            <span
              className="chat-thread-hint"
              role={waiting ? "status" : undefined}
            >
              {waiting || "Cmd+Enter adds"}
            </span>
            <ImagePickButton
              className="chat-thread-image"
              onPick={(files) => handle.current?.addImages(files)}
            />
          </div>
        </div>
        {failed ? (
          <div className="assistant-error" role="alert">
            <span>{failed}</span>
            <button
              type="button"
              className="ghost"
              onClick={() => setFailed("")}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        <div className="assistant-task-buttons">
          <button
            type="submit"
            className="primary"
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? "Adding..." : "Add"}
          </button>
          <button
            type="button"
            className="ghost"
            title="Drop what was written"
            onClick={() => {
              drafted.forget();
              onCancel();
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}
