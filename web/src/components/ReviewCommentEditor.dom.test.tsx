import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

/**
 * The review's comment editor mounted alone where Changes draws it: in an
 * element slotted into the diff's shadow DOM.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the comment editor in an isolated DOM runtime",
    "ROAMGATE_COMMENT_EDITOR_DOM_TEST",
    30_000,
  )
) {
  const { installReviewDom } = await import("./reviewSurface.testkit");
  await installReviewDom();
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { EditorView } = await import("@codemirror/view");
  const { ReviewCommentEditor } = await import("./ReviewCommentEditor");

  /** An element slotted into a shadow DOM, as a diff's annotation is. */
  const slottedHost = () => {
    const diff = document.createElement("div");
    document.body.append(diff);
    const shadow = diff.attachShadow({ mode: "open" });
    shadow.innerHTML = `<div class="line">one</div><slot name="annotation-additions-1"></slot>`;
    const slotted = document.createElement("div");
    slotted.slot = "annotation-additions-1";
    diff.append(slotted);
    return { diff, shadow, slotted };
  };

  test("slotted into the diff's shadow DOM, the editor's root is the page: it has the focus, draws its caret and is styled", async () => {
    const { diff, shadow, slotted } = slottedHost();
    expect(slotted.assignedSlot).toBe(shadow.querySelector("slot"));
    const root = createRoot(slotted);
    await act(async () =>
      root.render(
        createElement(ReviewCommentEditor, {
          value: "",
          vimMode: true,
          placeholder: "Your comment",
          onChange: () => {},
          onCommit: () => {},
          onCancel: () => {},
          onSuggest: () => {},
        }),
      ),
    );
    const content = slotted.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content!)!;
    // Its root found through `assignedSlot` was the diff's shadow root,
    // whose activeElement never is the editor: the caret was left behind
    // after Enter, and the theme (caret, font, box) went where it styles
    // nothing of the editor.
    expect(view.root).toBe(document);
    expect(document.activeElement).toBe(content);
    expect(view.hasFocus).toBe(true);
    expect(view.dom.querySelector(".cm-cursorLayer")).not.toBeNull();
    await act(async () => root.unmount());
    diff.remove();
  });
}
