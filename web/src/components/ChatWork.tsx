import { ListPlus } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { agentAddress } from "../../../shared/agentMessage";
import type { WorkLink } from "../../../shared/work";
import { copyTextWithFeedback } from "../copyText";
import { useStoreSelector } from "../store";
import { useWorkOwnedCount } from "../work";
import { openWork } from "../workOpen";
import type { WorkWorkspace } from "../workScope";
import "./ChatWork.css";

/*
 * Add to Work from an agent's chat: the conversation's header, a
 * message's own buttons, a part's menu (a right-click or a long-press on
 * it, beside Comment and Copy) and the words selected start the Work
 * board's add form for that session, quoting the words and linking the
 * message. The item lands in the project holding
 * the session's workspace, owned by the session, which sorts it (a clear
 * title, tags, a state) as the coordinator does the board's. The header
 * says how many live items the session owns and opens the board on them.
 */

/** What a chat adds to Work with: its session, and how to start an add. */
export type ChatWork = {
  /** The session's address, `connection/pane`: the items' owner. */
  address: string;
  /**
   * The Work board's add form for the session: `quote` (a part's words, a
   * message's) quoted, `entry` the message it came from.
   */
  add: (quote?: string, entry?: string) => void;
};

/** A part's menu (a right-click on it): where it opens, what it offers. */
export type ChatPartMenu = {
  /** The words selected in the message, else the part's. */
  quote: string;
  /** Where it opens: the pointer, or under the part for the keys. */
  at: { x: number; y: number };
  /** What gets the focus back when Esc closes it. */
  back?: HTMLElement | null;
  /** The message the part is in. */
  entry?: string;
  /** Comment on the words, as the part's + does. */
  comment?: () => void;
};

type ChatWorkScope = ChatWork & { menu: (menu: ChatPartMenu) => void };

const ChatWorkContext = createContext<ChatWorkScope | null>(null);

/** The chat's Add to Work, inside its provider; null without one. */
export function useChatWork(): ChatWorkScope | null {
  return useContext(ChatWorkContext);
}

/** The longest quote the form starts with, as a part's quote is. */
const QUOTE_CHARS = 4000;

/** Words quoted in Markdown, then a blank line for the user's own. */
export function workQuote(quote: string): string {
  const words = quote.trim().slice(0, QUOTE_CHARS);
  if (!words) return "";
  return `${words
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n")}\n\n`;
}

/**
 * Add to Work for a session's chat: its address, and the add form
 * started on the board with the session's workspace (its project), the
 * words quoted and the message linked.
 */
export function useChatWorkAdd({
  connectionId,
  paneId,
  workspaceId,
  chat,
  path,
  name,
}: {
  connectionId: string | null;
  paneId: string;
  workspaceId: string;
  /** The chat's session id, when known: the link names it. */
  chat?: string | null | undefined;
  /** The session's working directory: its project when no workspace says. */
  path?: string | null | undefined;
  /** The session's name (its title, or its workspace's). */
  name: string;
}): ChatWork | null {
  const workspace = useStoreSelector((state) =>
    state.activeConnectionId === connectionId
      ? state.workspaces.find((each) => each.workspace_id === workspaceId)
      : undefined,
  );
  const address = connectionId ? agentAddress(connectionId, paneId) : null;
  const add = useCallback(
    (quote?: string, entry?: string) => {
      if (!connectionId || !address) return;
      const where: WorkWorkspace = {
        connectionId,
        workspaceId,
        label: workspace?.label ?? name,
        checkoutPath:
          workspace?.worktree?.checkout_path ?? workspace?.cwd ?? path ?? null,
        repoRoot: workspace?.worktree?.repo_root ?? null,
      };
      const link: WorkLink = {
        kind: "chat",
        session: address,
        ...(chat ? { chat } : {}),
        ...(entry ? { entry } : {}),
      };
      openWork({
        add: {
          text: workQuote(quote ?? ""),
          owner: address,
          ownerName: name,
          workspace: where,
          links: [link],
        },
      });
    },
    [connectionId, address, workspaceId, workspace, name, path, chat],
  );
  return useMemo(() => (address ? { address, add } : null), [address, add]);
}

/**
 * The chat's Add to Work for what it holds: its messages' buttons and
 * the menu a right-click on a part opens (Comment, Add to Work, Copy).
 */
export function ChatWorkProvider({
  work,
  children,
}: {
  work: ChatWork | null;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<ChatPartMenu | null>(null);
  const scope = useMemo<ChatWorkScope | null>(
    () => (work ? { ...work, menu: setMenu } : null),
    [work],
  );
  return (
    <ChatWorkContext.Provider value={scope}>
      {children}
      {menu && work ? (
        <ChatPartMenuView
          menu={menu}
          onAdd={() => work.add(menu.quote, menu.entry)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </ChatWorkContext.Provider>
  );
}

/**
 * The menu a right-click or a long-press on a part opens: Comment, Add to
 * Work, Copy. Where it was asked for, on the page (not in the part, whose
 * words it would join); the arrows or j / k and Enter, Esc gives the
 * focus back.
 */
export function ChatPartMenuView({
  menu,
  onAdd,
  onClose,
}: {
  menu: ChatPartMenu;
  onAdd: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const { x, y } = menu.at;
    const width = ref.current?.offsetWidth ?? 160;
    const height = ref.current?.offsetHeight ?? 100;
    setPlace({
      // Above the point when there is no room under it.
      top: y + height + 4 > window.innerHeight ? Math.max(4, y - height) : y,
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
    });
  }, [menu.at]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, []);
  const close = useCallback(
    (refocus: boolean) => {
      onClose();
      if (refocus && menu.back?.isConnected)
        menu.back.focus({ preventScroll: true });
    },
    [onClose, menu.back],
  );
  useEffect(() => {
    const away = (event: Event) => {
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [close]);
  const pick = (action: () => void) => {
    close(false);
    action();
  };
  const items: { label: string; run: () => void }[] = [
    ...(menu.comment ? [{ label: "Comment", run: menu.comment }] : []),
    { label: "Add to Work", run: onAdd },
    { label: "Copy", run: () => void copyTextWithFeedback(menu.quote) },
  ];
  return createPortal(
    <div
      ref={ref}
      className="chat-part-menu"
      role="menu"
      aria-label="This part"
      style={place ? { top: place.top, left: place.left } : { opacity: 0 }}
      onKeyDown={(event) => {
        const all = Array.from(
          ref.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [],
        );
        const at = all.indexOf(document.activeElement as HTMLElement);
        const key = event.key;
        if (key === "Escape") close(true);
        else if (key === "ArrowDown" || key === "j")
          all[(at + 1) % all.length]?.focus();
        else if (key === "ArrowUp" || key === "k")
          all[(at - 1 + all.length) % all.length]?.focus();
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => pick(item.run)}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/**
 * The conversation header's Work: how many live items the session owns
 * ("3 items", the board opened on them), and Add to Work.
 */
export function ChatWorkHeader({ work }: { work: ChatWork | null }) {
  const count = useWorkOwnedCount(work?.address ?? null);
  if (!work) return null;
  return (
    <>
      {count > 0 ? (
        <button
          type="button"
          className="agent-chat-work-count"
          title={`The Work items this session owns: ${count} not done`}
          aria-label={`Work: ${count} ${count === 1 ? "item" : "items"} this session owns`}
          onClick={() => openWork({ owner: work.address })}
        >
          {count} {count === 1 ? "item" : "items"}
        </button>
      ) : null}
      <button
        type="button"
        className="agent-history-icon"
        aria-label="Add to Work"
        title="Add to Work: an item this session owns and sorts"
        onClick={() => work.add()}
      >
        <ListPlus size={14} />
      </button>
    </>
  );
}

/** A message's own Add to Work, beside its Copy: the whole message quoted. */
export function ChatMessageWorkButton({
  text,
  entry,
  className,
}: {
  text: string;
  entry: string;
  className: string;
}) {
  const work = useChatWork();
  if (!work) return null;
  return (
    <button
      type="button"
      className={className}
      aria-label="Add this message to Work"
      title="Add to Work: an item this session owns and sorts, quoting the message"
      onClick={() => work.add(text, entry)}
    >
      <ListPlus size={12} />
    </button>
  );
}
