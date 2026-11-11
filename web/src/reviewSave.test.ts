import { expect, test } from "bun:test";
import {
  editorKey,
  editorSave,
  handoffStatus,
  notSavedStatus,
  type ReviewEditor,
  STRAY_MAX,
  saveOrKeep,
  sendsOut,
  withoutUnchangedSuggestions,
} from "./reviewSave";

test("a failed save keeps the text and says why", async () => {
  const kept: string[] = [];
  const error = await saveOrKeep(
    async () => {
      throw new Error("connection lost");
    },
    () => kept.push("my comment"),
  );
  expect(error).toBe("connection lost");
  expect(kept).toEqual(["my comment"]);
  expect(notSavedStatus(error!)).toContain("connection lost");
  expect(notSavedStatus(error!)).toContain("kept");
});

test("a save that succeeds keeps nothing", async () => {
  let kept = false;
  const error = await saveOrKeep(
    async () => "saved",
    () => {
      kept = true;
    },
  );
  expect(error).toBeNull();
  expect(kept).toBe(false);
});

test("a handoff that failed does not claim it was sent", () => {
  const failed = handoffStatus("Claude", "agent pane is gone", 2, true);
  expect(failed).not.toContain("Sent to");
  expect(failed).toContain("agent pane is gone");
  expect(handoffStatus("Claude", null, 1, false)).toBe(
    "Sent to Claude: 1 open discussion.",
  );
  expect(handoffStatus("Claude", null, 2, true)).toBe(
    "Sent to Claude: 2 open discussions and your overall comment.",
  );
});

// ---- The editor's save policy ---------------------------------------------

const draft = (more: Partial<ReviewEditor> = {}): ReviewEditor => ({
  at: 3,
  file: 0,
  kind: "draft",
  anchor: { path: "a.ts", line: 4 },
  text: "",
  version: 0,
  ...more,
});
const base = {
  explicit: false,
  uploading: false,
  lineText: "const a = 1;",
  original: "",
  gitlab: false,
  talk: false,
  agentNamed: true,
  holdForSend: false,
};
const save = (editor: ReviewEditor, more: Partial<typeof base> = {}) =>
  editorSave({ ...base, ...more, editor });

test("each editor keeps its unsent text under its own key", () => {
  expect(editorKey(draft({ overall: true }))).toBe("overall");
  expect(editorKey(draft({ commentId: "c1" }))).toBe("edit:c1");
  expect(editorKey(draft({ replyTo: "t1" }))).toBe("reply:t1");
  expect(editorKey(draft())).toBe('new:draft:{"path":"a.ts","line":4}');
});

test("replies, discussions and suggestions in a local review reach someone", () => {
  expect(sendsOut(draft({ replyTo: "t1" }), "x", true)).toBe(true);
  expect(sendsOut(draft({ publicReply: true }), "x", true)).toBe(true);
  expect(sendsOut(draft({ kind: "discussion" }), "x", true)).toBe(true);
  expect(sendsOut(draft({ kind: "merge-request" }), "x", true)).toBe(true);
  expect(sendsOut(draft(), "a note", false)).toBe(false);
  const suggestion = "```suggestion:-0+0\nx\n```";
  expect(sendsOut(draft(), suggestion, false)).toBe(true);
  expect(sendsOut(draft(), suggestion, true)).toBe(false);
});

test("an unchanged suggestion saves as empty", () => {
  const block = "```suggestion:-0+0\nconst a = 1;\n```";
  expect(withoutUnchangedSuggestions(block, "const a = 1;")).toBe("");
  expect(withoutUnchangedSuggestions(`${block}\nwhy?`, "const a = 1;")).toBe(
    "why?",
  );
  expect(withoutUnchangedSuggestions(block, "const a = 2;")).toBe(block);
  // No line (a file comment): kept as written.
  expect(withoutUnchangedSuggestions(block, undefined)).toBe(block);
  const plan = save(draft({ text: block }), { explicit: true });
  expect(plan).toMatchObject({ kind: "write", meaningful: "", action: "none" });
});

test(`a new comment under ${STRAY_MAX} characters is a stray key unless saved explicitly`, () => {
  expect(save(draft({ text: "jj" }))).toMatchObject({
    kind: "write",
    stray: "jj",
    meaningful: "",
    action: "none",
  });
  expect(save(draft({ text: "jj" }), { explicit: true })).toMatchObject({
    stray: null,
    meaningful: "jj",
    action: "add",
  });
  expect(save(draft({ text: "abc" }))).toMatchObject({
    stray: null,
    action: "add",
  });
  // Edits are never strays: two letters replace the comment.
  expect(save(draft({ commentId: "c1", text: "ok" }))).toMatchObject({
    stray: null,
    action: "edit",
  });
});

test("Esc keeps what would reach someone as a draft; only an explicit save sends it", () => {
  const question = draft({ kind: "discussion", text: "Why this?" });
  expect(save(question)).toEqual({ kind: "kept", notice: true });
  expect(save(question, { explicit: true })).toMatchObject({
    kind: "write",
    action: "add",
  });
  // Nothing written, or the text as it was: nothing to keep.
  expect(save(draft({ kind: "discussion", text: "  " }))).toEqual({
    kind: "kept",
    notice: false,
  });
  expect(
    save(draft({ kind: "discussion", commentId: "c1", text: "same" }), {
      original: "same",
    }),
  ).toEqual({ kind: "kept", notice: false });
  // An edit of a suggestion that went out stays kept even emptied.
  expect(
    save(draft({ commentId: "c1", text: "" }), {
      original: "```suggestion\nx\n```",
    }),
  ).toEqual({ kind: "kept", notice: false });
});

test("a save waits while an image uploads; leaving does not", () => {
  const uploading = draft({ text: "see ![Adding image 1...]()" });
  expect(save(uploading, { explicit: true, uploading: true })).toEqual({
    kind: "uploading",
  });
  expect(save(uploading, { uploading: true }).kind).toBe("write");
});

test("an edit emptied deletes its comment; a reply emptied writes nothing", () => {
  expect(
    save(draft({ commentId: "c1", text: "" }), { explicit: true }),
  ).toMatchObject({
    action: "delete",
  });
  expect(
    save(draft({ replyTo: "t1", text: " " }), { explicit: true }),
  ).toMatchObject({
    action: "none",
  });
  expect(
    save(draft({ replyTo: "t1", text: "yes" }), { explicit: true }),
  ).toMatchObject({
    action: "reply",
  });
});

test("writing shows hidden comments, except an edit", () => {
  expect(save(draft({ text: "a note" }))).toMatchObject({ showComments: true });
  expect(
    save(draft({ replyTo: "t1", text: "yes" }), { explicit: true }),
  ).toMatchObject({
    showComments: true,
  });
  expect(save(draft({ commentId: "c1", text: "a note" }))).toMatchObject({
    showComments: false,
  });
  expect(save(draft({ text: "jj" }))).toMatchObject({ showComments: false });
});

test("comments show pending at once, except the forge's own notes", () => {
  expect(save(draft({ text: "a note" }))).toMatchObject({ pending: true });
  expect(save(draft({ text: "a note" }), { gitlab: true })).toMatchObject({
    pending: false,
  });
  expect(
    save(draft({ replyTo: "t1", publicReply: true, text: "yes" }), {
      explicit: true,
    }),
  ).toMatchObject({ pending: false });
});

test("a new question with no agent to ask is held for Send", () => {
  const question = draft({ kind: "discussion", text: "Why?" });
  expect(save(question, { explicit: true, holdForSend: true })).toMatchObject({
    held: true,
    action: "add",
  });
  expect(save(question, { explicit: true })).toMatchObject({ held: false });
  expect(
    save(draft({ kind: "discussion", replyTo: "t1", text: "Why?" }), {
      explicit: true,
      holdForSend: true,
    }),
  ).toMatchObject({ held: false });
  expect(
    save(draft({ text: "a note" }), { explicit: true, holdForSend: true }),
  ).toMatchObject({ held: false });
});

test("the overall comment goes to the agent on an explicit save while comments go out, else is kept as the summary", () => {
  const overall = draft({ overall: true, text: "Looks good" });
  expect(save(overall, { explicit: true, talk: true })).toEqual({
    kind: "overall",
    send: true,
  });
  expect(save(overall, { talk: true })).toEqual({
    kind: "overall",
    send: false,
  });
  expect(save(overall, { explicit: true })).toEqual({
    kind: "overall",
    send: false,
  });
  expect(
    save(overall, { explicit: true, talk: true, agentNamed: false }),
  ).toEqual({ kind: "overall", send: false });
  expect(
    save(draft({ overall: true, text: " " }), { explicit: true, talk: true }),
  ).toEqual({ kind: "overall", send: false });
});
