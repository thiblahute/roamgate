import { expect, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_PR_CARD_CACHE_DOM_TEST !== "1") {
  test("the pull request card shows what it knew at once, in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_PR_CARD_CACHE_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 30_000);
} else {
  const { Window } = await import("happy-dom");
  const browser = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Text: browser.Text,
    NodeFilter: browser.NodeFilter,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    MutationObserver: browser.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { PullRequestCard } = await import("./PullRequestCard");
  const { bridge } = await import("../api");
  const { createRoot } = await import("react-dom/client");
  type PullRequestStatus =
    import("../../../shared/pullRequest").PullRequestStatus;

  const status = (
    title: string,
    extra: Partial<PullRequestStatus> = {},
  ): PullRequestStatus => ({
    state: "ready",
    root: "/repo",
    branch: "work",
    remotes: [],
    provider: "gitlab",
    refreshedAt: "2026-11-14T10:00:00Z",
    request: {
      id: "!12965",
      number: 12965,
      title,
      state: "opened",
      draft: false,
      author: "me",
      source: "work",
      target: "main",
      url: "https://gitlab.example/gst/gstreamer/-/merge_requests/12965",
    } as never,
    ...extra,
  });

  const flush = async () => {
    for (let i = 0; i < 6; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
  };

  function fakeClient(
    answer: (params: Record<string, unknown>) => Promise<unknown>,
  ) {
    const calls: Record<string, unknown>[] = [];
    const client = {
      connectionId: "local",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: (method: string, params: Record<string, unknown>) => {
        if (method !== "git.pull_request") throw new Error(method);
        calls.push(params);
        return answer(params);
      },
    } as never;
    return { client, calls };
  }

  const mount = () => {
    const container = document.createElement("div");
    document.body.append(container);
    return { container, root: createRoot(container) };
  };

  test("switching back to a workspace shows its card at once, and a refresh or a push replaces it", async () => {
    const first = fakeClient(async () =>
      status("Old title", {
        cached: { fetchedAt: "2026-11-14T10:00:00Z", stale: false },
      }),
    );
    const { container, root } = mount();
    const title = () =>
      container.querySelector(".pull-request-card-link")?.textContent ?? "";
    try {
      await React.act(async () => {
        root.render(
          <PullRequestCard
            client={first.client}
            workspaceId="w1"
            branch="work"
          />,
        );
        await flush();
      });
      expect(container.textContent).toContain("Old title");
      // Another workspace, then back: the server is slow this time.
      await React.act(async () => {
        root.render(<p>elsewhere</p>);
        await flush();
      });
      const slow = fakeClient(() => new Promise(() => {}));
      await React.act(async () => {
        root.render(
          <PullRequestCard
            client={slow.client}
            workspaceId="w1"
            branch="work"
          />,
        );
        await flush();
      });
      expect(container.textContent).toContain("Old title");
      expect(container.textContent).not.toContain("Checking this branch");
      expect(
        container.querySelector("section")?.getAttribute("aria-busy"),
      ).toBe("true");
      expect(title()).toBe("GitLab #12965");
      // Another device refreshed it: the server pushes the new answer.
      (
        bridge as never as { helloAcceptedForSocket: boolean }
      ).helloAcceptedForSocket = true;
      await React.act(async () => {
        (bridge as never as { onMessage: (raw: string) => void }).onMessage(
          JSON.stringify({
            forge_cache: {
              kind: "card",
              fetchedAt: "2026-11-14T10:05:00Z",
              status: status("Newer title"),
            },
          }),
        );
        await flush();
      });
      expect(container.textContent).toContain("Newer title");
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("the refresh button asks the server to bypass its cache, nothing else does", async () => {
    const f = fakeClient(async () =>
      status("T", {
        cached: { fetchedAt: "2026-11-14T10:00:00Z", stale: false },
      }),
    );
    const { container, root } = mount();
    try {
      await React.act(async () => {
        root.render(
          <PullRequestCard client={f.client} workspaceId="w2" branch="work" />,
        );
        await flush();
      });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).not.toHaveProperty("refresh");
      await React.act(async () => {
        container
          .querySelector<HTMLButtonElement>(".pull-request-card-refresh")!
          .click();
        await flush();
      });
      expect(f.calls).toHaveLength(2);
      expect(f.calls[1]).toMatchObject({ refresh: true });
    } finally {
      await React.act(async () => root.unmount());
    }
  });
}
