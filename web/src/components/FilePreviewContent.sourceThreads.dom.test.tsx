import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";
import { mockReviewStore } from "../reviewState.testkit";

/*
 * The Files preview's source view (CodeMirror): its threads drawn under
 * their lines as the review's diff draws them, and the diff's keys on the
 * editor: c comments on the cursor's line or selection or answers the
 * line's thread, j / k step into a thread's messages and out, za folds, r
 * resolves, R answers, T lists, gn / gN and gH; `:comment` too. With Vim
 * keys on and off. A comment being written is drawn under its line, as
 * wide as the column; once its box closes, the editor has the keys again,
 * at the same line.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the Files preview's source view threads in an isolated DOM runtime",
    "ROAMGATE_PREVIEW_SOURCE_THREADS_DOM_TEST",
    60_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  const { previewEntry, previewFile, settlePreview } = await import(
    "./FilePreviewContent.testkit"
  );
  installTestDom();
  const { LEGACY_DEFAULT_CONNECTION_ID } = await import("../connectionStorage");
  const { threadComment } = await import("./FileThreads.testkit");
  const { setVimKeys, __resetVimKeysForTests } = await import("../vimKeys");

  const PATH = "src/main.rs";
  const code = [
    "fn main() {",
    "    let a = 1;",
    "    let b = 2;",
    "    let c = a + b;",
    '    println!("{c}");',
    "}",
    "",
    "fn helper(x: i32) -> i32 {",
    "    x * 2",
    "}",
    "",
    "// end",
  ].join("\n");
  const thread = (
    id: string,
    line: number,
    resolved: boolean,
    endLine?: number,
    author = "you",
  ) => ({
    id,
    sessionId: "s1",
    kind: "discussion",
    anchor: {
      path: PATH,
      line,
      ...(endLine === undefined ? {} : { endLine }),
    },
    comments: [threadComment(`${id}c`, author, `On ${id}`)],
    resolved,
    createdAt: `2026-11-10T10:00:${String(line).padStart(2, "0")}Z`,
    updatedAt: `2026-11-10T10:00:${String(line).padStart(2, "0")}Z`,
  });
  /** The checkout's review: its threads on the file, as Changes has them. */
  const freshReview = () => ({
    session: {
      id: "s1",
      connectionId: LEGACY_DEFAULT_CONNECTION_ID,
      workspaceId: "w1",
      root: "/repo",
      title: "work",
      target: { kind: "worktree" },
      gitlab: false,
      summary: "",
      agent: {},
      createdAt: "2026-11-10",
      updatedAt: "2026-11-10",
    },
    threads: [
      thread("t1", 3, false),
      thread("t2", 5, true),
      thread("t3", 8, false, 9),
    ],
  });
  let review = freshReview();
  const writes: { method: string; params: Record<string, unknown> }[] = [];
  const { mock } = await import("bun:test");
  const real = await import("../review");
  mock.module("../review", () => ({
    ...real,
    reviewCall: async (
      _connection: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      if (method === "review.get") return review;
      writes.push({ method, params });
      if (method === "review.resolve")
        review = {
          ...review,
          threads: review.threads.map((each) =>
            each.id === params.comment_id
              ? { ...each, resolved: !each.resolved }
              : each,
          ),
        };
      return {};
    },
    rememberReviewSnapshot: () => {},
    ...mockReviewStore(() => ({
      sessions: new Map<string, unknown>([["s1", review]]),
      openRequest: null,
    })),
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
  const { getCM, Vim } = await import("@replit/codemirror-vim");

  const settle = settlePreview;
  const press = (target: EventTarget, key: string, init = {}) =>
    act(async () => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
      await settle();
    });

  /** The source view of the file, with its threads, once drawn. */
  async function mount(
    options: { vim: boolean; annotate?: boolean } = {
      vim: false,
    },
  ) {
    __resetVimKeysForTests();
    setVimKeys(options.vim);
    review = freshReview();
    const created: unknown[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <FilePreviewContent
          entry={previewEntry(PATH)}
          preview={previewFile(PATH, code)}
          loading={false}
          error={null}
          onShowInReview={() => {}}
          onCreateAnnotation={(annotation, capture) =>
            created.push({ annotation, capture })
          }
        />,
      ),
    );
    await act(settle);
    // CodeMirror and its Vim keys load on demand.
    for (let i = 0; i < 100 && !host.querySelector(".cm-content"); i++)
      await act(settle);
    const content = host.querySelector<HTMLElement>(".cm-content")!;
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content)!;
    expect(view).not.toBeNull();
    /** The cursor put on a line, as a click or Vim's motions would. */
    const goTo = (line: number, end?: number) =>
      act(async () => {
        const doc = view.state.doc;
        view.dispatch({
          selection: {
            anchor: doc.line(line).from,
            head: end === undefined ? doc.line(line).from : doc.line(end).to,
          },
        });
        await settle();
      });
    const cursorLine = () =>
      view.state.doc.lineAt(view.state.selection.main.head).number;
    const keys = async (...names: string[]) => {
      for (const name of names) await press(content, name);
    };
    const card = (id: string) =>
      host.querySelector<HTMLElement>(
        `.cm-source-threads .chat-thread[data-thread-id="${id}"]`,
      );
    const widget = (line: number) =>
      host.querySelector<HTMLElement>(
        `.cm-source-threads[data-line="${line}"]`,
      );
    /** The thread message or folded line j / k are on, or the line. */
    const on = () =>
      host
        .querySelector(
          ".chat-thread-message.is-focused, .chat-thread.is-focused",
        )
        ?.getAttribute("data-chat-stop") ?? `line ${cursorLine()}`;
    const popover = () =>
      document.querySelector<HTMLElement>(".annotation-composer-popover");
    /** The comment being written, drawn under its line. */
    const draft = () => host.querySelector<HTMLElement>(".file-draft");
    const draftEditor = async () => {
      for (let i = 0; i < 100 && !draft()?.querySelector(".cm-content"); i++)
        await act(settle);
      return draft()!.querySelector<HTMLElement>(".cm-content")!;
    };
    /** Esc in the box (twice with Vim keys: insert mode left first). */
    const closeDraft = async () => {
      const editor = await draftEditor();
      editor.focus();
      for (let i = 0; i < 3 && draft(); i++) await press(editor, "Escape");
      await act(settle);
      await act(settle);
    };
    const unmount = async () => {
      await act(async () => root.unmount());
      host.remove();
      __resetVimKeysForTests();
    };
    return {
      host,
      content,
      view,
      goTo,
      cursorLine,
      keys,
      card,
      widget,
      on,
      popover,
      draft,
      draftEditor,
      closeDraft,
      created,
      unmount,
    };
  }

  for (const vim of [false, true]) {
    const mode = vim ? "Vim keys on" : "Vim keys off";

    test(`${mode}: the threads are drawn under their lines, resolved ones folded, their lines and gutter marked`, async () => {
      const page = await mount({ vim });
      // Under the last line each is on, in the chat's palette, with the
      // card's buttons; the resolved one on one line.
      const t1 = page.card("t1");
      expect(t1?.closest<HTMLElement>(".cm-source-threads")?.dataset.line).toBe(
        "3",
      );
      expect(t1?.closest(".chat-review")).not.toBeNull();
      expect(t1?.querySelector(".chat-thread-author")?.textContent).toBe("You");
      expect(
        [...(t1?.querySelectorAll(".chat-thread-bar button") ?? [])].map(
          (button) => button.textContent,
        ),
      ).toEqual(["Reply", "Resolve", "Fold", "Delete"]);
      expect(page.card("t2")?.classList.contains("is-folded")).toBe(true);
      expect(
        page.card("t3")?.closest<HTMLElement>(".cm-source-threads")?.dataset
          .line,
      ).toBe("9");
      // Their lines marked, the gutter counting the threads starting there.
      const marked = [...page.host.querySelectorAll(".cm-line")]
        .map((line, index) =>
          line.getAttribute("data-review-threaded") ? index + 1 : 0,
        )
        .filter(Boolean);
      expect(marked).toEqual([3, 5, 8, 9]);
      // One badge where each thread starts (lines 3, 5 and 8), counting.
      const badges = () => [
        ...page.host.querySelectorAll<HTMLElement>(
          ".cm-review-annotation-gutter .cm-review-annotation-marker",
        ),
      ];
      expect(badges().map((badge) => badge.textContent)).toEqual([
        "1",
        "1",
        "1",
      ]);
      expect(badges()[0]?.title).toBe("1 review comment (fold / unfold)");
      // The badge folds the line's threads, and unfolds them.
      const pressBadge = () =>
        act(async () => {
          badges()[0]!.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, button: 0 }),
          );
          await settle();
        });
      await pressBadge();
      expect(page.card("t1")?.classList.contains("is-folded")).toBe(true);
      await pressBadge();
      expect(page.card("t1")?.classList.contains("is-folded")).toBe(false);
      // The line numbers are the file's: the widgets shift no line.
      expect(page.view.state.doc.lines).toBe(12);
      expect(
        [...page.host.querySelectorAll(".cm-lineNumbers .cm-gutterElement")]
          .map((element) => element.textContent)
          .filter((text) => text === "9" || text === "12"),
      ).toEqual(["9", "12"]);
      await page.unmount();
    });

    test(`${mode}: c comments on the cursor's line, in a box under it; Esc closes it and the editor has the keys again, at that line`, async () => {
      const page = await mount({ vim });
      page.content.focus();
      await page.goTo(2);
      await page.keys("c");
      // Under the line, in the editor's content, not floating over it.
      expect(page.popover()).toBeNull();
      const box = page.draft();
      expect(box).not.toBeNull();
      expect(
        box?.closest<HTMLElement>(".cm-source-threads")?.dataset.line,
      ).toBe("2");
      expect(page.content.contains(box)).toBe(true);
      expect(box?.querySelector("strong")?.textContent).toBe(
        `${PATH} · line 2`,
      );
      expect(box?.querySelector("blockquote")?.textContent).toBe(
        "    let a = 1;",
      );
      // The box has the keys; no change of the file: Vim's c (change)
      // does nothing here.
      const editor = await page.draftEditor();
      expect(document.activeElement === editor).toBe(true);
      expect(page.view.state.doc.toString()).toBe(code);
      await page.closeDraft();
      expect(page.draft()).toBeNull();
      expect(document.activeElement === page.content).toBe(true);
      expect(page.cursorLine()).toBe(2);
      // A selection: the comment is on its lines, quoting them, under the
      // last one.
      await page.goTo(9, 10);
      await page.keys("c");
      expect(
        page.draft()?.closest<HTMLElement>(".cm-source-threads")?.dataset.line,
      ).toBe("10");
      expect(page.draft()?.querySelector("strong")?.textContent).toBe(
        `${PATH} · lines 9-10`,
      );
      expect(page.draft()?.querySelector("blockquote")?.textContent).toBe(
        "    x * 2\n}",
      );
      await page.closeDraft();
      // C comments anew on a line with a thread, under its card.
      await page.goTo(3);
      await page.keys("C");
      expect(page.draft()?.querySelector("strong")?.textContent).toBe(
        `${PATH} · line 3`,
      );
      expect(page.draft()?.previousElementSibling).toBe(page.card("t1"));
      await page.closeDraft();
      expect(page.draft()).toBeNull();
      await page.unmount();
    });

    test(`${mode}: c on a line with a thread answers it; the box closed, the editor has the keys`, async () => {
      const page = await mount({ vim });
      page.content.focus();
      await page.goTo(3);
      await page.keys("c");
      expect(page.popover()).toBeNull();
      expect(page.draft()).toBeNull();
      const editor = () =>
        page.card("t1")?.querySelector<HTMLElement>(".chat-thread-editor");
      for (let i = 0; i < 50 && !editor()?.querySelector(".cm-content"); i++)
        await act(settle);
      expect(editor()).not.toBeNull();
      expect(page.on()).toBe("m:t1c");
      // Cancel: the box goes, the keys are the editor's again.
      await act(async () => {
        [...editor()!.querySelectorAll("button")]
          .find((button) => button.textContent === "Cancel")!
          .click();
        await settle();
      });
      await act(settle);
      expect(editor()).toBeNull();
      expect(document.activeElement === page.content).toBe(true);
      expect(page.cursorLine()).toBe(3);
      // R answers too, from the line.
      await page.keys("R");
      for (let i = 0; i < 50 && !editor()?.querySelector(".cm-content"); i++)
        await act(settle);
      expect(editor()).not.toBeNull();
      await page.unmount();
    });

    test(`${mode}: j / k step into a thread's messages and out again, as in the diff`, async () => {
      const page = await mount({ vim });
      page.content.focus();
      await page.goTo(3);
      expect(page.on()).toBe("line 3");
      await page.keys("j");
      expect(page.on()).toBe("m:t1c");
      expect(page.cursorLine()).toBe(3);
      await page.keys("j");
      expect(page.on()).toBe("line 4");
      await page.keys("k");
      expect(page.on()).toBe("m:t1c");
      expect(page.cursorLine()).toBe(3);
      await page.keys("k");
      expect(page.on()).toBe("line 3");
      // The arrows too; Esc leaves the messages for the line.
      await page.keys("ArrowDown");
      expect(page.on()).toBe("m:t1c");
      await page.keys("Escape");
      expect(page.on()).toBe("line 3");
      await page.keys("ArrowDown", "ArrowDown");
      expect(page.on()).toBe("line 4");
      // The cursor put elsewhere leaves the thread's messages.
      await page.keys("k");
      expect(page.on()).toBe("m:t1c");
      await page.goTo(10);
      expect(page.on()).toBe("line 10");
      await page.unmount();
    });

    test(`${mode}: za folds, r resolves, T lists, gn / gN go to the unresolved threads, gH shows only those`, async () => {
      const page = await mount({ vim });
      page.content.focus();
      await page.goTo(3);
      await page.keys("z", "a");
      expect(page.card("t1")?.classList.contains("is-folded")).toBe(true);
      await page.keys("z", "a");
      expect(page.card("t1")?.classList.contains("is-folded")).toBe(false);
      // gn from line 3, whose thread this is: the next unresolved one,
      // the keys on it.
      await page.keys("g", "n");
      expect(page.cursorLine()).toBe(9);
      expect(page.on()).toBe("m:t3c");
      expect(document.activeElement === page.content).toBe(true);
      await page.keys("g", "N");
      expect(page.cursorLine()).toBe(3);
      expect(page.on()).toBe("m:t1c");
      // gH: the resolved thread's card goes; back again.
      await page.keys("g", "H");
      expect(page.widget(5)).toBeNull();
      await page.keys("g", "H");
      expect(page.widget(5)).not.toBeNull();
      // r resolves the thread under the line.
      writes.length = 0;
      await page.keys("r");
      expect(writes[0]).toMatchObject({
        method: "review.resolve",
        params: { comment_id: "t1", resolved: true },
      });
      // T lists them.
      await page.keys("T");
      expect(page.host.querySelector(".file-preview-threads")).not.toBeNull();
      await page.unmount();
    });

    test(`${mode}: \`:comment\` is listed in the source view and comments on the cursor's line`, async () => {
      const page = await mount({ vim });
      page.content.focus();
      await page.goTo(4);
      if (vim) {
        // Vim's own `:` line, whose words are the preview's.
        await act(async () => {
          Vim.handleEx(
            getCM(page.view)! as Parameters<typeof Vim.handleEx>[0],
            "comment",
          );
          await settle();
        });
      } else {
        await page.keys(":");
        const prompt = page.host.querySelector<HTMLInputElement>(
          'input[aria-label="Command"]',
        );
        expect(prompt).not.toBeNull();
        const names = [
          ...page.host.querySelectorAll(
            ".file-preview > .review-cmdline .wild-item",
          ),
        ].map((item) => item.firstChild?.textContent);
        expect(names).toContain("comment");
        expect(names).toContain("fold");
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(prompt!),
            "value",
          )!.set!.call(prompt, "comment");
          prompt!.dispatchEvent(new Event("input", { bubbles: true }));
          await settle();
        });
        await press(prompt!, "Enter");
      }
      expect(page.draft()?.querySelector("strong")?.textContent).toBe(
        `${PATH} · line 4`,
      );
      await page.closeDraft();
      expect(page.draft()).toBeNull();
      await page.unmount();
    });
  }

  test("without Vim keys, n / N go thread to thread from the cursor's line", async () => {
    const page = await mount({ vim: false });
    page.content.focus();
    await page.goTo(1);
    await page.keys("n");
    expect(page.on()).toBe("m:t1c");
    await page.keys("n");
    expect(page.cursorLine()).toBe(5);
    expect(page.card("t2")?.classList.contains("is-folded")).toBe(false);
    await page.keys("n");
    expect(page.on()).toBe("m:t3c");
    await page.keys("n");
    expect(page.on()).toBe("m:t1c");
    await page.keys("N");
    expect(page.on()).toBe("m:t3c");
    await page.unmount();
  });

  test("with Vim keys, a count or an operator pending leaves the key to Vim, and a thread's reply box keeps its own c", async () => {
    const page = await mount({ vim: true });
    page.content.focus();
    await page.goTo(2);
    // "3c": Vim's; nothing opens, and Esc drops what Vim kept.
    await page.keys("3", "c");
    expect(page.draft()).toBeNull();
    await page.keys("Escape");
    await page.keys("c");
    expect(page.draft()).not.toBeNull();
    await page.closeDraft();
    await page.unmount();
  });

  test("a comment sent from the box: the editor has the keys again", async () => {
    const page = await mount({ vim: false });
    page.content.focus();
    await page.goTo(2);
    await page.keys("c");
    const editor = EditorView.findFromDOM(await page.draftEditor())!;
    await act(async () => {
      editor.dispatch({ changes: { from: 0, insert: "Why 1?" } });
      await settle();
    });
    await act(async () => {
      [...page.draft()!.querySelectorAll("button")]
        .find((button) => button.textContent === "Add comment")!
        .click();
      await settle();
    });
    await act(settle);
    expect(page.created).toHaveLength(1);
    expect(page.created[0]).toMatchObject({
      annotation: {
        source: "file",
        anchor: "line",
        path: PATH,
        line: 2,
        quote: "    let a = 1;",
        comment: "Why 1?",
      },
      capture: { root: "/repo", lineText: "    let a = 1;" },
    });
    expect(page.draft()).toBeNull();
    expect(document.activeElement === page.content).toBe(true);
    expect(page.cursorLine()).toBe(2);
    await page.unmount();
  });
}
