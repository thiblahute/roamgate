import { expect, test } from "bun:test";
import {
  attachmentDisplay,
  rememberComposerAttachment,
  withoutAttachment,
} from "./composerAttachments";

const first = "/tmp/roamgate-uploads-501/upload-a/img-1.png";
const second = "/tmp/roamgate-uploads-501/upload-b/img-2.png";
rememberComposerAttachment(first, new File([], "shot.png"));
rememberComposerAttachment(second, new File([], "other.png"));

test("attached images show as [Image #N] and go back to their paths", () => {
  const draft = `look ${first} and ${second} then ${first} `;
  const shown = attachmentDisplay(draft);
  expect(shown.text).toBe("look [Image #1] and [Image #2] then [Image #1] ");
  expect(shown.attachments.map((a) => a.name)).toEqual([
    "shot.png",
    "other.png",
  ]);
  expect(shown.toDraft(shown.text)).toBe(draft);
  // Typing after the first image keeps it.
  expect(shown.toDraft("look [Image #1] here and [Image #2] then ")).toBe(
    `look ${first} here and ${second} then `,
  );
  // A broken placeholder drops its image.
  expect(shown.toDraft("look [Image #1")).toBe("look [Image #1");
  // Cursor positions map into the draft.
  expect(shown.draftOffset(shown.text, 5)).toBe(5);
  expect(shown.draftOffset(shown.text, 15)).toBe(5 + first.length);
  expect(shown.shownOffset(5 + first.length)).toBe(15);
  expect(shown.shownOffset(8)).toBe(15);
  expect(shown.shownOffset(draft.length)).toBe(shown.text.length);
});

test("a draft without attachments shows as it is", () => {
  const shown = attachmentDisplay("plain /other/path.png");
  expect(shown.text).toBe("plain /other/path.png");
  expect(shown.attachments).toEqual([]);
});

test("removing an attachment takes its trailing space too", () => {
  expect(withoutAttachment(`see ${first} now`, first)).toBe("see now");
});
