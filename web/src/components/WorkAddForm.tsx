import { ChevronLeft } from "lucide-react";
import { Suspense, useEffect, useRef, useState } from "react";
import {
  WORK_STATE_TITLE,
  WORK_STATES,
  type WorkState,
} from "../../../shared/work";
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
 * Adding an item, in the view as a request's detail is: its title, its
 * description in the review comment editor (images pasted, dropped or
 * picked go with it, stored as a review's are once it is added), its
 * state and tags. Cmd+Enter in the description, or Add, adds it; Esc or
 * Cancel leaves.
 */
export function WorkAddForm({
  project,
  projectName,
  tags,
  onAdd,
  onCancel,
}: {
  project: string;
  projectName: string;
  tags: string[];
  onAdd: (params: {
    title: string;
    state: WorkState;
    tags: string[];
    text?: string;
    images?: { token: string; type: string; data: string }[];
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [state, setState] = useState<WorkState>("open");
  const [chosen, setChosen] = useState("");
  const [waiting, setWaiting] = useState("");
  const [busy, setBusy] = useState(false);
  const text = useRef("");
  const images = useRef<WorkAddImage[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);
  const handle = useRef<CommentEditorHandle | null>(null);
  const [vim] = useState(vimKeys);
  useEffect(() => titleRef.current?.focus(), []);
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
    if (!title.trim()) {
      setWaiting("A title is needed");
      titleRef.current?.focus();
      return;
    }
    if (imageUploadPending(text.current)) return setWaiting(IMAGE_UPLOADING);
    setWaiting("");
    setBusy(true);
    try {
      await onAdd({
        title: title.trim(),
        state,
        tags: chosen.split(/[\s,]+/).filter(Boolean),
        ...(await workAddPayload(text.current, images.current)),
      });
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
          <h3>New item</h3>
          <span className="assistant-task-state">{projectName}</span>
        </div>
        <input
          ref={titleRef}
          className="work-add-title"
          aria-label="Title"
          placeholder="What needs doing"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <div className="chat-thread-editor work-add-text">
          <Suspense fallback={null}>
            <ReviewCommentEditorLazy
              value=""
              vimMode={vim}
              autoFocus={false}
              placeholder="Its description: what, why, where; paste or drop images, or add them"
              label="Description"
              handleRef={handle}
              onPasteImage={keepImage}
              onBlocked={setWaiting}
              onChange={(value) => {
                text.current = value;
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
        <div className="work-add-row">
          <select
            aria-label="State"
            value={state}
            onChange={(event) => setState(event.target.value as WorkState)}
          >
            {WORK_STATES.filter((each) => each !== "done").map((each) => (
              <option key={each} value={each}>
                {WORK_STATE_TITLE[each]}
              </option>
            ))}
          </select>
          <input
            aria-label="Tags"
            placeholder={
              tags.length ? `tags: ${tags.slice(0, 4).join(", ")}...` : "tags"
            }
            value={chosen}
            onChange={(event) => setChosen(event.target.value)}
          />
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
