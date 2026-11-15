/**
 * The review in Changes as a review surface for the shared behavior tests
 * (plan: review into the inspector, gate 3): Changes' diff (DiffContentView,
 * on Pierre) with the review's cursor on ("in Changes", Vim keys), mounted
 * on the review's files written as patches. It reads Pierre's drawing: the
 * line Pierre marks active is the cursor's, the lines it marks selected the
 * Visual selection's; its threads are the review's cards Changes draws,
 * fed from the classic kit's bridge as the host feeds them. What Changes
 * does not do yet (commits, the forge, ...: phases 5 to 8) throws, and the
 * tests that need it run on the classic pane only (`CHANGES_FEATURES` in
 * reviewSurfaces.testkit.ts).
 *
 * Not a test file: imported by `reviewBehavior.*.dom.test.tsx`, whose child
 * installed happy-dom (`installReviewDom`) first.
 */
import type {
  ReviewDiffFile,
  ReviewSnapshot,
  ReviewThread,
} from "../../../shared/review";
import type { GitDiffEntry, GitDiffFile } from "../types";
import {
  type BridgeUpdate,
  parseKeys,
  type ReviewSurface,
  type ShownLine,
  type ShownMessage,
  type ShownThread,
  type SurfaceOptions,
} from "./reviewSurface.testkit";

/** A line's height in Pierre's drawing, and its padding above the first. */
const LINE = 20;
const PAD = 8;
/**
 * A file's header above its lines, in the fake layout: none, so that a
 * screen of N lines shows N lines of the first file, as the tests count.
 */
const HEADER = 0;

/** The review's files as git patches. */
function patchOf(file: ReviewDiffFile): string {
  const lines = [
    `diff --git a/${file.oldPath} b/${file.path}`,
    `--- a/${file.oldPath}`,
    `+++ b/${file.path}`,
  ];
  for (const hunk of file.hunks) {
    lines.push(hunk.header);
    for (const line of hunk.lines)
      lines.push(`${line.kind === " " ? " " : line.kind}${line.text}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The globals Pierre needs that the review's DOM leaves out. */
function installPierreGlobals(): () => void {
  const browser = window as unknown as Record<string, unknown> & {
    EventTarget: typeof EventTarget;
    MessageEvent: typeof MessageEvent;
  };
  class TestWorker extends browser.EventTarget {
    // It answers its start-up only: lines are drawn as plain text (what
    // Pierre makes of the other answers is dropped, as a page would log it).
    postMessage(request: { id: string; type: string }) {
      try {
        this.dispatchEvent(
          new browser.MessageEvent("message", {
            data: {
              id: request.id,
              type: "success",
              requestType: request.type,
            },
          }),
        );
      } catch {}
    }
    terminate() {}
  }
  class TestIntersectionObserver {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target, isIntersecting: true } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  const values: Record<string, unknown> = {
    Worker: TestWorker,
    IntersectionObserver: TestIntersectionObserver,
    CSS: { escape: (value: string) => value.replace(/["\\]/g, "\\$&") },
  };
  for (const key of [
    "customElements",
    "Document",
    "DocumentFragment",
    "ShadowRoot",
    "CSSStyleSheet",
    "HTMLTemplateElement",
    "HTMLStyleElement",
    "HTMLButtonElement",
    "SVGElement",
    "MessageEvent",
    "PopStateEvent",
    "PointerEvent",
    "CustomEvent",
    "WheelEvent",
    "StorageEvent",
    "sessionStorage",
  ])
    values[key] = browser[key];
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  return () => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

let mounted = 0;

export async function mountChangesReview(
  options: SurfaceOptions,
): Promise<ReviewSurface> {
  const restoreGlobals = installPierreGlobals();
  // The bridge the classic pane's tests hold: the checkout's worktree
  // review, its reviewed marks written by review.update.
  const { backend, mockClassicBackend } = await import(
    "./reviewSurface.classic.testkit"
  );
  mockClassicBackend();
  const { act, createElement, useState } = await import("react");
  type ReactNode = import("react").ReactNode;
  const { createRoot } = await import("react-dom/client");
  const { spyOn } = await import("bun:test");
  const { store } = await import("../store");
  const { roamgateLocalStorage } = await import("../browserStorage");
  const { DiffContentView } = await import("./DiffContentView");
  const { InspectorCommandsContext, InspectorViewContext } = await import(
    "../useInspectorCommands"
  );
  const { runInspectorCommand } = await import("../inspectorCommands");
  type CommandSet = import("../useInspectorCommands").InspectorCommandSet;

  mounted += 1;
  const connectionId = `changes-review-${mounted}`;
  const { feedbackNote } = await import("../workspaceFeedback");
  const { CommandLine } = await import("./CommandLine");
  const { inspectorCompletions, opensCommandLine } = await import(
    "../inspectorCommands"
  );
  // The browser storage it opens with, as the classic kit's.
  if (options.storage !== "keep") {
    localStorage.clear();
    for (const [key, value] of Object.entries(options.storage ?? {}))
      localStorage.setItem(key, value);
  }
  // The bridge, from a clean slate.
  backend.files = options.files;
  backend.calls = [];
  backend.answers = options.answers ?? {};
  backend.failing.clear();
  backend.connected = true;
  backend.held.clear();
  backend.holds = null;
  const sessionId = options.sessionId ?? "s1";
  let marks: Record<string, string> = { ...(options.reviewed ?? {}) };
  let applied = 0;
  let sessionFields: Record<string, unknown> = { ...(options.session ?? {}) };
  let ownThreads: ReviewThread[] = options.threads ?? [];
  const otherReviews = options.otherReviews ?? [];
  /**
   * A thread as Changes' comments are: written on the unstaged entry; one
   * on the whole review with no line.
   */
  const asFeedback = (thread: ReviewThread, session: string): ReviewThread =>
    ({
      ...thread,
      sessionId: session,
      anchor: {
        ...thread.anchor,
        feedback: thread.anchor.path
          ? JSON.stringify({
              source: "diff",
              path: thread.anchor.path,
              kind: "unstaged",
              side: thread.anchor.side ?? "new",
              line: thread.anchor.line,
              quote: "",
              hunk: "",
            })
          : "{}",
      },
    }) as ReviewThread;
  const ownSession = () => ({
    id: sessionId,
    connectionId,
    workspaceId: "workspace",
    root: "/repo",
    title: "repo",
    target: { kind: "worktree" },
    gitlab: false,
    summary: "",
    agent: {},
    createdAt: "2026-11-04T14:11:18Z",
    updatedAt: "2026-11-04T14:11:18Z",
    ...sessionFields,
    reviewed: marks,
  });
  /** What the bridge holds: this review, and the checkout's others. */
  const publishSession = () => {
    backend.sessions = new Map([
      [
        sessionId,
        {
          session: ownSession() as Record<string, unknown>,
          threads: ownThreads.map((thread) => asFeedback(thread, sessionId)),
        },
      ],
      ...otherReviews.map(
        (session) =>
          [
            String(session.id),
            {
              session: { workspaceId: "workspace", ...session } as Record<
                string,
                unknown
              >,
              threads: (options.shared ?? [])
                .filter((thread) => thread.sessionId === session.id)
                .map((thread) => asFeedback(thread, String(session.id))),
            },
          ] as const,
      ),
    ]);
  };
  publishSession();
  /** The comments the host gives Changes: every review's, as App does. */
  const feedback = () => {
    const threads = [...backend.sessions.values()].flatMap((snapshot) =>
      ((snapshot as { threads?: ReviewThread[] }).threads ?? []).filter(
        (thread) =>
          thread.held === undefined && thread.anchor.feedback !== undefined,
      ),
    );
    return { threads, annotations: threads.map(feedbackNote) };
  };
  /** A snapshot of this review read back: shown once the surface settles. */
  let remembered: ReviewSnapshot | null = null;
  backend.remember = (read) => {
    if ((read.session as { id?: string }).id === sessionId) remembered = read;
  };
  const apply = (update: BridgeUpdate) => {
    if (update.threads) ownThreads = update.threads;
    if (update.session) sessionFields = { ...sessionFields, ...update.session };
  };
  /** Each file's chunk progress as Changes reports it to its tree. */
  let progress: ReadonlyMap<
    string,
    { done: number; total: number; reviewed: boolean }
  > = new Map();
  // Side by side as the classic pane would open it: as told, else by width.
  const split = options.split ?? (options.width ?? 1024) >= 1100;
  roamgateLocalStorage.setItem("diffViewMode", split ? "split" : "unified");
  const base = store.get();
  const getSpy = spyOn(store, "get").mockImplementation(
    () =>
      ({
        ...base,
        connections: [
          {
            id: connectionId,
            label: "Local",
            source: "test",
            is_default: false,
            state: "ready",
            generation: 1,
            type: "local",
          },
        ],
      }) as ReturnType<typeof store.get>,
  );
  const notices: string[] = [];
  const notify = store.notify.bind(store);
  const notifySpy = spyOn(store, "notify").mockImplementation(((notice: {
    message: string;
  }) => {
    notices.push(notice.message);
    return notify(notice as Parameters<typeof store.notify>[0]);
  }) as typeof store.notify);

  const files = options.files;
  const entries: GitDiffEntry[] = files.map((file) => ({
    path: file.path,
    kind: "unstaged",
    status: "M",
    additions: file.hunks.reduce(
      (sum, hunk) => sum + hunk.lines.filter((l) => l.kind === "+").length,
      0,
    ),
    deletions: file.hunks.reduce(
      (sum, hunk) => sum + hunk.lines.filter((l) => l.kind === "-").length,
      0,
    ),
  }));
  const diffFiles: Record<string, GitDiffFile> = Object.fromEntries(
    files.map((file) => [
      `unstaged:${file.path}`,
      {
        workspace_id: "workspace",
        root: "/repo",
        path: file.path,
        kind: "unstaged",
        diff: patchOf(file),
        truncated: false,
      } as GitDiffFile,
    ]),
  );

  // The inspector's prompt, as WorkspaceInspectorHost runs it.
  const parts = new Map<string, CommandSet>();
  /** The inspector's `:` prompt over Changes, with its completions. */
  const PromptHost = ({ children }: { children: ReactNode }) => {
    const [open, setOpen] = useState(false);
    return (
      <InspectorViewContext.Provider value="changes">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the inspector's keys */}
        <div
          onKeyDown={(event) => {
            if (open || event.defaultPrevented || !opensCommandLine(event))
              return;
            event.preventDefault();
            setOpen(true);
          }}
        >
          {children}
          {open ? (
            <CommandLine
              kind=":"
              completions={(typed) =>
                inspectorCompletions(
                  [...parts.values()].flatMap((set) => set.commands),
                  typed,
                )
              }
              onBlur={() => setOpen(false)}
              onSubmit={(text) => {
                setOpen(false);
                registry.run(text);
              }}
              onCancel={() => setOpen(false)}
            />
          ) : null}
        </div>
      </InspectorViewContext.Provider>
    );
  };
  const registry = {
    set: (id: string, _view: string, set: CommandSet | null) => {
      if (set) parts.set(id, set);
      else parts.delete(id);
    },
    run: (input: string) => {
      const sets = [...parts.values()];
      const problem = runInspectorCommand(
        sets.flatMap((set) => set.commands),
        input,
        sets.find((set) => set.line)?.line,
      );
      if (problem) store.notify({ kind: "info", message: problem });
    },
  };

  const host = document.createElement("div");
  document.body.append(host);
  let root = createRoot(host);
  const client = {
    connectionId,
    generation: 1,
    serverRuntimeGeneration: 1,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
    call: async (method: string) => {
      throw new Error(`no backend here: ${method}`);
    },
  };
  const settleOnly = async () => {
    for (let round = 0; round < 8; round++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
  };
  /** The marks each review.update wrote, applied as the bridge does. */
  const settleAll = async () => {
    await settleOnly();
    const readBack = remembered as ReviewSnapshot | null;
    if (readBack) {
      remembered = null;
      ownThreads = readBack.threads;
      const fields = { ...(readBack.session as Record<string, unknown>) };
      delete fields.reviewed;
      sessionFields = { ...sessionFields, ...fields };
      publishSession();
      await render();
    }
    const updates = backend.calls.filter((c) => c.method === "review.update");
    if (updates.length === applied) return;
    for (const update of updates.slice(applied)) {
      const changes = (update.params.reviewed ?? {}) as Record<
        string,
        string | null
      >;
      const next = { ...marks };
      for (const [key, value] of Object.entries(changes))
        if (value === null) delete next[key];
        else next[key] = value;
      marks = next;
    }
    applied = updates.length;
    publishSession();
    await render();
  };
  const render = async () => {
    const { threads, annotations } = feedback();
    await act(async () =>
      root.render(
        createElement(
          InspectorCommandsContext.Provider,
          { value: registry },
          createElement(
            PromptHost,
            null,
            createElement(DiffContentView, {
              entry: entries[0] ?? null,
              file: entries[0]
                ? diffFiles[`unstaged:${entries[0].path}`]!
                : null,
              entries,
              files: diffFiles,
              loading: false,
              error: null,
              resourceKey: connectionId,
              connectionClient: client as never,
              annotations,
              threads,
              reviewCursor: true,
              showFileSelector: false,
              onCreateAnnotation: () => {},
              onReviewProgress: (next: typeof progress) => {
                progress = next;
              },
              ...(goTo ? { cursorGoTo: goTo } : {}),
            }),
          ),
        ),
      ),
    );
    await settleOnly();
  };
  let goTo: { path: string; at: number } | null = null;
  /** Drawn side by side now (S may have switched it since mounting). */
  const drawnSplit = () =>
    sections().some(
      (section) =>
        shadowOf(section)
          ?.querySelector("pre")
          ?.getAttribute("data-diff-type") === "split",
    ) ||
    (sections().length === 0 && split);
  const view = () => host.querySelector<HTMLElement>(".diff-content-view")!;
  const sections = () => [
    ...host.querySelectorAll<HTMLElement>("[data-diff-entry-key]"),
  ];
  const pathOf = (section: HTMLElement) =>
    (section.dataset.diffEntryKey ?? "").replace(/^unstaged:/, "");
  const shadowOf = (section: HTMLElement) =>
    section.querySelector("diffs-container")?.shadowRoot ?? null;

  /** A drawn line of Pierre's, read as the review's. */
  const shown = (element: Element, path: string): ShownLine => {
    const code = element.closest("code");
    const number = Number(element.getAttribute("data-line"));
    const type = element.getAttribute("data-line-type") ?? "";
    const old =
      code?.hasAttribute("data-deletions") || type === "change-deletion";
    const file = files.find((each) => each.path === path);
    for (const hunk of file?.hunks ?? [])
      for (const line of hunk.lines) {
        const match = old
          ? line.old === number && line.kind !== "+"
          : line.new === number && line.kind !== "-";
        if (match)
          return {
            path,
            old: line.old,
            new: line.new,
            text: line.text,
            kind: line.kind,
          };
      }
    throw new Error(`no line ${path}:${old ? "-" : "+"}${number}`);
  };
  const drawn = (selector: string, only?: string) => {
    const found: { line: ShownLine; element: Element }[] = [];
    for (const section of sections()) {
      const path = pathOf(section);
      if (only !== undefined && path !== only) continue;
      // A reviewed file folded to its header shows no line.
      if (section.querySelector<HTMLElement>(".diff-file-section-body")?.hidden)
        continue;
      for (const element of shadowOf(section)?.querySelectorAll(
        `[data-content] [data-line][data-line-type]${selector}`,
      ) ?? []) {
        // A folded reviewed chunk: its one line says so, the rest hidden.
        if (element.hasAttribute("data-chunk-folded")) {
          if (!element.hasAttribute("data-chunk-fold-head")) continue;
          const line = shown(element, path);
          found.push({
            line: {
              ...line,
              kind: "reviewed",
              text: element.getAttribute("data-chunk-fold-label") ?? "",
            },
            element,
          });
          continue;
        }
        found.push({ line: shown(element, path), element });
      }
    }
    return found;
  };
  const sameLine = (a: ShownLine, b: ShownLine) =>
    a.path === b.path && a.old === b.old && a.new === b.new;
  const unique = (lines: ShownLine[]) =>
    lines.filter(
      (line, index) =>
        lines.findIndex((other) => sameLine(other, line)) === index,
    );
  /** The review's order of its lines: unified, file by file. */
  const order = files.flatMap((file) =>
    file.hunks.flatMap((hunk) =>
      hunk.lines.map((line) => ({ ...line, path: file.path })),
    ),
  );
  const rank = (line: ShownLine) =>
    order.findIndex(
      (each) =>
        each.path === line.path &&
        each.old === line.old &&
        each.new === line.new,
    );

  /** A file's rows as Pierre lays them out: split rows side by side. */
  const fileRows = (
    file: ReviewDiffFile,
    sideBySide = drawnSplit(),
  ): ShownLine[][] => {
    const rows: ShownLine[][] = [];
    for (const hunk of file.hunks) {
      const lines = hunk.lines.map((line) => ({ ...line, path: file.path }));
      if (!sideBySide) {
        for (const line of lines) rows.push([line]);
        continue;
      }
      for (let index = 0; index < lines.length; ) {
        if (lines[index]!.kind === " ") {
          rows.push([lines[index++]!]);
          continue;
        }
        const removed: ShownLine[] = [];
        const added: ShownLine[] = [];
        while (lines[index]?.kind === "-") removed.push(lines[index++]!);
        while (lines[index]?.kind === "+") added.push(lines[index++]!);
        for (let i = 0; i < Math.max(removed.length, added.length); i++)
          rows.push([removed[i], added[i]].filter(Boolean) as ShownLine[]);
      }
    }
    return rows;
  };

  // The screen: a column of lines `viewport` tall, Pierre's line positions
  // (PAD, then LINE each) stacked file under file. Every drawn line is LINE
  // tall, as Pierre measures it (happy-dom has no layout: 0 otherwise).
  const height = (options.viewport ?? 0) * LINE;
  const fileTops: number[] = [];
  let contentHeight = 0;
  for (const file of files) {
    fileTops.push(contentHeight + HEADER);
    contentHeight += HEADER + fileRows(file).length * LINE;
  }
  const layout = {
    scroll: 0,
    rowTop: (line: ShownLine) => {
      const index = files.findIndex((file) => file.path === line.path);
      const at = fileRows(files[index]!).findIndex((row) =>
        row.some((each) => sameLine(each, line)),
      );
      return fileTops[index]! + at * LINE;
    },
  };
  const clamp = (value: number) =>
    Math.max(0, Math.min(value, Math.max(0, contentHeight - height)));
  const proto = Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  const rect = proto.getBoundingClientRect;
  const box = (at: number, size: number) =>
    ({
      top: at,
      bottom: at + size,
      left: 0,
      right: 800,
      width: 800,
      height: size,
      x: 0,
      y: at,
    }) as DOMRect;
  const scroller = () => host.querySelector<HTMLElement>(".pierre-diff-scroll");
  proto.getBoundingClientRect = function (this: Element) {
    if (
      this.hasAttribute("data-line") ||
      this.hasAttribute("data-column-number")
    )
      return box(0, LINE);
    if (options.viewport === undefined) return rect.call(this);
    if (this === scroller()) return box(0, height);
    if (
      this instanceof HTMLElement &&
      this.classList.contains("pierre-diff-surface")
    ) {
      const section = this.closest<HTMLElement>("[data-diff-entry-key]");
      const index = section ? sections().indexOf(section) : -1;
      if (index >= 0)
        return box(fileTops[index]! - PAD - layout.scroll, contentHeight);
    }
    return rect.call(this);
  };
  const restoreLayout = () => {
    proto.getBoundingClientRect = rect;
  };
  /** The scroller as tall as the screen, scrolled by the fake layout. */
  const layOutScroller = () => {
    const element = scroller();
    if (options.viewport === undefined || !element) return;
    Object.defineProperty(element, "clientHeight", {
      configurable: true,
      get: () => height,
    });
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get: () => layout.scroll,
      set: (value: number) => {
        layout.scroll = clamp(value);
      },
    });
    element.scrollTo = ((arg?: ScrollToOptions) => {
      if (arg?.top !== undefined) layout.scroll = clamp(arg.top);
    }) as typeof element.scrollTo;
  };

  await render();
  layOutScroller();

  const press = async (keys: string) => {
    for (const stroke of parseKeys(keys)) {
      const active = document.activeElement;
      const target =
        active instanceof HTMLElement && view().contains(active)
          ? active
          : view();
      if (target === view()) target.focus();
      await act(async () => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: stroke.key,
            code: stroke.code ?? "",
            ctrlKey: stroke.ctrlKey ?? false,
            altKey: stroke.altKey ?? false,
            shiftKey: stroke.shiftKey ?? false,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await settleAll();
    }
  };
  // Threads as drawn: the review's cards (ThreadCard with the review's
  // bars), under their lines and above the diff.
  const threadCards = () =>
    [
      ...host.querySelectorAll<HTMLElement>(".chat-thread[data-thread-id]"),
    ].filter(
      (card) =>
        !card.parentElement?.closest(".chat-thread") &&
        !card.closest(".threads-panel"),
    );
  const barOf = (element: Element) => element.querySelector(":scope > .rc-bar");
  const readMessage = (element: Element): ShownMessage => {
    const bar = barOf(element);
    const body = element.querySelector(".chat-thread-body");
    const copy = body?.cloneNode(true) as Element | undefined;
    for (const add of copy?.querySelectorAll(".rc-part-add") ?? [])
      add.remove();
    return {
      id: (element.getAttribute("data-chat-stop") ?? "").replace(/^m:/, ""),
      text: (copy?.textContent ?? "").trim(),
      marks: [...(bar?.querySelectorAll(".rc-kind") ?? [])].map(
        (mark) => mark.textContent ?? "",
      ),
      buttons: [...(bar?.querySelectorAll("button") ?? [])].map(
        (button) => button.textContent ?? "",
      ),
      selected: element.classList.contains("is-focused"),
      pending: !element.classList.contains("is-pending")
        ? null
        : bar?.querySelector(".rc-failed")
          ? "failed"
          : "sending",
    };
  };
  const readThread = (card: HTMLElement): ShownThread => {
    const general = card.closest(".diff-review-general") !== null;
    const id = card.dataset.threadId ?? null;
    if (card.classList.contains("is-folded"))
      return {
        id,
        general,
        folded: true,
        resolved: (
          card.querySelector(".chat-thread-mark")?.textContent ?? ""
        ).startsWith("\u2713"),
        summary: card.querySelector(".chat-thread-summary")?.textContent ?? "",
        messages: [],
        buttons: [],
        working: null,
      };
    return {
      id,
      general,
      folded: false,
      resolved: card.classList.contains("is-resolved"),
      summary: "",
      messages: [...card.querySelectorAll(":scope > .chat-thread-message")].map(
        readMessage,
      ),
      buttons: [
        ...card.querySelectorAll(":scope > .chat-thread-bar button"),
      ].map((button) => button.textContent ?? ""),
      working: null,
    };
  };
  const threadCard = (threadId: string) => {
    const card = threadCards().find(
      (each) => each.dataset.threadId === threadId,
    );
    if (!card) throw new Error(`no thread ${threadId} shown`);
    return card;
  };
  const clickOn = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleAll();
  };
  /** The view button that shows or hides every comment. */
  const commentsButton = () =>
    [...host.querySelectorAll("button")].find((button) =>
      button.getAttribute("title")?.includes("(t, :comments)"),
    );
  // The open comment editor: the review's (CodeMirror) under its line.
  const editorBox = () =>
    host.querySelector<HTMLElement>("[data-review-editor]");
  const editorView = async () => {
    const content = editorBox()?.querySelector<HTMLElement>(".cm-content");
    if (!content) return null;
    const { EditorView } = await import("@codemirror/view");
    return EditorView.findFromDOM(content);
  };
  const editorBarButtons = () => [
    ...(editorBox()?.querySelectorAll<HTMLButtonElement>(
      ".diff-review-composer-bar button",
    ) ?? []),
  ];
  const typeInto = async (input: HTMLInputElement, text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input),
        "value",
      )!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const surface: Partial<ReviewSurface> = {
    name: "changes",
    cursorLine() {
      return drawn("[data-editor-active-line]")[0]?.line ?? null;
    },
    cursorSide() {
      const found = drawn("[data-editor-active-line]")[0];
      if (!found || !surface.sideBySide!()) return null;
      if (found.line.kind === " ") return "both";
      return found.line.kind === "-" ? "old" : "new";
    },
    cursorWord() {
      const element = drawn("[data-editor-active-line]")[0]?.element;
      const value = element?.getAttribute("data-cursor-col");
      if (!value || !element) return null;
      const [start, ...word] = value.split(":");
      const at = Number(start);
      const text = word.join(":");
      return {
        start: at,
        text:
          text || (drawn("[data-editor-active-line]")[0]!.line.text[at] ?? ""),
      };
    },
    selection() {
      return unique(drawn("[data-selected-line]").map(({ line }) => line)).sort(
        (a, b) => rank(a) - rank(b),
      );
    },
    lines(path) {
      // In the review's order: side by side, row by row, the removed half
      // before the added one, an unchanged line once.
      const shown = drawn("", path).map(({ line }) => line);
      return files
        .filter((file) => path === undefined || file.path === path)
        .flatMap((file) => fileRows(file).flat())
        .flatMap((line) => {
          // As drawn: a folded chunk's line is "reviewed".
          const drawnLine = shown.find((each) => sameLine(each, line));
          return drawnLine ? [drawnLine] : [];
        });
    },
    sideBySide() {
      return sections().some(
        (section) =>
          shadowOf(section)
            ?.querySelector("pre")
            ?.getAttribute("data-diff-type") === "split",
      );
    },
    text() {
      return host.textContent ?? "";
    },
    async goToFile(path) {
      // Picked in the tree: Changes' cursor goes to it, shown.
      goTo = { path, at: Math.max(Date.now(), (goTo?.at ?? 0) + 1) };
      await render();
      await settleAll();
    },
    fileReviewed(path) {
      return progress.get(path)?.reviewed ?? false;
    },
    chunkProgress(path) {
      // As the review pane's list: a count while partly reviewed.
      const own = progress.get(path);
      return own && !own.reviewed && own.done > 0
        ? `${own.done}/${own.total}`
        : null;
    },
    reviewedMarks() {
      return { ...marks };
    },
    press,
    async command(text) {
      await act(async () => registry.run(text));
      await settleAll();
    },
    async click(line, shift = false) {
      const target = drawn("").find(
        ({ line: each }) =>
          each.path === line.path &&
          (line.new === undefined || each.new === line.new) &&
          (line.old === undefined || each.old === line.old) &&
          (line.text === undefined || each.text === line.text) &&
          (line.kind === undefined || each.kind === line.kind),
      );
      if (!target) throw new Error(`no line ${JSON.stringify(line)}`);
      const event = new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        pointerType: "mouse",
        button: 0,
        pointerId: 1,
        shiftKey: shift,
      });
      Object.defineProperty(event, "clientX", { value: Number.NaN });
      Object.defineProperty(event, "clientY", { value: Number.NaN });
      await act(async () => {
        target.element.dispatchEvent(event);
        target.element.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            composed: true,
            pointerType: "mouse",
            button: 0,
            pointerId: 1,
            shiftKey: shift,
          }),
        );
        target.element.dispatchEvent(
          Object.assign(
            new PointerEvent("click", {
              bubbles: true,
              composed: true,
              pointerType: "mouse",
              button: 0,
              shiftKey: shift,
            }),
          ),
        );
      });
      await settleAll();
    },
    async reload() {
      await act(async () => root.unmount());
      root = createRoot(host);
      await render();
      layOutScroller();
    },
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
      restoreLayout();
      getSpy.mockRestore();
      notifySpy.mockRestore();
      restoreGlobals();
    },
    screenLines() {
      if (options.viewport === undefined)
        throw new Error("no viewport: mount with one");
      const lines = unique(drawn("").map(({ line }) => line))
        .filter((line) => {
          const top = layout.rowTop(line);
          return top >= layout.scroll && top + LINE <= layout.scroll + height;
        })
        .sort(
          (a, b) => layout.rowTop(a) - layout.rowTop(b) || rank(a) - rank(b),
        );
      // Side by side, a drawn row once: its added half, else its only one.
      return lines.filter(
        (line, index) =>
          !lines.some(
            (other, at) =>
              at !== index &&
              layout.rowTop(other) === layout.rowTop(line) &&
              line.kind === "-" &&
              other.kind === "+",
          ),
      );
    },
    view() {
      return "";
    },
    editorOpen() {
      // The review's editor, else the popover (Changes not "in Changes").
      return (
        editorBox() !== null ||
        document.querySelector(".annotation-composer-popover") !== null
      );
    },
    editorText() {
      const content = editorBox()?.querySelector(".cm-content");
      return content ? (content.textContent ?? "") : null;
    },
    async writeInEditor(text) {
      // The editor loads lazily: let it come.
      for (let round = 0; round < 20 && !(await editorView()); round++)
        await settleOnly();
      const view = await editorView();
      if (!view) throw new Error("no comment editor open");
      await act(async () =>
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        }),
      );
      await settleAll();
    },
    editorButtons() {
      return editorBarButtons().map((button) => button.textContent ?? "");
    },
    async editorButton(label) {
      const button = editorBarButtons().find(
        (each) => each.textContent === label,
      );
      if (!button) throw new Error(`no editor button ${label}`);
      await act(async () => button.click());
      await settleAll();
    },

    // Threads.
    shownThreads() {
      return threadCards().map(readThread);
    },
    async threadButton(threadId, label, message) {
      const card = threadCard(threadId);
      const scope =
        message === undefined
          ? card.querySelector(":scope > .chat-thread-bar")
          : barOf(
              card.querySelectorAll(":scope > .chat-thread-message")[message]!,
            );
      const button = [
        ...(scope?.querySelectorAll<HTMLButtonElement>("button") ?? []),
      ].find((each) => each.textContent === label);
      if (!button) throw new Error(`no button ${label} on ${threadId}`);
      await act(async () => button.click());
      await settleAll();
    },
    async clickThread(threadId, message = 0) {
      const card = threadCard(threadId);
      if (card.classList.contains("is-folded")) return clickOn(card);
      const target = card.querySelectorAll(":scope > .chat-thread-message")[
        message
      ];
      if (!target) throw new Error(`no message ${message} on ${threadId}`);
      await clickOn(target);
    },
    commentsShown() {
      return !(commentsButton()?.getAttribute("aria-pressed") === "false");
    },
    commentsHidden() {
      return commentsButton()?.getAttribute("aria-pressed") === "false";
    },
    hiddenBadge() {
      const badge = commentsButton()?.querySelector(".rv-badge")?.textContent;
      return badge ? Number(badge) : null;
    },
    markedLines() {
      return unique(drawn("[data-thread-mark]").map(({ line }) => line)).sort(
        (a, b) => rank(a) - rank(b),
      );
    },
    status() {
      return host.querySelector(".changes-review-status")?.textContent ?? "";
    },
    buttons() {
      return [...host.querySelectorAll("button, a")].map(
        (element) =>
          (element.textContent ?? "").trim() ||
          element.getAttribute("aria-label") ||
          "",
      );
    },
    threadsPanel() {
      const panel = host.querySelector(".threads-panel");
      if (!panel) return null;
      const items = [...panel.querySelectorAll("[data-panel-thread]")];
      return {
        ids: items.map((item) => item.getAttribute("data-panel-thread") ?? ""),
        selected:
          items
            .find((item) => item.classList.contains("is-selected"))
            ?.getAttribute("data-panel-thread") ?? null,
        unfolded: items
          .filter(
            (item) =>
              item
                .querySelector(".threads-panel-summary")
                ?.getAttribute("aria-expanded") === "true",
          )
          .map((item) => item.getAttribute("data-panel-thread") ?? ""),
        searching:
          document.activeElement !== null &&
          panel.contains(document.activeElement) &&
          document.activeElement instanceof HTMLInputElement,
        text: panel.textContent ?? "",
      };
    },
    threadsChip() {
      return host.querySelector(".threads-chip")?.textContent ?? null;
    },
    async clickThreadsChip() {
      const chip = host.querySelector<HTMLButtonElement>(".threads-chip");
      if (!chip) throw new Error("no comments chip");
      await act(async () => chip.click());
      await settleAll();
    },
    unresolvedNav() {
      const nav = host.querySelector('[aria-label="Unresolved threads"]');
      if (!nav) return null;
      return {
        label: nav.querySelector('[aria-live="polite"]')?.textContent ?? "",
        disabled:
          nav.querySelector<HTMLButtonElement>(
            'button[aria-label="Next unresolved thread"]',
          )?.disabled === true,
      };
    },
    async unresolvedStep(which) {
      const label =
        which === "next"
          ? "Next unresolved thread"
          : which === "previous"
            ? "Previous unresolved thread"
            : "Unresolved only";
      const button = host.querySelector<HTMLButtonElement>(
        `[aria-label="Unresolved threads"] button[aria-label="${label}"]`,
      );
      if (!button) throw new Error(`no ${label} button`);
      await act(async () => button.click());
      await settleAll();
    },

    // The bridge: the classic kit's, this review in it.
    calls(method) {
      return backend.calls
        .filter((call) => method === undefined || call.method === method)
        .map((call) => ({ ...call }));
    },
    async push(update) {
      apply(update);
      publishSession();
      await render();
      await settleAll();
    },
    bridgeHolds(next) {
      backend.holds = () => {
        const update = typeof next === "function" ? next() : next;
        const session = { ...ownSession(), ...(update.session ?? {}) };
        delete (session as { reviewed?: unknown }).reviewed;
        return {
          session,
          threads: update.threads ?? ownThreads,
        } as unknown as ReviewSnapshot;
      };
    },
    failBridge(methods, error = "not connected to bridge") {
      backend.failing.clear();
      for (const method of methods) backend.failing.set(method, error);
    },
    holdBridge(method) {
      let release: (failure?: string) => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = (failure) => {
          backend.held.delete(method);
          if (failure !== undefined) backend.failing.set(method, failure);
          resolve();
        };
      });
      backend.held.set(method, waiting);
      return {
        async release(failure) {
          await act(async () => {
            release(failure);
            await settleOnly();
          });
          backend.failing.delete(method);
          await settleAll();
        },
      };
    },
    async typeCommand(text) {
      await press(":");
      const input = host.querySelector<HTMLInputElement>(
        'input[aria-label="Command"]',
      );
      if (!input) throw new Error("no command prompt");
      await act(async () => input.focus());
      await typeInto(input, text.replace(/^:/, ""));
      await settleAll();
    },
    prompt() {
      const line = host.querySelector(".review-cmdline");
      const input = line?.querySelector("input");
      if (!line || !input) return null;
      return {
        kind: (line.firstChild?.textContent ?? "").trim(),
        text: input.value,
        completions: [...line.querySelectorAll(".wild-item")].map((item) => ({
          name: item.firstChild?.textContent ?? "",
          description: (item.querySelector(".note")?.textContent ?? "").trim(),
          on: item.classList.contains("on"),
        })),
      };
    },
    notice() {
      return notices[notices.length - 1] ?? null;
    },
    notices() {
      return [...notices];
    },
    async search(pattern) {
      await press("/");
      const input = view().querySelector<HTMLInputElement>(
        'input[aria-label="Search"]',
      );
      if (!input) throw new Error("no search prompt");
      await act(async () => input.focus());
      await typeInto(input, pattern);
      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await settleAll();
    },
    searchLine() {
      const line = view().querySelector(".diff-cursor-status");
      const text = line?.textContent ?? null;
      return text?.startsWith("-- VISUAL") ? null : text;
    },
    filesMatching() {
      return sections()
        .filter((section) => section.classList.contains("is-cursor-search-hit"))
        .map(pathOf);
    },
  };
  return new Proxy(surface as ReviewSurface, {
    get(target, key) {
      const value = Reflect.get(target, key);
      // Not a promise: `await mount()` must not take it for one.
      if (value !== undefined || typeof key !== "string" || key === "then")
        return value;
      return () => {
        throw new Error(`${key} is not in Changes yet`);
      };
    },
  });
}
