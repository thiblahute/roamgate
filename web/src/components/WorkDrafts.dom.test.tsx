import { expect, mock, test } from "bun:test";
import { inIsolatedChild } from "../testIsolated";

/**
 * The Work board's boxes keep what was written and not sent: the new item
 * form (its words and images), an item's comment box and a thread's reply
 * box come back with it when drawn again (another view, a reload), Send
 * and Cancel forget it, and the board marks the items and the + that have
 * one.
 */
if (
  inIsolatedChild(
    import.meta.path,
    "the Work board's unsent drafts, in an isolated DOM runtime",
    "ROAMGATE_WORK_DRAFTS_DOM_TEST",
    40_000,
  )
) {
  const { installTestDom } = await import("../testDom");
  installTestDom({ url: "http://localhost/", width: 1280 });
  (HTMLElement.prototype as any).scrollIntoView = () => {};
  const React = await import("react");
  const { act, useEffect, useRef } = React;
  // The editor as a text area: its words, Esc (:q), and a pasted image.
  mock.module("./ReviewCommentEditorLazy", () => ({
    ReviewCommentEditorLazy: (props: {
      value: string;
      label?: string;
      placeholder?: string;
      onChange: (text: string) => void;
      onCancel: () => void;
      onPasteImage?: (file: File) => Promise<string>;
    }) => {
      const field = useRef<HTMLTextAreaElement>(null);
      const paste = async () => {
        const file = new File([new Uint8Array([1, 2, 3])], "shot.png", {
          type: "image/png",
        });
        const markdown = await props.onPasteImage!(file);
        field.current!.value = `${field.current!.value} ${markdown}`;
        props.onChange(field.current!.value);
      };
      useEffect(() => {
        field.current!.value = props.value;
      }, []);
      return (
        <>
          <textarea
            ref={field}
            aria-label={props.label ?? props.placeholder}
            onChange={(event) => props.onChange(event.target.value)}
          />
          {props.onPasteImage ? (
            <button type="button" data-paste onClick={() => void paste()}>
              paste
            </button>
          ) : null}
        </>
      );
    },
  }));
  const { createRoot } = await import("react-dom/client");
  const { WorkAddForm } = await import("./WorkAddForm");
  const { useWorkItemView, WorkItemThreads } = await import(
    "./WorkItemThreads"
  );
  const { draftImagesNow, keepReviewDraft, peekReviewDraft } = await import(
    "../reviewDrafts"
  );
  const { useWorkDraftItems, workAddDraft, workItemDrafts } = await import(
    "../workDrafts"
  );
  type Api = Parameters<typeof WorkItemThreads>[0]["api"];

  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const host = document.createElement("div");
  document.body.appendChild(host);
  let root = createRoot(host);
  const draw = async (node: React.ReactNode) => {
    await act(async () => {
      root.render(node);
      await wait(10);
    });
  };
  /** Away from it: the view drawn without the box (another item, a tab). */
  const leave = async () => {
    await act(async () => {
      root.unmount();
      await wait(10);
    });
    root = createRoot(host);
  };
  const field = () => host.querySelector("textarea")!;
  const type = async (text: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(field(), text);
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find(
      (each) => each.textContent?.trim() === label,
    )!;
  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click();
      await wait(20);
    });
  };

  const place = workAddDraft("p1", {
    connectionId: "local",
    workspaceId: "w1",
  });
  const adds: { text?: string; images?: { token: string }[] }[] = [];
  const form = (initialText?: string) => (
    <WorkAddForm
      project="p1"
      projectName="Project"
      draft={place}
      {...(initialText ? { initialText } : {})}
      onAdd={async (params) => {
        adds.push(params);
      }}
      onCancel={() => {}}
    />
  );

  test("the new item form keeps its words and images when left, and gives them back", async () => {
    await draw(form());
    await type("The box does not open");
    await click(host.querySelector<HTMLElement>("[data-paste]")!);
    const written = field().value;
    expect(written).toContain("![shot.png](<work-image:1>)");
    // Back: the form goes, its words and images stay.
    await click(button("Back"));
    await leave();
    expect(peekReviewDraft(place.session, place.key)).toBe(written);
    expect(
      draftImagesNow(place.session, place.key).map((i) => i.token),
    ).toEqual(["work-image:1"]);
    // Opened again: there they are; a new image goes on from them.
    await draw(form());
    expect(field().value).toBe(written);
    await click(host.querySelector<HTMLElement>("[data-paste]")!);
    expect(field().value).toContain("<work-image:2>");
    // Added: what was sent has both images; the draft is gone.
    await click(button("Add"));
    expect(adds[adds.length - 1]?.images?.map((i) => i.token)).toEqual([
      "work-image:1",
      "work-image:2",
    ]);
    await leave();
    expect(peekReviewDraft(place.session, place.key)).toBeUndefined();
    expect(draftImagesNow(place.session, place.key)).toEqual([]);
  });

  test("a reload keeps the words: they are in the browser's storage", async () => {
    await draw(form());
    await type("Written before the reload");
    // The page goes away: kept as it hides, before any unmount.
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(peekReviewDraft(place.session, place.key)).toBe(
      "Written before the reload",
    );
    await leave();
    // A chat's quote opened in the form goes after the kept words.
    await draw(form("A quote"));
    expect(field().value).toBe("Written before the reload\n\nA quote");
    // Cancel drops them.
    await click(button("Cancel"));
    await leave();
    expect(peekReviewDraft(place.session, place.key)).toBeUndefined();
  });

  const item = "1200000000000000";
  const at = "2026-11-20T10:00:01.000Z";
  const thread = {
    id: "a000000000000001",
    sessionId: "r000000000000001",
    kind: "discussion" as const,
    anchor: { work: { item } },
    comments: [
      {
        id: "c000000000000001",
        author: "Claude",
        body: "Which box?",
        createdAt: at,
        updatedAt: at,
      },
    ],
    resolved: false,
    createdAt: at,
    updatedAt: at,
  };
  const sends: Record<string, unknown>[] = [];
  let sent = true;
  function Threads({ compose }: { compose: "comment" | null }) {
    const view = useWorkItemView();
    const api = {
      snapshot: undefined,
      threads: [thread],
      open: 1,
      waiting: null,
      write: async () => true,
      addImage: async () => "",
      send: async (next: Record<string, unknown>) => {
        sends.push(next);
        return sent;
      },
      pendingById: new Map(),
      undelivered: new Set<string>(),
      error: "",
      ...view,
    } as unknown as Api;
    return (
      <WorkItemThreads
        item={item}
        api={api}
        compose={compose}
        onComposeDone={() => {}}
        onLeave={() => {}}
      />
    );
  }

  test("an item's comment box opens again with its words, and Send forgets them", async () => {
    await draw(<Threads compose="comment" />);
    await type("Half a comment");
    // To another item and back.
    await leave();
    expect(peekReviewDraft(workItemDrafts(item), "comment")).toBe(
      "Half a comment",
    );
    await draw(<Threads compose={null} />);
    expect(field().value).toBe("Half a comment");
    // Not sent: the box stays, and its words stay its draft.
    sent = false;
    await click(button("Send"));
    await leave();
    expect(peekReviewDraft(workItemDrafts(item), "comment")).toBe(
      "Half a comment",
    );
    sent = true;
    await draw(<Threads compose={null} />);
    await click(button("Send"));
    expect(sends[sends.length - 1]?.text).toBe("Half a comment");
    await leave();
    expect(peekReviewDraft(workItemDrafts(item), "comment")).toBeUndefined();
  });

  test("a thread's reply box opens again with its words; Cancel forgets them", async () => {
    keepReviewDraft(workItemDrafts(item), `reply:${thread.id}`, "The red one");
    await draw(<Threads compose={null} />);
    expect(field().value).toBe("The red one");
    await click(button("Cancel"));
    await leave();
    expect(
      peekReviewDraft(workItemDrafts(item), `reply:${thread.id}`),
    ).toBeUndefined();
  });

  test("the items with a draft are known to the board, as they change", async () => {
    function Marked() {
      const items = useWorkDraftItems();
      return <p data-marked>{[...items].join(",")}</p>;
    }
    await draw(<Marked />);
    const marked = () => host.querySelector("[data-marked]")!.textContent;
    expect(marked()).toBe("");
    await act(async () => {
      keepReviewDraft(workItemDrafts(item), "ask", "Not yet");
    });
    expect(marked()).toBe(item);
    await act(async () => {
      keepReviewDraft(workItemDrafts(item), "ask", "");
    });
    expect(marked()).toBe("");
    await leave();
  });
}
