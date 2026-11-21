import {
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Link2,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Plus,
  RefreshCw,
  Rocket,
  Route,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReviewThread } from "../../../shared/review";
import {
  describeWorkLink,
  filterWorkItems,
  readableWorkLink,
  summarizeWorkLinks,
  WORK_STATE_TITLE,
  WORK_STATES,
  type WorkItem,
  type WorkLink,
  type WorkLinkGroupKind,
  type WorkLinkNames,
  workLinkGroupOf,
  type WorkProject,
  type WorkState,
  workDescriptionThread,
  workDoneWhen,
  workQueryWithTag,
  workTagCompletions,
} from "../../../shared/work";
import { openAgentTask } from "../agentTasksOpen";
import { nextColumn, nextRow } from "../boardNavigation";
import { roamgateLocalStorage } from "../browserStorage";
import { requestReviewShown, useReviewState } from "../review";
import { EMPTY_KEY_STATE, feedKey } from "../reviewNavigation";
import {
  shallowEqual,
  type State,
  store,
  TASK_NOTIFICATION_ACTIVATE_EVENT,
  useStoreSelector,
} from "../store";
import { useSystemBack } from "../systemBack";
import { formatUiDateTime } from "../uiLocale";
import { useWorkBoard, workCall } from "../work";
import {
  projectForWorkspace,
  readWorkScopeMemory,
  rememberWorkScope,
  WORK_SCOPE_ALL,
  type WorkScope,
  type WorkWorkspace,
  workScopeFor,
  workspaceScopeKey,
  workTagCounts,
} from "../workScope";
import { BoardCard } from "./BoardCard";
import { WorkAddForm } from "./WorkAddForm";
import {
  useWorkItemKeys,
  useWorkItemThreads,
  WorkDescription,
  WorkItemThreads,
} from "./WorkItemThreads";
import "./WorkBoard.css";

/**
 * The board view's Work mode: the user's work items in the view's columns
 * by state (For you, Doing, Verify, Open, Done), the project of the
 * workspace the page shows (or the one chosen there, or all), filtered by
 * the search: words, and tags as `#tag` or `tag:tag` (completed as they
 * are typed; a card's tag chip puts its tag there). Each card is an item: its title, tags, owner (a session
 * or its subagent), when it moved, its links. Opening a card (Enter, a
 * click) shows the item's detail in the view, as a request's is shown:
 * its description, state, tags, owner, links, then its thread with a
 * comment box; Esc goes back to the card. The view's keys and columns are
 * the inbox's: this is content for them, not a panel of its own.
 */

const NO_ITEMS: WorkItem[] = [];
const NO_PROJECTS: WorkProject[] = [];
const FOLDED_KEY = "mrReviewsWorkFolded";

function selectWorkWorkspace(state: State): WorkWorkspace | null {
  const workspace = state.workspaces.find((each) => each.focused);
  if (!workspace) return null;
  return {
    connectionId: state.activeConnectionId,
    workspaceId: workspace.workspace_id,
    label: workspace.label,
    checkoutPath: workspace.worktree?.checkout_path ?? workspace.cwd ?? null,
    repoRoot: workspace.worktree?.repo_root ?? null,
  };
}

/** The workspace the page shows, as the board scopes by it. */
export function useWorkWorkspace(): WorkWorkspace | null {
  return useStoreSelector(selectWorkWorkspace, shallowEqual);
}

/** "3 min ago", "2 h ago", "4 d ago". */
export function ago(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

type Column = { state: WorkState; items: WorkItem[] };

/** The columns, by state, the live ones newest first, Done by when. */
export function workColumns(items: readonly WorkItem[]): Column[] {
  return WORK_STATES.map((state) => ({
    state,
    items: items
      .filter((item) => item.state === state)
      .sort((a, b) =>
        state === "done"
          ? (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt)
          : b.updatedAt.localeCompare(a.updatedAt),
      ),
  }));
}

function storedFolded(): Set<WorkState> {
  try {
    const value = JSON.parse(
      roamgateLocalStorage.getItem(FOLDED_KEY) ?? '["done"]',
    );
    return new Set(
      Array.isArray(value)
        ? value.filter((state) => WORK_STATES.includes(state))
        : ["done"],
    );
  } catch {
    return new Set(["done"]);
  }
}

function keepFolded(folded: ReadonlySet<WorkState>) {
  try {
    roamgateLocalStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]));
  } catch {
    // Kept for this page only.
  }
}

/** The item's description (its text when it was added), when it has one. */
export function workDescriptionOf(
  threads: readonly ReviewThread[],
  item: WorkItem,
): ReviewThread | null {
  const thread = workDescriptionThread(threads, item);
  const body = thread?.comments[0]?.body.trim() ?? "";
  return thread && body && body !== item.title ? thread : null;
}

/** A card dragged between the columns: the item, the pointer, the column under it. */
export type WorkDrag = {
  item: WorkItem;
  x: number;
  y: number;
  /** The state column the pointer is over, when one. */
  over: WorkState | null;
};

/** A mouse drags after this far; a finger after holding this long. */
export const WORK_DRAG_MOVE_PX = 6;
export const WORK_DRAG_HOLD_MS = 250;
/** A finger that moves this far while holding scrolls instead. */
const WORK_DRAG_SLOP_PX = 10;

/** The state column under a point of the page, when one. */
export function workColumnAt(x: number, y: number): WorkState | null {
  const state = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>("[data-work-column]")?.dataset.workColumn;
  return state && WORK_STATES.includes(state as WorkState)
    ? (state as WorkState)
    : null;
}

/**
 * Dragging a card to another column, by pointer (a mouse moves it at once;
 * a finger or pen holds it first, so that the columns still scroll by
 * touch), changing the item's state on the drop as the detail's state menu
 * does. The keys are untouched; Esc lets go. Returns the drag in progress,
 * the handler for a card's pointer down, and the cancel.
 */
export function useWorkDrag(
  enabled: boolean,
  onDrop: (item: WorkItem, state: WorkState) => void,
): {
  drag: WorkDrag | null;
  start: (item: WorkItem) => (event: ReactPointerEvent<HTMLElement>) => void;
  cancel: () => void;
} {
  const [drag, setDrag] = useState<WorkDrag | null>(null);
  const live = useRef<WorkDrag | null>(null);
  const pending = useRef<{
    item: WorkItem;
    pointerId: number;
    x: number;
    y: number;
    mouse: boolean;
    target: HTMLElement;
    timer: ReturnType<typeof setTimeout> | null;
    stop: () => void;
  } | null>(null);

  const show = (next: WorkDrag | null) => {
    live.current = next;
    setDrag(next);
  };
  const end = useCallback(() => {
    const open = pending.current;
    if (!open) return;
    pending.current = null;
    if (open.timer) clearTimeout(open.timer);
    open.stop();
    try {
      if (open.target.hasPointerCapture?.(open.pointerId))
        open.target.releasePointerCapture(open.pointerId);
    } catch {
      // The element may be gone.
    }
    show(null);
  }, []);

  useEffect(() => end, [end]);
  useEffect(() => {
    if (!enabled) end();
  }, [enabled, end]);

  const start = useCallback(
    (item: WorkItem) => (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0 || !event.isPrimary) return;
      // Its buttons and links keep their clicks; a drag starts on the card.
      if (
        (event.target as HTMLElement).closest(
          "button, a, input, select, textarea",
        )
      )
        return;
      end();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const mouse = event.pointerType === "mouse";
      const begin = () => {
        const open = pending.current;
        if (!open || live.current) return;
        if (open.timer) clearTimeout(open.timer);
        open.timer = null;
        try {
          target.setPointerCapture(pointerId);
        } catch {
          // Capture is a nicety: the window listeners carry the drag.
        }
        // A finger: the page stops scrolling under the held card.
        document.addEventListener("touchmove", noScroll, { passive: false });
        show({
          item: open.item,
          x: open.x,
          y: open.y,
          over: workColumnAt(open.x, open.y),
        });
      };
      const noScroll = (touch: TouchEvent) => {
        if (touch.cancelable) touch.preventDefault();
      };
      const move = (moved: PointerEvent) => {
        const open = pending.current;
        if (!open || moved.pointerId !== pointerId) return;
        const dx = moved.clientX - open.x;
        const dy = moved.clientY - open.y;
        const far = Math.hypot(dx, dy);
        if (!live.current) {
          if (open.mouse) {
            if (far >= WORK_DRAG_MOVE_PX) begin();
            else return;
          } else if (far > WORK_DRAG_SLOP_PX) {
            // A swipe before the hold is a scroll: not a drag.
            end();
            return;
          } else return;
        }
        if (!live.current) return;
        show({
          ...live.current,
          x: moved.clientX,
          y: moved.clientY,
          over: workColumnAt(moved.clientX, moved.clientY),
        });
      };
      const swallowClick = () => {
        const stop = (click: Event) => {
          click.stopPropagation();
          click.preventDefault();
        };
        document.addEventListener("click", stop, { capture: true });
        setTimeout(
          () => document.removeEventListener("click", stop, { capture: true }),
          0,
        );
      };
      const up = (upped: PointerEvent) => {
        if (upped.pointerId !== pointerId) return;
        const current = live.current;
        if (current) {
          const over = workColumnAt(upped.clientX, upped.clientY);
          // The drop is no click on the card: it stays where it is.
          swallowClick();
          if (over && over !== current.item.state) onDrop(current.item, over);
        }
        end();
      };
      const cancel = (cancelled: PointerEvent) => {
        if (cancelled.pointerId === pointerId) end();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      pending.current = {
        item,
        pointerId,
        x: event.clientX,
        y: event.clientY,
        mouse,
        target,
        // A mouse waits for a move; a finger, for the hold.
        timer: mouse ? null : setTimeout(begin, WORK_DRAG_HOLD_MS),
        stop: () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", cancel);
          document.removeEventListener("touchmove", noScroll);
        },
      };
    },
    [enabled, end, onDrop],
  );

  return { drag, start, cancel: end };
}

export type WorkModeOptions = {
  /** The view shows this mode: its state lives, its keys answer. */
  enabled: boolean;
  mobile: boolean;
  /** A wide pane: the columns side by side (the view's rule). */
  board: boolean;
  panelRef: RefObject<HTMLElement | null>;
  onClose: (options?: { keepFocus?: boolean }) => void;
  /** An item to open on (a notification's link). */
  initialItem?: string;
  /** The upstreaming efforts the view knows: their names. */
  efforts?: readonly { id: string; name: string }[] | undefined;
  /** The requests the view knows: their titles, by URL. */
  requests?: readonly { url: string; title: string }[] | undefined;
  /** Shows an effort's view (the inbox mode's). */
  onOpenEffort?: (id: string) => void;
};

export type WorkMode = {
  /** The For you items, in every project: the Work tab's badge. */
  forYou: number;
  /** The head's second line: the scope and the counts. */
  meta: ReactNode;
  /** The head's own buttons: add, read again. */
  actions: ReactNode;
  /** The search box's value and setter (the view draws the box). */
  query: string;
  setQuery: (next: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** The search's tag completions, the one chosen, and how to take one. */
  completions: { tag: string; insert: string }[];
  completionAt: number;
  complete: (index: number) => boolean;
  onSearchFocus: (focused: boolean) => void;
  /** The content under the head: the filter row and the columns, the item's detail, the form. */
  body: ReactNode;
  /** The detail or the form shows: no search box, no filter row. */
  inner: boolean;
  /** One key in the panel; true when the mode took it. */
  onKey: (event: KeyboardEvent) => boolean;
  /** The selected card is scrolled into view. */
  selected: string | null;
};

export function useWorkMode({
  enabled,
  mobile,
  board,
  panelRef,
  onClose,
  initialItem,
  efforts,
  requests,
  onOpenEffort,
}: WorkModeOptions): WorkMode {
  const { board: data, error, reload } = useWorkBoard();
  const reviews = useReviewState();
  const workspace = useWorkWorkspace();
  const searchRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef<HTMLSelectElement>(null);
  const tagsRef = useRef<HTMLInputElement>(null);
  const [memory, setMemory] = useState(() => readWorkScopeMemory());
  /** The scope chosen on this board, for the workspace it was chosen in. */
  const [choice, setChoice] = useState<{
    key: string;
    scope: WorkScope;
  } | null>(null);
  const [query, setQueryState] = useState("");
  // The search completes a tag as it is typed (#vo, tag:vo): Tab, the
  // arrows and Enter take one, Esc puts them away, as the reviews' do.
  const [searchFocused, setSearchFocused] = useState(false);
  const [completionAt, setCompletionAt] = useState(-1);
  const [completionsOff, setCompletionsOff] = useState(false);
  const setQuery = (next: string) => {
    setQueryState(next);
    setCompletionAt(-1);
    setCompletionsOff(false);
  };
  const [folded, setFolded] = useState<Set<WorkState>>(storedFolded);
  const [selected, setSelected] = useState<string | null>(initialItem ?? null);
  const [detail, setDetail] = useState<string | null>(initialItem ?? null);
  const [compose, setCompose] = useState<"comment" | "reply" | null>(null);
  /** The detail's list, where its keys are (the chat threads' keys). */
  const detailListRef = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const keyState = useRef(EMPTY_KEY_STATE);
  /** s or t on a card: the detail opens with that box focused. */
  const pendingFocus = useRef<"state" | "tags" | null>(null);
  // The phone's Back closes the detail, then the view.
  useSystemBack(
    enabled && (detail !== null || adding),
    () => {
      setDetail(null);
      setAdding(false);
    },
    "popup",
  );

  const projects = data?.projects ?? NO_PROJECTS;
  const boardItems = data?.items ?? NO_ITEMS;
  const workspaceKey = workspace ? workspaceScopeKey(workspace) : "";
  const openedOn = useMemo(
    () =>
      initialItem ? boardItems.find((each) => each.id === initialItem) : null,
    [initialItem, boardItems],
  );
  const resolved = useMemo(
    () => workScopeFor({ workspace, projects, memory, item: openedOn }),
    [workspace, projects, memory, openedOn],
  );
  /** The project shown, or null for all of them. */
  const scope: WorkScope =
    choice && choice.key === workspaceKey ? choice.scope : resolved.scope;
  const ownProject = useMemo(
    () => projectForWorkspace(workspace, projects),
    [workspace, projects],
  );
  const choose = (next: WorkScope) => {
    setChoice({ key: workspaceKey, scope: next });
    setMemory((current) => rememberWorkScope(current, workspace, next));
    setQuery("");
    setSelected(null);
  };
  const projectItems = useMemo(
    () =>
      scope ? boardItems.filter((item) => item.project === scope) : boardItems,
    [boardItems, scope],
  );
  const tagCounts = useMemo(() => workTagCounts(projectItems), [projectItems]);
  const completions = useMemo(
    () =>
      searchFocused && !completionsOff
        ? workTagCompletions(
            query,
            tagCounts.map(({ tag }) => tag),
          ).slice(0, 12)
        : [],
    [query, tagCounts, searchFocused, completionsOff],
  );
  const complete = (index: number) => {
    const chosen = completions[Math.max(0, index)];
    if (!chosen) return false;
    setQuery(chosen.insert);
    return true;
  };
  /** A tag's chip on a card: the search keeps that tag's items. */
  const searchTag = (tag: string) => {
    setQuery(workQueryWithTag(query, tag));
    setSelected(null);
  };
  const items = useMemo(
    () => filterWorkItems(projectItems, { query }),
    [projectItems, query],
  );
  const columns = useMemo(() => workColumns(items), [items]);
  /** The columns as drawn: folded ones hold nothing the keys walk. */
  const columnKeys = useMemo(
    () =>
      columns.map((column) =>
        folded.has(column.state) ? [] : column.items.map((item) => item.id),
      ),
    [columns, folded],
  );
  const orderedKeys = useMemo(() => columnKeys.flat(), [columnKeys]);
  const forYou = projectItems.filter((item) => item.state === "you").length;
  const forYouAll = boardItems.filter((item) => item.state === "you").length;
  const openCount = projectItems.filter((item) => item.state !== "done").length;
  const projectName = (id: string) =>
    projects.find((each) => each.id === id)?.name ?? id;
  /** The scope's name in the head: the workspace's when it is its project. */
  const scopeName = !data
    ? null
    : scope === null
      ? projects.length > 1
        ? "All projects"
        : null
      : workspace && ownProject?.id === scope
        ? workspace.label
        : projectName(scope);
  const status = data
    ? `${forYou} for you · ${openCount} open${scope && forYouAll > forYou ? ` · ${forYouAll} for you in all` : ""}`
    : error
      ? `Not loaded: ${error}`
      : "Loading...";

  const back = useCallback(
    () =>
      requestAnimationFrame(() =>
        panelRef.current?.focus({ preventScroll: true }),
      ),
    [panelRef],
  );
  const select = useCallback((id: string | null) => {
    setSelected(id);
  }, []);
  // The selected card follows the keys and stays in view.
  useEffect(() => {
    if (!enabled || !selected || detail) return;
    panelRef.current
      ?.querySelector(`[data-work-item="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [enabled, selected, detail, panelRef]);
  // An item asked for (a notification's link): its column unfolded.
  useEffect(() => {
    if (!initialItem || !data) return;
    const item = data.items.find((each) => each.id === initialItem);
    if (!item) return;
    setFolded((current) => {
      if (!current.has(item.state)) return current;
      const next = new Set(current);
      next.delete(item.state);
      keepFolded(next);
      return next;
    });
  }, [initialItem, data]);
  // The detail's box asked for from a card (s, t): focused once drawn.
  useEffect(() => {
    if (!detail || !pendingFocus.current) return;
    const wanted = pendingFocus.current;
    pendingFocus.current = null;
    requestAnimationFrame(() =>
      (wanted === "state" ? stateRef : tagsRef).current?.focus(),
    );
  }, [detail]);

  const act = useCallback(
    async (method: string, params: Record<string, unknown>) => {
      setFailure(null);
      try {
        await workCall(method, params);
        return true;
      } catch (cause) {
        setFailure(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
    },
    [],
  );
  // A card dragged to another column: its state, as the detail's menu sets it.
  const onDrop = useCallback(
    (item: WorkItem, state: WorkState) =>
      void act("update", { item: item.id, state }),
    [act],
  );
  const {
    drag,
    start: dragStart,
    cancel: dragCancel,
  } = useWorkDrag(enabled && !detail && !adding, onDrop);

  /** Where the owner is: its pane shown, its task's sheet opened. */
  const openOwner = useCallback(
    async (item: WorkItem) => {
      if (!item.owner) return;
      setFailure(null);
      try {
        const { target } = await workCall<{
          target: {
            connectionId: string;
            runtimeGeneration: number;
            workspaceId: string;
            paneId: string;
            task?: string;
          } | null;
        }>("owner_target", { item: item.id });
        if (!target) {
          setFailure(
            `${item.owner.session} is not running in any pane right now`,
          );
          return;
        }
        window.dispatchEvent(
          new CustomEvent(TASK_NOTIFICATION_ACTIVATE_EVENT, {
            detail: {
              connectionId: target.connectionId,
              runtimeGeneration: target.runtimeGeneration,
              workspaceId: target.workspaceId,
              paneId: target.paneId,
            },
          }),
        );
        if (target.task) openAgentTask(target.paneId, target.task);
        // The pane is behind the panel on a phone: the panel steps aside.
        if (mobile) onClose({ keepFocus: true });
      } catch (cause) {
        setFailure(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [mobile, onClose],
  );

  /** A link's action, from the item's detail. */
  const openLink = useCallback(
    (link: WorkLink) => {
      switch (link.kind) {
        case "review": {
          const snapshot = reviews.sessions.get(link.id);
          if (snapshot) {
            requestReviewShown(snapshot.session.connectionId, link.id);
            if (mobile) onClose({ keepFocus: true });
          } else
            setFailure(
              `review ${link.id.slice(0, 8)} is not loaded on this page`,
            );
          return;
        }
        case "effort":
          onOpenEffort?.(link.id);
          return;
        case "pr":
          window.open(link.url, "_blank", "noopener");
          return;
        case "item":
          setDetail(link.id);
          setSelected(link.id);
          return;
        case "commit":
          // Its review (`SHA^..SHA`), shown in Changes as Commits' is.
          void import("../reviewOpen").then(async ({ openCommitReview }) => {
            const sessionId = await openCommitReview(link.sha, {
              ...(link.root ? { path: link.root } : {}),
            });
            const connectionId = store.get().activeConnectionId;
            if (!sessionId || !connectionId) return;
            requestReviewShown(connectionId, sessionId);
            if (mobile) onClose({ keepFocus: true });
          });
          return;
        case "branch":
          void navigator.clipboard?.writeText(link.name).catch(() => {});
          return;
        case "deploy":
          void navigator.clipboard?.writeText(link.sha).catch(() => {});
          return;
        default:
          return;
      }
    },
    [reviews.sessions, mobile, onClose, onOpenEffort],
  );
  /** What names the detail's links: efforts, requests, reviews, items. */
  const linkNames = useMemo<WorkLinkNames>(
    () => ({
      effort: (id) => efforts?.find((each) => each.id === id)?.name,
      pr: (url) => requests?.find((each) => each.url === url)?.title,
      review: (id, thread) => {
        const snapshot = reviews.sessions.get(id);
        if (!snapshot) return undefined;
        const body = thread
          ? snapshot.threads.find((each) => each.id === thread)?.comments[0]
              ?.body
          : undefined;
        const words = body?.replace(/\s+/g, " ").trim();
        return {
          title: snapshot.session.title,
          ...(words
            ? {
                thread: words.length > 80 ? `${words.slice(0, 79)}...` : words,
              }
            : {}),
        };
      },
      item: (id) => boardItems.find((each) => each.id === id)?.title,
    }),
    [efforts, requests, reviews.sessions, boardItems],
  );

  const selectedItem = items.find((item) => item.id === selected) ?? null;
  const detailItem = detail
    ? (boardItems.find((item) => item.id === detail) ?? null)
    : null;
  const markDone = (item: WorkItem) => void act("done", { item: item.id });
  const openDetail = (item: WorkItem) => {
    setSelected(item.id);
    setDetail(item.id);
  };
  const closeDetail = () => {
    setDetail(null);
    setCompose(null);
    back();
  };
  const toggleFold = (state: WorkState) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      keepFolded(next);
      return next;
    });
  const placeSelected = (where: "center" | "start" | "end") => {
    if (!selected) return;
    panelRef.current
      ?.querySelector<HTMLElement>(`[data-work-item="${CSS.escape(selected)}"]`)
      ?.closest<HTMLElement>(".mr-reviews-item")
      ?.scrollIntoView({ block: where });
  };

  /** One key in the panel; true when the mode took it. */
  const onKey = (event: KeyboardEvent): boolean => {
    if (!enabled) return false;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const typing = !!target?.closest(
      "input, textarea, select, [contenteditable], .cm-editor",
    );
    if (typing) {
      // The search's tag completions: Tab, the arrows, Enter on one taken.
      if (target === searchRef.current && completions.length) {
        const key = event.ctrlKey ? `C-${event.key}` : event.key;
        if (key === "Tab") return complete(completionAt);
        if (key === "ArrowDown" || key === "C-n") {
          setCompletionAt((at) => (at + 1) % completions.length);
          return true;
        }
        if (key === "ArrowUp" || key === "C-p") {
          setCompletionAt((at) => (at <= 0 ? completions.length : at) - 1);
          return true;
        }
        if (key === "Enter" && completionAt >= 0) return complete(completionAt);
        if (key === "Escape") {
          setCompletionsOff(true);
          setCompletionAt(-1);
          return true;
        }
      }
      // A box keeps its keys; Esc leaves it (the comment editor takes its
      // own Esc: Vim's insert mode ends on it).
      if (event.key === "Escape" && !target?.closest(".cm-editor")) {
        if (target === searchRef.current && query) setQuery("");
        target?.blur?.();
        panelRef.current?.focus({ preventScroll: true });
        return true;
      }
      if (event.key === "Enter" && target === searchRef.current) {
        target?.blur?.();
        panelRef.current?.focus({ preventScroll: true });
        const first = selected ?? nextRow(null, orderedKeys, null, 1);
        if (first) select(first);
        return true;
      }
      return false;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key === "Escape") {
      keyState.current = EMPTY_KEY_STATE;
      if (drag) dragCancel();
      else if (adding) {
        setAdding(false);
        back();
      } else if (detail) closeDetail();
      else if (query) setQuery("");
      else if (selected) setSelected(null);
      else return false;
      return true;
    }
    if (adding) return false;
    // The detail's list has the keys when it has the focus (the chat
    // threads' keys, and the detail's own through them).
    if (detailItem && target?.closest("[data-work-keys]")) return false;
    const fed = feedKey(keyState.current, event.key);
    keyState.current = fed.state;
    if (fed.type === "wait") return true;
    const count = fed.count ?? 1;
    const key = fed.key;
    if (detailItem) {
      const list = detailListRef.current;
      if (
        list &&
        (key === "j" ||
          key === "k" ||
          key === "ArrowDown" ||
          key === "ArrowUp" ||
          key === "gg" ||
          key === "G")
      ) {
        // The keys go to the list, and this one with them.
        list.focus({ preventScroll: true });
        if (key.length === 1 || key.startsWith("Arrow"))
          list.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true }),
          );
      } else if (key === "c") setCompose("comment");
      else if (key === "r") setCompose("reply");
      else if (key === "s") stateRef.current?.focus();
      else if (key === "t") tagsRef.current?.focus();
      else if (key === "o") void openOwner(detailItem);
      else if (key === "dd" && detailItem.state !== "done")
        markDone(detailItem);
      else return false;
      return true;
    }
    const current = selectedItem;
    if (
      board &&
      (key === "h" ||
        key === "l" ||
        key === "ArrowLeft" ||
        key === "ArrowRight" ||
        key === "Tab")
    ) {
      const next = nextColumn(
        columnKeys,
        selected,
        key === "h" || key === "ArrowLeft" || (key === "Tab" && event.shiftKey)
          ? -count
          : count,
      );
      if (next) select(next);
    } else if (key === "j" || key === "ArrowDown")
      select(nextRow(board ? columnKeys : null, orderedKeys, selected, count));
    else if (key === "k" || key === "ArrowUp")
      select(nextRow(board ? columnKeys : null, orderedKeys, selected, -count));
    else if (key === "gg" || key === "Home") {
      const at = Math.min(orderedKeys.length, count) - 1;
      if (at >= 0) select(orderedKeys[at]!);
    } else if (key === "G" || key === "End") {
      const at =
        Math.min(orderedKeys.length, fed.count ?? orderedKeys.length) - 1;
      if (at >= 0) select(orderedKeys[at]!);
    } else if (key === "zz" || key === "zt" || key === "zb")
      placeSelected(key === "zz" ? "center" : key === "zt" ? "start" : "end");
    else if (key === "Enter" || key === "i") {
      if (current) openDetail(current);
      else {
        const first = nextRow(null, orderedKeys, null, 1);
        if (first) select(first);
      }
    } else if (key === "za" || key === "zc" || key === "zo") {
      if (current) toggleFold(current.state);
    } else if (key === "a") setAdding(true);
    else if (key === "/") {
      searchRef.current?.focus();
      searchRef.current?.select();
    } else if (key === "r") void reload();
    else if (key === "o" && current) void openOwner(current);
    else if (key === "dd" && current && current.state !== "done")
      markDone(current);
    else if (key === "c" && current) {
      openDetail(current);
      setCompose("comment");
    } else if ((key === "s" || key === "t") && current) {
      pendingFocus.current = key === "s" ? "state" : "tags";
      openDetail(current);
    } else return false;
    return true;
  };

  const deployed = data?.deployed;
  const inner = adding || !!detailItem;
  const meta = (
    <>
      {scopeName ? (
        <span
          className="work-scope-name"
          title={
            scope
              ? `${projectName(scope)}${workspace && ownProject?.id === scope ? `: the project of ${workspace.label}` : ""}`
              : "Every project"
          }
        >
          {scopeName}
        </span>
      ) : null}
      <span className="assistant-panel-status work-status" role="status">
        {status}
      </span>
    </>
  );
  const actions = (
    <>
      <button
        type="button"
        className="assistant-icon-button"
        aria-label="Add an item (a)"
        title="Add an item (a)"
        aria-pressed={adding}
        onClick={() => setAdding(true)}
      >
        <Plus size={16} />
      </button>
      <button
        type="button"
        className="assistant-icon-button"
        aria-label="Read again (r)"
        title="Read again (r)"
        onClick={() => void reload()}
      >
        <RefreshCw size={16} />
      </button>
    </>
  );

  const body = !enabled ? null : (
    <>
      {failure ? (
        <div className="assistant-error" role="alert">
          <span>{failure}</span>
          <button
            type="button"
            className="ghost"
            onClick={() => setFailure(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {adding && (scope ?? projects[0]?.id) ? (
        <WorkAddForm
          project={scope ?? projects[0]!.id}
          projectName={projectName(scope ?? projects[0]!.id)}
          onCancel={() => {
            setAdding(false);
            back();
          }}
          onAdd={async (params) => {
            setFailure(null);
            try {
              const { item } = await workCall<{ item: WorkItem }>("add", {
                ...params,
                project: scope ?? projects[0]!.id,
              });
              setAdding(false);
              setSelected(item.id);
              back();
            } catch (cause) {
              setFailure(
                cause instanceof Error ? cause.message : String(cause),
              );
            }
          }}
        />
      ) : detailItem ? (
        <WorkDetail
          item={detailItem}
          project={scope ? null : projectName(detailItem.project)}
          doneWhen={workDoneWhen(
            detailItem,
            projects.find((each) => each.id === detailItem.project),
          )}
          compose={compose}
          onCompose={setCompose}
          onComposeDone={() => setCompose(null)}
          onBack={closeDetail}
          onOpenOwner={() => void openOwner(detailItem)}
          onLink={openLink}
          linkNames={linkNames}
          canOpenEffort={!!onOpenEffort}
          onState={(next) =>
            void act("update", { item: detailItem.id, state: next })
          }
          onDone={() => markDone(detailItem)}
          onReopen={() => void act("reopen", { item: detailItem.id })}
          onTags={(next) =>
            void act("update", { item: detailItem.id, tags: next })
          }
          onRemove={() => {
            if (window.confirm(`Delete "${detailItem.title}"?`)) {
              setDetail(null);
              void act("remove", { item: detailItem.id });
            }
          }}
          back={back}
          stateRef={stateRef}
          tagsRef={tagsRef}
          listRef={detailListRef}
        />
      ) : (
        <>
          {projects.length > 1 ? (
            <div className="work-filter-row">
              <select
                className="work-scope-select"
                aria-label="Project"
                title="The project shown: the workspace's, another, or all"
                value={scope ?? WORK_SCOPE_ALL}
                onChange={(event) => {
                  const value = event.target.value;
                  choose(value === WORK_SCOPE_ALL ? null : value);
                  back();
                }}
              >
                <option value={WORK_SCOPE_ALL}>
                  All projects (
                  {boardItems.filter((item) => item.state !== "done").length})
                </option>
                {projects.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.name} (
                    {
                      boardItems.filter(
                        (item) =>
                          item.project === each.id && item.state !== "done",
                      ).length
                    }
                    )
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {data && !items.length ? (
            <p className="assistant-hint">
              {projectItems.length
                ? "Nothing matches the filter."
                : "No work item yet: a (or the + button) adds one; agents add theirs with work_add."}
            </p>
          ) : null}
          <div
            className={`${board ? "mr-reviews-board" : "mr-reviews-sections"}${drag ? " is-work-dragging" : ""}`}
          >
            {columns.map(({ state, items: inColumn }) => {
              // A list on a narrow pane leaves empty states out, but a card
              // being dragged can be dropped in any of them.
              if (!inColumn.length && !board && !drag) return null;
              const isFolded = folded.has(state);
              return (
                <div
                  key={state}
                  className={`mr-reviews-lane is-${state}${isFolded ? " is-folded" : ""}${drag?.over === state ? " is-drop-target" : ""}${drag?.item.state === state ? " is-drop-source" : ""}`}
                  role="group"
                  aria-label={WORK_STATE_TITLE[state]}
                  data-work-column={state}
                >
                  <button
                    type="button"
                    className="mr-reviews-lane-title"
                    aria-expanded={!isFolded}
                    title={`${isFolded ? "Expand" : "Fold"} ${WORK_STATE_TITLE[state]} (za)`}
                    onClick={() => toggleFold(state)}
                  >
                    {isFolded ? (
                      <ChevronRight size={13} />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                    {WORK_STATE_TITLE[state]}
                    <span>{inColumn.length}</span>
                  </button>
                  {isFolded ? null : (
                    <ul className="assistant-task-list">
                      {inColumn.map((item) => (
                        <WorkCard
                          key={item.id}
                          item={item}
                          project={scope ? null : projectName(item.project)}
                          selected={item.id === selected}
                          dragging={drag?.item.id === item.id}
                          onDragStart={dragStart(item)}
                          onSelect={() => select(item.id)}
                          onOpen={() => openDetail(item)}
                          onOpenOwner={() => void openOwner(item)}
                          onTag={searchTag}
                          onDone={() => markDone(item)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
          {drag ? (
            <div
              className="work-drag-ghost"
              aria-hidden="true"
              style={{ left: drag.x, top: drag.y }}
            >
              {drag.item.title}
              {drag.over && drag.over !== drag.item.state ? (
                <small>{WORK_STATE_TITLE[drag.over]}</small>
              ) : null}
            </div>
          ) : null}
          {deployed ? (
            <p className="assistant-hint work-deployed">
              Deployed build {deployed.slice(0, 10)}: items whose commit it
              holds are done.
            </p>
          ) : null}
          {!mobile ? (
            <p className="assistant-hint mr-reviews-keys">
              j/k move · h/l columns · Enter open · c comment · s state (or drag
              a card to a column) · t tags · o the agent's work · dd done · a
              add · za fold · / search (#tag) · [ ] Reviews · ? all keys
            </p>
          ) : null}
        </>
      )}
    </>
  );

  return {
    forYou: forYouAll,
    meta,
    actions,
    query,
    setQuery,
    searchRef,
    completions,
    completionAt,
    complete,
    onSearchFocus: setSearchFocused,
    body,
    inner,
    onKey,
    selected,
  };
}

/** The owner as a chip: the session, and its subagent's task. */
function OwnerChip({ owner }: { owner: NonNullable<WorkItem["owner"]> }) {
  return (
    <span
      className="mr-reviews-chip is-wait work-owner"
      title={
        owner.task
          ? `Subagent ${owner.task} of ${owner.session}`
          : owner.session
      }
    >
      <Bot size={11} aria-hidden="true" />
      {owner.session}
      {owner.task ? ` · ${owner.task.slice(0, 8)}` : ""}
    </span>
  );
}

function WorkCard({
  item,
  project,
  selected,
  dragging,
  onDragStart,
  onSelect,
  onOpen,
  onOpenOwner,
  onTag,
  onDone,
}: {
  item: WorkItem;
  /** Its project's name, when the board shows every project. */
  project: string | null;
  selected: boolean;
  /** Being dragged to another column. */
  dragging?: boolean;
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  onSelect: () => void;
  onOpen: () => void;
  onOpenOwner: () => void;
  /** A tag's chip: the search keeps that tag's items. */
  onTag: (tag: string) => void;
  onDone: () => void;
}) {
  return (
    <BoardCard
      selected={selected}
      className={`work-card is-${item.state}${dragging ? " is-dragging" : ""}`}
      data={{ "data-work-item": item.id, "data-work-state": item.state }}
      item={onDragStart ? { onPointerDown: onDragStart } : undefined}
      onSelect={onSelect}
      onOpen={onOpen}
      actions={
        selected ? (
          <>
            {item.owner ? (
              <button
                type="button"
                className="assistant-icon-button mr-reviews-action-more"
                aria-label="Open the agent's work (o)"
                title={
                  item.owner.task
                    ? `Open the subagent's work in ${item.owner.session} (o)`
                    : `Open the session ${item.owner.session} (o)`
                }
                onClick={onOpenOwner}
              >
                <Bot size={14} />
              </button>
            ) : null}
            {item.state !== "done" ? (
              <button
                type="button"
                className="assistant-icon-button mr-reviews-action-more"
                aria-label="Done (dd)"
                title="Done (dd)"
                onClick={onDone}
              >
                <Check size={14} />
              </button>
            ) : null}
          </>
        ) : null
      }
    >
      <div className="mr-reviews-dense-head">
        <strong>{item.title}</strong>
        <span className="mr-reviews-dense-chips" aria-label="Tags and owner">
          {item.needsTriage ? (
            <span
              className="mr-reviews-chip is-wait work-triage"
              title="Added as free text: its owner gives it a clear title, tags and a state"
            >
              being sorted
            </span>
          ) : null}
          {project ? (
            <span className="mr-reviews-chip is-tree">{project}</span>
          ) : null}
          {item.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className="mr-reviews-chip is-label work-tag"
              title={`Only the items tagged ${tag} (#${tag} in the search)`}
              onClick={(event) => {
                event.stopPropagation();
                onTag(tag);
              }}
            >
              {tag}
            </button>
          ))}
          {item.owner ? <OwnerChip owner={item.owner} /> : null}
        </span>
      </div>
      <span className="mr-reviews-next">
        {item.links.length ? (
          <span
            className="mr-reviews-dense-chips work-link-chips"
            aria-label="Links"
          >
            {summarizeWorkLinks(item.links).map((group) => {
              const Icon = WORK_LINK_ICONS[group.kind];
              return (
                <span
                  key={group.kind}
                  className={`mr-reviews-chip is-label work-link-chip is-${group.kind}${group.kind === "deploy" ? " is-good" : ""}`}
                  title={group.title}
                >
                  <Icon size={10} aria-hidden="true" />
                  {group.label}
                </span>
              );
            })}
          </span>
        ) : null}
        <small className="mr-reviews-dense-meta">
          {ago(
            item.state === "done"
              ? (item.doneAt ?? item.updatedAt)
              : item.updatedAt,
          )}
          {item.by === "agent" ? " · by an agent" : ""}
        </small>
      </span>
    </BoardCard>
  );
}

/** A link chip's icon, by the kind its chip groups. */
const WORK_LINK_ICONS: Record<WorkLinkGroupKind, LucideIcon> = {
  effort: Route,
  pr: GitPullRequest,
  thread: MessageSquare,
  review: FileDiff,
  branch: GitBranch,
  commit: GitCommitHorizontal,
  decision: ListChecks,
  item: Link2,
  deploy: Rocket,
};

/** What a link's button does, said on it; null: it does nothing. */
function workLinkAction(link: WorkLink, canOpenEffort: boolean): string | null {
  switch (link.kind) {
    case "review":
      return link.thread ? "Open the thread's review" : "Open the review";
    case "effort":
      return canOpenEffort ? "Open the effort's view" : null;
    case "pr":
      return "Open the request online";
    case "commit":
      return "Review the commit in Changes";
    case "branch":
      return "Copy the branch's name";
    case "item":
      return "Open that item";
    case "deploy":
      return link.sha === "decision" ? null : "Copy the commit's sha";
    case "decision":
      return null;
  }
}

/**
 * A link in the item's detail: its icon, a label one reads and what it
 * is, the whole row its action (open the effort, the review, the commit,
 * the request online); a commit's sha copied beside.
 */
function WorkLinkRow({
  link,
  names,
  canOpenEffort,
  onOpen,
}: {
  link: WorkLink;
  names: WorkLinkNames;
  canOpenEffort: boolean;
  onOpen: () => void;
}) {
  const { label, detail } = readableWorkLink(link, names);
  const Icon = WORK_LINK_ICONS[workLinkGroupOf(link)];
  const action = workLinkAction(link, canOpenEffort);
  const body = (
    <>
      <Icon size={13} aria-hidden="true" />
      <span className="work-link-text">
        <span className="work-link-label">{label}</span>
        {detail ? <small>{detail}</small> : null}
      </span>
    </>
  );
  return (
    <li className={`work-link-row is-${workLinkGroupOf(link)}`}>
      {action ? (
        <button
          type="button"
          className="work-link-open"
          title={action}
          onClick={onOpen}
        >
          {body}
        </button>
      ) : (
        <span className="work-link-open">{body}</span>
      )}
      {link.kind === "commit" ? (
        <button
          type="button"
          className="assistant-icon-button"
          aria-label="Copy the sha"
          title={`Copy ${link.sha.slice(0, 10)}`}
          onClick={() =>
            void navigator.clipboard?.writeText(link.sha).catch(() => {})
          }
        >
          <Copy size={13} />
        </button>
      ) : null}
    </li>
  );
}

/**
 * An item's detail in the view, as a request's: its title and state, its
 * description (its text when it was added), what one sets (state, tags),
 * its owner (and the agent's work), its project, links and dates, its
 * buttons, then its thread, whose comments go to the owner session. The
 * description and the comments are messages in parts, with the chat
 * threads' keys on the detail (`listRef`: where they are).
 */
function WorkDetail({
  item,
  project,
  doneWhen,
  compose,
  onCompose,
  onComposeDone,
  onBack,
  onOpenOwner,
  onLink,
  linkNames,
  canOpenEffort,
  onState,
  onDone,
  onReopen,
  onTags,
  onRemove,
  back,
  stateRef,
  tagsRef,
  listRef,
}: {
  item: WorkItem;
  project: string | null;
  /** How the item becomes done by itself, when something watches it. */
  doneWhen: string | null;
  compose: "comment" | "reply" | null;
  onCompose: (what: "comment" | "reply") => void;
  onComposeDone: () => void;
  onBack: () => void;
  onOpenOwner: () => void;
  onLink: (link: WorkLink) => void;
  /** What names its links better than their ids. */
  linkNames: WorkLinkNames;
  /** An effort link opens the effort's view. */
  canOpenEffort: boolean;
  onState: (state: WorkState) => void;
  onDone: () => void;
  onReopen: () => void;
  onTags: (tags: string[]) => void;
  onRemove: () => void;
  back: () => void;
  stateRef: RefObject<HTMLSelectElement | null>;
  tagsRef: RefObject<HTMLInputElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const api = useWorkItemThreads(item.id);
  const description = useMemo(
    () => workDescriptionOf(api.threads, item),
    [api.threads, item],
  );
  const owner = item.owner;
  /** A box closed: the keys go back to the detail. */
  const leave = useCallback(
    () => listRef.current?.focus({ preventScroll: true }),
    [listRef],
  );
  useWorkItemKeys({
    api,
    description,
    getList: () => listRef.current,
    fallback: (key) => {
      if (key === "c") onCompose("comment");
      else if (key === "r") onCompose("reply");
      else if (key === "s") stateRef.current?.focus();
      else if (key === "t") tagsRef.current?.focus();
      else if (key === "o") onOpenOwner();
      else if (key === "dd") {
        if (item.state !== "done") onDone();
      } else return false;
      return true;
    },
  });
  // The keys are the detail's as it opens.
  useEffect(() => {
    listRef.current?.focus({ preventScroll: true });
  }, [listRef]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys' list
    <div
      className="work-detail-keys"
      data-work-keys=""
      tabIndex={-1}
      ref={listRef}
    >
      <div className="assistant-section-heading">
        <button type="button" className="ghost" onClick={onBack}>
          <ChevronLeft size={13} /> All items
        </button>
      </div>
      <section
        className="assistant-task-overview mr-reviews-detail work-detail"
        data-work-detail={item.id}
      >
        <div className="assistant-task-heading">
          <h3>{item.title}</h3>
          <span className={`assistant-task-state is-${item.state}`}>
            {WORK_STATE_TITLE[item.state]}
          </span>
        </div>
        {description ? (
          <WorkDescription
            api={api}
            item={item.id}
            thread={description}
            onLeave={leave}
          />
        ) : null}
        <dl className="assistant-task-metadata">
          <div>
            <dt>State</dt>
            <dd>
              <select
                ref={stateRef}
                aria-label="State (s)"
                value={item.state}
                onChange={(event) => {
                  onState(event.target.value as WorkState);
                  back();
                }}
              >
                {WORK_STATES.map((state) => (
                  <option key={state} value={state}>
                    {WORK_STATE_TITLE[state]}
                  </option>
                ))}
              </select>
            </dd>
          </div>
          <div>
            <dt>Tags</dt>
            <dd>
              <input
                ref={tagsRef}
                aria-label="Tags (t)"
                placeholder="tags, space separated"
                defaultValue={item.tags.join(" ")}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  onTags(
                    event.currentTarget.value.split(/[\s,]+/).filter(Boolean),
                  );
                  back();
                }}
                onBlur={(event) => {
                  const next = event.currentTarget.value
                    .split(/[\s,]+/)
                    .filter(Boolean);
                  if (next.join(" ") !== item.tags.join(" ")) onTags(next);
                }}
              />
            </dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd className="mr-reviews-own">
              {owner ? (
                <>
                  <OwnerChip owner={owner} />
                  <button
                    type="button"
                    className="ghost"
                    title={
                      owner.task
                        ? `Open the subagent's work in ${owner.session} (o)`
                        : `Open the session ${owner.session} (o)`
                    }
                    onClick={onOpenOwner}
                  >
                    {owner.task ? "Open the agent's work" : "Open the session"}
                  </button>
                </>
              ) : (
                "nobody yet"
              )}
            </dd>
          </div>
          {project ? (
            <div>
              <dt>Project</dt>
              <dd>{project}</dd>
            </div>
          ) : null}
          {item.links.length ? (
            <div>
              <dt>Links</dt>
              <dd>
                <ul className="work-link-list">
                  {item.links.map((link) => (
                    <WorkLinkRow
                      key={`${link.kind}:${describeWorkLink(link)}`}
                      link={link}
                      names={linkNames}
                      canOpenEffort={canOpenEffort}
                      onOpen={() => onLink(link)}
                    />
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          {doneWhen ? (
            <div>
              <dt>Done when</dt>
              <dd className="work-done-when">{doneWhen}</dd>
            </div>
          ) : null}
          <div>
            <dt>Added</dt>
            <dd>{formatUiDateTime(item.createdAt)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>
              {formatUiDateTime(item.updatedAt)}
              {item.by === "agent" ? " by an agent" : ""}
            </dd>
          </div>
          {item.doneAt ? (
            <div>
              <dt>Done</dt>
              <dd>{formatUiDateTime(item.doneAt)}</dd>
            </div>
          ) : null}
        </dl>
        <div className="assistant-task-buttons">
          {item.state === "done" ? (
            <button type="button" className="ghost" onClick={onReopen}>
              Reopen
            </button>
          ) : (
            <button type="button" className="primary" onClick={onDone}>
              Done (dd)
            </button>
          )}
          {owner ? (
            <button
              type="button"
              className="ghost"
              title="The owner's pane, and its subagent's task (o)"
              onClick={onOpenOwner}
            >
              <Bot size={13} />{" "}
              {owner.task ? "The agent's work" : "Its session"}
            </button>
          ) : null}
          <button
            type="button"
            className="ghost danger-text"
            onClick={onRemove}
          >
            Delete
          </button>
        </div>
      </section>
      <section className="work-detail-threads" aria-label="Comments">
        <WorkItemThreads
          item={item.id}
          api={api}
          description={description}
          compose={compose}
          onComposeDone={onComposeDone}
          onLeave={leave}
        />
      </section>
    </div>
  );
}
