/**
 * The review's bridge held in memory, and the screen a mounted review is
 * shown on (a touch screen, the phone's layout and history, stylesheets),
 * for the shared behavior tests' review surface (reviewSurface.changes).
 *
 * `mockReviewBackend()` must run before the review's modules are imported
 * (it replaces `../review` with a bridge held in memory).
 */
import { mock } from "bun:test";
import type {
  ReviewDiffFile,
  ReviewFileStatus,
  ReviewSnapshot,
} from "../../../shared/review";
import {
  type SurfaceOptions,
  settle as settleTimers,
} from "./reviewSurface.testkit";
import { mockReviewStore } from "../reviewState.testkit";

type Call = { method: string; params: Record<string, unknown> };

/** What the in-memory bridge answers, for the review mounted now. */
export const backend = {
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
  /**
   * `review.diff` answers summaries when asked (the files read a few at a
   * time after), as the bridge does; false: the whole diff, as an older
   * bridge or GitLab's whole diff of a merge request.
   */
  summaries: true,
  /** Methods that fail, and with what (an Error as it is: its code too). */
  failing: new Map<string, string | Error>(),
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
  /** The connection is up: calls reach the bridge. */
  connected: true,
  /** Told when the connection goes down or comes back. */
  connectionListeners: new Set<() => void>(),
};

let mocked = false;

/** Replace the bridge (`../review`) with one held here. Once per process. */
export function mockReviewBackend() {
  if (mocked) return;
  mocked = true;
  mock.module("../review", () => ({
    reviewCall: async (
      _connection: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      backend.calls.push({ method, params });
      if (!backend.connected) throw new Error("bridge hello is unavailable");
      const held = backend.held.get(method);
      if (held) await held;
      const failure = backend.failing.get(method);
      if (failure !== undefined)
        throw typeof failure === "string" ? new Error(failure) : failure;
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
        // The server's `first`: the oldest commit's view (its own files, or
        // the review's when the commit lists none), else all the changes.
        const first = params.first ? (backend.commits[0] ?? null) : null;
        const commit =
          first ??
          backend.commits.find(
            (each) => each.files && each.sha === params.commit,
          );
        const files = (commit?.files ?? backend.files) as ReviewDiffFile[];
        // A summary's files, read a few at a time, as the
        // bridge answers them.
        if (Array.isArray(params.files))
          return {
            files: (params.files as { path: string }[]).map(
              ({ path }) =>
                files.find((file) => file.path === path) ?? {
                  path,
                  oldPath: path,
                  hunks: [],
                },
            ),
            baseSha: "b",
            headSha: "h",
            truncated: false,
          };
        if (params.summary === true && backend.summaries)
          return {
            files: files.map((file) => ({
              path: file.path,
              oldPath: file.oldPath,
              hunks: [],
              ...(file.binary ? { binary: true } : {}),
              status: summaryStatus(file),
              additions: count(file, "+"),
              deletions: count(file, "-"),
            })),
            baseSha: "b",
            headSha: "h",
            truncated: false,
            summary: true,
            ...(params.first ? { view: first?.sha ?? null } : {}),
          };
        return {
          files,
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
    ...mockReviewStore(() => ({
      sessions: backend.sessions,
      openRequest: null,
    })),
  }));
  mock.module("../connectionReady", () => ({
    connectionReady: () => backend.connected,
    onConnectionChange: (listener: () => void) => {
      backend.connectionListeners.add(listener);
      return () => {
        backend.connectionListeners.delete(listener);
      };
    },
  }));
}

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
export async function setUpScreen(
  options: SurfaceOptions,
  /** The surface's stylesheets (with `styles`), by their file here. */
  stylesheets: readonly string[],
) {
  const restores: (() => void)[] = [];

  if (options.styles)
    for (const sheet of stylesheets) {
      const style = document.createElement("style");
      style.textContent = await Bun.file(
        new URL(sheet, import.meta.url).pathname,
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

  return {
    /** The review's element, for what the screen reads of it. */
    element: null as HTMLElement | null,
    attach(element: HTMLElement) {
      this.element = element;
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

function count(file: ReviewDiffFile, kind: "+" | "-") {
  return file.hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((line) => line.kind === kind).length,
    0,
  );
}

function summaryStatus(file: ReviewDiffFile): ReviewFileStatus {
  const all = (pattern: RegExp) =>
    file.hunks.length > 0 &&
    file.hunks.every((hunk) => pattern.test(hunk.header));
  if (all(/^@@ -0,0 /)) return "added";
  if (all(/^@@ -\d+(?:,\d+)? \+0,0 @@/)) return "deleted";
  return file.oldPath !== file.path ? "renamed" : "modified";
}
