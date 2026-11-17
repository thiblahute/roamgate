import { inIsolatedChild } from "../testIsolated";
import { expect, test } from "bun:test";

if (
  inIsolatedChild(
    import.meta.path,
    "file threads in an isolated DOM runtime",
    "ROAMGATE_FILE_THREADS_DOM_TEST",
    20_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  const { browser } = installTestDom();

  const writes: { method: string; params: Record<string, unknown> }[] = [];
  const comment = (id: string, body: string) => ({
    id,
    author: "you",
    body,
    createdAt: "2026-11-10T10:00:00Z",
    updatedAt: "2026-11-10T10:00:00Z",
  });
  const thread = (id: string, line: number, resolved: boolean) => ({
    id,
    sessionId: "s1",
    kind: "discussion",
    anchor: { path: "plan.md", line, render: { quote: "para" } },
    comments: [comment(`${id}c`, `**On** \`${id}\``)],
    resolved,
    createdAt: `2026-11-10T10:00:0${line}Z`,
    updatedAt: `2026-11-10T10:00:0${line}Z`,
  });
  const review = {
    session: {
      id: "s1",
      connectionId: "local",
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
    threads: [
      thread("t1", 3, false),
      thread("t2", 5, true),
      thread("t3", 7, false),
    ],
  };
  /** A file of lists and a table, its threads on an item and a cell. */
  const onPart = (id: string, line: number, quote: string) => ({
    ...thread(id, line, false),
    sessionId: "s2",
    anchor: { path: "lists.md", line, render: { quote } },
  });
  const listsReview = {
    session: {
      ...review.session,
      id: "s2",
      title: "lists.md",
      target: { kind: "rendered", path: "lists.md" },
    },
    threads: [onPart("x1", 4, "one a"), onPart("x2", 11, "1")],
  };
  /**
   * A file where threads quote a few words: a table's cells (the case of
   * docs/DEPLOYMENT.md: part of a cell, two cells of a row, written out of
   * column order), words said twice in a paragraph, words across inline
   * code.
   */
  const placesText = [
    "# Places",
    "",
    "| Herdr | Support |",
    "| --- | --- |",
    "| 0.7.0–0.8.2 (protocols 14–20) | Legacy terminal mode |",
    "| 0.9.0 and 0.9.4 (protocol 22) | Endpoint terminal mode (recommended) |",
    "| Protocol 21 and unknown versions | Rejected |",
    "",
    "Use the cache here.",
    "Then use the cache there.",
    "",
    "Run `bun install` then restart.",
    "",
  ].join("\n");
  const quoting = (
    id: string,
    line: number,
    quote: string,
    second: number,
    resolved = false,
  ) => ({
    ...thread(id, line, resolved),
    sessionId: "s4",
    anchor: { path: "places.md", line, render: { quote } },
    createdAt: `2026-11-10T10:00:${String(second).padStart(2, "0")}Z`,
  });
  const placesReview = {
    session: {
      ...review.session,
      id: "s4",
      title: "places.md",
      target: { kind: "rendered", path: "places.md" },
    },
    threads: [
      quoting("p3", 6, "Endpoint terminal mode (recommended)", 2),
      quoting("p2", 6, ".0 and 0.9.4 (protocol", 3),
      quoting("p1", 5, "0.7.0–0.8.2 (protocols 14–20)", 1),
      quoting("p4", 10, "the cache", 4),
      quoting("p5", 9, "the cache", 5),
      quoting("p6", 7, "Rejected", 6, true),
      quoting("p7", 12, "bun install then", 7),
      quoting("p8", 12, "`bun install` then restart", 8),
    ],
  };
  /**
   * A review the page writes to as the server would (review.open, a
   * thread added), for a comment written in the view: shown once read
   * back (rememberReviewSnapshot), as the page's store does.
   */
  type Snapshot = { session: Record<string, unknown>; threads: unknown[] };
  let written: Snapshot | null = null;
  const redraw = new Set<() => void>();
  const { mock } = await import("bun:test");
  mock.module("../review", () => ({
    reviewCall: async (
      _connection: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      if (method === "review.get")
        return params.session_id === "s3"
          ? written
          : params.session_id === "s2"
            ? listsReview
            : params.session_id === "s4"
              ? placesReview
              : review;
      writes.push({ method, params });
      if (method === "review.open") {
        written ??= {
          session: {
            ...review.session,
            id: "s3",
            title: "notes.md",
            target: { kind: "rendered", path: "notes.md" },
            autoSend: true,
            agent: params.agent_pane
              ? { paneId: params.agent_pane, name: params.agent }
              : {},
          },
          threads: [],
        };
        return written;
      }
      if (method === "review.thread.add" && written) {
        const anchor = params.anchor as Record<string, unknown>;
        written = {
          ...written,
          threads: [
            ...written.threads,
            {
              id: params.new_thread_id,
              sessionId: "s3",
              kind: params.kind,
              anchor,
              comments: [
                comment(`${params.new_thread_id}c`, String(params.text)),
              ],
              resolved: false,
              createdAt: "2026-11-10T11:00:00Z",
              updatedAt: "2026-11-10T11:00:00Z",
              ...(params.held !== undefined ? { held: params.held } : {}),
            },
          ],
        };
      }
      return {};
    },
    rememberReviewSnapshot: (snapshot: Snapshot) => {
      if (snapshot === written) for (const each of redraw) each();
    },
    useReviewState: () => ({
      sessions: new Map<string, unknown>([
        ["s1", review],
        ["s2", listsReview],
        ["s4", placesReview],
        ...(written ? [["s3", written] as [string, unknown]] : []),
      ]),
      openRequest: null,
    }),
  }));

  const settle = async () => {
    for (let i = 0; i < 20; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  };

  test("the Files preview draws its threads as a chat's, with the chat's keys", async () => {
    const { act, useMemo, useState } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const {
      fileThreadKeys,
      SlotThreads,
      focusFileThread,
      useFileThreads,
      useFileThreadView,
      useMarkedBlocks,
    } = await import("./FileThreads");
    const { useThreadKeys } = await import("./useThreadKeys");
    const { MarkdownPreview } = await import("./markdown");
    const commented: string[] = [];
    let overview = 0;
    // As FilePreviewContent wires them.
    function Preview() {
      const api = useFileThreads("local", { absolute: "/repo/plan.md" });
      const [element, setElement] = useState<HTMLDivElement | null>(null);
      const view = useFileThreadView(() => element);
      const byId = useMemo(
        () => new Map(api.threads.map((each) => [each.id, each])),
        [api.threads],
      );
      useThreadKeys(
        () => element,
        element,
        fileThreadKeys({
          view,
          api,
          threadsById: byId,
          goToThread: (each) => focusFileThread(element, each, view.setCursor),
          openOverview: () => overview++,
          jumpUnresolved: () => {},
          comment: (block) => {
            commented.push(block.dataset.line ?? "");
            return true;
          },
        }),
      );
      useMarkedBlocks(element, view.cursor);
      return (
        <section className="file-preview">
          <div ref={setElement} className="file-preview-file-content">
            <MarkdownPreview
              text={"# Plan\n\nFirst para.\n\nSecond para.\n\nThird para.\n"}
              threadsFor={(stops, stopOf) => (
                <SlotThreads
                  stops={stops}
                  stopOf={stopOf}
                  threads={api.threads}
                  api={api}
                  view={view}
                />
              )}
            />
            <input className="typing" />
          </div>
        </section>
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Preview />));
    await act(settle);
    const content = host.querySelector<HTMLElement>(
      ".file-preview-file-content",
    )!;
    const keys = (...names: string[]) =>
      act(async () => {
        for (const name of names)
          content.dispatchEvent(
            new KeyboardEvent("keydown", { key: name, bubbles: true }),
          );
        await settle();
      });
    const block = (line: number) =>
      host.querySelector<HTMLElement>(`.md-source-block[data-line="${line}"]`)!;
    const on = () =>
      host
        .querySelector(
          ".chat-thread-message.is-focused, .chat-thread.is-focused",
        )
        ?.closest("[data-thread-id]")
        ?.getAttribute("data-thread-id") ??
      host.querySelector<HTMLElement>(".md-source-block.is-focused")?.dataset
        .line;
    const folded = (id: string) =>
      host
        .querySelector(`[data-thread-id="${id}"]`)
        ?.classList.contains("is-folded");

    // Drawn as a chat's: the card, in the chat's palette, under its block,
    // which has the comments' bar; the resolved one folded on one line.
    const card = host.querySelector('.chat-thread[data-thread-id="t1"]');
    expect(card?.closest(".md-thread-slot .chat-review")).not.toBeNull();
    expect(card?.querySelector(".chat-thread-author")?.textContent).toBe("You");
    expect(
      [...(card?.querySelectorAll(".chat-thread-bar button") ?? [])].map(
        (button) => button.textContent,
      ),
    ).toEqual(["Reply", "Resolve", "Fold", "Delete"]);
    expect(folded("t2")).toBe(true);
    expect(
      host.querySelector('[data-thread-id="t2"] .chat-thread-mark')
        ?.textContent,
    ).toBe("✓ Resolved");
    expect(block(3).classList.contains("has-notes")).toBe(true);
    expect(block(1).classList.contains("has-notes")).toBe(false);

    // j / k through the blocks and the threads' messages.
    await keys("j");
    expect(on()).toBe("1");
    await keys("j");
    expect(on()).toBe("3");
    expect(block(3).classList.contains("is-focused")).toBe(true);
    await keys("j");
    expect(on()).toBe("t1");
    await keys("k");
    expect(on()).toBe("3");
    // c on a block: a comment on it.
    await keys("c");
    expect(commented).toEqual(["3"]);
    // n / N thread to thread, the folded one too.
    await keys("n");
    expect(on()).toBe("t1");
    await keys("n");
    expect(on()).toBe("t2");
    await keys("n");
    expect(on()).toBe("t3");
    await keys("N");
    expect(on()).toBe("t2");
    // za unfolds the resolved one, and folds it again.
    await keys("z", "a");
    expect(folded("t2")).toBe(false);
    await keys("z", "a");
    expect(folded("t2")).toBe(true);
    // r reopens it.
    await keys("r");
    expect(writes[writes.length - 1]).toMatchObject({
      method: "review.resolve",
      params: { comment_id: "t2", resolved: false },
    });
    // gg / G: the first and last stops; R answers a thread; dd deletes a
    // lone comment of yours.
    await keys("G");
    expect(on()).toBe("t3");
    await keys("g", "g");
    expect(on()).toBe("1");
    await keys("j");
    await keys("j");
    expect(on()).toBe("t1");
    await keys("R");
    expect(
      host.querySelector('[data-thread-id="t1"] .chat-thread-editor'),
    ).not.toBeNull();
    content.focus();
    await keys("d", "d");
    expect(writes[writes.length - 1]).toMatchObject({
      method: "review.delete",
      params: { comment_id: "t1" },
    });
    // T lists them.
    await keys("T");
    expect(overview).toBe(1);
    // Typing in a box keeps the keys.
    const before = on();
    await act(async () => {
      host
        .querySelector("input.typing")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "j", bubbles: true }),
        );
      await settle();
    });
    expect(on()).toBe(before);
    await act(async () => root.unmount());
    host.remove();
  });

  test("the Files preview stops on each list item and table cell, and anchors there", async () => {
    const { act, useMemo, useState } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const {
      fileStopAnchor,
      fileThreadKeys,
      focusFileThread,
      SlotThreads,
      useFileThreads,
      useFileThreadView,
      useMarkedBlocks,
    } = await import("./FileThreads");
    const { useThreadKeys } = await import("./useThreadKeys");
    const { MarkdownPreview } = await import("./markdown");
    const anchors: unknown[] = [];
    const text = [
      "# Lists",
      "",
      "- one",
      "  - one a",
      "  - one b",
      "    on two lines",
      "- two",
      "",
      "| Name | Size |",
      "| --- | --- |",
      "| a | 1 |",
      "| b | 2 |",
      "",
      "End.",
      "",
    ].join("\n");
    function Preview() {
      const api = useFileThreads("local", { absolute: "/repo/lists.md" });
      const [element, setElement] = useState<HTMLDivElement | null>(null);
      const view = useFileThreadView(() => element);
      const byId = useMemo(
        () => new Map(api.threads.map((each) => [each.id, each])),
        [api.threads],
      );
      useThreadKeys(
        () => element,
        element,
        fileThreadKeys({
          view,
          api,
          threadsById: byId,
          goToThread: (each) => focusFileThread(element, each, view.setCursor),
          openOverview: () => {},
          jumpUnresolved: () => {},
          comment: (stop) => {
            anchors.push(fileStopAnchor(stop, 4000));
            return true;
          },
        }),
      );
      useMarkedBlocks(element, view.cursor);
      return (
        <section className="file-preview">
          <div ref={setElement} className="file-preview-file-content">
            <MarkdownPreview
              text={text}
              threadsFor={(stops, stopOf) => (
                <SlotThreads
                  stops={stops}
                  stopOf={stopOf}
                  threads={api.threads}
                  api={api}
                  view={view}
                />
              )}
            />
          </div>
        </section>
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Preview />));
    await act(settle);
    const content = host.querySelector<HTMLElement>(
      ".file-preview-file-content",
    )!;
    // One at a time: each key reads where the one before left the cursor.
    const keys = async (...names: string[]) => {
      for (const name of names)
        await act(async () => {
          content.dispatchEvent(
            new KeyboardEvent("keydown", { key: name, bubbles: true }),
          );
          await settle();
        });
    };
    const stop = (key: string) =>
      host.querySelector<HTMLElement>(`[data-stop="${key}"]`)!;
    const on = () =>
      host
        .querySelector(".chat-thread-message.is-focused")
        ?.closest("[data-thread-id]")
        ?.getAttribute("data-thread-id") ??
      host.querySelector<HTMLElement>(".is-focused[data-stop]")?.dataset.stop;

    // A list's items, nested ones too, and a table's cells, header first,
    // each with its own lines; the list and the table are no stops.
    expect(
      [...host.querySelectorAll<HTMLElement>("[data-stop]")].map(
        (each) =>
          `${each.dataset.stop}=${each.dataset.line}-${each.dataset.end}`,
      ),
    ).toEqual([
      "b:1=1-1",
      "b:3=3-3",
      "b:4=4-4",
      "b:5=5-6",
      "b:7=7-7",
      "b:9:0=9-9",
      "b:9:1=9-9",
      "b:11:0=11-11",
      "b:11:1=11-11",
      "b:12:0=12-12",
      "b:12:1=12-12",
      "b:14=14-14",
    ]);
    expect(stop("b:3").textContent).toBe("one");
    expect(stop("b:9:0").tagName).toBe("TH");

    // A thread on an item is under that item (before its nested items),
    // one on a cell under that cell's row; the bar marks the item and the
    // cell, not their list, row or neighbours.
    const x1 = host.querySelector('.chat-thread[data-thread-id="x1"]')!;
    expect(x1.closest(".md-thread-slot")?.getAttribute("data-stops")).toBe(
      "b:4",
    );
    expect(x1.closest("li")?.querySelector(".md-source-item")).toBe(
      stop("b:4"),
    );
    const x2 = host.querySelector('.chat-thread[data-thread-id="x2"]')!;
    const row = x2.closest("tr.md-thread-row");
    expect(row?.previousElementSibling?.contains(stop("b:11:1"))).toBe(true);
    expect(stop("b:4").classList.contains("has-notes")).toBe(true);
    expect(stop("b:11:1").classList.contains("has-notes")).toBe(true);
    expect(stop("b:11:0").classList.contains("has-notes")).toBe(false);
    expect(stop("b:3").classList.contains("has-notes")).toBe(false);

    // j / k item by item, the threads after their item.
    await keys("j");
    expect(on()).toBe("b:1");
    await keys("j");
    expect(on()).toBe("b:3");
    await keys("j");
    expect(on()).toBe("b:4");
    await keys("j");
    expect(on()).toBe("x1");
    await keys("j");
    expect(on()).toBe("b:5");
    // c on an item: its own lines and words, not the list's.
    await keys("c");
    expect(anchors.pop()).toEqual({
      line: 5,
      endLine: 6,
      quote: "one b\non two lines",
    });
    await keys("k", "k", "k", "c");
    expect(on()).toBe("b:3");
    expect(anchors.pop()).toEqual({ line: 3, quote: "one" });
    await keys("j", "j", "j", "j");
    expect(on()).toBe("b:7");

    // In the table, a grid: j into its first cell, l / h along the row,
    // j / k down and up the column, through the threads on a row.
    await keys("j");
    expect(on()).toBe("b:9:0");
    await keys("l");
    expect(on()).toBe("b:9:1");
    await keys("l");
    expect(on()).toBe("b:9:1");
    await keys("j");
    expect(on()).toBe("b:11:1");
    // c on a cell: its row's line and its own words.
    await keys("c");
    expect(anchors.pop()).toEqual({ line: 11, quote: "1" });
    await keys("j");
    expect(on()).toBe("x2");
    await keys("j");
    expect(on()).toBe("b:12:1");
    await keys("h");
    expect(on()).toBe("b:12:0");
    await keys("k");
    expect(on()).toBe("x2");
    await keys("k");
    expect(on()).toBe("b:11:0");
    await keys("k");
    expect(on()).toBe("b:9:0");
    // Out of the table above its header and below its last row.
    await keys("k");
    expect(on()).toBe("b:7");
    await keys("j", "l", "j", "j", "j", "j");
    expect(on()).toBe("b:14");
    // Into it from below: its last row's first cell.
    await keys("k");
    expect(on()).toBe("b:12:0");
    // h / l outside a table move nothing.
    await keys("j", "l");
    expect(on()).toBe("b:14");
    await keys("h");
    expect(on()).toBe("b:14");
    await act(async () => root.unmount());
    host.remove();
  });

  test("a click on a block, an item or a cell, or words selected in it, puts the cursor there", async () => {
    const { act, useMemo, useState } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const {
      fileThreadKeys,
      focusFileThread,
      SlotThreads,
      useFileThreads,
      useFileThreadView,
      useMarkedBlocks,
    } = await import("./FileThreads");
    const { useThreadKeys } = await import("./useThreadKeys");
    const { MarkdownPreview } = await import("./markdown");
    const text = [
      "# Plan",
      "",
      "First para with [a link](https://example.com/).",
      "",
      "- one",
      "- two",
      "",
      "| Name | Size |",
      "| --- | --- |",
      "| a | 1 |",
      "",
      "Last para.",
      "",
    ].join("\n");
    function Preview() {
      const api = useFileThreads("local", { absolute: "/repo/plan.md" });
      const [element, setElement] = useState<HTMLDivElement | null>(null);
      const view = useFileThreadView(() => element);
      const byId = useMemo(
        () => new Map(api.threads.map((each) => [each.id, each])),
        [api.threads],
      );
      useThreadKeys(
        () => element,
        element,
        fileThreadKeys({
          view,
          api,
          threadsById: byId,
          goToThread: (each) => focusFileThread(element, each, view.setCursor),
          openOverview: () => {},
          jumpUnresolved: () => {},
          comment: () => true,
        }),
      );
      useMarkedBlocks(element, view.cursor);
      return (
        <section className="file-preview">
          <div ref={setElement} className="file-preview-file-content">
            <MarkdownPreview
              text={text}
              threadsFor={(stops, stopOf) => (
                <SlotThreads
                  stops={stops}
                  stopOf={stopOf}
                  threads={api.threads}
                  api={api}
                  view={view}
                />
              )}
            />
          </div>
          <input className="elsewhere" />
        </section>
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Preview />));
    await act(settle);
    const content = host.querySelector<HTMLElement>(
      ".file-preview-file-content",
    )!;
    const stop = (key: string) =>
      host.querySelector<HTMLElement>(`[data-stop="${key}"]`)!;
    const on = () =>
      host.querySelector<HTMLElement>(".is-focused[data-stop]")?.dataset.stop;
    const click = (target: Element, type = "click") =>
      act(async () => {
        target.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }),
        );
        await settle();
      });
    // The focus elsewhere, as after typing in another box.
    host.querySelector<HTMLInputElement>("input.elsewhere")!.focus();

    // A block: the cursor on it, and the keys the preview's again.
    await click(stop("b:12"));
    expect(on()).toBe("b:12");
    expect(document.activeElement).toBe(content);
    // A list item, the words inside it too.
    await click(stop("b:6").firstChild?.parentElement ?? stop("b:6"));
    expect(on()).toBe("b:6");
    // A table's cell.
    await click(stop("b:10:1"));
    expect(on()).toBe("b:10:1");
    // j goes on from where the click put it.
    await act(async () => {
      content.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", bubbles: true }),
      );
      await settle();
    });
    expect(on()).toBe("b:12");
    // A link keeps its own click: the cursor stays.
    await click(stop("b:3").querySelector("a")!);
    expect(on()).toBe("b:12");
    // Words selected in a block with the mouse: it is the one focused.
    const words = document
      .createTreeWalker(stop("b:3"), NodeFilter.SHOW_TEXT)
      .nextNode()!;
    const range = document.createRange();
    range.setStart(words, 0);
    range.setEnd(words, 5);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await click(stop("b:3"), "mouseup");
    expect(on()).toBe("b:3");
    selection.removeAllRanges();
    await act(async () => root.unmount());
    host.remove();
  });

  test("a comment written in the Files preview is the view's thread, the focus left there", async () => {
    const { act, useMemo, useState, useEffect } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const {
      fileStopAnchor,
      fileThreadKeys,
      focusFileThread,
      SlotThreads,
      ThreadsList,
      useFileThreads,
      useFileThreadView,
      useMarkedBlocks,
    } = await import("./FileThreads");
    const { useThreadKeys } = await import("./useThreadKeys");
    const { MarkdownPreview } = await import("./markdown");
    const { AnnotationComposerPopover } = await import(
      "./AnnotationComposerPopover"
    );
    const { createReviewAnnotation } = await import("../annotations");
    const { writeFeedback } = await import("../workspaceFeedback");
    const { reviewCall } = await import("../review");
    type Draft = { line: number; quote: string };
    // As FilePreviewContent and App wire them: c on a block opens the
    // composer; its save writes the comment as a thread of the file's
    // review, given the workspace's agent.
    function Preview() {
      const [, setTick] = useState(0);
      useEffect(() => {
        const bump = () => setTick((tick) => tick + 1);
        redraw.add(bump);
        return () => {
          redraw.delete(bump);
        };
      }, []);
      const api = useFileThreads("local", { absolute: "/repo/notes.md" });
      const [element, setElement] = useState<HTMLDivElement | null>(null);
      const [draft, setDraft] = useState<Draft | null>(null);
      const view = useFileThreadView(() => element);
      const byId = useMemo(
        () => new Map(api.threads.map((each) => [each.id, each])),
        [api.threads],
      );
      useThreadKeys(
        () => element,
        element,
        fileThreadKeys({
          view,
          api,
          threadsById: byId,
          goToThread: (each) => focusFileThread(element, each, view.setCursor),
          openOverview: () => {},
          jumpUnresolved: () => {},
          comment: (block) => {
            const own = fileStopAnchor(block, 4000);
            if (!own) return false;
            setDraft({ line: own.line, quote: own.quote });
            return true;
          },
        }),
      );
      useMarkedBlocks(element, view.cursor);
      return (
        <section className="file-preview">
          <div ref={setElement} className="file-preview-file-content">
            <MarkdownPreview
              text={"# Notes\n\nA para.\n\nAnother.\n"}
              threadsFor={(stops, stopOf) => (
                <SlotThreads
                  stops={stops}
                  stopOf={stopOf}
                  threads={api.threads}
                  api={api}
                  view={view}
                />
              )}
            />
          </div>
          <ThreadsList
            className="file-preview-threads"
            threads={api.threads}
            api={api}
            onGo={() => {}}
            onClose={() => {}}
          />
          <AnnotationComposerPopover
            draft={
              draft
                ? { x: 0, y: 0, title: "notes.md", quote: draft.quote }
                : null
            }
            commentValue="Say why."
            onCommentChange={() => {}}
            onClose={() => setDraft(null)}
            onSave={async (text) => {
              if (!draft) return;
              setDraft(null);
              await writeFeedback(
                (method, params) => reviewCall("local", method, params),
                createReviewAnnotation({
                  source: "file",
                  anchor: "quote",
                  path: "notes.md",
                  section: [],
                  line: draft.line,
                  quote: draft.quote,
                  comment: text,
                }),
                {
                  workspaceId: "w1",
                  root: "/repo",
                  agent: { paneId: "w1:p1", name: "Claude" },
                },
                1,
              ).then(async (done) =>
                (await import("../review")).rememberReviewSnapshot(
                  (await reviewCall("local", "review.get", {
                    session_id: done.snapshot.session.id,
                  })) as never,
                ),
              );
            }}
          />
        </section>
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Preview />));
    await act(settle);
    const content = host.querySelector<HTMLElement>(
      ".file-preview-file-content",
    )!;
    const keys = async (...names: string[]) => {
      for (const name of names)
        await act(async () => {
          content.dispatchEvent(
            new KeyboardEvent("keydown", { key: name, bubbles: true }),
          );
          await settle();
        });
    };
    // On "A para.", c: the composer.
    await keys("j", "j", "c");
    const form = document.querySelector<HTMLFormElement>(
      ".annotation-composer-popover",
    );
    expect(form?.querySelector("blockquote")?.textContent).toBe("A para.");
    content.focus();
    const send = [...form!.querySelectorAll("button")].find(
      (button) => button.textContent === "Add comment",
    )!;
    await act(async () => {
      send.click();
      await settle();
    });
    // Written as the review pane writes: to the review with the agent,
    // held for nothing.
    const open = writes.find((each) => each.method === "review.open");
    expect(open?.params).toMatchObject({
      agent_pane: "w1:p1",
      agent: "Claude",
      target: { kind: "rendered" },
    });
    const add = writes.find((each) => each.method === "review.thread.add");
    expect(add?.params).toMatchObject({ kind: "discussion", text: "Say why." });
    expect(add?.params.held).toBeUndefined();
    // The composer gone, the focus is still the preview's, nowhere else.
    expect(document.querySelector(".annotation-composer-popover")).toBeNull();
    expect(document.activeElement).toBe(content);
    // The comment is a thread of this view: under its block, and in its
    // Comments panel; nothing waits in Review feedback.
    const card = host.querySelector(".md-thread-slot .chat-thread");
    expect(card?.textContent).toContain("Say why.");
    expect(card?.textContent).not.toContain("Review feedback");
    expect(
      host.querySelector(".file-preview-threads .threads-panel-item")
        ?.textContent,
    ).toContain("Say why.");
    await act(async () => root.unmount());
    host.remove();
  });

  test("a thread shows its quote where it is: in its cell's column, highlighted", async () => {
    const { act, useMemo, useState } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const {
      CELL_CARD_MIN_WIDTH,
      fileThreadOrder,
      SlotThreads,
      useFileThreads,
      useFileThreadView,
      useMarkedBlocks,
      useQuoteHighlights,
    } = await import("./FileThreads");
    const { MarkdownPreview } = await import("./markdown");
    // The table's columns as a browser draws them: the first too narrow
    // for a card, the second wide enough.
    expect(120).toBeLessThan(CELL_CARD_MIN_WIDTH);
    expect(300).toBeGreaterThanOrEqual(CELL_CARD_MIN_WIDTH);
    const proto = browser.HTMLElement.prototype;
    const box = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: HTMLElement) {
      const column = /^b:\d+:(\d+)$/.exec(this.dataset?.stop ?? "")?.[1];
      if (column === undefined) return box.call(this);
      const [left, width] = column === "0" ? [0, 120] : [120, 300];
      return {
        left,
        width,
        right: left + width,
        top: 0,
        bottom: 20,
        height: 20,
        x: left,
        y: 0,
        toJSON: () => ({}),
      } as never;
    } as never;
    class FakeHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    const highlights = new Map<string, FakeHighlight>();
    Object.assign(globalThis.CSS, { highlights });
    Object.defineProperty(globalThis, "Highlight", {
      value: FakeHighlight,
      configurable: true,
      writable: true,
    });
    function Preview() {
      const api = useFileThreads("local", { absolute: "/repo/places.md" });
      const [element, setElement] = useState<HTMLDivElement | null>(null);
      const view = useFileThreadView(() => element);
      const byId = useMemo(
        () => new Map(api.threads.map((each) => [each.id, each])),
        [api.threads],
      );
      useMarkedBlocks(element, view.cursor);
      useQuoteHighlights(element, byId, placesText);
      return (
        <section className="file-preview">
          <div ref={setElement} className="file-preview-file-content">
            <MarkdownPreview
              text={placesText}
              threadsFor={(stops, stopOf, where) => (
                <SlotThreads
                  stops={stops}
                  stopOf={stopOf}
                  where={where}
                  threads={api.threads}
                  api={api}
                  view={view}
                />
              )}
            />
          </div>
        </section>
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Preview />));
      await act(settle);
      const stop = (key: string) =>
        host.querySelector<HTMLElement>(`[data-stop="${key}"]`)!;
      const group = (id: string) =>
        host
          .querySelector(`.chat-thread[data-thread-id="${id}"]`)
          ?.closest<HTMLElement>("[data-for-stop]");

      // Each on its cell, the partial quote too; the bar on those cells.
      expect(group("p1")?.dataset.forStop).toBe("b:5:0");
      expect(group("p2")?.dataset.forStop).toBe("b:6:0");
      expect(group("p3")?.dataset.forStop).toBe("b:6:1");
      expect(stop("b:6:0").classList.contains("has-notes")).toBe(true);
      expect(stop("b:6:1").classList.contains("has-notes")).toBe(true);

      // Under the row, in the row's columns as drawn: the wide column's
      // thread in it, the narrow one's under the row from its column,
      // pointing at its middle; by column, not as written.
      const grid = group("p2")?.parentElement;
      expect(grid?.classList.contains("md-thread-grid")).toBe(true);
      expect(grid?.style.gridTemplateColumns).toBe("120px 300px");
      expect(
        [...(grid?.children ?? [])].map(
          (each) => (each as HTMLElement).dataset.forStop,
        ),
      ).toEqual(["b:6:0", "b:6:1"]);
      expect(group("p3")?.style.gridColumn).toBe("2 / 3");
      expect(group("p3")?.classList.contains("is-under-row")).toBe(false);
      expect(group("p2")?.style.gridColumn).toBe("1 / 3");
      expect(group("p2")?.classList.contains("is-under-row")).toBe(true);
      expect(group("p2")?.style.getPropertyValue("--md-thread-pointer")).toBe(
        "60px",
      );

      // n / N go the same way: by line, then by column and quote.
      expect(
        fileThreadOrder(placesReview.threads as never, placesText).map(
          (each) => each.id,
        ),
      ).toEqual(["p1", "p2", "p3", "p6", "p5", "p4", "p7", "p8"]);

      // The open threads' quotes highlighted where they are; not the
      // resolved one's.
      const ranges = highlights.get("roamgate-quote")?.ranges ?? [];
      expect(ranges.map((range) => range.toString()).sort()).toEqual(
        [
          "0.7.0–0.8.2 (protocols 14–20)",
          ".0 and 0.9.4 (protocol",
          "Endpoint terminal mode (recommended)",
          "the cache",
          "the cache",
          "bun install then",
          "bun install then restart",
        ].sort(),
      );
      // Within its cell, not its row's other.
      const partial = ranges.find(
        (range) => range.toString() === ".0 and 0.9.4 (protocol",
      )!;
      expect(stop("b:6:0").contains(partial.startContainer)).toBe(true);
      // Said twice in the paragraph: each where the line it was written on
      // says it.
      const paragraph = stop("b:9").textContent ?? "";
      expect(
        ranges
          .filter((range) => range.toString() === "the cache")
          .map((range) => range.startOffset)
          .sort((a, b) => a - b),
      ).toEqual([
        paragraph.indexOf("the cache"),
        paragraph.lastIndexOf("the cache"),
      ]);
      // Across inline code, written with or without its backticks.
      for (const quote of ["bun install then", "bun install then restart"]) {
        const range = ranges.find((each) => each.toString() === quote)!;
        expect(range.startContainer.parentElement?.tagName).toBe("CODE");
        expect(stop("b:12").contains(range.endContainer)).toBe(true);
      }

      await act(async () => root.unmount());
      // Gone with the preview.
      expect(highlights.has("roamgate-quote")).toBe(false);
    } finally {
      proto.getBoundingClientRect = box;
      host.remove();
    }
  });

  // Ported from reviewStops.dom.test.ts (the review pane's comment stops,
  // retired with it): a forge discussion's messages are stops as they are.
  test("a forge discussion's message is one stop, never cut in parts as yours are", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { MrThreadCard } = await import("./MrThreadCard");
    const forge = {
      ...thread("m1", 3, false),
      kind: "merge-request",
      comments: [
        {
          ...comment("m1c", "First paragraph.\n\nSecond paragraph."),
          author: "reviewer",
        },
        { ...comment("m1d", "An answer."), author: "you" },
      ],
    } as unknown as import("../../../shared/review").ReviewThread;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <MrThreadCard
            thread={forge}
            forge="GitLab"
            onDraftReply={() => {}}
            onEditReply={() => {}}
            onDeleteReply={() => {}}
          />,
        ),
      );
      expect(host.textContent).toContain("Second paragraph.");
      expect(
        [...host.querySelectorAll<HTMLElement>("[data-chat-stop^='m:']")].map(
          (stop) => stop.dataset.chatStop,
        ),
      ).toEqual(["m:m1c", "m:m1d"]);
      // Its parts are drawn, but none is a stop: fileStops takes a part
      // only inside a message of yours (.chat-thread-body).
      expect(host.querySelectorAll("[data-part]").length).toBeGreaterThan(1);
      expect(
        host.querySelectorAll(".chat-thread-body [data-part]"),
      ).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
}
