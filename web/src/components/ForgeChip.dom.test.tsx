import { expect, test } from "bun:test";
import * as React from "react";

if (process.env.ROAMGATE_FORGE_CHIP_DOM_TEST !== "1") {
  test("merge request chips in an isolated browser runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_FORGE_CHIP_DOM_TEST: "1" },
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
    DOMParser: browser.DOMParser,
    // The hover card loads lazily, which notes it in storage.
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const { ForgeChatProvider } = await import("./ForgeChip");
  const { ForgeHeaderChips } = await import("./ForgeRequests");
  const { MarkdownPreview } = await import("./markdown");
  const { UserText: UserMessageText } = await import("./AgentHistoryChat");
  const { forgeStore } = await import("../forgeStore");
  const { createRoot } = await import("react-dom/client");
  type ForgeStatus = import("../../../shared/forge").ForgeStatus;
  type ForgeRef = import("../../../shared/forge").ForgeRef;

  const project = {
    provider: "gitlab" as const,
    host: "gitlab.example",
    project: "gst/gstreamer",
  };
  const ready = (ref: ForgeRef, extra: Partial<ForgeStatus["request"]> = {}) =>
    ({
      ref,
      state: "ready",
      fetchedAt: "",
      request: {
        url: `https://gitlab.example/${ref.project}/-/merge_requests/${ref.number}`,
        project: ref.project,
        title: `Title of ${ref.number}`,
        state: "open",
        draft: false,
        author: "me",
        sourceBranch: "work",
        targetBranch: "main",
        updatedAt: "2026-11-02T10:00:00Z",
        pipeline: { status: "running", failed: [] },
        approvals: { approved: false, count: 2 },
        unresolved: 3,
        ...extra,
      },
    }) as ForgeStatus;

  const setup = (answer: (ref: ForgeRef) => ForgeStatus) => {
    forgeStore.clear();
    const calls: ForgeRef[] = [];
    const client = {
      connectionId: "local",
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: async (method: string, params: { ref: ForgeRef }) => {
        if (method !== "forge.status") throw new Error(method);
        calls.push(params.ref);
        return answer(params.ref);
      },
    } as never;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const chat = { client, workspaceId: "w1", defaultProject: project };
    const render = (node: React.ReactNode) =>
      React.act(async () => {
        root.render(<ForgeChatProvider chat={chat}>{node}</ForgeChatProvider>);
        for (let i = 0; i < 5; i++)
          await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const chips = () =>
      [...container.querySelectorAll<HTMLElement>(".forge-chip")].map(
        (chip) => ({
          ref: chip.querySelector(".forge-chip-ref")?.textContent,
          state: chip.querySelector(".forge-chip-state")?.textContent ?? null,
          href: chip.querySelector("a")?.getAttribute("href") ?? null,
        }),
      );
    return { root, container, render, chips, calls };
  };

  test("a message's references become chips, never inside code", async () => {
    const { root, container, render, chips, calls } = setup((ref) =>
      ready(ref),
    );
    try {
      await render(
        <MarkdownPreview
          text={
            "Opened !42, see gst/cerbero!7 and `!43`.\n\n```\n!44\n```\n\nhttps://gitlab.example/gst/gstreamer/-/merge_requests/45"
          }
          breaks
        />,
      );
      expect(chips()).toEqual([
        {
          ref: "!42",
          state: "open",
          href: "https://gitlab.example/gst/gstreamer/-/merge_requests/42",
        },
        {
          ref: "gst/cerbero!7",
          state: "open",
          href: "https://gitlab.example/gst/cerbero/-/merge_requests/7",
        },
        {
          ref: "!45",
          state: "open",
          href: "https://gitlab.example/gst/gstreamer/-/merge_requests/45",
        },
      ]);
      expect(calls.map((ref) => ref.number).sort()).toEqual([42, 45, 7]);
      // The code is left as written.
      expect(
        [...container.querySelectorAll("code")].map((code) => code.textContent),
      ).toEqual(["!43", "!44\n"]);
      const chip = container.querySelector(".forge-chip")!;
      expect(chip.querySelector(".forge-chip-title")?.textContent).toBe(
        "Title of 42",
      );
      expect(chip.querySelector(".forge-pipeline.is-running")).not.toBeNull();
      expect(chip.textContent).toContain("2");
      expect(chip.querySelector(".is-threads")?.textContent).toBe("3");
      // Hovering shows more.
      await React.act(async () => {
        chip.dispatchEvent(
          new window.MouseEvent("mouseover", { bubbles: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
        for (let i = 0; i < 5; i++)
          await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const card = document.querySelector(".forge-card");
      expect(card?.querySelector(".forge-card-title")?.textContent).toBe(
        "Title of 42",
      );
      expect(card?.textContent).toContain("work → main");
      expect(
        [...(card?.querySelectorAll("a") ?? [])].map((a) =>
          a.getAttribute("href"),
        ),
      ).toEqual([
        "https://gitlab.example/gst/gstreamer/-/merge_requests/42",
        "https://gitlab.example/gst/gstreamer/-/merge_requests/42/pipelines",
      ]);
      // The message's own text is unchanged around the chips.
      expect(container.querySelector("p")?.textContent).toStartWith(
        "Opened !42",
      );
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("chips say why they cannot show more, and link nowhere new", async () => {
    const { root, render, chips } = setup((ref) =>
      ref.number === 1
        ? {
            ref,
            state: "not_signed_in",
            message: `Not signed in to ${ref.host}`,
            fetchedAt: "",
          }
        : ref.number === 2
          ? { ref, state: "not_found", fetchedAt: "" }
          : ready(ref, { state: "merged", pipeline: null }),
    );
    try {
      await render(
        <UserMessageText text="https://other.example/a/b/-/merge_requests/1 then !2 and !3" />,
      );
      expect(chips()).toEqual([
        {
          ref: "a/b!1",
          state: "not signed in to other.example",
          // The URL the message had, no other.
          href: "https://other.example/a/b/-/merge_requests/1",
        },
        {
          ref: "!2",
          state: "not found",
          href: null,
        },
        {
          ref: "!3",
          state: "merged",
          href: "https://gitlab.example/gst/gstreamer/-/merge_requests/3",
        },
      ]);
    } finally {
      await React.act(async () => root.unmount());
    }
  });

  test("the header shows the branch's request, or one chip listing several", async () => {
    const { root, container, render, chips } = setup((ref) => ready(ref));
    const branch = (number: number, repo: string) => ({
      ref: { ...project, project: `gst/${repo}`, number },
      root: `/src/${repo}`,
      branch: `work-${repo}`,
    });
    try {
      await render(<ForgeHeaderChips branches={[branch(12, "gstreamer")]} />);
      // The chat's own project: its number is enough.
      expect(chips()).toEqual([
        {
          ref: "!12",
          state: "open",
          href: "https://gitlab.example/gst/gstreamer/-/merge_requests/12",
        },
      ]);
      expect(container.querySelector(".forge-chip.is-header")).not.toBeNull();
      await render(
        <ForgeHeaderChips
          branches={[
            branch(12, "gstreamer"),
            branch(13, "gst-plugins-rs"),
            branch(14, "cerbero"),
          ]}
        />,
      );
      const button =
        container.querySelector<HTMLButtonElement>(".forge-header-many")!;
      expect(button.getAttribute("aria-label")).toBe(
        "3 MRs for this session's branches",
      );
      // The worst pipeline of the three shows on it.
      expect(button.querySelector(".forge-pipeline.is-running")).not.toBeNull();
      button.getBoundingClientRect = () =>
        ({ bottom: 20, right: 600 }) as DOMRect;
      await React.act(async () => {
        button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const rows = [...container.querySelectorAll(".forge-row")].map((row) =>
        [
          row.querySelector(".forge-row-repo")?.textContent,
          row.querySelector(".forge-row-ref")?.textContent,
          row.querySelector(".forge-row-tag")?.textContent,
        ].join(" "),
      );
      expect(rows).toEqual([
        "gstreamer !12 work-gstreamer",
        "gst-plugins-rs !13 work-gst-plugins-rs",
        "cerbero !14 work-cerbero",
      ]);
    } finally {
      await React.act(async () => root.unmount());
    }
  });
}
