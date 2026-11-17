import { inIsolatedChild } from "../testIsolated";
import { expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { listLocalFiles } from "../../../server/src/workspace/local-files";
import { bridge, type ConnectionClient } from "../api";
import { __storeTesting, store } from "../store";

/**
 * One review across Files and Changes, in Files' tree: a file of the
 * checkout's review carries its tick (reviewed, changed or not), and a file
 * with no change in the review by a comment a dot; other files nothing.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "Files' tree review marks in an isolated DOM runtime",
    "ROAMGATE_FILE_EXPLORER_REVIEW_DOM_TEST",
    15_000,
  )
) {
  test("the review's files carry their tick, or a dot while only commented on", async () => {
    const browser = new Window({ url: "http://localhost" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      HTMLButtonElement: browser.HTMLButtonElement,
      HTMLInputElement: browser.HTMLInputElement,
      MutationObserver: browser.MutationObserver,
      Element: browser.Element,
      Node: browser.Node,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    const { createRoot } = await import("react-dom/client");
    const { FileExplorerPanel } = await import("./FileExplorerDialog");
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "roamgate-files-review-")),
    );
    for (const name of ["changed.ts", "notes.md", "ticked.md", "plain.txt"])
      await writeFile(join(directory, name), name);
    const pending = new Set<Promise<unknown>>();
    const client: ConnectionClient = {
      connectionId: "local",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call(method, params = {}) {
        const handlers: Record<
          string,
          (params: Record<string, unknown>) => Promise<unknown>
        > = {
          "file.list": async (params) => ({
            ...(await listLocalFiles(
              directory,
              String(params.path ?? ""),
              false,
            )),
            workspace_id: "w1",
            checkout_path: directory,
          }),
          "git.diff_summary": async () => ({
            root: directory,
            entries: [
              {
                path: "changed.ts",
                kind: "unstaged",
                status: "M",
                additions: 1,
                deletions: 0,
              },
            ],
            counts: {},
          }),
        };
        const task = (handlers[method] ?? (async () => ({})))(params);
        pending.add(task);
        void task.finally(() => pending.delete(task));
        return task;
      },
    };
    const connection = spyOn(bridge, "connection").mockReturnValue(client);
    const previous = store.get();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const update = async (action: () => void) => {
      await act(async () => {
        action();
      });
      for (let round = 0; round < 5; round++)
        await act(async () => {
          while (pending.size) await Promise.allSettled([...pending]);
          await new Promise((resolve) => setTimeout(resolve, 2));
        });
    };
    const markOf = (path: string) =>
      container
        .querySelector(`.file-row[data-file-path="${path}"] .file-review-mark`)
        ?.getAttribute("data-review-mark") ?? null;
    try {
      __storeTesting.replaceState({
        ...previous,
        activeConnectionId: "local",
        workspaces: [
          {
            workspace_id: "w1",
            number: 1,
            label: "Files test",
            focused: true,
            pane_count: 0,
            tab_count: 0,
            agent_status: "idle",
            cwd: directory,
          },
        ],
      });
      const render = (
        marks: [string, { reviewed: boolean; other: boolean }][],
      ) =>
        update(() =>
          root.render(
            createElement(FileExplorerPanel, {
              open: true,
              workspaceId: "w1",
              onClose: () => {},
              reviewMarks: { root: directory, marks: new Map(marks) },
            }),
          ),
        );
      await render([
        ["changed.ts", { reviewed: true, other: false }],
        ["notes.md", { reviewed: false, other: true }],
        ["ticked.md", { reviewed: true, other: true }],
      ]);
      expect(markOf("changed.ts")).toBe("reviewed");
      expect(markOf("notes.md")).toBe("other");
      expect(markOf("ticked.md")).toBe("other-reviewed");
      expect(markOf("plain.txt")).toBeNull();
      // Unticked and its threads resolved: out of the review, unmarked.
      await render([["changed.ts", { reviewed: true, other: false }]]);
      expect(markOf("notes.md")).toBeNull();
      expect(markOf("ticked.md")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      connection.mockRestore();
      __storeTesting.replaceState(previous);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
