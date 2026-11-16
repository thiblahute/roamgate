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
  type HostCall,
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
  const { act, cloneElement, createElement, isValidElement, useState } =
    await import("react");
  type ReactNode = import("react").ReactNode;
  type ReactElement<P> = import("react").ReactElement<P>;
  const { createRoot } = await import("react-dom/client");
  const { jest, spyOn } = await import("bun:test");
  const { store } = await import("../store");
  const { roamgateLocalStorage } = await import("../browserStorage");
  const { DiffContentView } = await import("./DiffContentView");
  const { commitMessageFile } = await import("../reviewModel");
  const { InspectorCommandsContext, InspectorViewContext } = await import(
    "../useInspectorCommands"
  );
  const { runInspectorCommand } = await import("../inspectorCommands");
  type CommandSet = import("../useInspectorCommands").InspectorCommandSet;
  type InspectorCommand = import("../inspectorCommands").InspectorCommand;
  const { useInspectorCommands } = await import("../useInspectorCommands");
  const { ChangesScopeBar, useChangesRepos, useChangesSeries } = await import(
    "./ChangesScopeBar"
  );
  const { repoLabel } = await import("../reviewRepos");
  type WorkspaceRepo = import("../reviewModel").WorkspaceRepo;

  mounted += 1;
  const connectionId = `changes-review-${mounted}`;
  const { addFeedbackImage, feedbackNote, writeFeedback } = await import(
    "../workspaceFeedback"
  );
  const { createReviewAnnotation } = await import("../annotations");
  const { reviewCall, rememberReviewSnapshot } = await import("../review");
  type NewReviewAnnotation = import("../annotations").NewReviewAnnotation;
  type FeedbackCapture = import("../workspaceFeedback").FeedbackCapture;
  const { CommandLine } = await import("./CommandLine");
  const { inspectorCompletions, isTypingTarget, opensCommandLine } =
    await import("../inspectorCommands");
  const { inspectorShortcutList } = await import("../useInspectorCommands");
  const { inspectorSettingCommands } = await import("../inspectorSettings");
  const { ShortcutList } = await import("./ShortcutList");
  const { changesFrameClass, changesFrameCommands, useChangesTreeHidden } =
    await import("./changesFrame");
  const { useZenEscape, useZenMode } = await import("../useZenMode");
  // The browser storage it opens with, as the classic kit's.
  if (options.storage !== "keep") {
    localStorage.clear();
    for (const [key, value] of Object.entries(options.storage ?? {}))
      localStorage.setItem(key, value);
  }
  // The bridge, from a clean slate.
  backend.files = options.files;
  backend.texts = options.texts ?? {};
  backend.commits = options.commits ?? [];
  backend.patchIds = options.patchIds;
  backend.fileAt = options.fileAt ?? {};
  backend.repos = options.repos ?? [];
  backend.calls = [];
  backend.failing.clear();
  backend.connected = true;
  backend.held.clear();
  backend.holds = null;
  backend.imageGate = Promise.resolve();
  if (options.vim !== undefined)
    (await import("../vimKeys")).setVimKeys(options.vim);
  const sessionId = options.sessionId ?? "s1";
  let marks: Record<string, string> = { ...(options.reviewed ?? {}) };
  let applied = 0;
  // A review of commits (the commit bar): a range shown as a review scope
  // in Changes, as the review toggle shows one (plan phase 6).
  const ofCommits = !!options.commits?.length;
  let sessionFields: Record<string, unknown> = {
    ...(ofCommits
      ? { target: { kind: "range", base: "main", head: "HEAD" } }
      : {}),
    ...(options.session ?? {}),
  };
  // A merge request's review: shown as Changes' review scope, as the review
  // toggle shows one (plan phase 7); its threads are the forge's, the
  // agent's and the review pane's, not written in Changes.
  const ofRequest =
    (sessionFields.target as { kind?: string } | undefined)?.kind === "mr";
  const asReview = ofCommits || ofRequest;
  /** What the bridge read of the merge request, pushed with the review. */
  let pushed: { mergeRequest?: unknown; gitlabError?: string } = {
    ...(options.mergeRequest ? { mergeRequest: options.mergeRequest } : {}),
    ...(options.gitlabError ? { gitlabError: options.gitlabError } : {}),
  };
  let ownThreads: ReviewThread[] = options.threads ?? [];
  const otherReviews = options.otherReviews ?? [];
  /**
   * A thread as Changes' comments are: written on the unstaged entry; one
   * on the whole review with no line.
   */
  const asFeedback = (thread: ReviewThread, session: string): ReviewThread =>
    ofRequest && session === sessionId
      ? ({ ...thread, sessionId: session } as ReviewThread)
      : asChangesComment(thread, session);
  const asChangesComment = (
    thread: ReviewThread,
    session: string,
  ): ReviewThread =>
    // Written on a commit's view (the review pane's commit bar): the
    // review's own thread, anchored on that commit, as it is stored.
    thread.anchor.commit && !thread.anchor.feedback
      ? ({ ...thread, sessionId: session } as ReviewThread)
      : ({
          ...thread,
          sessionId: session,
          anchor: {
            ...thread.anchor,
            feedback: thread.anchor.feedback
              ? thread.anchor.feedback
              : thread.anchor.path
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
        } as ReviewThread);
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
          ...pushed,
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
  /** This review as the bridge answers it. */
  const ownSnapshot = () =>
    ({
      session: ownSession(),
      threads: ownThreads.map((thread) => asFeedback(thread, sessionId)),
      ...pushed,
    }) as unknown as ReviewSnapshot;
  // The bridge writes what Changes writes through the host: the review
  // opened (the checkout's), a thread added to it, the review read back.
  backend.answers = {
    "review.open": () => ownSnapshot(),
    "review.get": (params) =>
      backend.holds
        ? backend.holds()
        : params.session_id === sessionId
          ? ownSnapshot()
          : {},
    "review.thread.add": (params) => {
      if (params.session_id !== sessionId) return {};
      const anchor = params.anchor as Record<string, unknown>;
      const at = new Date().toISOString();
      const id = String(params.new_thread_id ?? `w${backend.calls.length}`);
      ownThreads = [
        ...ownThreads,
        {
          id,
          sessionId,
          kind: params.kind,
          anchor,
          comments: [
            {
              id: `${id}c`,
              author: "you",
              body: String(params.text ?? ""),
              createdAt: at,
              updatedAt: at,
            },
          ],
          resolved: false,
          createdAt: at,
          updatedAt: at,
          ...(params.held !== undefined ? { held: params.held } : {}),
        } as unknown as ReviewThread,
      ];
      return { threadId: id };
    },
    ...(options.answers ?? {}),
  };
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
    if (update.mergeRequest)
      pushed = { ...pushed, mergeRequest: update.mergeRequest };
    if (update.gitlabError !== undefined)
      pushed = { ...pushed, gitlabError: update.gitlabError };
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
  // The page around the review: its host's callbacks, new tabs, visibility.
  const hostCalls: HostCall[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      hostCalls.push({ name, args });
    };
  const opened: string[] = [];
  const windowOpen = Object.getOwnPropertyDescriptor(window, "open");
  Object.defineProperty(window, "open", {
    configurable: true,
    writable: true,
    value: (url?: string | URL) => {
      opened.push(String(url));
      return null;
    },
  });
  let pageHidden = false;
  const documentHidden = Object.getOwnPropertyDescriptor(document, "hidden");
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => pageHidden,
  });
  // Time: Bun's fake clock when asked; settling then runs on setImmediate,
  // which the fake clock leaves running.
  const fake = options.fakeTimers === true;
  if (fake) jest.useFakeTimers();
  const tick = fake
    ? async () => {
        jest.advanceTimersByTime(2);
        await new Promise((resolve) => setImmediate(resolve));
      }
    : () => new Promise((resolve) => setTimeout(resolve, 2));
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

  // The inspector's frame around Changes, as WorkspaceInspectorHost draws
  // and runs it: the tree beside the diff (`:files`), Review only
  // (`:only`), the `:` prompt and the shortcut list (`?`, `:help`), the
  // inspector's settings (`:vim`, `:set`).
  const parts = new Map<string, CommandSet>();
  const frame = {
    commands: [] as InspectorCommand[],
    only: false,
  };
  /** The commands shown: Changes' parts', then the frame's. */
  const shownCommands = (): CommandSet => {
    const sets = [...parts.values()];
    const own = sets.find((set) => set.shortcuts || set.unknown);
    return {
      commands: [...sets.flatMap((set) => set.commands), ...frame.commands],
      line: sets.find((set) => set.line)?.line,
      keys: sets.flatMap((set) => set.keys ?? []),
      ...(own?.shortcuts ? { shortcuts: own.shortcuts } : {}),
      ...(own?.unknown ? { unknown: own.unknown } : {}),
    };
  };
  const Frame = ({ children }: { children: ReactNode }) => {
    const [open, setOpen] = useState(false);
    const [shortcuts, setShortcuts] = useState<{ filter: string } | null>(null);
    const [treeHidden, toggleTree] = useChangesTreeHidden();
    const [only, toggleOnly] = useZenMode();
    useZenEscape(only, toggleOnly);
    frame.only = only;
    frame.commands = [
      ...changesFrameCommands({
        // A phone's inspector is compact: its tree is a drill-down.
        toggleTree: options.phone ? null : toggleTree,
        only,
        toggleOnly,
      }),
      ...inspectorSettingCommands((filter) => setShortcuts({ filter })),
    ];
    const back = () => view()?.focus({ preventScroll: true });
    return (
      <InspectorViewContext.Provider value="changes">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the inspector's keys */}
        <div
          onKeyDown={(event) => {
            if (
              event.key === "?" &&
              !event.defaultPrevented &&
              !open &&
              !shortcuts &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              !isTypingTarget(event.target)
            ) {
              event.preventDefault();
              setShortcuts({ filter: "" });
              return;
            }
            if (open || event.defaultPrevented || !opensCommandLine(event))
              return;
            event.preventDefault();
            setOpen(true);
          }}
        >
          <div
            className={`workspace-inspector-resource inspector-changes-resource ${changesFrameClass(
              { treeHidden: treeHidden && !options.phone, only },
            )}`}
          >
            <div className="workspace-inspector-navigation" />
            <div className="workspace-inspector-detail">
              {isValidElement(children)
                ? cloneElement(
                    children as ReactElement<{ reviewOnly?: boolean }>,
                    {
                      reviewOnly: only,
                    },
                  )
                : children}
            </div>
          </div>
          {shortcuts ? (
            <ShortcutList
              className="inspector-keys"
              {...inspectorShortcutList(shownCommands())}
              filter={shortcuts.filter}
              onFilter={(filter) => setShortcuts({ filter })}
              placeholder="Search shortcuts and commands"
              onClose={() => {
                setShortcuts(null);
                back();
              }}
            />
          ) : null}
          {open ? (
            <CommandLine
              kind=":"
              completions={(typed) =>
                inspectorCompletions(shownCommands().commands, typed)
              }
              onBlur={() => setOpen(false)}
              onSubmit={(text) => {
                setOpen(false);
                back();
                registry.run(text);
              }}
              onCancel={() => {
                setOpen(false);
                back();
              }}
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
      const { commands, line, unknown } = shownCommands();
      const problem = runInspectorCommand(
        commands,
        input,
        line,
        unknown ? (text) => unknown(text) : undefined,
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
  /** Each file's lines in order, read again once the surface settled. */
  const orders = new Map<string, ShownLine[]>();
  const settleOnly = async () => {
    for (let round = 0; round < 8; round++)
      await act(async () => {
        await tick();
      });
    orders.clear();
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
  // The host's writes (App's addFeedback): a comment written in Changes is
  // a thread of the checkout's review, read back once written.
  const call = <T,>(method: string, params: Record<string, unknown>) =>
    reviewCall<T>(connectionId, method, params);
  const place = () => {
    const agent = (sessionFields.agent ?? {}) as {
      name?: string;
      paneId?: string;
    };
    // The review's agent, else the workspace's first agent pane, as App
    // gives it.
    const pane = options.agentPanes?.[0];
    return {
      workspaceId: "workspace",
      root: "/repo",
      ...(agent.paneId
        ? { agent: { paneId: agent.paneId, name: agent.name ?? "Agent" } }
        : pane
          ? {
              agent: {
                paneId: pane.paneId,
                name: pane.agent.charAt(0).toUpperCase() + pane.agent.slice(1),
              },
            }
          : {}),
    };
  };
  const writeComment = (
    input: NewReviewAnnotation,
    capture?: FeedbackCapture,
  ) => {
    void (async () => {
      const written = await writeFeedback(
        call,
        createReviewAnnotation(input),
        place(),
        Date.now() * 1000,
        capture,
      );
      rememberReviewSnapshot(
        await call<ReviewSnapshot>("review.get", {
          session_id: written.snapshot.session.id,
        }),
      );
    })().catch((error: unknown) =>
      store.notify({
        kind: "error",
        message: "Comment kept in this browser",
        detail: String(error),
      }),
    );
  };
  const addImage = (image: File) => addFeedbackImage(call, place(), image);
  const render = async () => {
    const { threads, annotations } = feedback();
    await act(async () =>
      root.render(
        createElement(
          InspectorCommandsContext.Provider,
          { value: registry },
          createElement(
            Frame,
            null,
            createElement(series ? ChangesWithSeries : DiffContentView, {
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
              ...(asReview
                ? { reviewScope: { kind: "review" as const, sessionId } }
                : {}),
              // Another review and the reviews list are always offered, as
              // the page around the review offers them.
              forgeHost: {
                onShowReview: record("showReview"),
                ...(options.hostCallbacks
                  ? { onOpenLocal: record("openLocal") }
                  : {}),
              },
              onShowReviews: record("showList"),
              // The inspector reads the changes again (its refresh).
              onRetry: record("reload"),
              // Closed as the review toggle closes it, the review kept.
              onCloseReview: record("close"),
              ...(options.hostCallbacks
                ? { onFocusAgentPane: record("focusAgentPane") }
                : {}),
              ...(options.agentPanes ? { agentPanes: options.agentPanes } : {}),
              showFileSelector: false,
              // The checkout's git actions, as the host runs them.
              onGitAction: (action: string, path: string) => {
                record("gitAction")(action, path);
                return true;
              },
              // A review naming its repository: the checkout's is /repo.
              ...(options.session?.root !== undefined
                ? { repo: { root: "/repo", own: true } }
                : {}),
              onCreateAnnotation: writeComment,
              onAddReviewImage: addImage,
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
  /**
   * The workspace's repositories (plan phase 8), as the inspector lists
   * them over Changes: its scope line's chooser, p, ( and ). Picking one
   * is the host's (`openRepo`, with whether it has only uncommitted work);
   * the review shown stays, as the review pane's host leaves it to the
   * page.
   */
  const series =
    options.repos !== undefined || options.repoDirs !== undefined
      ? {
          ownRoot: (options.session?.root as string | undefined) ?? "/repo",
          repos: [] as readonly WorkspaceRepo[],
        }
      : null;
  function ChangesWithSeries(props: Parameters<typeof DiffContentView>[0]) {
    const own = series!.ownRoot;
    const repos = useChangesRepos(connectionId, "workspace", own, true, {
      dirs: options.repoDirs ?? [],
      agentDirs: options.agentDirs ?? [],
    });
    series!.repos = repos;
    const chooser = useChangesSeries({
      repos,
      shownRoot: own,
      onPick: (root, worktree) => {
        if (options.hostCallbacks) record("openRepo")(root, worktree);
      },
    });
    useInspectorCommands({ commands: chooser.commands });
    return createElement(DiffContentView, {
      ...props,
      scopeControls: createElement(ChangesScopeBar, {
        repos,
        root: own,
        repoName: undefined,
        mode: "working",
        baseBranch: "",
        baseBranches: [],
        files: entries.length,
        pickerOpen: chooser.pickerOpen,
        onPickerOpen: chooser.setPickerOpen,
        onPickRepo: chooser.pick,
        onScope: () => {},
        onBase: () => {},
        onDone: () => {},
      }),
    });
  }
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
    (section.dataset.diffEntryKey ?? "").replace(/^[a-z-]+:/, "");
  const shadowOf = (section: HTMLElement) =>
    section.querySelector("diffs-container")?.shadowRoot ?? null;

  /**
   * A file's line revealed around its hunks (unchanged code, read from the
   * file's text): its numbers on both sides, by the hunks' offsets.
   */
  const revealed = (
    file: ReviewDiffFile,
    number: number,
    old: boolean,
  ): ShownLine | null => {
    const text = options.texts?.[file.path];
    if (text === undefined) return null;
    const heads = file.hunks.map((hunk) =>
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
        .exec(hunk.header)!
        .slice(1)
        .map((value) => (value === undefined ? 1 : Number(value))),
    );
    // The gap's offset: before the first hunk past it, else after the last.
    let offset: number | null = null;
    for (const [oldStart, , newStart] of heads)
      if ((old ? oldStart! : newStart!) > number) {
        offset = newStart! - oldStart!;
        break;
      }
    if (offset === null) {
      const [oldStart, oldCount, newStart, newCount] = heads[heads.length - 1]!;
      offset = newStart! + newCount! - (oldStart! + oldCount!);
    }
    const at = old ? number + offset : number;
    const line = text.split("\n")[at - 1];
    if (line === undefined) return null;
    return {
      path: file.path,
      old: at - offset,
      new: at,
      text: line,
      kind: " ",
    };
  };
  /**
   * The files of the view shown: a commit's (its message first) when the
   * commit bar names one, else the review's.
   */
  const viewFiles = (): ReviewDiffFile[] => {
    const head =
      view()?.querySelector(".diff-commit-name .note")?.textContent ?? "";
    const at = /^(\d+)\//.exec(head);
    const commit = at ? options.commits?.[Number(at[1]) - 1] : undefined;
    if (!commit) return files;
    return [
      commitMessageFile(commit.subject, commit.body ?? ""),
      ...(commit.files ?? files),
    ];
  };
  /** A drawn line of Pierre's, read as the review's. */
  const shown = (element: Element, path: string): ShownLine => {
    const code = element.closest("code");
    const number = Number(element.getAttribute("data-line"));
    const type = element.getAttribute("data-line-type") ?? "";
    const old =
      code?.hasAttribute("data-deletions") || type === "change-deletion";
    const file = viewFiles().find((each) => each.path === path);
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
    const context = file ? revealed(file, number, old) : null;
    if (context) return context;
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
  /**
   * A file's lines in the review's order: its hunks' lines, and the
   * unchanged lines revealed around them (drawn now) where they read.
   */
  const fileOrder = (file: ReviewDiffFile): ShownLine[] => {
    const cached = orders.get(file.path);
    if (cached) return cached;
    const found = readOrder(file);
    orders.set(file.path, found);
    return found;
  };
  const readOrder = (file: ReviewDiffFile): ShownLine[] => {
    const own = file.hunks.flatMap((hunk) =>
      hunk.lines.map((line) => ({ ...line, path: file.path }) as ShownLine),
    );
    const known = new Set(own.map((line) => `${line.old}:${line.new}`));
    const extra = sections()
      .filter((section) => pathOf(section) === file.path)
      .flatMap((section) => [
        ...(shadowOf(section)?.querySelectorAll(
          "[data-content] [data-line][data-line-type]",
        ) ?? []),
      ])
      .map((element) => {
        try {
          return shown(element, file.path);
        } catch {
          return null;
        }
      })
      .filter(
        (line): line is ShownLine =>
          !!line && !known.has(`${line.old}:${line.new}`),
      );
    if (!extra.length) return own;
    // Where each reads: a removed line just before the new line after it.
    const place = (line: ShownLine, index: number, list: ShownLine[]) => {
      if (line.new !== null) return line.new;
      const next = list.slice(index + 1).find((each) => each.new !== null);
      return (next?.new ?? Number.MAX_SAFE_INTEGER) - 0.5;
    };
    const placed = own.map((line, index) => ({
      line,
      at: place(line, index, own),
      index,
    }));
    const seen = new Set<string>();
    for (const line of extra) {
      const key = `${line.old}:${line.new}`;
      if (seen.has(key)) continue;
      seen.add(key);
      placed.push({ line, at: line.new!, index: own.length });
    }
    return placed
      .sort((a, b) => a.at - b.at || a.index - b.index)
      .map(({ line }) => line);
  };
  const order = () => files.flatMap(fileOrder);
  const rank = (line: ShownLine) => {
    const list = order();
    return list.findIndex(
      (each) =>
        each.path === line.path &&
        each.old === line.old &&
        each.new === line.new,
    );
  };

  /** A file's rows as Pierre lays them out: split rows side by side. */
  const fileRows = (
    file: ReviewDiffFile,
    sideBySide = drawnSplit(),
  ): ShownLine[][] => {
    const rows: ShownLine[][] = [];
    for (const hunk of [{ lines: fileOrder(file) }]) {
      const lines = hunk.lines;
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
    // No screen asked for: one tall enough that Pierre draws every row.
    if (options.viewport === undefined)
      return this === scroller() ? box(0, 100_000) : rect.call(this);
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

  /**
   * Where a key goes: the focus, in the diff or in the frame's own fields
   * (the shortcut list's filter, the prompt, the focus bar); else the diff.
   */
  const keyTarget = () => {
    const active = document.activeElement;
    return active instanceof HTMLElement &&
      (view().contains(active) ||
        (host.contains(active) &&
          active.closest(".review-keys, .review-cmdline") !== null))
      ? active
      : view();
  };
  const press = async (keys: string) => {
    for (const stroke of parseKeys(keys)) {
      const target = keyTarget();
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
  const keyTaken = async (keys: string) => {
    const [stroke] = parseKeys(keys);
    const active = document.activeElement;
    const target =
      active instanceof HTMLElement && view().contains(active)
        ? active
        : view();
    if (target === view()) target.focus();
    let taken = false;
    await act(async () => {
      taken = !target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: stroke!.key,
          code: stroke!.code ?? "",
          ctrlKey: stroke!.ctrlKey ?? false,
          altKey: stroke!.altKey ?? false,
          shiftKey: stroke!.shiftKey ?? false,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settleAll();
    return taken;
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
  const { EditorView } = await import("@codemirror/view");
  const currentView = (content: HTMLElement) => EditorView.findFromDOM(content);
  const editorView = async () => {
    // The editor loads lazily: let it come.
    for (let round = 0; round < 20; round++) {
      const content = editorBox()?.querySelector<HTMLElement>(".cm-content");
      if (content) return currentView(content);
      if (!editorBox()) return null;
      await settleOnly();
    }
    return null;
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

  // The head's menus: More (the forge's, copying) and the agent's.
  const menuButton = (name: "agent" | "more") => {
    const button = [
      ...host.querySelectorAll<HTMLButtonElement>(".rv-menu-button"),
    ].find((each) =>
      name === "more"
        ? each.closest(".rv-more") !== null
        : each.closest(".rv-agent") !== null,
    );
    if (!button) throw new Error(`no ${name} menu`);
    return button;
  };
  const menuItems = (button: HTMLButtonElement) => [
    ...(button.parentElement?.querySelectorAll<HTMLButtonElement>(
      '.rv-menu [role^="menuitem"]',
    ) ?? []),
  ];
  const menuLabel = (item: Element) =>
    item.querySelector(".rv-menu-label")?.textContent ??
    (item.textContent ?? "").trim();

  const surface: Partial<ReviewSurface> = {
    name: "changes",
    keyTaken,
    repoChooser() {
      // The scope line's chooser: each repository as its option reads
      // (its name, then its branch and state).
      if (!series || !host.querySelector(".changes-scope-repo")) return null;
      return {
        choices: series.repos.map((repo) => repoLabel(repo)),
        value: series.ownRoot,
      };
    },
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
    gaps(path) {
      const section = sections().find((each) => pathOf(each) === path);
      return [...(section?.querySelectorAll<HTMLElement>(".rd-expand") ?? [])]
        .sort((a, b) => Number(a.dataset.gap) - Number(b.dataset.gap))
        .map((row) => ({
          label: row.querySelector(".note")?.textContent ?? "",
          buttons: [...row.querySelectorAll("button")].map(
            (button) => button.textContent ?? "",
          ),
        }));
    },
    async expandGap(path, index, label) {
      const section = sections().find((each) => pathOf(each) === path);
      const row = [
        ...(section?.querySelectorAll<HTMLElement>(".rd-expand") ?? []),
      ].sort((a, b) => Number(a.dataset.gap) - Number(b.dataset.gap))[index];
      if (!row) throw new Error(`no gap ${index} in ${path}`);
      const button = [
        ...row.querySelectorAll<HTMLButtonElement>("button"),
      ].find((each) => each.textContent === label);
      if (!button) throw new Error(`no gap button ${label}`);
      await act(async () => button.click());
      await settleAll();
      await settleAll();
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
      if (windowOpen) Object.defineProperty(window, "open", windowOpen);
      if (documentHidden)
        Object.defineProperty(document, "hidden", documentHidden);
      else Reflect.deleteProperty(document, "hidden");
      if (fake) jest.useRealTimers();
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
    editorOpen() {
      // The review's editor, else the popover (Changes not "in Changes").
      return (
        editorBox() !== null ||
        document.querySelector(".annotation-composer-popover") !== null
      );
    },
    editor() {
      const text = surface.editorText!();
      if (text === null) return null;
      return { placeholder: surface.editorPlaceholder!() ?? "", text };
    },
    editorText() {
      const content = editorBox()?.querySelector<HTMLElement>(".cm-content");
      if (!content) return null;
      return currentView(content)?.state.doc.toString() ?? "";
    },
    editorPlaceholder() {
      const content = editorBox()?.querySelector<HTMLElement>(".cm-content");
      const view = content ? currentView(content) : null;
      if (!view) return null;
      const placeholder = view.dom.querySelector(".cm-placeholder");
      return (
        placeholder?.getAttribute("aria-label") ??
        placeholder?.textContent ??
        view.contentDOM.getAttribute("aria-placeholder")
      );
    },
    async type(text) {
      const view = await editorView();
      if (!view) throw new Error("no comment editor open");
      await act(async () => {
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
      });
      await settleAll();
    },
    async typeInEditor(text) {
      const view = await editorView();
      if (!view) throw new Error("no comment editor open");
      await act(async () =>
        view.dispatch({
          changes: { from: view.state.doc.length, insert: text },
        }),
      );
    },
    async editorPress(keys) {
      for (const stroke of parseKeys(keys)) {
        const content = editorBox()?.querySelector(".cm-content");
        if (!content) throw new Error("no comment editor open");
        await act(async () => {
          content.dispatchEvent(
            new KeyboardEvent("keydown", {
              ...stroke,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
      }
      await settleAll();
    },
    async editorCommand(text) {
      const view = await editorView();
      if (!view) throw new Error("no comment editor open");
      const { getCM, Vim } = await import("@replit/codemirror-vim");
      const cm = getCM(view);
      if (!cm) throw new Error("the editor has no Vim");
      // As typed at Vim's `:` prompt (its panel needs a real layout).
      await act(async () => {
        Vim.handleEx(
          cm as Parameters<typeof Vim.handleEx>[0],
          text.replace(/^:/, ""),
        );
      });
      await settleAll();
    },
    async pasteImage(name, type = "image/png") {
      const content = editorBox()?.querySelector(".cm-content");
      if (!content) throw new Error("no comment editor open");
      const image = new File([new Uint8Array([137, 80, 78, 71])], name, {
        type,
      });
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: { files: [image], getData: () => "", types: ["Files"] },
      });
      await act(async () => {
        content.dispatchEvent(event);
      });
      await settleAll();
      await settleAll();
    },
    holdImageUploads() {
      let release = () => {};
      backend.imageGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return async () => {
        backend.imageGate = Promise.resolve();
        release();
        await settleAll();
        await settleAll();
      };
    },
    async selectWords(words) {
      const body = [...host.querySelectorAll(".chat-thread-body")].find(
        (element) => element.textContent?.includes(words),
      );
      if (!body) throw new Error(`no message reads ${words}`);
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent?.includes(words))
        node = walker.nextNode();
      if (!node) throw new Error(`the words ${words} span several nodes`);
      const start = node.textContent!.indexOf(words);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + words.length);
      // happy-dom lays nothing out: the selection gets a box, as drawn.
      range.getBoundingClientRect = () =>
        ({
          x: 40,
          y: 60,
          left: 40,
          top: 60,
          right: 140,
          bottom: 76,
          width: 100,
          height: 16,
        }) as DOMRect;
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      // Released over the words, as a drag over them ends.
      const released = node.parentElement ?? body;
      await act(async () => {
        released.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
      await settleAll();
    },
    async commentOnPart(part) {
      const row = [...host.querySelectorAll("[data-part]")].find(
        (element) =>
          (element.textContent ?? "")
            .replace(
              element.querySelector(":scope > .rc-part-add")?.textContent ?? "",
              "",
            )
            .trim() === part.trim(),
      );
      const button = row?.querySelector<HTMLButtonElement>(
        'button[aria-label="Comment on this part"]',
      );
      if (!button) throw new Error(`no part ${part} to comment on`);
      await act(async () => button.click());
      await settleAll();
    },
    fileComments(path) {
      const section = sections().find((each) => pathOf(each) === path);
      return [
        ...(section?.querySelectorAll<HTMLElement>(
          ".diff-file-threads .chat-thread[data-thread-id]",
        ) ?? []),
      ].map((card) => card.textContent ?? "");
    },
    commentTexts() {
      return threadCards().map((card) => card.textContent ?? "");
    },
    async clickButton(label, index = 0) {
      // A selection's Comment is drawn over the page, out of the view.
      const found = [
        ...document.body.querySelectorAll<HTMLElement>("button, a"),
      ].filter(
        (element) =>
          (element.textContent ?? "").trim() === label ||
          element.getAttribute("aria-label") === label,
      )[index];
      if (!found) throw new Error(`no button ${label}`);
      await act(async () => found.click());
      await settleAll();
    },
    async writeInEditor(text) {
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
      // The review's line; the agent group's own when it has a bar.
      return (
        host.querySelector(".changes-review-status")?.textContent ||
        host.querySelector(".diff-agent-status")?.textContent ||
        ""
      );
    },
    focusBar() {
      return (
        host.querySelector<HTMLInputElement>(".diff-review-focusbar input")
          ?.value ?? null
      );
    },

    // The inspector's frame around Changes.
    filesShown() {
      const resource = host.querySelector(".inspector-changes-resource");
      return !!resource && !resource.classList.contains("files-tree-hidden");
    },
    diffOnly() {
      return !!host
        .querySelector(".inspector-changes-resource")
        ?.classList.contains("is-review-only");
    },
    chromeShown() {
      return !surface.diffOnly!() && surface.filesShown!();
    },
    conversationsShown() {
      return host.querySelector(".threads-panel") !== null;
    },
    shortcuts() {
      const panel = [...host.querySelectorAll(".review-keys-panel")].find(
        (each) => each.querySelector("h2")?.textContent === "Review shortcuts",
      );
      if (!panel) return null;
      return [...panel.querySelectorAll(".keys-row")].map((row) => ({
        keys: [...row.querySelectorAll("kbd")]
          .map((key) => key.textContent)
          .join(" "),
        label: row.querySelector("dd")?.textContent ?? "",
      }));
    },
    async filterShortcuts(text) {
      const input = host.querySelector<HTMLInputElement>(
        ".review-keys-panel .review-keys-filter",
      );
      if (!input) throw new Error("no shortcut list");
      await typeInto(input, text);
      await settleAll();
    },
    shortcutKeys() {
      return [...host.querySelectorAll(".keys .keys-row dt")].map((row) =>
        [...row.querySelectorAll("kbd")].map((key) => key.textContent ?? ""),
      );
    },
    vimPreference() {
      const stored = roamgateLocalStorage.getItem("vimKeys");
      return stored === null ? undefined : stored === "true";
    },
    reviewInPreference() {
      try {
        return JSON.parse(roamgateLocalStorage.getItem("reviewPrefs") ?? "{}")
          .reviewIn;
      } catch {
        return undefined;
      }
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
    view() {
      const name = view().querySelector(".diff-commit-name");
      return [...(name?.children ?? [])]
        .map((part) => part.textContent ?? "")
        .join(" ")
        .trim();
    },
    commitBar() {
      const name = view().querySelector(".diff-commit-name");
      if (!name) return null;
      return {
        head: name.querySelector(".note")?.textContent ?? "",
        subject:
          name.querySelector(":scope > span:not(.note)")?.textContent ?? "",
      };
    },
    async stepCommitBar(direction) {
      const button = view().querySelector<HTMLButtonElement>(
        `.diff-commit-bar button[title^="${direction < 0 ? "Previous" : "Next"} commit"]`,
      );
      if (!button) throw new Error("no commit bar");
      await act(async () => button.click());
      await settleAll();
    },
    commitPicker() {
      const input = host.querySelector<HTMLInputElement>(
        'input[aria-label="Search commits"]',
      );
      if (!input) return null;
      const list = input.parentElement?.querySelector("ul");
      return {
        query: input.value,
        choices: [...(list?.querySelectorAll("li") ?? [])].map((item) =>
          (
            item.querySelector("button > span:first-child")?.textContent ??
            item.textContent ??
            ""
          ).trim(),
        ),
      };
    },
    banner() {
      return (
        view().querySelector(".diff-review-changed span")?.textContent ?? null
      );
    },
    notices() {
      return [...notices];
    },

    // Time and the page.
    async advance(ms) {
      await act(async () => {
        jest.advanceTimersByTime(ms);
      });
      await settleAll();
    },
    async setPageHidden(hidden) {
      pageHidden = hidden;
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settleAll();
    },

    // The forge.
    forgeThreads() {
      return [...host.querySelectorAll<HTMLDetailsElement>("details.mrt")].map(
        (card) => ({
          id: card.dataset.threadId ?? "",
          head: (card.querySelector("summary")?.textContent ?? "").trim(),
          open: card.open,
          text: card.textContent ?? "",
        }),
      );
    },
    async toggleForgeThread(id) {
      const card = [
        ...host.querySelectorAll<HTMLDetailsElement>("details.mrt"),
      ].find((each) => each.dataset.threadId === id);
      if (!card) throw new Error(`no forge thread ${id}`);
      // A summary's click toggles its details in a browser.
      await act(async () => {
        card.open = !card.open;
        card.dispatchEvent(new Event("toggle"));
      });
      await settleAll();
    },
    linkHref(label) {
      const link = [...host.querySelectorAll("a")].find(
        (element) => (element.textContent ?? "").trim() === label,
      );
      return link?.getAttribute("href") ?? null;
    },
    modeSwitch() {
      const group = host.querySelector(
        '[role="group"][aria-label="Review mode"]',
      );
      if (!group) return null;
      return [...group.querySelectorAll("button")].map((button) => ({
        label: button.textContent ?? "",
        on: button.getAttribute("aria-pressed") === "true",
      }));
    },
    async menu(name) {
      const button = menuButton(name);
      await act(async () => button.click());
      await settleAll();
      const items = menuItems(button).map((item) => ({
        label: menuLabel(item),
        ...(item.getAttribute("role") === "menuitemcheckbox"
          ? { checked: item.getAttribute("aria-checked") === "true" }
          : {}),
        disabled: item.disabled,
      }));
      await act(async () => button.click());
      await settleAll();
      return items;
    },
    async chooseMenu(name, label) {
      const button = menuButton(name);
      await act(async () => button.click());
      await settleAll();
      const item = menuItems(button).find((each) => menuLabel(each) === label);
      if (!item) throw new Error(`no menu entry ${label}`);
      await act(async () => item.click());
      await settleAll();
    },

    // The page around the review.
    hostCalls(name) {
      return hostCalls.filter(
        (call) => name === undefined || call.name === name,
      );
    },
    closes() {
      return hostCalls.filter((call) => call.name === "close").length;
    },
    listsShown() {
      return hostCalls.filter((call) => call.name === "showList").length;
    },
    reviewsShown() {
      return hostCalls
        .filter((call) => call.name === "showReview")
        .map((call) => call.args[0]);
    },
    opened() {
      return [...opened];
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
