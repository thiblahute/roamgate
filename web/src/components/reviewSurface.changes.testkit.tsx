/**
 * The review in Changes as a review surface for the shared behavior tests
 * (plan: review into the inspector, gate 3): Changes' diff (DiffContentView,
 * on Pierre) with the review's cursor on ("in Changes", Vim keys), mounted
 * on the review's files written as patches. It reads Pierre's drawing: the
 * line Pierre marks active is the cursor's, the lines it marks selected the
 * Visual selection's. What Changes does not do yet (threads, reviewed
 * marks, commits, ...: phases 4 to 8) throws, and the tests that need it
 * run on the classic pane only (`needs` in reviewSurfaces.testkit.ts).
 *
 * Not a test file: imported by `reviewBehavior.*.dom.test.tsx`, whose child
 * installed happy-dom (`installReviewDom`) first.
 */
import type { ReviewDiffFile } from "../../../shared/review";
import type { GitDiffEntry, GitDiffFile } from "../types";
import {
  parseKeys,
  type ReviewSurface,
  type ShownLine,
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
  const { act, createElement } = await import("react");
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
  const settleAll = async () => {
    for (let round = 0; round < 8; round++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
  };
  const render = async () => {
    await act(async () =>
      root.render(
        createElement(
          InspectorCommandsContext.Provider,
          { value: registry },
          createElement(
            InspectorViewContext.Provider,
            { value: "changes" },
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
              annotations: [],
              reviewCursor: true,
              showFileSelector: false,
            }),
          ),
        ),
      ),
    );
    await settleAll();
  };
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
      for (const element of shadowOf(section)?.querySelectorAll(
        `[data-content] [data-line][data-line-type]${selector}`,
      ) ?? [])
        found.push({ line: shown(element, path), element });
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
        .filter((line) => shown.some((each) => sameLine(each, line)));
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
          (line.text === undefined || each.text === line.text),
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
      // Changes' comment box (the popover until the review's editor comes).
      return document.querySelector(".annotation-composer-popover") !== null;
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
