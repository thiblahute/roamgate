import { inIsolatedChild } from "../testIsolated";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";
import type {
  AgentChatMcp,
  AgentChatMcpRequest,
  AgentChatMcpResult,
  AgentChatMcpServer,
} from "../../../shared/agentChat";
import { mcpSheetRows, mcpSheetSummary } from "./AgentMcpSheet";

const ECHO: AgentChatMcpServer = {
  name: "echo",
  status: "connected",
  scope: "user",
  transport: "stdio",
  target: "bun",
  version: "echo-probe 1.2.3",
  tools: [
    { name: "echo", readOnly: true },
    { name: "wipe", destructive: true },
  ],
  actions: ["reconnect", "disable"],
};
const DOCS: AgentChatMcpServer = {
  name: "docs",
  status: "needs-auth",
  scope: "project",
  transport: "http",
  target: "mcp.example.com",
  actions: ["authenticate", "reconnect", "disable"],
};
const BROKEN: AgentChatMcpServer = {
  name: "broken",
  status: "failed",
  transport: "stdio",
  error: "ENOENT: no such file or directory",
  actions: ["reconnect", "disable"],
};
const OFF: AgentChatMcpServer = {
  name: "off",
  status: "disabled",
  actions: ["enable"],
};

test("the filter keeps servers by name, scope, transport or target", () => {
  const all = [ECHO, DOCS, BROKEN];
  expect(mcpSheetRows(all, "")).toEqual(all);
  expect(mcpSheetRows(all, "EXAMPLE.com")).toEqual([DOCS]);
  expect(mcpSheetRows(all, "stdio")).toEqual([ECHO, BROKEN]);
  expect(mcpSheetRows(all, "nope")).toEqual([]);
});

test("the summary counts what the list comes to", () => {
  expect(
    mcpSheetSummary([
      ECHO,
      DOCS,
      BROKEN,
      OFF,
      { name: "p", status: "pending", actions: [] },
    ]),
  ).toBe("1 connected, 1 needs sign-in, 1 failed, 1 connecting, 1 disabled");
});

if (
  inIsolatedChild(
    import.meta.path,
    "MCP sheet interactions in an isolated DOM runtime",
    "ROAMGATE_MCP_SHEET_DOM_TEST",
    15_000,
  )
) {
  await registerTests();
}

async function registerTests() {
  const browser = new Window({ url: "http://localhost" });
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "HTMLInputElement",
    "Element",
    "Node",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
    "PointerEvent",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      value: key === "window" ? browser : browser[key],
      writable: true,
      configurable: true,
    });
  }
  Object.assign(globalThis, {
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { act, createElement: h } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { AgentMcpSheet } = await import("./AgentMcpSheet");

  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    await browser.happyDOM.whenAsyncComplete();
  });
  afterAll(async () => browser.happyDOM.close());

  const flush = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await browser.happyDOM.whenAsyncComplete();
    });

  async function open(
    load: () => Promise<AgentChatMcp>,
    run: (
      request: AgentChatMcpRequest,
    ) => Promise<AgentChatMcpResult> = async () => ({
      ok: true,
    }),
    pollMs?: number,
  ) {
    const actMock = mock(run);
    const loadMock = mock(load);
    const onClose = mock(() => {});
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        h(AgentMcpSheet, {
          load: loadMock,
          act: actMock,
          onClose,
          ...(pollMs === undefined ? {} : { pollMs }),
        }),
      ),
    );
    await flush();
    const row = (name: string) =>
      [...container.querySelectorAll<HTMLElement>(".agent-mcp-row")].find(
        (each) => each.querySelector(".agent-mcp-name")?.textContent === name,
      )!;
    const button = (name: string, label: string) =>
      [...row(name).querySelectorAll("button")].find(
        (each) => each.textContent === label,
      ) as HTMLButtonElement | undefined;
    const press = async (name: string, label: string) => {
      await act(async () => button(name, label)!.click());
      await flush();
    };
    return { container, row, button, press, actMock, loadMock, onClose };
  }

  test("each server shows its state, where it comes from, its tools and actions", async () => {
    const { container, row, button } = await open(async () => ({
      servers: [ECHO, DOCS, BROKEN, OFF],
    }));
    expect(container.textContent).toContain(
      "1 connected, 1 needs sign-in, 1 failed, 1 disabled",
    );
    expect(row("echo").dataset.status).toBe("connected");
    expect(row("echo").textContent).toContain("Connected");
    expect(row("echo").textContent).toContain(
      "user \u00b7 stdio \u00b7 bun \u00b7 echo-probe 1.2.3",
    );
    expect(row("echo").querySelector("summary")?.textContent).toBe("2 tools");
    expect(row("echo").querySelector("details")?.textContent).toContain(
      "read-only",
    );
    expect(row("docs").textContent).toContain("Needs sign-in");
    expect(button("docs", "Sign in")).toBeDefined();
    expect(row("broken").textContent).toContain(
      "ENOENT: no such file or directory",
    );
    expect(button("off", "Enable")).toBeDefined();
    expect(button("off", "Disable")).toBeUndefined();
  });

  test("an empty session, and a list that cannot be read, say so", async () => {
    const empty = await open(async () => ({ servers: [] }));
    expect(empty.container.textContent).toContain(
      "This session has no MCP servers.",
    );
    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
    const failing = await open(async () => {
      throw new Error("Claude did not answer in time");
    });
    expect(failing.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Claude did not answer in time",
    );
  });

  test("an action is asked for, then the list is read again", async () => {
    let servers = [ECHO];
    const { press, actMock, row } = await open(
      async () => ({ servers }),
      async () => {
        servers = [{ ...ECHO, status: "disabled", actions: ["enable"] }];
        return { ok: true };
      },
    );
    await press("echo", "Disable");
    expect(actMock).toHaveBeenCalledWith({
      action: "disable",
      server: "echo",
    });
    expect(row("echo").dataset.status).toBe("disabled");
  });

  test("a refusal is said on its server, and the sheet stays open", async () => {
    const { press, row, onClose } = await open(
      async () => ({ servers: [ECHO] }),
      async () => ({ ok: false, reason: "Server not found: echo" }),
    );
    await press("echo", "Reconnect");
    expect(row("echo").querySelector('[role="alert"]')?.textContent).toBe(
      "Server not found: echo",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  test("a sign-in opens its page and takes the pasted address, once", async () => {
    let servers: AgentChatMcpServer[] = [DOCS];
    const { press, row, actMock } = await open(
      async () => ({ servers }),
      async (request) => {
        if (request.action === "authenticate")
          return {
            ok: true,
            signIn: { url: "https://auth.example.com/a", redirects: true },
          };
        servers = [{ ...DOCS, status: "connected", actions: ["reconnect"] }];
        return { ok: true };
      },
    );
    await press("docs", "Sign in");
    const link = row("docs").querySelector<HTMLAnchorElement>(
      ".agent-mcp-signin a",
    )!;
    expect(link.getAttribute("href")).toBe("https://auth.example.com/a");
    expect(link.target).toBe("_blank");
    const input = row("docs").querySelector<HTMLInputElement>("input")!;
    const finish = () =>
      [...row("docs").querySelectorAll("button")].find(
        (each) => each.textContent === "Finish sign-in",
      )!;
    expect(finish().disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        browser.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "http://localhost:1/callback?code=a&state=b");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => finish().click());
    await flush();
    expect(actMock).toHaveBeenCalledWith({
      action: "finish-sign-in",
      server: "docs",
      url: "http://localhost:1/callback?code=a&state=b",
    });
    expect(row("docs").querySelector(".agent-mcp-signin")).toBeNull();
    expect(row("docs").textContent).toContain("Signed in.");
  });

  test("a sign-in that comes back by itself clears, the list being read meanwhile", async () => {
    let servers: AgentChatMcpServer[] = [DOCS];
    const { press, row, loadMock } = await open(
      async () => ({ servers }),
      async () => ({
        ok: true,
        signIn: { url: "https://auth.example.com/a", redirects: true },
      }),
      5,
    );
    await press("docs", "Sign in");
    expect(row("docs").querySelector(".agent-mcp-signin")).not.toBeNull();
    const reads = loadMock.mock.calls.length;
    servers = [{ ...DOCS, status: "connected", actions: ["reconnect"] }];
    await flush();
    await flush();
    expect(loadMock.mock.calls.length).toBeGreaterThan(reads);
    expect(row("docs").querySelector(".agent-mcp-signin")).toBeNull();
    expect(row("docs").textContent).toContain("Signed in.");
  });

  test("a connector signed in to elsewhere says to reconnect, with no paste box", async () => {
    const { press, row } = await open(
      async () => ({ servers: [DOCS] }),
      async () => ({
        ok: true,
        signIn: {
          url: "https://claude.ai/settings/connectors",
          redirects: false,
        },
      }),
    );
    await press("docs", "Sign in");
    expect(row("docs").querySelector(".agent-mcp-signin input")).toBeNull();
    expect(row("docs").textContent).toContain(
      "Connect it on that page, then press Reconnect here.",
    );
  });

  test("a sign-in that needs nothing says so, and no sign-in points at the terminal", async () => {
    const { press, row } = await open(
      async () => ({
        servers: [
          DOCS,
          { ...DOCS, name: "proxied", actions: ["reconnect", "disable"] },
        ],
      }),
      async () => ({ ok: true, signIn: { url: null, redirects: false } }),
    );
    await press("docs", "Sign in");
    expect(row("docs").textContent).toContain("No sign-in was needed.");
    expect(row("proxied").textContent).toContain(
      "Sign in to this server from the agent's terminal.",
    );
  });

  test("a server still connecting is read again until it has come up", async () => {
    let servers: AgentChatMcpServer[] = [
      { ...ECHO, status: "pending", actions: [] },
    ];
    const { row, loadMock } = await open(
      async () => ({ servers }),
      undefined,
      5,
    );
    expect(row("echo").textContent).toContain("Connecting...");
    servers = [ECHO];
    await flush();
    await flush();
    expect(row("echo").dataset.status).toBe("connected");
    const reads = loadMock.mock.calls.length;
    await flush();
    await flush();
    expect(loadMock.mock.calls.length).toBe(reads);
  });

  test("the filter shows with many servers, and Esc closes", async () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      ...ECHO,
      name: `server-${index}`,
    }));
    const { container, row, onClose } = await open(async () => ({
      servers: many,
    }));
    const filter = container.querySelector<HTMLInputElement>(
      ".agent-model-filter",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        browser.HTMLInputElement.prototype,
        "value",
      )!.set!.call(filter, "server-3");
      filter.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await flush();
    expect(container.querySelectorAll(".agent-mcp-row")).toHaveLength(1);
    expect(row("server-3")).toBeDefined();
    await act(async () => {
      container
        .querySelector(".agent-mcp-sheet")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });
    expect(onClose).toHaveBeenCalled();
  });

  test("the list is read when opened and the refresh button reads it again", async () => {
    const { container, loadMock } = await open(async () => ({
      servers: [ECHO],
    }));
    expect(loadMock).toHaveBeenCalledTimes(1);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Refresh"]')!
        .click(),
    );
    await flush();
    expect(loadMock).toHaveBeenCalledTimes(2);
  });
}
