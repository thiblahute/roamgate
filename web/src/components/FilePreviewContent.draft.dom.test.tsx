import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

/*
 * A comment written in the rendered view of a Markdown file: its box is
 * drawn under the block it is on, after the block's threads, as wide as
 * they are (not a small box floating over the text), and once it is sent
 * or closed the content has the keys again, so j / k go on at once.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the Files preview's comment box in an isolated DOM runtime",
    "ROAMGATE_PREVIEW_DRAFT_DOM_TEST",
    30_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  const { previewEntry, previewFile, settlePreview } = await import(
    "./FilePreviewContent.testkit"
  );
  installTestDom();
  const { LEGACY_DEFAULT_CONNECTION_ID } = await import("../connectionStorage");
  const { fileThread } = await import("./FileThreads.testkit");
  const review = {
    session: {
      id: "s1",
      connectionId: LEGACY_DEFAULT_CONNECTION_ID,
      workspaceId: "w1",
      root: "/repo",
      title: "plan.md",
      target: { kind: "rendered", path: "plan.md" },
      gitlab: false,
      summary: "",
      agent: {},
      createdAt: "2026-11-10",
      updatedAt: "2026-11-10",
    },
    threads: [fileThread("t1", 3, false)],
  };
  const { mock } = await import("bun:test");
  const real = await import("../review");
  mock.module("../review", () => ({
    ...real,
    reviewCall: async (_connection: string, method: string) =>
      method === "review.get" ? review : {},
    rememberReviewSnapshot: () => {},
    useReviewState: () => ({
      sessions: new Map<string, unknown>([["s1", review]]),
      openRequest: null,
    }),
  }));
  mock.module("../sitesWeWorkOn", () => ({
    loadSitesWeWorkOn: async () => [],
    saveSitesWeWorkOn: async () => {},
  }));
  const { store } = await import("../store");
  store.notify = (() => {}) as typeof store.notify;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FilePreviewContent } = await import("./FilePreviewContent");
  const { EditorView } = await import("@codemirror/view");
  const { setVimKeys, __resetVimKeysForTests } = await import("../vimKeys");

  const settle = settlePreview;
  const markdown = "# Plan\n\nFirst para.\n\nSecond para.\n\nThird para.\n";

  async function mount() {
    __resetVimKeysForTests();
    setVimKeys(false);
    const created: unknown[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <FilePreviewContent
          entry={previewEntry("plan.md")}
          preview={previewFile("plan.md", markdown)}
          loading={false}
          error={null}
          onCreateAnnotation={(annotation) => created.push(annotation)}
        />,
      ),
    );
    await act(settle);
    const content = host.querySelector<HTMLElement>(
      ".file-preview-file-content",
    )!;
    const keys = async (...names: string[]) => {
      for (const name of names)
        await act(async () => {
          content.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: name,
              bubbles: true,
              cancelable: true,
            }),
          );
          await settle();
        });
    };
    const on = () =>
      host
        .querySelector(
          ".chat-thread-message.is-focused, .chat-thread.is-focused",
        )
        ?.getAttribute("data-chat-stop") ??
      `block ${host.querySelector<HTMLElement>(".md-source-block.is-focused")?.dataset.line}`;
    const draft = () => host.querySelector<HTMLElement>(".file-draft");
    const draftEditor = async () => {
      for (let i = 0; i < 100 && !draft()?.querySelector(".cm-content"); i++)
        await act(settle);
      return draft()!.querySelector<HTMLElement>(".cm-content")!;
    };
    const unmount = async () => {
      await act(async () => root.unmount());
      host.remove();
      __resetVimKeysForTests();
    };
    return { host, content, keys, on, draft, draftEditor, created, unmount };
  }

  test("c on a block draws the comment box under it, after its threads, in the column; sent, the content has the keys", async () => {
    const page = await mount();
    page.content.focus();
    await page.keys("j", "j");
    expect(page.on()).toBe("block 3");
    await page.keys("c");
    // Nothing floats over the text; the box is in the block's slot.
    expect(document.querySelector(".annotation-composer-popover")).toBeNull();
    const box = page.draft();
    expect(box).not.toBeNull();
    const slot = box?.closest<HTMLElement>(".md-thread-slot");
    expect(slot?.dataset.line).toBe("3");
    expect(box?.closest(".chat-review")).not.toBeNull();
    // After the block's thread, as wide as it (the same column).
    expect(box?.previousElementSibling?.getAttribute("data-thread-id")).toBe(
      "t1",
    );
    expect(box?.querySelector("strong")?.textContent).toBe("plan.md · Plan");
    expect(box?.querySelector("blockquote")?.textContent).toBe("First para.");
    const editor = await page.draftEditor();
    expect(document.activeElement === editor).toBe(true);
    // Written and sent: the comment, then the keys back on the content,
    // where j goes on.
    const view = EditorView.findFromDOM(editor)!;
    await act(async () => {
      view.dispatch({ changes: { from: 0, insert: "Say more." } });
      await settle();
    });
    await act(async () => {
      [...box!.querySelectorAll("button")]
        .find((button) => button.textContent === "Add comment")!
        .click();
      await settle();
    });
    await act(settle);
    expect(page.created).toHaveLength(1);
    expect(page.created[0]).toMatchObject({
      source: "file",
      anchor: "quote",
      path: "plan.md",
      line: 3,
      quote: "First para.",
      comment: "Say more.",
    });
    expect(page.draft()).toBeNull();
    expect(document.activeElement === page.content).toBe(true);
    await page.keys("j");
    expect(page.on()).toBe("m:t1c");
    await page.unmount();
  });

  test("Esc on an empty box closes it; the content has the keys again at its block", async () => {
    const page = await mount();
    page.content.focus();
    await page.keys("j", "j", "j", "j");
    expect(page.on()).toBe("block 5");
    await page.keys("c");
    const editor = await page.draftEditor();
    await act(async () => {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      await settle();
    });
    await act(settle);
    expect(page.draft()).toBeNull();
    expect(document.activeElement === page.content).toBe(true);
    expect(page.on()).toBe("block 5");
    await page.keys("j");
    expect(page.on()).toBe("block 7");
    await page.unmount();
  });
}
