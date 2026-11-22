import { expect, mock, test } from "bun:test";
import { inIsolatedChild } from "../testIsolated";

/**
 * Add to Work from an agent's chat: the header's button and count, a
 * message's own button, and the menu a right-click on a part opens
 * (Comment, Add to Work, Copy), each starting the Work board's add form for the session: the
 * words quoted, the message linked, the session's workspace given.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "a chat's Add to Work, in an isolated DOM runtime",
    "ROAMGATE_CHAT_WORK_DOM_TEST",
    20_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  installTestDom({ url: "http://localhost/" });
  const React = await import("react");
  const { act } = React;

  const opened: unknown[] = [];
  const copied: string[] = [];
  mock.module("../copyText", () => ({
    copyTextWithFeedback: async (text: string) => {
      copied.push(text);
    },
  }));
  mock.module("../workOpen", () => ({
    openWork: (open: unknown) => opened.push(open),
  }));
  let owned = 0;
  const workModule = await import("../work");
  mock.module("../work", () => ({
    ...workModule,
    useWorkOwnedCount: (address: string | null) => (address ? owned : 0),
  }));
  const storeModule = await import("../store");
  mock.module("../store", () => ({
    ...storeModule,
    useStoreSelector: (selector: (state: unknown) => unknown) =>
      selector({
        activeConnectionId: "desktop",
        workspaces: [
          {
            workspace_id: "w36",
            label: "roamgate-header",
            worktree: {
              checkout_path: "/home/me/roamgate.worktrees/header",
              repo_root: "/home/me/roamgate",
            },
          },
        ],
      }),
  }));
  const {
    ChatMessageWorkButton,
    ChatWorkHeader,
    ChatWorkProvider,
    useChatWork,
    useChatWorkAdd,
    workQuote,
  } = await import("./ChatWork");
  const { NoteBody } = await import("./ReviewNoteBody");
  const { createRoot } = await import("react-dom/client");

  /** A message drawn in parts, a right-click on one opening the chat's menu. */
  function Part({ onComment }: { onComment: (quote: string) => void }) {
    const work = useChatWork();
    const back = React.useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={back} type="button" className="chat-list">
          the chat
        </button>
        <NoteBody
          text={"First part.\n\nSecond part."}
          parts={{
            notes: [],
            focused: null,
            onComment,
            ...(work
              ? {
                  onPartMenu: (quote, at) =>
                    work.menu({
                      quote,
                      at: { x: at.x, y: at.y },
                      back: back.current,
                      entry: "msg-7",
                      comment: () => onComment(quote),
                    }),
                }
              : {}),
          }}
        />
      </>
    );
  }

  function Chat({ onComment }: { onComment: (quote: string) => void }) {
    const work = useChatWorkAdd({
      connectionId: "desktop",
      paneId: "w36:p2",
      workspaceId: "w36",
      chat: "c0ffee",
      path: "/home/me/roamgate.worktrees/header",
      name: "Fix the header",
    });
    return (
      <ChatWorkProvider work={work}>
        <header>
          <ChatWorkHeader work={work} />
        </header>
        <Part onComment={onComment} />
        <ChatMessageWorkButton
          text={"The whole message.\nTwo lines."}
          entry="msg-8"
          className="agent-history-copy"
        />
      </ChatWorkProvider>
    );
  }

  const draft = (text: string, entry?: string) => ({
    add: {
      text,
      owner: "desktop/w36:p2",
      ownerName: "Fix the header",
      workspace: {
        connectionId: "desktop",
        workspaceId: "w36",
        label: "roamgate-header",
        checkoutPath: "/home/me/roamgate.worktrees/header",
        repoRoot: "/home/me/roamgate",
      },
      links: [
        {
          kind: "chat",
          session: "desktop/w36:p2",
          chat: "c0ffee",
          ...(entry ? { entry } : {}),
        },
      ],
    },
  });

  test("words quoted in Markdown, a blank line after for the user's own", () => {
    expect(workQuote("one\n\ntwo")).toBe("> one\n>\n> two\n\n");
    expect(workQuote("  ")).toBe("");
  });

  test("the header, a message and a part's menu start the board's add form for the session", async () => {
    const comments: string[] = [];
    owned = 3;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(<Chat onComment={(quote) => comments.push(quote)} />),
    );
    const click = async (element: Element | null | undefined) => {
      if (!element) throw new Error("nothing to click");
      await act(async () => (element as HTMLElement).click());
    };
    try {
      // The header: the session's items, and Add to Work quoting nothing.
      const count = container.querySelector(".agent-chat-work-count");
      expect(count?.textContent).toBe("3 items");
      await click(count);
      expect(opened.pop()).toEqual({ owner: "desktop/w36:p2" });
      await click(container.querySelector("header [aria-label='Add to Work']"));
      expect(opened.pop()).toEqual(draft(""));

      // A message's own button: the whole message quoted, linked.
      await click(
        container.querySelector("[aria-label='Add this message to Work']"),
      );
      expect(opened.pop()).toEqual(
        draft("> The whole message.\n> Two lines.\n\n", "msg-8"),
      );

      // A part's +: a comment at once, no menu.
      const plus = container.querySelectorAll<HTMLElement>(".rc-part-add")[1]!;
      expect(plus.getAttribute("aria-haspopup")).toBeNull();
      const menu = () =>
        document.body.querySelector<HTMLElement>(".chat-part-menu");
      await click(plus);
      expect(comments).toEqual(["Second part."]);
      expect(menu()).toBeNull();

      // A right-click on a part: a menu where it was, outside the message.
      const part = container.querySelector<HTMLElement>('[data-part="1"]')!;
      const rightClick = async () =>
        act(async () => {
          part.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: 30,
              clientY: 40,
            }),
          );
        });
      await rightClick();
      expect(container.contains(menu())).toBe(false);
      expect(
        [...menu()!.querySelectorAll("[role='menuitem']")].map(
          (item) => item.textContent,
        ),
      ).toEqual(["Comment", "Add to Work", "Copy"]);
      expect(document.activeElement?.textContent).toBe("Comment");
      // Comment: the thread on the part, as its + opens.
      await click(menu()!.querySelector("[role='menuitem']"));
      expect(comments).toEqual(["Second part.", "Second part."]);
      expect(menu()).toBeNull();
      // Add to Work: the part quoted, its message linked.
      await rightClick();
      await act(async () =>
        menu()!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "j", bubbles: true }),
        ),
      );
      expect(document.activeElement?.textContent).toBe("Add to Work");
      await click(document.activeElement);
      expect(opened.pop()).toEqual(draft("> Second part.\n\n", "msg-7"));
      expect(menu()).toBeNull();
      // Copy: the part's words.
      await rightClick();
      await click(
        [...menu()!.querySelectorAll("[role='menuitem']")].find(
          (item) => item.textContent === "Copy",
        ),
      );
      expect(copied).toEqual(["Second part."]);
      expect(menu()).toBeNull();
      // Esc closes it, the focus back where the menu says.
      await rightClick();
      await act(async () =>
        menu()!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
      );
      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(
        container.querySelector<HTMLElement>(".chat-list"),
      );
      expect(opened).toEqual([]);

      // No items: no count, Add to Work still there.
      owned = 0;
      await act(async () =>
        root.render(<Chat onComment={(quote) => comments.push(quote)} />),
      );
      expect(container.querySelector(".agent-chat-work-count")).toBeNull();
      expect(
        container.querySelector("header [aria-label='Add to Work']"),
      ).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}
