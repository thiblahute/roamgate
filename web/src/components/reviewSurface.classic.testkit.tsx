/**
 * The classic review pane (ReviewOverlay) behind the `ReviewSurface` test
 * kit: it answers the kit's questions by reading the pane's rows. Only this
 * file knows the pane's markup; the behavior tests do not.
 *
 * `mockClassicBackend()` must run before ReviewOverlay is imported (it
 * replaces `../review` with a bridge held in memory).
 */
import { jest, mock } from "bun:test";
import type { ReviewSnapshot, ReviewThread } from "../../../shared/review";
import {
  type BridgeUpdate,
  type HostCall,
  parseKeys,
  type ReviewSurface,
  type ShownLine,
  type ShownMessage,
  type ShownThread,
  type SurfaceOptions,
  settle as settleTimers,
} from "./reviewSurface.testkit";

type Call = { method: string; params: Record<string, unknown> };

/** What the in-memory bridge answers, for the review mounted now. */
const backend = {
  files: [] as SurfaceOptions["files"],
  texts: {} as Record<string, string>,
  calls: [] as Call[],
  /** Answers by method, over the ones below. */
  answers: {} as NonNullable<SurfaceOptions["answers"]>,
  /** The review's commits, some with their own changes. */
  commits: [] as NonNullable<SurfaceOptions["commits"]>,
  patchIds: undefined as SurfaceOptions["patchIds"],
  /** File texts by `${rev}:${path}`. */
  fileAt: {} as Record<string, string>,
  repos: [] as NonNullable<SurfaceOptions["repos"]>,
  /** Methods that fail, and with what. */
  failing: new Map<string, string>(),
  /** Methods held until released. */
  held: new Map<string, Promise<void>>(),
  /** What `review.get` answers: the review as the bridge holds it. */
  holds: null as (() => ReviewSnapshot) | null,
  /** A snapshot the review remembers (read back): shown from then on. */
  remember: (() => {}) as (snapshot: ReviewSnapshot) => void,
  /** The other reviews the bridge holds (useReviewState's sessions). */
  sessions: new Map<string, { session: unknown }>(),
  /** Image uploads wait on it while held. */
  imageGate: Promise.resolve() as Promise<void>,
};

let mocked = false;

/** Replace the bridge (`../review`) with one held here. Once per process. */
export function mockClassicBackend() {
  if (mocked) return;
  mocked = true;
  mock.module("../review", () => ({
    reviewCall: async (
      _connection: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      backend.calls.push({ method, params });
      const held = backend.held.get(method);
      if (held) await held;
      const failure = backend.failing.get(method);
      if (failure !== undefined) throw new Error(failure);
      const answer = backend.answers[method];
      if (answer) return answer(params);
      if (method === "review.get" && backend.holds) return backend.holds();
      if (method === "review.commits")
        return {
          commits: backend.commits.map((commit) => {
            const listed: Record<string, unknown> = {
              parent: null,
              author: "T",
              date: "2026-11-05",
              body: "",
              ...commit,
            };
            delete listed.files;
            return listed;
          }),
          ...(backend.patchIds ? { patchIds: backend.patchIds } : {}),
        };
      if (method === "review.state") return { state: "s" };
      if (method === "review.repos") return { repos: backend.repos };
      if (method === "review.diff") {
        // A commit's view, or all the changes; with commits of their own
        // changes the review opens on the oldest.
        const first = params.first
          ? backend.commits[0]?.files
            ? backend.commits[0]
            : null
          : null;
        const commit =
          first ??
          backend.commits.find(
            (each) => each.files && each.sha === params.commit,
          );
        return {
          files: commit?.files ?? backend.files,
          headSha: "h",
          truncated: false,
          ...(params.first ? { view: first?.sha ?? null } : {}),
        };
      }
      if (method === "review.file") {
        if (params.rev !== undefined) {
          const text = backend.fileAt[`${String(params.rev)}:${params.path}`];
          if (text !== undefined) return { text };
        }
        return { text: backend.texts[String(params.path)] ?? "" };
      }
      if (method === "review.image.add") {
        await backend.imageGate;
        return { path: `/reviews/images/${backend.calls.length}.png` };
      }
      return {};
    },
    // A snapshot read back is shown.
    rememberReviewSnapshot: (snapshot: ReviewSnapshot) => {
      if (snapshot?.session && Array.isArray(snapshot.threads))
        backend.remember(snapshot);
    },
    useReviewState: () => ({ sessions: backend.sessions, openRequest: null }),
  }));
}

function numberOf(element: Element | undefined | null): number | null {
  const text = element?.textContent ?? "";
  return text === "" ? null : Number(text);
}

/** A row's file: the `.rd-file` header drawn last before it. */
function pathBefore(row: Element, root: Element): string {
  let path = "";
  for (const element of root.querySelectorAll(".rd-file, .rl[data-at]")) {
    if (element.classList.contains("rd-file")) {
      const name = element.querySelector(".rd-name")?.textContent ?? "";
      // Its fold caret first; a rename reads "old → new".
      path = name.replace(/^[▸▾]/, "").split(" → ").pop()!.trim();
    }
    if (element === row) break;
  }
  return path;
}

/** A row as the reviewer reads it. */
function readRow(row: Element, root: Element): ShownLine {
  const path = pathBefore(row, root);
  const classes = row.classList;
  if (classes.contains("rd-hunk-done"))
    return { path, old: null, new: null, text: "", kind: "reviewed" };
  const numbers = [...row.querySelectorAll(":scope > .no")];
  const tx = row.querySelector(":scope > .tx");
  const kind: ShownLine["kind"] = classes.contains("msg")
    ? "message"
    : classes.contains("add")
      ? "+"
      : classes.contains("del")
        ? "-"
        : " ";
  // The sign column ("+", "-", " ") is the text's first character.
  let text = (tx?.textContent ?? "").slice(kind === "message" ? 0 : 1);
  // An empty line under the cursor draws one blank to show it.
  if (text === " " && tx?.querySelector(".rv-word")) text = "";
  if (classes.contains("half")) {
    const isOld = row.parentElement?.firstElementChild === row;
    const number = numberOf(numbers[0]);
    return {
      path,
      old: isOld ? number : null,
      new: isOld ? null : number,
      text,
      kind,
    };
  }
  if (kind === "message")
    return { path, old: null, new: numberOf(numbers[0]), text, kind };
  return {
    path,
    old: numberOf(numbers[0]),
    new: numberOf(numbers[1]),
    text,
    kind,
  };
}

export async function mountClassicReview(
  options: SurfaceOptions,
): Promise<ReviewSurface> {
  mockClassicBackend();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ReviewOverlay } = await import("./ReviewOverlay");
  const { EditorView } = await import("@codemirror/view");
  const { store } = await import("../store");
  const { roamgateLocalStorage } = await import("../browserStorage");

  // The browser storage it opens with, and the preferences asked for.
  if (options.storage !== "keep") {
    localStorage.clear();
    for (const [key, value] of Object.entries(options.storage ?? {}))
      localStorage.setItem(key, value);
  }
  if (options.split !== undefined)
    localStorage.setItem(
      "reviewPrefs",
      JSON.stringify({ split: options.split }),
    );
  if (options.vim !== undefined)
    localStorage.setItem(
      "reviewPrefs",
      JSON.stringify({
        ...JSON.parse(localStorage.getItem("reviewPrefs") ?? "{}"),
        vim: options.vim,
      }),
    );
  (
    window as unknown as {
      happyDOM?: {
        setWindowSize(size: { width: number; height: number }): void;
      };
    }
  ).happyDOM?.setWindowSize({ width: options.width ?? 1024, height: 768 });

  // The bridge.
  backend.files = options.files;
  backend.texts = options.texts ?? {};
  backend.calls = [];
  backend.answers = options.answers ?? {};
  backend.commits = options.commits ?? [];
  backend.patchIds = options.patchIds;
  backend.fileAt = options.fileAt ?? {};
  backend.repos = options.repos ?? [];
  backend.failing.clear();
  backend.held.clear();
  backend.holds = null;
  backend.imageGate = Promise.resolve();
  backend.sessions = new Map(
    (options.otherReviews ?? []).map((session) => [
      String(session.id),
      { session },
    ]),
  );
  let marks: Record<string, string> = { ...(options.reviewed ?? {}) };
  let applied = 0;
  const sessionId = options.sessionId ?? "s1";
  let sessionFields: Record<string, unknown> = { ...(options.session ?? {}) };
  let threads: ReviewThread[] = options.threads ?? [];
  let pushed: Partial<ReviewSnapshot> = {
    ...(options.mergeRequest ? { mergeRequest: options.mergeRequest } : {}),
    ...(options.gitlabError ? { gitlabError: options.gitlabError } : {}),
  };
  let hidden = options.hidden ?? false;

  // Time: Bun's fake clock when asked; settling then runs on setImmediate,
  // which the fake clock leaves running.
  const fake = options.fakeTimers === true;
  if (fake) jest.useFakeTimers();
  const settle = fake
    ? async (rounds = 10) => {
        for (let i = 0; i < rounds; i++) {
          jest.advanceTimersByTime(0);
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    : settleTimers;

  // The app's notices, from a clean slate.
  store.clearNotice();
  const notices: string[] = [];
  let lastNotice: unknown = store.get().notice;
  const stopNotices = store.subscribe(() => {
    const notice = store.get().notice;
    if (notice && notice !== lastNotice) notices.push(notice.message);
    lastNotice = notice;
  }) as () => void;

  // The page around the review: its host's callbacks, new tabs, visibility.
  const hostCalls: HostCall[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      hostCalls.push({ name, args });
    };
  const openedFiles: { path: string; line?: number; rendered?: boolean }[] = [];
  const onOpenFile = (path: string, line?: number, rendered?: boolean) => {
    record("openFile")(path, line, rendered);
    openedFiles.push({
      path,
      ...(line !== undefined ? { line } : {}),
      ...(rendered ? { rendered } : {}),
    });
  };
  const callbacks = {
    onClose: record("close"),
    onShowList: record("showList"),
    onShowReview: record("showReview"),
    ...(options.hostCallbacks
      ? {
          onFocusAgentPane: record("focusAgentPane"),
          onOpenRepo: record("openRepo"),
          onOpenLocal: record("openLocal"),
        }
      : {}),
    ...(options.hostCallbacks || options.openFiles ? { onOpenFile } : {}),
  };
  const opened: string[] = [];
  Object.defineProperty(window, "open", {
    value: (url?: string | URL) => {
      opened.push(String(url));
      return null;
    },
    configurable: true,
    writable: true,
  });
  let pageHidden = false;
  Object.defineProperty(document, "hidden", {
    get: () => pageHidden,
    configurable: true,
  });

  const screen = await setUpScreen(options);
  const host = document.createElement("div");
  document.body.append(host);
  screen.attach(host);
  let root = createRoot(host);
  const snapshot = () =>
    ({
      session: {
        id: sessionId,
        connectionId: "desktop",
        workspaceId: "w1",
        root: "/repo",
        title: "Review",
        target: { kind: "worktree" },
        gitlab: false,
        summary: "",
        agent: {},
        reviewed: marks,
        createdAt: "2026-10-30",
        updatedAt: "2026-10-30",
        ...sessionFields,
      },
      threads,
      ...(options.shared ? { shared: options.shared } : {}),
      ...pushed,
    }) as unknown as ReviewSnapshot;
  const render = () =>
    act(async () => {
      root.render(
        <ReviewOverlay
          snapshot={snapshot()}
          connectionId="desktop"
          hidden={hidden}
          repoDirs={options.repoDirs}
          agentDirs={options.agentDirs}
          agentPanes={options.agentPanes}
          {...callbacks}
        />,
      );
    });
  /** A new state of the review, as the bridge pushes it. */
  const apply = (update: BridgeUpdate) => {
    if (update.threads) threads = update.threads;
    if (update.session) sessionFields = { ...sessionFields, ...update.session };
    if (update.mergeRequest)
      pushed = { ...pushed, mergeRequest: update.mergeRequest };
    if (update.gitlabError !== undefined)
      pushed = { ...pushed, gitlabError: update.gitlabError };
  };
  /**
   * A snapshot of this review read back, shown once the surface settles
   * (another review's, such as the one a switch opens, is not this one's).
   */
  let remembered: ReviewSnapshot | null = null;
  backend.remember = (read) => {
    if ((read.session as { id?: string }).id === sessionId) remembered = read;
  };
  /** The marks each review.update wrote, applied as the bridge does. */
  const syncMarks = async () => {
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
    await render();
    await act(settle);
  };
  const settleAll = async () => {
    await act(settle);
    await syncMarks();
    const readBack = remembered as ReviewSnapshot | null;
    if (readBack) {
      remembered = null;
      // Its reviewed marks are the surface's own (reviewedMarks()).
      const session = {
        ...(readBack.session as unknown as Record<string, unknown>),
      };
      delete session.reviewed;
      apply({ threads: readBack.threads, session });
      await render();
      await act(settle);
    }
  };
  await render();
  await act(settle);
  await act(settle);

  const overlay = () => host.querySelector<HTMLElement>(".review-overlay")!;
  const diffRoot = () => host.querySelector(".review-diff") ?? host;
  const cursorRow = () => host.querySelector(".review-diff .rl.cur");

  const keydown = (target: Element, stroke: ReturnType<typeof parseKeys>[0]) =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        ...stroke,
        bubbles: true,
        cancelable: true,
      }),
    );
  /** Set an input's value as typing does, for React to see. */
  const typeInto = async (input: HTMLInputElement, text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input),
        "value",
      )!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const fileName = (header: Element) =>
    (header.querySelector(".rd-name")?.textContent ?? "")
      .replace(/^[▸▾]/, "")
      .split(" → ")
      .pop()!
      .trim();
  const fileHeader = (path: string) => {
    const header = [...diffRoot().querySelectorAll(".rd-file")].find(
      (each) => fileName(each) === path,
    );
    if (!header) throw new Error(`no file ${path}`);
    return header;
  };

  // The comment editor (CodeMirror).
  const editorView = () => {
    const content =
      host.querySelector<HTMLElement>(".rc-editor .cm-content") ??
      host.querySelector<HTMLElement>(".cm-content");
    return content ? EditorView.findFromDOM(content) : null;
  };
  /** The open editor's own buttons (Save, Suggest, Esc...). */
  const editorBarButtons = () =>
    [...host.querySelectorAll(".rc-editor")].flatMap((editor) => [
      ...(editor.parentElement?.querySelectorAll<HTMLButtonElement>(
        ":scope > .rc-bar button",
      ) ?? []),
    ]);

  // Threads as drawn.
  /** Thread ids by their first comment's id. */
  const threadOf = (commentId: string | null) => {
    const known = [...threads, ...(options.shared ?? [])];
    return (
      known.find((thread) => thread.comments[0]?.id === commentId)?.id ??
      known.find((thread) =>
        thread.comments.some((comment) => comment.id === commentId),
      )?.id ??
      null
    );
  };
  const buttonsIn = (element: Element) =>
    [...element.querySelectorAll(":scope > .rc-bar button")].map(
      (button) => button.textContent ?? "",
    );
  /** A message's words, without its parts' "+" buttons. */
  const messageText = (body: Element | null) => {
    if (!body) return "";
    const copy = body.cloneNode(true) as Element;
    for (const add of copy.querySelectorAll(".rc-part-add")) add.remove();
    return (copy.textContent ?? "").trim();
  };
  const readMessage = (element: Element): ShownMessage => {
    const bar = element.querySelector(":scope > .rc-bar");
    return {
      id: element.getAttribute("data-comment-id") ?? "",
      text: messageText(element.querySelector(".rc-text")),
      marks: [...(bar?.querySelectorAll(".rc-kind") ?? [])].map(
        (mark) => mark.textContent ?? "",
      ),
      buttons: [...(bar?.querySelectorAll("button") ?? [])].map(
        (button) => button.textContent ?? "",
      ),
      selected: element.classList.contains("focused"),
      pending: !element.classList.contains("rc-pending")
        ? null
        : bar?.querySelector(".rc-failed")
          ? "failed"
          : "sending",
    };
  };
  const threadElements = () =>
    [...host.querySelectorAll(".review-main .rc")].filter(
      (element) =>
        !element.closest(".threads-panel") &&
        !element.querySelector(":scope > .rc-editor"),
    );
  const readThread = (element: Element): ShownThread => {
    const general = element.closest(".review-mr") !== null;
    if (element.classList.contains("folded")) {
      const id = element.getAttribute("data-comment-id");
      return {
        id: threadOf(id),
        general,
        folded: true,
        resolved: element.classList.contains("resolved"),
        summary: element.querySelector(".rc-fold-text")?.textContent ?? "",
        messages: [],
        buttons: [],
        working: null,
      };
    }
    const messages = [
      ...element.querySelectorAll(":scope > [data-comment-id]"),
    ].map(readMessage);
    return {
      id: threadOf(messages[0]?.id ?? null),
      general,
      folded: false,
      resolved: element.classList.contains("resolved"),
      summary: "",
      messages,
      buttons: buttonsIn(element),
      working: element.querySelector(".rc-working")?.textContent ?? null,
    };
  };
  const threadElement = (threadId: string) => {
    const element = threadElements().find(
      (each) => readThread(each).id === threadId,
    );
    if (!element) throw new Error(`no thread ${threadId} shown`);
    return element;
  };
  /** The view button that shows or hides every comment. */
  const commentsButton = () =>
    [...host.querySelectorAll("button")].find((button) =>
      button.getAttribute("title")?.includes("(t, :comments)"),
    );
  const clickOn = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleAll();
  };
  /** A forge discussion card's thread: its id, else its first message's. */
  const forgeThreadId = (card: HTMLElement) => {
    if (card.dataset.threadId) return card.dataset.threadId;
    const first = card
      .querySelector("[data-comment-id]")
      ?.getAttribute("data-comment-id");
    return (
      threads.find((thread) =>
        thread.comments.some((comment) => comment.id === first),
      )?.id ?? ""
    );
  };

  // The head's menus and the commit bar.
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
  const commitBarElement = () =>
    host.querySelector(
      overlay()?.classList.contains("zen")
        ? ".review-zen-commits"
        : ".review-commits",
    );

  const surface: ReviewSurface = {
    name: "classic",
    cursorLine() {
      const row = cursorRow();
      return row ? readRow(row, diffRoot()) : null;
    },
    cursorSide() {
      const row = cursorRow();
      if (!row || !row.closest(".review-diff.split")) return null;
      if (!row.classList.contains("half")) return "both";
      return row.parentElement?.firstElementChild === row ? "old" : "new";
    },
    cursorWord() {
      const tx = cursorRow()?.querySelector(":scope > .tx");
      if (!tx) return null;
      // The sign column first, then the line, the word under the cursor
      // marked (possibly split by syntax marks).
      let offset = -1;
      let start = -1;
      let text = "";
      for (const node of tx.childNodes) {
        const value = node.textContent ?? "";
        const marked =
          node instanceof Element && node.classList.contains("rv-word");
        if (marked) {
          if (start < 0) start = Math.max(0, offset);
          text += value;
        } else if (start >= 0) break;
        offset += value.length;
      }
      return start < 0 ? null : { start, text };
    },
    lines(path) {
      const root = diffRoot();
      return [...root.querySelectorAll(".rl[data-at]")]
        .map((row) => readRow(row, root))
        .filter((line) => path === undefined || line.path === path);
    },
    selection() {
      const root = diffRoot();
      return [...root.querySelectorAll(".rl.in-sel[data-at]")].map((row) =>
        readRow(row, root),
      );
    },
    sideBySide() {
      return host.querySelector(".review-diff.split") !== null;
    },
    text() {
      return host.textContent ?? "";
    },
    async press(keys) {
      for (const stroke of parseKeys(keys)) {
        const active = document.activeElement;
        const target =
          active && host.contains(active) && active !== document.body
            ? active
            : overlay();
        await act(async () => {
          keydown(target, stroke);
        });
      }
      await settleAll();
    },
    async command(text) {
      await surface.press(":");
      const input = host.querySelector<HTMLInputElement>(
        'input[aria-label="Command"]',
      );
      if (!input) throw new Error("no command prompt");
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(input),
          "value",
        )!.set!.call(input, text.replace(/^:/, ""));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        keydown(input, { key: "Enter" });
      });
      await settleAll();
    },
    async click(line, shift = false) {
      const root = diffRoot();
      const row = [...root.querySelectorAll(".rl[data-at]")].find((element) => {
        const shown = readRow(element, root);
        return (
          shown.path === line.path &&
          (line.new === undefined || shown.new === line.new) &&
          (line.old === undefined || shown.old === line.old) &&
          (line.text === undefined || shown.text === line.text)
        );
      });
      if (!row) throw new Error(`no line ${JSON.stringify(line)}`);
      await act(async () => {
        row.dispatchEvent(
          new MouseEvent("click", { bubbles: true, shiftKey: shift }),
        );
      });
      await settleAll();
    },
    gaps(path) {
      const found: { label: string; buttons: string[] }[] = [];
      let current = "";
      for (const element of diffRoot().querySelectorAll(
        ".rd-file, .rd-expand",
      )) {
        if (element.classList.contains("rd-file")) {
          current = (element.querySelector(".rd-name")?.textContent ?? "")
            .replace(/^[▸▾]/, "")
            .split(" → ")
            .pop()!
            .trim();
          continue;
        }
        if (current !== path) continue;
        found.push({
          label: element.querySelector(".note")?.textContent ?? "",
          buttons: [...element.querySelectorAll("button")].map(
            (button) => button.textContent ?? "",
          ),
        });
      }
      return found;
    },
    async expandGap(path, index, label) {
      let current = "";
      let seen = -1;
      for (const element of diffRoot().querySelectorAll(
        ".rd-file, .rd-expand",
      )) {
        if (element.classList.contains("rd-file")) {
          current = (element.querySelector(".rd-name")?.textContent ?? "")
            .replace(/^[▸▾]/, "")
            .split(" → ")
            .pop()!
            .trim();
          continue;
        }
        if (current !== path || ++seen !== index) continue;
        const button = [
          ...element.querySelectorAll<HTMLButtonElement>("button"),
        ].find((each) => each.textContent === label);
        if (!button) throw new Error(`no gap button ${label}`);
        await act(async () => button.click());
        await settleAll();
        return;
      }
      throw new Error(`no gap ${index} in ${path}`);
    },
    async goToFile(path) {
      const button = host.querySelector<HTMLButtonElement>(
        `.review-files button[title="${path}"]`,
      );
      if (!button) throw new Error(`no file ${path} in the list`);
      await act(async () => button.click());
      await settleAll();
    },
    fileReviewed(path) {
      const button = host.querySelector(
        `.review-files button[title="${path}"]`,
      );
      return button?.querySelector(".rf-check.done") != null;
    },
    chunkProgress(path) {
      const chunks = host.querySelector(
        `.review-files button[title="${path}"] .rf-chunks`,
      );
      return chunks?.textContent?.replace(/ chunks$/, "") ?? null;
    },
    reviewedMarks() {
      return { ...marks };
    },
    async reload() {
      await act(async () => root.unmount());
      root = createRoot(host);
      await render();
      await act(settle);
      await act(settle);
    },
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
      stopNotices();
      screen.restore();
      if (fake) jest.useRealTimers();
    },
    shortcutKeys() {
      return [...host.querySelectorAll(".keys .keys-row dt")].map((row) =>
        [...row.querySelectorAll("kbd")].map((key) => key.textContent ?? ""),
      );
    },

    // Showing and the screen.
    async setHidden(value) {
      hidden = value;
      await render();
    },
    hasFocus() {
      // A browser drops the focus of an element hidden; happy-dom keeps it.
      const active = document.activeElement;
      const root = overlay();
      return active !== null && !root.hidden && root.contains(active);
    },
    async advance(ms) {
      await act(async () => {
        jest.advanceTimersByTime(ms);
      });
      if (fake) await settleAll();
    },
    async setPageHidden(value) {
      pageHidden = value;
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settleAll();
    },
    screenLines() {
      const root = diffRoot();
      return screen
        .screenRows()
        .map((row) => readRow(row, root))
        .filter((line) => line.kind !== "message");
    },
    async systemBack() {
      await screen.back(act);
      await settleAll();
    },
    control(label) {
      const element = [
        ...host.querySelectorAll<HTMLElement>("button, [role='button']"),
      ].find(
        (each) =>
          each.getAttribute("aria-label") === label ||
          each.title === label ||
          // A title naming its keys: "Close (Esc, :q)".
          each.title.startsWith(`${label} (`) ||
          each.textContent === label,
      );
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        minHeight: Number.parseFloat(style.minHeight) || 0,
        sticky: style.position === "sticky",
      };
    },

    // What is shown.
    filesShown() {
      // Hidden by `f` / :files: the pane draws it, styled away; with the
      // stylesheet, as it lays the list out (a narrow window hides it).
      const files = host.querySelector(".review-files");
      if (!files || overlay().classList.contains("no-files")) return false;
      return !options.styles || screen.shown(files);
    },
    chromeShown() {
      return (
        screen.shown(host.querySelector(".review-head")) &&
        screen.shown(host.querySelector(".review-files"))
      );
    },
    diffOnly() {
      return overlay().classList.contains("zen");
    },
    view() {
      const name = host.querySelector(".review-commit-name");
      return [...(name?.children ?? [])]
        .map((part) => part.textContent ?? "")
        .join(" ")
        .trim();
    },
    commitBar() {
      const name = commitBarElement()?.querySelector(".review-commit-name");
      if (!name) return null;
      return {
        head: name.querySelector(".note")?.textContent ?? "",
        subject:
          name.querySelector(":scope > span:not(.note)")?.textContent ?? "",
      };
    },
    async stepCommitBar(direction) {
      const button = commitBarElement()?.querySelector<HTMLButtonElement>(
        `button[title^="${direction < 0 ? "Previous" : "Next"} commit"]`,
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
    repoChooser() {
      const select = host.querySelector<HTMLSelectElement>(
        'select[aria-label="Repository"]',
      );
      if (!select) return null;
      return {
        choices: [...select.options].map((option) => option.textContent ?? ""),
        value: select.value,
      };
    },
    banner() {
      return host.querySelector(".review-changed span")?.textContent ?? null;
    },
    status() {
      return host.querySelector("#review-status")?.textContent ?? "";
    },
    notice() {
      return (
        (store.get() as { notice?: { message?: string } | null }).notice
          ?.message ?? null
      );
    },
    notices() {
      return [...notices];
    },
    buttons() {
      return [...host.querySelectorAll("button, a")]
        .filter((element) => element.closest(".rv-menu") === null)
        .map(
          (element) =>
            (element.textContent ?? "").trim() ||
            element.getAttribute("aria-label") ||
            "",
        );
    },
    async clickButton(label, index = 0) {
      const found = [...host.querySelectorAll<HTMLElement>("button, a")].filter(
        (element) =>
          (element.textContent ?? "").trim() === label ||
          element.getAttribute("aria-label") === label,
      )[index];
      if (!found) throw new Error(`no button ${label}`);
      await act(async () => found.click());
      await settleAll();
    },
    linkHref(label) {
      const link = [...host.querySelectorAll("a")].find(
        (element) => (element.textContent ?? "").trim() === label,
      );
      return link?.getAttribute("href") ?? null;
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
    focusBar() {
      return (
        host.querySelector<HTMLInputElement>(".review-focusbar input")?.value ??
        null
      );
    },

    // Files.
    fileFolded(path) {
      return fileHeader(path).querySelector(".rd-caret")?.textContent === "▸";
    },
    fileButtons(path) {
      return [...fileHeader(path).querySelectorAll("button:not(.rd-name)")].map(
        (button) => button.textContent ?? "",
      );
    },
    async clickFileHeader(path, label) {
      const header = fileHeader(path);
      const button =
        label === undefined
          ? header.querySelector<HTMLButtonElement>(".rd-name")
          : [
              ...header.querySelectorAll<HTMLButtonElement>(
                "button:not(.rd-name)",
              ),
            ].find((each) => each.textContent === label);
      if (!button) throw new Error(`no button ${label} on ${path}`);
      await act(async () => button.click());
      await settleAll();
    },

    // Search, the `:` prompt and the shortcut list.
    async search(pattern) {
      await surface.press("/");
      const input = host.querySelector<HTMLInputElement>(
        'input[aria-label="Search"]',
      );
      if (!input) throw new Error("no search prompt");
      await typeInto(input, pattern);
      await act(async () => {
        keydown(input, { key: "Enter" });
      });
      await settleAll();
    },
    searchLine() {
      const lines = [...host.querySelectorAll(".review-searchline")]
        .map((line) => line.textContent ?? "")
        .filter((text) => !text.startsWith("-- VISUAL"));
      return lines[0] ?? null;
    },
    filesMatching() {
      return [...host.querySelectorAll(".review-files button[title]")]
        .filter((button) => button.querySelector(".rf-name mark") !== null)
        .map((button) => button.getAttribute("title") ?? "");
    },
    async typeCommand(text) {
      await surface.press(":");
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
      const input = host.querySelector<HTMLInputElement>("#review-keys-filter");
      if (!input) throw new Error("no shortcut list");
      await typeInto(input, text);
      await settleAll();
    },
    vimPreference() {
      try {
        return JSON.parse(roamgateLocalStorage.getItem("reviewPrefs") ?? "{}")
          .vim;
      } catch {
        return undefined;
      }
    },

    // The comment editor.
    editorOpen() {
      return host.querySelector(".rc-editor") !== null;
    },
    editor() {
      const view = editorView();
      if (!view) return null;
      return {
        placeholder: surface.editorPlaceholder() ?? "",
        text: view.state.doc.toString(),
      };
    },
    editorText() {
      return editorView()?.state.doc.toString() ?? null;
    },
    editorPlaceholder() {
      const view = editorView();
      if (!view) return null;
      const placeholder = view.dom.querySelector(".cm-placeholder");
      return (
        placeholder?.getAttribute("aria-label") ??
        placeholder?.textContent ??
        view.contentDOM.getAttribute("aria-placeholder")
      );
    },
    async type(text) {
      const view = editorView();
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
      const view = editorView();
      if (!view) throw new Error("no comment editor open");
      await act(async () =>
        view.dispatch({
          changes: { from: view.state.doc.length, insert: text },
        }),
      );
    },
    async writeInEditor(text) {
      const view = editorView();
      if (!view) throw new Error("no comment editor open");
      await act(async () =>
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        }),
      );
      await settleAll();
    },
    async editorPress(keys) {
      for (const stroke of parseKeys(keys)) {
        const content = host.querySelector(".rc-editor .cm-content");
        if (!content) throw new Error("no comment editor open");
        await act(async () => {
          keydown(content, stroke);
        });
      }
      await settleAll();
    },
    async editorCommand(text) {
      const view = editorView();
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
    async pasteImage(name, type = "image/png") {
      const content = host.querySelector(".rc-editor .cm-content");
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
      const body = [...host.querySelectorAll("[data-comment-id]")].find(
        (element) =>
          element.querySelector(".rc-text")?.textContent?.includes(words),
      );
      if (!body) throw new Error(`no message reads ${words}`);
      const walker = document.createTreeWalker(
        body.querySelector(".rc-text")!,
        NodeFilter.SHOW_TEXT,
      );
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
      await act(async () => {
        body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
      await settleAll();
    },
    async commentOnPart(part) {
      const row = [...host.querySelectorAll("[data-part]")].find(
        (element) => element.textContent?.trim() === part.trim(),
      );
      const button = row?.querySelector<HTMLButtonElement>(
        'button[aria-label="Comment on this part"]',
      );
      if (!button) throw new Error(`no part ${part} to comment on`);
      await act(async () => button.click());
      await settleAll();
    },

    // Threads.
    shownThreads() {
      return threadElements().map(readThread);
    },
    fileComments(path) {
      const found: string[] = [];
      let current = "";
      const root = diffRoot();
      for (const element of root.querySelectorAll(
        ".rd-file, .rl[data-at], .rc",
      )) {
        if (element.classList.contains("rd-file")) {
          current = fileName(element);
          continue;
        }
        if (current !== path) continue;
        if (element.matches(".rl[data-at]")) {
          if (pathBefore(element, root) === path) current = "";
          continue;
        }
        found.push(element.textContent ?? "");
      }
      return found;
    },
    commentTexts() {
      return [...diffRoot().querySelectorAll(".rc")]
        .filter((box) => !box.querySelector(".rc-editor"))
        .map((box) => box.textContent ?? "");
    },
    async threadButton(threadId, label, message) {
      const element = threadElement(threadId);
      const scope =
        message === undefined
          ? element.querySelector(":scope > .rc-bar")
          : element.querySelectorAll(":scope > [data-comment-id]")[message];
      const button = [
        ...(scope?.querySelectorAll<HTMLButtonElement>(
          message === undefined ? "button" : ":scope > .rc-bar button",
        ) ?? []),
      ].find((each) => each.textContent === label);
      if (!button) throw new Error(`no button ${label} on ${threadId}`);
      await act(async () => button.click());
      await settleAll();
    },
    async clickThread(threadId, message = 0) {
      const element = threadElement(threadId);
      if (element.classList.contains("folded")) return clickOn(element);
      const target = element.querySelectorAll(":scope > [data-comment-id]")[
        message
      ];
      if (!target) throw new Error(`no message ${message} on ${threadId}`);
      await clickOn(target);
    },
    commentsShown() {
      return !overlay().classList.contains("hide-comments");
    },
    commentsHidden() {
      return commentsButton()?.getAttribute("aria-pressed") === "false";
    },
    hiddenBadge() {
      const button = commentsButton();
      const badge = button?.querySelector(".rv-badge")?.textContent;
      const count =
        badge ?? button?.textContent?.match(/^Show (\d+) hidden/)?.[1];
      return count ? Number(count) : null;
    },
    markedLines() {
      const root = diffRoot();
      return [...root.querySelectorAll(".rl.has[data-at]")].map((row) =>
        readRow(row, root),
      );
    },
    forgeThreads() {
      return [...host.querySelectorAll<HTMLDetailsElement>("details.mrt")].map(
        (card) => ({
          id: forgeThreadId(card),
          head: (card.querySelector("summary")?.textContent ?? "").trim(),
          open: card.open,
          text: card.textContent ?? "",
        }),
      );
    },
    async toggleForgeThread(id) {
      const card = [
        ...host.querySelectorAll<HTMLDetailsElement>("details.mrt"),
      ].find((each) => forgeThreadId(each) === id);
      if (!card) throw new Error(`no forge thread ${id}`);
      // A summary's click toggles its details in a browser.
      await act(async () => {
        card.open = !card.open;
        card.dispatchEvent(new Event("toggle"));
      });
      await settleAll();
    },
    conversationsShown() {
      // The shared threads panel (a dialog, or docked), or the review's own
      // list before it.
      return (
        host.querySelector(
          '[role="dialog"][aria-label="Conversations"], .review-threads-panel, .review-keys-panel.review-threads',
        ) !== null ||
        [...host.querySelectorAll(".review-keys-panel h2")].some(
          (title) => title.textContent === "Conversations",
        )
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

    // The bridge.
    calls(method) {
      return backend.calls
        .filter((call) => method === undefined || call.method === method)
        .map((call) => ({ ...call }));
    },
    async push(update) {
      apply(update);
      await render();
      await settleAll();
    },
    bridgeHolds(next) {
      backend.holds = () => {
        const update = typeof next === "function" ? next() : next;
        const held = snapshot() as unknown as {
          session: Record<string, unknown>;
          threads: ReviewThread[];
        };
        const session = { ...held.session, ...(update.session ?? {}) };
        delete session.reviewed;
        return {
          session,
          threads: update.threads ?? threads,
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
            await settle();
          });
          backend.failing.delete(method);
          await settleAll();
        },
      };
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
    openedFiles() {
      return [...openedFiles];
    },
    opened() {
      return [...opened];
    },
  };
  return surface;
}

const LINE_HEIGHT = 20;

/**
 * The window of the first DOM installed in this process: the one modules
 * imported with it (systemBack's popstate listener) stay on when several
 * test files share a process, each with its own window.
 */
const firstWindow = window;

/**
 * The screen one mounted review is shown on: a layout of lines, a touch
 * screen, the phone's layout and history, the stylesheet. `restore` undoes
 * it.
 */
async function setUpScreen(options: SurfaceOptions) {
  const restores: (() => void)[] = [];
  const layout: { screenRows?: () => Element[] } = {};
  let host: HTMLElement | null = null;

  if (options.styles) {
    const style = document.createElement("style");
    style.textContent = await Bun.file(
      new URL("./ReviewOverlay.css", import.meta.url).pathname,
    ).text();
    document.head.append(style);
    restores.push(() => style.remove());
  }

  if (options.coarse) {
    const navigatorObject = window.navigator as unknown as object;
    Object.defineProperty(navigatorObject, "maxTouchPoints", {
      value: 5,
      configurable: true,
    });
    const before = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
    Object.defineProperty(globalThis, "matchMedia", {
      value: window.matchMedia.bind(window),
      configurable: true,
      writable: true,
    });
    restores.push(() => {
      Object.defineProperty(navigatorObject, "maxTouchPoints", {
        value: 0,
        configurable: true,
      });
      if (before) Object.defineProperty(globalThis, "matchMedia", before);
      else delete (globalThis as { matchMedia?: unknown }).matchMedia;
    });
  }

  // The phone: mobile mode and a session history Back walks (happy-dom has
  // none), each Back completing as a task, as browsers do.
  const history = {
    entries: [{ state: null as unknown }],
    index: 0,
  };
  if (options.phone) {
    const fake = {
      get state() {
        return history.entries[history.index]!.state;
      },
      get length() {
        return history.entries.length;
      },
      pushState(value: unknown) {
        history.entries = history.entries.slice(0, history.index + 1);
        history.entries.push({ state: value });
        history.index++;
      },
      replaceState(value: unknown) {
        history.entries[history.index] = { state: value };
      },
      back() {
        move(-1);
      },
      forward() {
        move(1);
      },
    };
    const move = (delta: number) =>
      setTimeout(() => {
        const next = history.index + delta;
        if (next < 0 || next >= history.entries.length) return;
        history.index = next;
        const PopState = (
          firstWindow as unknown as {
            PopStateEvent: new (
              type: string,
              init: { state: unknown },
            ) => Event;
          }
        ).PopStateEvent;
        firstWindow.dispatchEvent(
          new PopState("popstate", { state: fake.state }),
        );
      }, 0);
    const before = Object.getOwnPropertyDescriptor(window, "history");
    Object.defineProperty(window, "history", {
      value: fake,
      configurable: true,
    });
    const { initializeLayoutPreferences, updateLayoutPreferences } =
      await import("../layoutPreferences");
    initializeLayoutPreferences();
    updateLayoutPreferences({ mode: "mobile" });
    restores.push(() => {
      updateLayoutPreferences({ mode: "auto" });
      if (before) Object.defineProperty(window, "history", before);
    });
  }

  if (options.viewport !== undefined) {
    const height = options.viewport * LINE_HEIGHT;
    let scrolled = 0;
    const proto = Element.prototype as unknown as {
      getBoundingClientRect: () => DOMRect;
      scrollIntoView: (arg?: unknown) => void;
      scrollTo: (arg?: unknown) => void;
    };
    const rect = proto.getBoundingClientRect;
    const into = proto.scrollIntoView;
    const scrollTo = proto.scrollTo;
    const main = () => host?.querySelector<HTMLElement>(".review-main") ?? null;
    /** Each drawn line, a side by side row as one, top to bottom. */
    const slots = () => {
      const found: Element[] = [];
      for (const element of main()?.querySelectorAll("[data-at]") ?? []) {
        const slot = element.closest(".srow") ?? element;
        if (found[found.length - 1] !== slot) found.push(slot);
      }
      return found;
    };
    const slotOf = (element: Element) => {
      const row = element.closest("[data-at]");
      if (!row || !main()?.contains(row)) return -1;
      return slots().indexOf(row.closest(".srow") ?? row);
    };
    const box = (top: number, size: number) =>
      ({
        top,
        bottom: top + size,
        left: 0,
        right: 800,
        width: 800,
        height: size,
        x: 0,
        y: top,
      }) as DOMRect;
    const clamp = (value: number) =>
      Math.max(
        0,
        Math.min(value, Math.max(0, slots().length * LINE_HEIGHT - height)),
      );
    proto.getBoundingClientRect = function (this: Element) {
      if (this === main()) return box(0, height);
      const slot = slotOf(this);
      if (slot < 0) return rect.call(this);
      return box(slot * LINE_HEIGHT - scrolled, LINE_HEIGHT);
    };
    proto.scrollIntoView = function (this: Element, arg?: unknown) {
      const slot = slotOf(this);
      if (slot < 0) return into.call(this, arg);
      const block =
        (typeof arg === "object" && arg !== null
          ? (arg as { block?: string }).block
          : undefined) ?? "start";
      const top = slot * LINE_HEIGHT;
      if (block === "start") scrolled = clamp(top);
      else if (block === "end") scrolled = clamp(top + LINE_HEIGHT - height);
      else if (block === "center")
        scrolled = clamp(top - (height - LINE_HEIGHT) / 2);
      else if (top < scrolled) scrolled = clamp(top);
      else if (top + LINE_HEIGHT > scrolled + height)
        scrolled = clamp(top + LINE_HEIGHT - height);
    };
    proto.scrollTo = function (this: Element, arg?: unknown) {
      if (this !== main()) return scrollTo?.call(this, arg);
      const top =
        typeof arg === "object" && arg !== null
          ? (arg as { top?: number }).top
          : undefined;
      if (top !== undefined) scrolled = clamp(top);
    };
    restores.push(() => {
      proto.getBoundingClientRect = rect;
      proto.scrollIntoView = into;
      proto.scrollTo = scrollTo;
    });
    layout.screenRows = () => {
      const rows: Element[] = [];
      slots().forEach((slot, index) => {
        const top = index * LINE_HEIGHT - scrolled;
        if (top < 0 || top + LINE_HEIGHT > height) return;
        // A side by side row: its added half, else its only one.
        const lines = [...slot.querySelectorAll("[data-at]")];
        rows.push(slot.matches("[data-at]") ? slot : lines[lines.length - 1]!);
      });
      return rows;
    };
  }

  return {
    attach(element: HTMLElement) {
      host = element;
    },
    screenRows(): Element[] {
      if (!layout.screenRows) throw new Error("no viewport: mount with one");
      return layout.screenRows();
    },
    /** Shown: neither it nor a parent has display: none. */
    shown(element: Element | null): boolean {
      if (!options.styles) throw new Error("mount with styles to see this");
      if (!element) return false;
      for (
        let at: Element | null = element;
        at && at !== document.body;
        at = at.parentElement
      )
        if (getComputedStyle(at).display === "none") return false;
      return true;
    },
    async back(act: (callback: () => Promise<void>) => Promise<void>) {
      if (!options.phone) throw new Error("mount as a phone for its Back");
      await act(async () => {
        window.history.back();
        await settleTimers();
      });
    },
    restore() {
      for (const undo of restores.reverse()) undo();
    },
  };
}
