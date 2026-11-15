/**
 * App with reviews, for the app-level review tests (plan: review into the
 * inspector, gate 3): Option+R, the reviews list, Cmd+K, voice arrival, Go
 * to agent's pane, focus back to the chat, the code preload. It mounts the
 * real App on a store held here, with two workspaces, and stands a stub in
 * for the review surface: the tests read which review App shows, keeps
 * mounted or puts away, never how a review draws itself (the review's own
 * behavior is reviewBehavior.*.dom.test.tsx's).
 *
 * Not a test file: imported by `App.review*.test.tsx`, in an isolated child.
 * `installAppReviewDom` must run first, before React or App is imported.
 */
import { jest, mock, spyOn } from "bun:test";
import * as React from "react";
import type { ReviewSnapshot } from "../../shared/review";
import type { Pane } from "./types";

export async function installAppReviewDom(url = "http://localhost/") {
  const { Window } = await import("happy-dom");
  const browser = new Window({ url });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    HTMLInputElement: browser.HTMLInputElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    FocusEvent: browser.FocusEvent,
    KeyboardEvent: browser.KeyboardEvent,
    MouseEvent: browser.MouseEvent,
    CustomEvent: browser.CustomEvent,
    ResizeObserver: browser.ResizeObserver,
    MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    matchMedia: browser.matchMedia.bind(browser),
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  return browser;
}

/** A review of a workspace (of no workspace with `workspaceId: ""`). */
export function reviewOf(id: string, workspaceId: string): ReviewSnapshot {
  return {
    session: {
      id,
      connectionId: "local",
      workspaceId,
      root: `/repo/${id}`,
      title: `Review ${id}`,
      target: { kind: "worktree" },
      gitlab: false,
      summary: "",
      agent: {},
      createdAt: "2026-10-30",
      updatedAt: "2026-10-30",
    },
    threads: [],
  } as unknown as ReviewSnapshot;
}

/** What the stub review surface was given on its last render. */
export type ShownReviews = {
  /** The reviews kept mounted, in order. */
  mounted: string[];
  /** The one showing, or null. */
  shownId: string | null;
};

type HostProps = {
  pinned: ReviewSnapshot[];
  shownId: string | null;
  onClose: () => void;
  onShow: (sessionId: string) => void;
  onShowList: () => void;
  onFocusAgentPane: (paneId: string) => void;
  onOpenFile: (
    workspaceId: string,
    path: string,
    line?: number,
    rendered?: boolean,
  ) => void;
};

type InspectorProps = {
  fileSelection?: unknown;
  onViewChange: (view: "files" | "changes" | "commits" | "history") => void;
  onExpandedChange: (expanded: boolean) => void;
  onShowInReview?: (path: string, line?: number) => void;
  reviewGoTo?: { path: string; line?: number; at: number } | null;
  state: {
    open: boolean;
    view: string;
    scope: { workspaceId: string };
  } & Record<string, unknown>;
};

export type AppWithReviews = {
  /** Reviews mounted and the one shown. */
  shown(): ShownReviews;
  /** How many times each review's surface was mounted. */
  mounts(id: string): number;
  /** The last props App gave the review surface. */
  host(): HostProps;
  /** Whether the reviews list shows. */
  listShown(): boolean;
  /** Close the reviews list with its own close. */
  closeList(): Promise<void>;
  /** A key on the focused element (else the page), in App's notation. */
  key(init: KeyboardEventInit): Promise<void>;
  /** Option+R (`review.toggle`): Ctrl+Alt+R off a Mac. */
  toggleReview(): Promise<void>;
  /** Option+Shift+R (`reviews.list`). */
  toggleList(): Promise<void>;
  /** Bring another workspace forward, as the sidebar does. */
  focusWorkspace(id: string): Promise<void>;
  /** The review `openWorkspaceReview` finds or makes next (Option+R). */
  setNextOpened(id: string | null): void;
  /** The notices shown since the mount. */
  notices(): string[];
  /** The repositories `review.repos` finds in the workspace. */
  setRepos(roots: string[]): void;
  /** The paths a Changes scope holds ("working", "branch-main"). */
  setChanged(mode: string, paths: string[]): void;
  /** Calls App made to `openWorkspaceReview`. */
  openCalls(): number;
  /** Panes App was asked to focus. */
  focusedPanes(): string[];
  /** Times the syntax highlighter was preloaded. */
  highlighterPreloads(): number;
  /** The inspector's state as App last gave it (view, open, scope). */
  inspector(): InspectorProps["state"] | null;
  /** The file the inspector previews, as App last gave it. */
  inspectorFile(): unknown;
  /** Files' Review, as the inspector's Files preview calls it. */
  inspectorShowInReview(path: string, line?: number): void;
  /** Where App last asked Changes' cursor to go. */
  inspectorGoTo(): { path: string; line?: number; at: number } | null;
  /** Switches the shown inspector's view, as its tab strip does. */
  inspectorView(view: Parameters<InspectorProps["onViewChange"]>[0]): void;
  /** Docks or expands the shown inspector, as its header's button does. */
  inspectorExpand(expanded: boolean): void;
  /** The tab bar's Review button, or null. */
  tabBarReview(): HTMLButtonElement | null;
  click(button: HTMLElement): Promise<void>;
  /** Run a call App's review surface makes (its props), then settle. */
  run(call: () => void): Promise<void>;
  container: HTMLElement;
  settle(ms?: number): Promise<void>;
  unmount(): Promise<void>;
};

/** The page App runs on now: what the mocks read, reset by each mount. */
type Page = {
  snapshot: Record<string, unknown>;
  listeners: Set<() => void>;
  sessions: Map<string, ReviewSnapshot>;
  reviewState: {
    sessions: Map<string, ReviewSnapshot>;
    openRequest: null;
  };
  nextOpened: string | null;
  openCalls: number;
  /** What `review.repos` finds in the workspace (one repository: none). */
  repos: { root: string }[];
  /** The paths each Changes scope holds (git.diff_summary's mode). */
  changed: Record<string, string[]>;
  highlighterPreloads: number;
  focusedPanes: string[];
  mountCount: Map<string, number>;
  hostProps: HostProps | null;
  inspectorProps: InspectorProps | null;
};

let page: Page | null = null;
const now = () => {
  if (!page) throw new Error("no App mounted");
  return page;
};

/** The store's own initial state, before it is replaced. */
let initialState: object = {};

function stateWith(base: object, focused: string) {
  const pane = (id: string, workspace: string): Pane => ({
    pane_id: id,
    terminal_id: `terminal-${id}`,
    workspace_id: workspace,
    tab_id: `tab-${workspace}`,
    agent: "claude",
    agent_status: "idle",
    focused: true,
    revision: 1,
  });
  const rect = { x: 0, y: 0, width: 80, height: 24 };
  const front = focused === "w1" ? "a" : "b";
  return {
    ...base,
    activeConnectionId: "local",
    connectionGeneration: 1,
    selectedPaneId: front,
    panes: [pane("a", "w1"), pane("b", "w2")],
    workspaces: ["w1", "w2"].map((id, index) => ({
      workspace_id: id,
      number: index + 1,
      label: `Workspace ${index + 1}`,
      focused: id === focused,
      pane_count: 1,
      tab_count: 1,
      agent_status: "idle",
      active_tab_id: `tab-${id}`,
      // Each workspace is the checkout of its review (/repo/r1, /repo/r2).
      worktree: {
        repo_key: `repo-${index + 1}`,
        repo_name: `r${index + 1}`,
        repo_root: `/repo/r${index + 1}`,
        checkout_path: `/repo/r${index + 1}`,
        is_linked_worktree: false,
      },
    })),
    tabs: ["w1", "w2"].map((id) => ({
      tab_id: `tab-${id}`,
      workspace_id: id,
      number: 1,
      label: "Tab",
      focused: id === focused,
      pane_count: 1,
      agent_status: "idle",
    })),
    layout: {
      workspace_id: focused,
      tab_id: `tab-${focused}`,
      focused_pane_id: front,
      zoomed: false,
      area: rect,
      panes: [{ pane_id: front, focused: true, rect }],
      splits: [],
    },
  };
}

function publish() {
  for (const listener of now().listeners) listener();
}

let mocked = false;

/**
 * Replace App's store, review state, review surface and heavy views with
 * ones reading `page`. Once per process: App keeps the modules it loaded.
 */
async function mockApp(before?: () => Promise<void> | void) {
  if (mocked) return;
  mocked = true;
  const { store } = await import("./store");
  initialState = store.get();
  const subscribe = (listener: () => void) => {
    now().listeners.add(listener);
    return () => now().listeners.delete(listener);
  };
  spyOn(store, "get").mockImplementation(() => now().snapshot as never);
  spyOn(store, "init").mockImplementation(() => {});
  spyOn(store, "subscribe").mockImplementation(subscribe);
  spyOn(store, "focusWorkspace").mockImplementation(async (id: string) => {
    now().snapshot = stateWith(now().snapshot, id);
    publish();
  });
  spyOn(store, "focusPane").mockImplementation(async (id: string) => {
    now().focusedPanes.push(id);
  });
  const storeModule = await import("./store");
  mock.module("./store", () => ({
    ...storeModule,
    useStoreSelector: <T,>(
      selector: (state: ReturnType<typeof store.get>) => T,
    ) =>
      selector(
        React.useSyncExternalStore(
          subscribe,
          () => now().snapshot as unknown as ReturnType<typeof store.get>,
        ),
      ),
  }));

  // The review state: the reviews given, all loaded.
  const reviewModule = await import("./review");
  mock.module("./review", () => ({
    ...reviewModule,
    useReviewState: () => now().reviewState,
    getReviewSnapshot: (id: string) => now().sessions.get(id),
    loadReviews: async () => {},
    loadedReviewConnections: () => new Set(["local"]),
    startReviewClient: () => {},
    reviewCall: async (_connection: string, method: string) =>
      method === "review.repos" ? { repos: now().repos } : {},
    rememberReviewSnapshot: () => {},
  }));
  const reviewOpenModule = await import("./reviewOpen");
  mock.module("./reviewOpen", () => ({
    ...reviewOpenModule,
    openWorkspaceReview: async () => {
      now().openCalls++;
      return now().nextOpened;
    },
  }));
  const highlighting = await import("./components/syntaxHighlighting");
  mock.module("./components/syntaxHighlighting", () => ({
    ...highlighting,
    preloadSyntaxHighlighter: () => {
      now().highlighterPreloads++;
    },
  }));

  // The review surface: one element per review kept mounted, the shown one
  // visible and holding the keys, as the classic pane does.
  function Review({ id, shown }: { id: string; shown: boolean }) {
    const ref = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
      const counts = now().mountCount;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }, [id]);
    React.useEffect(() => {
      if (shown) ref.current?.focus();
    }, [shown]);
    return (
      <div
        ref={ref}
        className="review-overlay"
        data-review={id}
        hidden={!shown}
        tabIndex={-1}
      />
    );
  }
  mock.module("./components/ReviewHost", () => ({
    ReviewHost: (props: HostProps) => {
      now().hostProps = props;
      return props.pinned.map((review) => (
        <Review
          key={review.session.id}
          id={review.session.id}
          shown={review.session.id === props.shownId}
        />
      ));
    },
  }));
  mock.module("./components/ReviewList", () => ({
    ReviewList: ({ onClose }: { onClose: () => void }) => (
      <div className="review-list-overlay" data-review-list="">
        <button type="button" onClick={onClose}>
          Close the list
        </button>
      </div>
    ),
  }));

  const client = {
    connectionId: "local",
    generation: 1,
    isCurrent: () => true,
    // What Changes' scopes hold (git.diff_summary), per mode.
    call: async (method: string, params?: { mode?: string }) =>
      method === "git.diff_summary"
        ? {
            workspace_id: "w1",
            root: "/repo/r1",
            entries: (now().changed[params?.mode ?? "working"] ?? []).map(
              (path) => ({ path, kind: "unstaged", status: "M" }),
            ),
            counts: {},
          }
        : {},
  };
  mock.module("./useConnectionClient", () => ({
    useConnectionClient: () => client,
    useConnectionReady: () => true,
    connectionClientScopeKey: () => `local:${client.generation}`,
  }));
  const assistantModule = await import("./assistant");
  mock.module("./assistant", () => ({
    ...assistantModule,
    useAssistantState: () => ({ snapshot: null }),
    assistantActionExecuting: () => false,
    onAssistantShow: () => () => {},
  }));
  const inspectorModule = await import("./components/WorkspaceInspectorHost");
  mock.module("./components/WorkspaceInspectorHost", () => ({
    ...inspectorModule,
    WorkspaceInspectorHost: (props: InspectorProps) => {
      now().inspectorProps = props;
      // Changes' diff, which the review toggle gives the keys to.
      return props.state?.open && props.state.view === "changes" ? (
        <div className="diff-content-view" data-review-cursor tabIndex={0} />
      ) : null;
    },
  }));
  for (const name of [
    "ConnectionSwitcher",
    "GlobalTooltip",
    "AnnotationPanel",
    "AssistantPanel",
    "WorkspaceTree",
    "ConfigMenu",
  ]) {
    const real = await import(`./components/${name}`);
    mock.module(`./components/${name}`, () => ({
      ...real,
      [name]: () => null,
    }));
  }
  mock.module("./components/TerminalView", () => ({
    TerminalView: () => null,
  }));
  await before?.();
  const { initializeLayoutPreferences } = await import("./layoutPreferences");
  initializeLayoutPreferences();
}

/**
 * Mount App on a store with workspaces `w1` (focused, pane `a`) and `w2`
 * (pane `b`), the reviews given known to the review state, as a fresh
 * page: no pins, closed reviews or preferences stored.
 */
// The store's own notify, wrapped once per mount for `notices()`.
const notifyOf = new WeakMap<object, (notice: never) => unknown>();

export async function mountAppWithReviews(options: {
  reviews: ReviewSnapshot[];
  /**
   * Mocks of modules the caller adds before App is first imported (once
   * per process: the first mount's).
   */
  before?: () => Promise<void> | void;
  /**
   * Mount under Bun's fake timers: `settle(ms)` then advances them. The
   * caller restores real timers (`jest.useRealTimers()`) in finally.
   */
  fakeTimers?: boolean;
}): Promise<AppWithReviews> {
  localStorage.clear();
  sessionStorage.clear();
  const sessions = new Map(
    options.reviews.map((review) => [review.session.id, review]),
  );
  page = {
    snapshot: {},
    listeners: new Set(),
    sessions,
    reviewState: { sessions, openRequest: null },
    nextOpened: null,
    repos: [],
    changed: { working: ["a.ts"], "branch-main": ["a.ts"] },
    openCalls: 0,
    highlighterPreloads: 0,
    focusedPanes: [],
    mountCount: new Map(),
    hostProps: null,
    inspectorProps: null,
  };
  await mockApp(options.before);
  const notices: string[] = [];
  // Each mount scans its own repositories.
  (await import("./reviewRepos")).clearRepoScans();
  {
    const { store } = await import("./store");
    const real = notifyOf.get(store) ?? store.notify.bind(store);
    notifyOf.set(store, real);
    store.notify = ((notice: { message: string }) => {
      notices.push(notice.message);
      return real(notice as Parameters<typeof store.notify>[0]);
    }) as typeof store.notify;
  }
  page.snapshot = stateWith(initialState, "w1");
  const current = page;
  const { default: App } = await import("./App");
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const fake = options.fakeTimers === true;
  if (fake) jest.useFakeTimers();
  const settle = (ms = 20) =>
    React.act(async () => {
      if (fake) {
        // Each step lets the promises it resolves run before the next.
        for (let step = 0; step < ms; step += 10) {
          jest.advanceTimersByTime(Math.min(10, ms - step));
          for (let turn = 0; turn < 5; turn++) await Promise.resolve();
        }
      } else await new Promise((resolve) => setTimeout(resolve, ms));
    });
  await React.act(async () => root.render(<App />));
  await settle();

  const key = async (init: KeyboardEventInit) => {
    const active = document.activeElement;
    const target = active && active !== document.body ? active : document.body;
    await React.act(async () => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    });
    await settle();
  };
  return {
    container,
    shown() {
      const mounted = [
        ...container.querySelectorAll<HTMLElement>("[data-review]"),
      ].map((element) => element.dataset.review!);
      return {
        mounted,
        shownId: mounted.length ? (current.hostProps?.shownId ?? null) : null,
      };
    },
    mounts: (id) => current.mountCount.get(id) ?? 0,
    host() {
      if (!current.hostProps) throw new Error("no review surface mounted");
      return current.hostProps;
    },
    listShown: () => container.querySelector("[data-review-list]") !== null,
    async closeList() {
      const button = container.querySelector<HTMLButtonElement>(
        "[data-review-list] button",
      );
      if (!button) throw new Error("no reviews list");
      await React.act(async () => button.click());
      await settle();
    },
    key,
    toggleReview: () =>
      key({ key: "r", code: "KeyR", ctrlKey: true, altKey: true }),
    toggleList: () =>
      key({
        key: "R",
        code: "KeyR",
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      }),
    async focusWorkspace(id) {
      await React.act(async () => {
        current.snapshot = stateWith(current.snapshot, id);
        publish();
      });
      await settle();
    },
    setNextOpened(id) {
      current.nextOpened = id;
    },
    notices: () => [...notices],
    setChanged(mode, paths) {
      current.changed[mode] = paths;
    },
    setRepos(roots) {
      current.repos = roots.map((root) => ({ root }));
    },
    openCalls: () => current.openCalls,
    focusedPanes: () => [...current.focusedPanes],
    highlighterPreloads: () => current.highlighterPreloads,
    inspector: () => current.inspectorProps?.state ?? null,
    inspectorFile: () => current.inspectorProps?.fileSelection ?? null,
    inspectorShowInReview(path, line) {
      if (!current.inspectorProps?.onShowInReview)
        throw new Error("no Review in the inspector");
      current.inspectorProps.onShowInReview(path, line);
    },
    inspectorGoTo: () => current.inspectorProps?.reviewGoTo ?? null,
    inspectorView(view) {
      if (!current.inspectorProps) throw new Error("no inspector shown");
      current.inspectorProps.onViewChange(view);
    },
    inspectorExpand(expanded) {
      if (!current.inspectorProps) throw new Error("no inspector shown");
      current.inspectorProps.onExpandedChange(expanded);
    },
    tabBarReview() {
      return (
        [
          ...container.querySelectorAll<HTMLButtonElement>(
            ".tabbar-utilities button",
          ),
        ].find((button) => button.textContent === "Review") ?? null
      );
    },
    async run(call) {
      await React.act(async () => call());
      await settle();
    },
    async click(button) {
      await React.act(async () => button.click());
      await settle();
    },
    settle,
    async unmount() {
      await React.act(async () => root.unmount());
      container.remove();
    },
  };
}
