import { ChevronLeft } from "lucide-react";
import { Suspense, useRef, useState } from "react";
import { blobBase64 } from "../renderedCapture";
import { vimKeys } from "../vimKeys";
import { ImagePickButton } from "./ImagePickButton";
import type { CommentEditorHandle } from "./ReviewCommentEditor";
import { ReviewCommentEditorLazy } from "./ReviewCommentEditorLazy";
import { IMAGE_UPLOADING, imageUploadPending } from "./reviewImageUpload";

/** An image is at most this big (the review image store's limit). */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** How many images an item is added with, at most. */
export const WORK_ADD_IMAGES = 8;

/** An image taken into the form, named in its text by a token. */
export type WorkAddImage = { token: string; file: File };

/**
 * The Markdown for an image taken into the text: its token stands for
 * the path the server stores it at once the item is added.
 */
export function workImageMarkdown(image: WorkAddImage): string {
  const name =
    image.file.name && image.file.name !== "image.png"
      ? image.file.name.replace(/[[\]]/g, "")
      : "screenshot";
  return `![${name}](<${image.token}>)`;
}

/** What the add call carries: the text, and its images as base64. */
export async function workAddPayload(
  text: string,
  images: readonly WorkAddImage[],
): Promise<{
  text?: string;
  images?: { token: string; type: string; data: string }[];
}> {
  const kept = images.filter((image) => text.includes(image.token));
  return {
    ...(text.trim() ? { text: text.trim() } : {}),
    ...(kept.length
      ? {
          images: await Promise.all(
            kept.map(async (image) => ({
              token: image.token,
              type: image.file.type,
              data: await blobBase64(image.file),
            })),
          ),
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
 * or Add, adds it; Esc or Cancel leaves.
 */
export function WorkAddForm({
  project,
  projectName,
  initialText = "",
  owner,
  onAdd,
  onCancel,
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
}) {
  const [waiting, setWaiting] = useState("");
  const [busy, setBusy] = useState(false);
  const text = useRef(initialText);
  const images = useRef<WorkAddImage[]>([]);
  const handle = useRef<CommentEditorHandle | null>(null);
  const [vim] = useState(vimKeys);
  const keepImage = async (file: File): Promise<string> => {
    if (!file.type.startsWith("image/")) throw new Error("not an image");
    if (file.size > IMAGE_MAX_BYTES)
      throw new Error("an image is at most 10 MiB");
    if (images.current.length >= WORK_ADD_IMAGES)
      throw new Error(`at most ${WORK_ADD_IMAGES} images`);
    const image = {
      token: `work-image:${images.current.length + 1}`,
      file,
    };
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
    setBusy(true);
    try {
      await onAdd(await workAddPayload(text.current, images.current));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="assistant-section-heading">
        <button type="button" className="ghost" onClick={onCancel}>
          <ChevronLeft size={13} /> All items
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
              value={initialText}
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
        <div className="assistant-task-buttons">
          <button
            type="submit"
            className="primary"
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? "Adding..." : "Add"}
          </button>
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}
