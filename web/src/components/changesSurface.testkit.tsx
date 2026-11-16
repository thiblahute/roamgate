/**
 * Behavior-level test kit for the inspector's Changes (plan: review into
 * the inspector, gate 3): it mounts Changes' tree (DiffViewerPanel) on an
 * in-memory connection and answers what a user sees: the tree's rows, the
 * scope picked, the file selected, the menu opened, the confirmation shown.
 * Tests read Changes only through it, so they keep running when Changes
 * moves onto the shared Pierre surface.
 *
 * Not a test file: imported by `*.behavior.dom.test.ts(x)` children, after
 * `installChangesDom()` has put a happy-dom window in place.
 */
import type { ConnectionClient } from "../api";
import type { GitDiffEntry, GitDiffFile, GitDiffKind } from "../types";
import type {
  ActiveDiffSelection,
  DiffViewerPanelHandle,
} from "./DiffViewerPanel";

export type ChangesScope = "working" | "branch-main" | "last-step";

/** The scope buttons' names. */
export const SCOPE_LABEL: Record<ChangesScope, string> = {
  "last-step": "Last step",
  working: "Working tree",
  "branch-main": "Against branch",
};

type Call = { method: string; params: Record<string, unknown> };

export type ChangesOptions = {
  /** Each scope's changed files. */
  entries: Partial<Record<ChangesScope, GitDiffEntry[]>>;
  /** A file's patch by `${kind}:${path}` (default: a one-line patch). */
  patches?: Record<string, string>;
  /** Scopes whose baseline is missing (no step yet, no base branch). */
  noBaseline?: ChangesScope[];
  connectionId?: string;
  workspaceId?: string;
  /** The scope remembered from an earlier visit (default: none, Working). */
  scope?: ChangesScope;
  /** "ssh" for the click-to-load mode. */
  connectionType?: "local" | "ssh";
  /** The host can reveal files (a desktop's file manager). */
  canReveal?: boolean;
  /** Files' "Open file", when the inspector gives one. */
  onOpenFile?: (entry: GitDiffEntry) => void;
  /** The inspector's `:` prompt, given the tree's commands as Changes'. */
  inspectorCommands?: import("../useInspectorCommands").InspectorCommandRegistry;
  /** The base Automatic resolves (default: refs/heads/main). */
  automaticBase?: string;
  /** The working changes in status groups (the review in Changes). */
  groupByStatus?: boolean;
};

/** One row of the changed-files tree, as a user reads it. */
export type TreeRow = {
  name: string;
  folder: boolean;
  /** Status badges, e.g. ["M", "U"]. */
  badges: string[];
  selected: boolean;
};

export type MenuGroup = {
  label: string;
  items: { label: string; disabled: boolean; detail: string }[];
};

export interface ChangesTree {
  /** Every call Changes made to the connection, in order. */
  readonly calls: Call[];
  /** The `mode` of every `git.diff_summary` call, in order. */
  summaryModes(): string[];
  /** The scope shown as picked. */
  scope(): ChangesScope | null;
  /** The Branch scope's toggle and Compare against, as they read. */
  branchBase(): { scope: string; compare: string };
  pickScope(scope: ChangesScope): Promise<void>;
  rows(): TreeRow[];
  clickRow(name: string): Promise<void>;
  /** What Changes hands its diff view: the selected file and its patches. */
  selection(): ActiveDiffSelection | null;
  /** Every selection Changes handed its diff view, in order. */
  selections(): ActiveDiffSelection[];
  refresh(): Promise<void>;
  /** The empty state's text, or null when files are listed. */
  emptyText(): string | null;
  /** Placeholder rows while the first summary loads. */
  skeleton(): boolean;
  /**
   * Open a row's menu: right click, the ContextMenu key, or a touch held
   * down ("longpress" only presses: the caller moves the fake clock).
   */
  openMenu(
    name: string,
    how?: "contextmenu" | "keyboard" | "longpress",
  ): Promise<void>;
  /** The menu shown, by group, or null. */
  menu(): MenuGroup[] | null;
  /** Pick a menu item by its label (its trailing ellipsis optional). */
  chooseMenuItem(label: string): Promise<void>;
  /** Escape out of the menu. */
  closeMenu(): Promise<void>;
  /** The confirmation asked, or null. */
  confirmation(): { title: string; message: string } | null;
  confirm(): Promise<void>;
  /** Changes' handle, as the inspector and Files call it. */
  handle(): DiffViewerPanelHandle;
  /** Unmount and mount again, as a page reload or an inspector remount. */
  remount(): Promise<void>;
  /** Let pending calls answer and React settle. */
  settle(): Promise<void>;
  unmount(): Promise<void>;
}

export function entry(
  path: string,
  kind: GitDiffKind = "unstaged",
  status = "M",
  extra: Partial<GitDiffEntry> = {},
): GitDiffEntry {
  return { path, kind, status, additions: 1, deletions: 1, ...extra };
}

/** Install a happy-dom window as the global DOM; returns a restore. */
export async function installChangesDom(url = "http://localhost/") {
  const { Window } = await import("happy-dom");
  const browser = new Window({ url, width: 1280, height: 800 });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    customElements: browser.customElements,
    Document: browser.Document,
    DocumentFragment: browser.DocumentFragment,
    ShadowRoot: browser.ShadowRoot,
    CSSStyleSheet: browser.CSSStyleSheet,
    HTMLTemplateElement: browser.HTMLTemplateElement,
    HTMLStyleElement: browser.HTMLStyleElement,
    SVGElement: browser.SVGElement,
    Text: browser.Text,
    DOMParser: browser.DOMParser,
    MessageEvent: browser.MessageEvent,
    PopStateEvent: browser.PopStateEvent,
    Range: browser.Range,
    getSelection: browser.getSelection.bind(browser),
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    CSS: { escape: (value: string) => value.replace(/["\\]/g, "\\$&") },
    WheelEvent: browser.WheelEvent,
    StorageEvent: browser.StorageEvent,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    Element: browser.Element,
    Node: browser.Node,
    NodeFilter: browser.NodeFilter,
    Event: browser.Event,
    KeyboardEvent: browser.KeyboardEvent,
    MouseEvent: browser.MouseEvent,
    PointerEvent: browser.PointerEvent,
    CustomEvent: browser.CustomEvent,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  // Pierre highlights in a worker: one that answers its start-up only, so
  // lines are drawn as plain text.
  class TestWorker extends browser.EventTarget {
    postMessage(request: { id: string; type: string }) {
      this.dispatchEvent(
        new browser.MessageEvent("message", {
          data: { id: request.id, type: "success", requestType: request.type },
        }),
      );
    }
    terminate() {}
  }
  // Every file section counts as on screen (no layout here).
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
  for (const [key, value] of Object.entries({
    Worker: TestWorker,
    IntersectionObserver: TestIntersectionObserver,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  return {
    browser,
    async restore() {
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

const PATCH = "@@ -1 +1 @@\n-old\n+new\n";

let mounted = 0;

/** Mount Changes' tree on an in-memory connection. */
export async function mountChangesTree(
  options: ChangesOptions,
): Promise<ChangesTree> {
  const { act, createElement, createRef } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { spyOn } = await import("bun:test");
  const { bridge } = await import("../api");
  const { store } = await import("../store");
  const { DiffViewerPanel } = await import("./DiffViewerPanel");
  const { InspectorCommandsContext, InspectorViewContext } = await import(
    "../useInspectorCommands"
  );

  mounted += 1;
  const connectionId = options.connectionId ?? `changes-kit-${mounted}`;
  const workspaceId = options.workspaceId ?? "workspace";
  if (options.scope) {
    const { roamgateLocalStorage } = await import("../browserStorage");
    const { connectionStorageKey } = await import("../connectionStorage");
    roamgateLocalStorage.setItem(
      connectionStorageKey(connectionId, `diffViewerScope:${workspaceId}`),
      options.scope,
    );
  }
  const calls: Call[] = [];
  const baselineMissing = new Set(options.noBaseline ?? []);
  const client: ConnectionClient = {
    connectionId,
    generation: 1,
    serverRuntimeGeneration: 1,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
    call: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === "git.diff_summary") {
        const mode = String(params.mode ?? "working") as ChangesScope;
        const listed = (options.entries[mode] ?? []).map((each) => ({
          ...each,
        }));
        return {
          workspace_id: workspaceId,
          root: "/repo",
          mode,
          ...(mode === "branch-main"
            ? {
                base:
                  params.base_branch ??
                  options.automaticBase ??
                  "refs/heads/main",
                base_branches: ["refs/heads/main", "refs/heads/develop"],
              }
            : {}),
          ...(mode === "last-step" ? { snapshot_id: "step-1" } : {}),
          ...(baselineMissing.has(mode) ? { baseline_available: false } : {}),
          entries: listed,
          counts: {
            staged: listed.filter((each) => each.kind === "staged").length,
            unstaged: listed.filter((each) => each.kind === "unstaged").length,
            untracked: listed.filter((each) => each.kind === "untracked")
              .length,
            conflicted: listed.filter((each) => each.kind === "conflicted")
              .length,
            branch: 0,
            "last-step": 0,
          },
        };
      }
      if (method === "git.diff_file") {
        const kind = String(params.kind);
        const path = String(params.path);
        return {
          workspace_id: workspaceId,
          root: "/repo",
          path,
          kind: kind as GitDiffKind,
          diff: options.patches?.[`${kind}:${path}`] ?? PATCH,
          truncated: false,
        } satisfies GitDiffFile as GitDiffFile;
      }
      return {};
    },
  };
  const snapshot: ReturnType<typeof store.get> = {
    ...store.get(),
    activeConnectionId: connectionId,
    status: "connected",
    connections: [
      {
        id: connectionId,
        label: "Test",
        source: "test",
        is_default: false,
        state: "ready",
        generation: 1,
        type: options.connectionType ?? "local",
      },
    ],
    workspaces: [
      {
        workspace_id: workspaceId,
        number: 1,
        label: "Repo",
        focused: true,
        pane_count: 0,
        tab_count: 0,
        agent_status: "",
      },
    ],
  } as ReturnType<typeof store.get>;
  const spies = [
    spyOn(store, "get").mockImplementation(() => snapshot),
    spyOn(bridge, "connection").mockImplementation(() => client),
  ];
  if (options.canReveal) {
    const hello = Object.getOwnPropertyDescriptor(bridge, "hello");
    Object.defineProperty(bridge, "hello", {
      configurable: true,
      get: () => ({ capabilities: { file_reveal: true } }),
    });
    spies.push({
      mockRestore: () => {
        if (hello) Object.defineProperty(bridge, "hello", hello);
        else Reflect.deleteProperty(bridge, "hello");
      },
    } as (typeof spies)[number]);
  }

  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  const ref = createRef<DiffViewerPanelHandle>();
  let selection: ActiveDiffSelection | null = null;
  const selections: ActiveDiffSelection[] = [];
  const panel = () =>
    createElement(DiffViewerPanel, {
      ref,
      workspaceId,
      resourceKey: workspaceId,
      ...(options.groupByStatus ? { groupByStatus: true } : {}),
      onSelectionChange: (next: ActiveDiffSelection) => {
        selection = next;
        selections.push(next);
      },
      ...(options.onOpenFile ? { onOpenFile: options.onOpenFile } : {}),
    });
  const render = () =>
    act(async () =>
      root.render(
        options.inspectorCommands
          ? createElement(
              InspectorCommandsContext.Provider,
              { value: options.inspectorCommands },
              createElement(
                InspectorViewContext.Provider,
                { value: "changes" },
                panel(),
              ),
            )
          : panel(),
      ),
    );
  const settle = async () => {
    for (let round = 0; round < 6; round += 1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
  };
  await render();
  await settle();

  const rowElements = () => [
    ...container.querySelectorAll<HTMLButtonElement>(".diff-tree-row"),
  ];
  const rowNamed = (name: string) => {
    const row = rowElements().find(
      (element) =>
        element.querySelector(".diff-tree-name")?.textContent === name,
    );
    if (!row) throw new Error(`no row ${name}`);
    return row;
  };
  const menuElement = () => document.querySelector<HTMLElement>("[role=menu]");
  const dialog = () =>
    [...document.querySelectorAll<HTMLElement>("[role=dialog]")].find(
      (element) => element.textContent,
    ) ?? null;

  const tree: ChangesTree = {
    calls,
    summaryModes: () =>
      calls
        .filter((call) => call.method === "git.diff_summary")
        .map((call) => String(call.params.mode)),
    scope() {
      const pressed = container.querySelector(
        '.diff-scope-toggle button[aria-pressed="true"]',
      );
      const label = pressed?.getAttribute("aria-label") ?? "";
      if (label === "Last step") return "last-step";
      if (label === "Working tree") return "working";
      if (label.startsWith("Against")) return "branch-main";
      return null;
    },
    branchBase: () => ({
      scope:
        [...container.querySelectorAll(".diff-scope-toggle button")]
          .map((button) => button.getAttribute("aria-label") ?? "")
          .find((label) => label.startsWith("Against")) ?? "",
      compare:
        container
          .querySelector('.diff-base-selector [aria-label="Comparison branch"]')
          ?.textContent?.trim() ?? "",
    }),
    async pickScope(scope) {
      const buttons = [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".diff-scope-toggle button",
        ),
      ];
      const button = buttons.find((each) => {
        const label = each.getAttribute("aria-label") ?? "";
        return scope === "branch-main"
          ? label.startsWith("Against")
          : label === SCOPE_LABEL[scope];
      });
      if (!button) throw new Error(`no scope ${scope}`);
      await act(async () => button.click());
      await settle();
    },
    rows: () =>
      rowElements().map((row) => ({
        name: row.querySelector(".diff-tree-name")?.textContent ?? "",
        folder: row.classList.contains("diff-tree-folder"),
        badges: [...row.querySelectorAll(".diff-tree-badges [role=img]")].map(
          (badge) => badge.textContent ?? "",
        ),
        selected: row.getAttribute("aria-current") === "true",
      })),
    async clickRow(name) {
      const row = rowNamed(name);
      await act(async () => row.click());
      await settle();
    },
    selection: () => selection,
    selections: () => [...selections],
    async refresh() {
      const button = container.querySelector<HTMLButtonElement>(
        '[aria-label="Refresh changes"]',
      );
      if (!button) throw new Error("no Refresh (still refreshing?)");
      await act(async () => button.click());
      await settle();
    },
    emptyText: () =>
      container.querySelector(".diff-tree .diff-empty")?.textContent ?? null,
    skeleton: () => container.querySelector(".diff-skeleton-list") !== null,
    async openMenu(name, how = "contextmenu") {
      const row = rowNamed(name);
      if (how === "contextmenu")
        await act(async () => {
          row.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: 10,
              clientY: 10,
            }),
          );
        });
      else if (how === "keyboard")
        await act(async () => {
          row.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "ContextMenu",
              bubbles: true,
              cancelable: true,
            }),
          );
        });
      else {
        // A touch held down: the menu opens once the press lasts. The
        // caller moves the (fake) clock; nothing is awaited here.
        act(() => {
          row.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              pointerType: "touch",
              clientX: 10,
              clientY: 10,
            }),
          );
        });
        return;
      }
      await settle();
    },
    menu() {
      const menu = menuElement();
      if (!menu) return null;
      return [...menu.querySelectorAll(".context-menu-group")].map((group) => ({
        label:
          group.querySelector(".context-menu-group-title")?.textContent ?? "",
        items: [
          ...group.querySelectorAll<HTMLButtonElement>("[role=menuitem]"),
        ].map((item) => ({
          label:
            item.querySelector(".context-menu-item-label")?.textContent ?? "",
          disabled: item.disabled,
          detail:
            item.querySelector(".context-menu-item-detail")?.textContent ?? "",
        })),
      }));
    },
    async chooseMenuItem(label) {
      const item = [
        ...(menuElement()?.querySelectorAll<HTMLButtonElement>(
          "[role=menuitem]",
        ) ?? []),
      ].find((each) => {
        const shown =
          each.querySelector(".context-menu-item-label")?.textContent ?? "";
        // A label that asks first ends with an ellipsis.
        return shown === label || shown === `${label}\u2026`;
      });
      if (!item) throw new Error(`no menu item ${label}`);
      await act(async () => item.click());
      await settle();
    },
    async closeMenu() {
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
        );
      });
      await settle();
    },
    confirmation() {
      const shown = dialog();
      if (!shown) return null;
      return {
        title: shown.querySelector("h2, h3, .modal-title")?.textContent ?? "",
        message: shown.querySelector("p")?.textContent ?? "",
      };
    },
    async confirm() {
      const shown = dialog();
      const button = [
        ...(shown?.querySelectorAll<HTMLButtonElement>("button") ?? []),
      ].find((each) => each.classList.contains("danger"));
      if (!button) throw new Error("no confirmation to accept");
      await act(async () => button.click());
      await settle();
    },
    handle() {
      if (!ref.current) throw new Error("Changes is not mounted");
      return ref.current;
    },
    async remount() {
      await act(async () => root.unmount());
      root = createRoot(container);
      selection = null;
      await render();
      await settle();
    },
    settle,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      for (const spy of spies) spy.mockRestore();
    },
  };
  return tree;
}

/** A drawn line of a file section's diff. */
export type DiffLine = {
  side: "old" | "new";
  number: number;
  text: string;
  /** "context", "change-addition" or "change-deletion". */
  type: string;
};

export type ChangesDiffOptions = {
  entries: GitDiffEntry[];
  /** Patches by `${kind}:${path}`. */
  patches: Record<string, string>;
  /** The selected entry (default: the first). */
  entry?: GitDiffEntry;
  /** Bumped by each pick in the tree (DiffViewerPanel's selection). */
  selectionRevision?: number;
  mobile?: boolean;
  embedded?: boolean;
  annotations?: readonly import("../annotations").ReviewAnnotation[];
  threads?: readonly import("../../../shared/review").ReviewThread[];
  /** The repository shown (default: none named, every comment drawn). */
  repo?: import("../changesRepo").ShownRepo;
  /** Commenting is on when given (Changes); off without (Commits). */
  onCreateAnnotation?: (
    note: import("../annotations").NewReviewAnnotation,
  ) => void;
  backAction?: { label: string; onClick: () => void };
  /** A kept comment opened from under its line. */
  onEditAnnotation?: (id: string) => void;
  /** The inspector's `:` prompt, given the diff's commands as Changes'. */
  inspectorCommands?: import("../useInspectorCommands").InspectorCommandRegistry;
  /** The review's Vim cursor ("in Changes", Vim keys on). */
  reviewCursor?: boolean;
  /** Files' Review on "in Changes": the cursor to that file and line. */
  cursorGoTo?: { path: string; line?: number; at: number } | null;
  /** The connection's id (default: one of its own per mount). */
  connectionId?: string;
  /** A git action on a file (`gs`, `:stage`). */
  onGitAction?: (
    action: import("../gitActions").GitFileAction,
    path: string,
  ) => boolean;
};

export interface ChangesDiff {
  /** The file sections shown, in order. */
  sections(): { key: string; path: string; badge: string }[];
  /** The lines a section draws (both sides of a split view). */
  lines(key: string): DiffLine[];
  /**
   * Drag over line numbers, from one line to another (the same line for
   * a click), as a mouse does.
   */
  select(
    key: string,
    from: { side: "old" | "new"; line: number },
    to?: { side: "old" | "new"; line: number },
  ): Promise<void>;
  /** The comment composer shown, or null. */
  composer(): { title: string; quote: string } | null;
  /** Type into the composer's box. */
  write(text: string): Promise<void>;
  /** Press the composer's Add comment. */
  save(): Promise<void>;
  /** What is drawn under a section's lines: comments and threads. */
  comments(key: string): string[];
  /** Open a comment drawn under a line, by its text. */
  openComment(key: string, text: string): Promise<void>;
  /** How a section's diff is drawn: side by side or in one column. */
  diffStyle(key: string): "split" | "unified" | null;
  /** The Wrap toggle's state, or null without one. */
  wrap(): boolean | null;
  toggleWrap(): Promise<void>;
  /** The on-screen Back button's label, or null. */
  backButton(): string | null;
  pressBack(): Promise<void>;
  /** The raw patch shown in place of the diff, or null. */
  rawPatch(key: string): string | null;
  /** The colors a section's diff is drawn with. */
  theme(key: string): "dark" | "light" | null;
  /** Draw again with other options (the same view, not a remount). */
  update(next: Partial<ChangesDiffOptions>): Promise<void>;
  remount(): Promise<void>;
  settle(): Promise<void>;
  unmount(): Promise<void>;
}

/**
 * Drag over the line numbers of a diff file section (any view drawing
 * Changes' diff: Changes, Commits, Files' changes), from one line to
 * another, as a mouse does.
 */
export async function selectDiffLines(
  section: Element,
  from: { side: "old" | "new"; line: number },
  to: { side: "old" | "new"; line: number } = from,
) {
  const { act } = await import("react");
  const root = section.querySelector("diffs-container")?.shadowRoot;
  const cell = ({ side, line }: { side: "old" | "new"; line: number }) => {
    const code =
      root?.querySelector(
        side === "old" ? "code[data-deletions]" : "code[data-additions]",
      ) ?? root?.querySelector("code[data-unified]");
    const found = code?.querySelector(
      `[data-gutter] [data-column-number="${line}"]`,
    );
    if (!found) throw new Error(`no ${side} line ${line}`);
    return found;
  };
  const pointer = (type: string, target: Element) => {
    const event = new PointerEvent(type, {
      bubbles: true,
      composed: true,
      pointerType: "mouse",
      button: 0,
      pointerId: 1,
    });
    // No layout: Pierre then finds the line from the event's path.
    Object.defineProperty(event, "clientX", { value: Number.NaN });
    Object.defineProperty(event, "clientY", { value: Number.NaN });
    target.dispatchEvent(event);
  };
  const start = cell(from);
  const end = cell(to);
  await act(async () => pointer("pointerdown", start));
  await act(async () => pointer("pointermove", end));
  await act(async () => pointer("pointerup", end));
}

/** The comment composer shown anywhere on the page, or null. */
export function shownComposer() {
  // The review's comment editor, under its line ("in Changes").
  const box = document.querySelector<HTMLElement>(".diff-review-composer");
  if (box)
    return {
      title:
        box.closest<HTMLElement>("[data-diff-entry-key]")?.dataset
          .diffEntryKey ?? "",
      quote: "",
    };
  const form = document.querySelector<HTMLFormElement>(
    ".annotation-composer-popover",
  );
  if (!form) return null;
  return {
    title: form.querySelector("strong")?.textContent ?? "",
    quote: form.querySelector("blockquote")?.textContent ?? "",
  };
}

/** Mount Changes' diff view (DiffContentView) on loaded patches. */
export async function mountChangesDiff(
  initial: ChangesDiffOptions,
): Promise<ChangesDiff> {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { spyOn } = await import("bun:test");
  const { store } = await import("../store");
  const { DiffContentView } = await import("./DiffContentView");
  const { InspectorCommandsContext, InspectorViewContext } = await import(
    "../useInspectorCommands"
  );
  mounted += 1;
  const connectionId = initial.connectionId ?? `changes-diff-${mounted}`;
  const client: ConnectionClient = {
    connectionId,
    generation: 1,
    serverRuntimeGeneration: 1,
    isCurrent: () => true,
    acceptsServerGeneration: () => true,
    call: async (method) => {
      throw new Error(`no backend here: ${method}`);
    },
  };
  const base = store.get();
  const spy = spyOn(store, "get").mockImplementation(
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
  let options = initial;
  const fileOf = (each: GitDiffEntry): GitDiffFile => ({
    workspace_id: "workspace",
    root: options.repo?.root ?? "/repo",
    path: each.path,
    kind: each.kind,
    diff: options.patches[`${each.kind}:${each.path}`] ?? "",
    truncated: false,
  });
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  const settle = async () => {
    for (let round = 0; round < 8; round += 1)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
  };
  const render = async () => {
    const files = Object.fromEntries(
      options.entries.map((each) => [
        `${each.kind}:${each.path}`,
        fileOf(each),
      ]),
    );
    const selected = options.entry ?? options.entries[0] ?? null;
    const inInspector = (view: ReturnType<typeof createElement>) =>
      options.inspectorCommands
        ? createElement(
            InspectorCommandsContext.Provider,
            { value: options.inspectorCommands },
            createElement(
              InspectorViewContext.Provider,
              { value: "changes" },
              view,
            ),
          )
        : view;
    await act(async () =>
      root.render(
        inInspector(
          createElement(DiffContentView, {
            ...(options.selectionRevision !== undefined
              ? { selectionRevision: options.selectionRevision }
              : {}),
            entry: selected,
            file: selected ? files[`${selected.kind}:${selected.path}`]! : null,
            entries: options.entries,
            files,
            loading: false,
            error: null,
            resourceKey: connectionId,
            connectionClient: client,
            mobile: options.mobile ?? false,
            embedded: options.embedded ?? false,
            annotations: options.annotations ?? [],
            ...(options.threads ? { threads: options.threads } : {}),
            ...(options.repo ? { repo: options.repo } : {}),
            ...(options.onCreateAnnotation
              ? { onCreateAnnotation: options.onCreateAnnotation }
              : {}),
            ...(options.backAction ? { backAction: options.backAction } : {}),
            ...(options.onEditAnnotation
              ? { onEditAnnotation: options.onEditAnnotation }
              : {}),
            reviewCursor: options.reviewCursor ?? false,
            ...(options.cursorGoTo ? { cursorGoTo: options.cursorGoTo } : {}),
            ...(options.onGitAction
              ? { onGitAction: options.onGitAction }
              : {}),
          }),
        ),
      ),
    );
    await settle();
  };
  await render();

  const section = (key: string) => {
    const found = [
      ...container.querySelectorAll<HTMLElement>("[data-diff-entry-key]"),
    ].find((each) => each.dataset.diffEntryKey === key);
    if (!found) throw new Error(`no section ${key}`);
    return found;
  };
  const shadow = (key: string) =>
    section(key).querySelector("diffs-container")?.shadowRoot ?? null;
  const composerForm = () =>
    document.querySelector<HTMLElement>(
      ".annotation-composer-popover, .diff-review-composer",
    );

  const diff: ChangesDiff = {
    sections: () =>
      [...container.querySelectorAll<HTMLElement>("[data-diff-entry-key]")].map(
        (each) => ({
          key: each.dataset.diffEntryKey ?? "",
          path:
            each.querySelector(".diff-file-section-title strong")
              ?.textContent ?? "",
          badge:
            each.querySelector(".diff-file-section-title [role=img]")
              ?.textContent ?? "",
        }),
      ),
    lines(key) {
      const root = shadow(key);
      if (!root) return [];
      const found: DiffLine[] = [];
      for (const code of root.querySelectorAll("code")) {
        for (const line of code.querySelectorAll<HTMLElement>(
          "[data-content] [data-line]",
        )) {
          const type = line.getAttribute("data-line-type") ?? "";
          const side = code.hasAttribute("data-deletions")
            ? "old"
            : code.hasAttribute("data-additions")
              ? "new"
              : type === "change-deletion"
                ? "old"
                : "new";
          found.push({
            side,
            number: Number(line.getAttribute("data-line")),
            text: line.textContent ?? "",
            type,
          });
        }
      }
      return found;
    },
    async select(key, from, to = from) {
      await selectDiffLines(section(key), from, to);
      await settle();
    },
    composer: shownComposer,
    async write(text) {
      // A plain box (upstream's composer) or the comment editor.
      const box =
        composerForm()?.querySelector<HTMLTextAreaElement>("textarea");
      if (box) {
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          )!.set!.call(box, text);
          box.dispatchEvent(new Event("input", { bubbles: true }));
        });
        return;
      }
      const { EditorView } = await import("@codemirror/view");
      for (
        let i = 0;
        i < 50 && !composerForm()?.querySelector(".cm-content");
        i++
      )
        await settle();
      const content = composerForm()?.querySelector<HTMLElement>(".cm-content");
      if (!content) throw new Error("no comment box");
      const view = EditorView.findFromDOM(content);
      if (!view) throw new Error("no editor");
      await act(async () =>
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        }),
      );
    },
    async save() {
      const button = [
        ...(composerForm()?.querySelectorAll<HTMLButtonElement>("button") ??
          []),
      ].find(
        (each) =>
          each.textContent === "Add comment" || each.textContent === "Save",
      );
      if (!button) throw new Error("no Add comment");
      await act(async () => button.click());
      await settle();
    },
    comments: (key) =>
      [
        ...section(key).querySelectorAll<HTMLElement>(
          ".diff-review-thread, .diff-review-annotation",
        ),
      ].map((each) => each.textContent ?? ""),
    async openComment(key, text) {
      const button = [
        ...section(key).querySelectorAll<HTMLButtonElement>(
          "button.diff-review-annotation",
        ),
      ].find((each) => each.textContent === text);
      if (!button) throw new Error(`no comment ${text}`);
      await act(async () => button.click());
      await settle();
    },
    diffStyle(key) {
      const type = shadow(key)
        ?.querySelector("pre")
        ?.getAttribute("data-diff-type");
      return type === "split" ? "split" : type ? "unified" : null;
    },
    wrap() {
      const toggle = container.querySelector(".diff-wrap-toggle");
      return toggle ? toggle.getAttribute("aria-pressed") === "true" : null;
    },
    async toggleWrap() {
      const toggle =
        container.querySelector<HTMLButtonElement>(".diff-wrap-toggle");
      if (!toggle) throw new Error("no Wrap toggle");
      await act(async () => toggle.click());
      await settle();
    },
    backButton: () =>
      container
        .querySelector(".diff-content-back")
        ?.getAttribute("aria-label") ?? null,
    async pressBack() {
      const button =
        container.querySelector<HTMLButtonElement>(".diff-content-back");
      if (!button) throw new Error("no Back button");
      await act(async () => button.click());
      await settle();
    },
    rawPatch: (key) =>
      section(key).querySelector(".diff-raw-patch")?.textContent ?? null,
    theme(key) {
      const css =
        shadow(key)?.querySelector("style[data-theme-css]")?.textContent ?? "";
      if (css.includes("--diffs-token-light")) return "light";
      if (css.includes("--diffs-token-dark")) return "dark";
      return null;
    },
    async update(next) {
      options = { ...options, ...next };
      await render();
    },
    async remount() {
      await act(async () => root.unmount());
      root = createRoot(container);
      await render();
    },
    settle,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      composerForm()?.remove();
      spy.mockRestore();
    },
  };
  return diff;
}
