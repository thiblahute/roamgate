import { inIsolatedChild } from "../testIsolated";
import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

if (
  inIsolatedChild(
    import.meta.path,
    "phone workspace search in an isolated DOM runtime",
    "ROAMGATE_WORKSPACE_SEARCH_DOM_TEST",
    15_000,
  )
) {
  await registerTests();
}

async function registerTests() {
  // A phone's viewport.
  const browser = new Window({
    url: "http://localhost",
    width: 393,
    height: 852,
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "Element",
    "Node",
    "Event",
    "InputEvent",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      value: key === "window" ? browser : browser[key],
      writable: true,
      configurable: true,
    });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { act, createElement: h, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WorkspaceSearchField } = await import("./WorkspaceSearchField");
  const { paneSearchEntries, serverSessionPaneEntries } = await import(
    "../paneJump"
  );

  // The phone shows the desktop; `tasks` lives on the Mac only, which this
  // browser holds no session for.
  const workspace = (workspace_id: string, label: string) => ({
    workspace_id,
    number: 1,
    label,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    agent_status: "unknown" as const,
  });
  const tab = (tab_id: string, workspace_id: string) => ({
    tab_id,
    workspace_id,
    number: 1,
    label: "1",
    focused: false,
    pane_count: 1,
    agent_status: "unknown" as const,
  });
  const pane = (pane_id: string, workspace_id: string, tab_id: string) => ({
    pane_id,
    terminal_id: `terminal-${pane_id}`,
    workspace_id,
    tab_id,
    focused: false,
    cwd: `/repos/${workspace_id}`,
    agent_status: "unknown" as const,
    revision: 1,
  });
  const connection = (id: string, label: string) => ({
    id,
    label,
    source: "profile" as const,
    is_default: false,
    state: "ready" as const,
    generation: 1,
  });
  const desktop = {
    layout: null,
    panes: [pane("p1", "w1", "t1")],
    recentPaneIds: ["p1"],
    tabs: [tab("t1", "w1")],
    workspaces: [workspace("w1", "roamgate")],
  };
  const serverEntries = serverSessionPaneEntries(
    [connection("desktop", "Desktop"), connection("local", "Mac")],
    [
      {
        connection_id: "local",
        connection_generation: 1,
        workspaces: [workspace("wF", "tasks")],
        tabs: [tab("tF", "wF")],
        panes: [pane("pF", "wF", "tF")],
        agents: null,
      },
    ],
    "desktop",
  );

  const opened: [string, string][] = [];
  const open = (connectionId: string, workspaceId: string) =>
    opened.push([connectionId, workspaceId]);
  const queries: string[] = [];
  // The sheet's search as App wires it: the field's text drives the same
  // search, its rows open the workspace on its connection.
  function Sheet() {
    const [query, setQuery] = useState("");
    queries.push(query);
    const results = query.trim()
      ? paneSearchEntries(
          desktop,
          query,
          "p1",
          [],
          "workspaces",
          undefined,
          undefined,
          serverEntries,
        )
      : [];
    return h(
      "div",
      null,
      h(WorkspaceSearchField, { value: query, onChange: setQuery }),
      query.trim() && results.length === 0
        ? h("p", { role: "status" }, "No workspace matches.")
        : null,
      ...results.map((entry) =>
        h(
          "button",
          {
            key: entry.key,
            type: "button",
            role: "listitem",
            onClick: () =>
              open(entry.source?.connectionId ?? "desktop", entry.workspaceId),
          },
          entry.title,
        ),
      ),
    );
  }

  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    opened.length = 0;
    queries.length = 0;
    document.body.replaceChildren();
  });
  afterAll(async () => browser.happyDOM.close());

  async function mount() {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(h(Sheet)));
    return container.querySelector<HTMLInputElement>("input")!;
  }

  const setValue = Object.getOwnPropertyDescriptor(
    browser.HTMLInputElement.prototype,
    "value",
  )!.set!;
  async function input(
    field: HTMLInputElement,
    value: string,
    composing = false,
  ) {
    await act(async () => {
      setValue.call(field, value);
      field.dispatchEvent(
        new browser.InputEvent("input", {
          bubbles: true,
          isComposing: composing,
          inputType: composing ? "insertCompositionText" : "insertText",
          data: value.slice(-1),
        }) as unknown as Event,
      );
    });
  }
  const titles = () =>
    [...document.querySelectorAll<HTMLButtonElement>("[role=listitem]")].map(
      (row) => row.textContent,
    );
  const status = () =>
    document.querySelector("[role=status]")?.textContent ?? null;

  test("runs at a phone's width", () => {
    expect(window.innerWidth).toBe(393);
    expect(window.innerHeight).toBe(852);
  });

  test("an Android keyboard composing Tasks finds the Mac's workspace, which opens there", async () => {
    const field = await mount();
    await act(async () => {
      field.focus();
      field.dispatchEvent(
        new browser.Event("compositionstart", {
          bubbles: true,
        }) as unknown as Event,
      );
    });
    // Gboard composes the word, capitalised, one letter at a time.
    for (const value of ["T", "Ta", "Tas", "Task", "Tasks"]) {
      await input(field, value, true);
      expect(field.value).toBe(value);
      // "T" also matches roamgate; each letter keeps tasks listed.
      expect(titles()).toContain("tasks");
      expect(status()).toBeNull();
    }
    await act(async () => {
      field.dispatchEvent(
        new browser.Event("compositionend", {
          bubbles: true,
        }) as unknown as Event,
      );
    });
    // The committed word, then the space it adds after it.
    await input(field, "Tasks");
    await input(field, "Tasks ");
    expect(field.value).toBe("Tasks ");
    expect(titles()).toEqual(["tasks"]);
    expect(queries).toContain("Tas");

    await act(async () =>
      document.querySelector<HTMLButtonElement>("[role=listitem]")!.click(),
    );
    expect(opened).toEqual([["local", "wF"]]);
  });

  test("matches in any case, and says when nothing does", async () => {
    const field = await mount();
    for (const value of ["TASKS", "tasks", "tAsKs"]) {
      await input(field, value);
      expect(titles()).toEqual(["tasks"]);
    }
    await input(field, "tasks nowhere");
    expect(titles()).toEqual([]);
    expect(status()).toBe("No workspace matches.");
  });

  test("keeps the keyboard's own fixes out of the query", async () => {
    const field = await mount();
    expect(field.getAttribute("autocapitalize")).toBe("off");
    expect(field.getAttribute("autocorrect")).toBe("off");
    expect(field.getAttribute("spellcheck")).toBe("false");
    expect(field.type).toBe("search");
  });
}
