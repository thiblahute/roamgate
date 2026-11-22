import {
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileDiff,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Hand,
  LayoutGrid,
  Link2,
  ListChecks,
  LoaderCircle,
  type LucideIcon,
  Maximize2,
  MessageSquare,
  MessageSquareQuote,
  Minimize2,
  Plus,
  RefreshCw,
  Rocket,
  Route,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { parseAgentAddress } from "../../../shared/agentMessage";
import type { ReviewThread } from "../../../shared/review";
import {
  describeWorkLink,
  filterWorkItems,
  isAbsoluteWorkPath,
  isWorkWorkspaceTag,
  readableWorkLink,
  summarizeWorkLinks,
  WORK_STATE_TITLE,
  WORK_STATES,
  workAskOf,
  type WorkItem,
  type WorkLink,
  type WorkLinkGroupKind,
  type WorkLinkNames,
  workLinkGroupOf,
  type WorkProject,
  type WorkState,
  workDescriptionThread,
  workDoneWhen,
  workProjectFamily,
  workProjectTree,
  workQueryWithTag,
  workTagCompletions,
  workTagLabel,
} from "../../../shared/work";
import { openAgentTask } from "../agentTasksOpen";
import { nextColumn, nextRow } from "../boardNavigation";
import { roamgateLocalStorage } from "../browserStorage";
import { requestFileLinkOpen } from "../fileLinkOpen";
import {
  requestReviewShown,
  useReviewSnapshots,
  useReviewState,
} from "../review";
import {
  EMPTY_KEY_STATE,
  feedKey,
  REVIEW_KEY_SEQUENCES,
} from "../reviewNavigation";
import {
  shallowEqual,
  type State,
  store,
  TASK_NOTIFICATION_ACTIVATE_EVENT,
  useStoreSelector,
} from "../store";
import { useSystemBack } from "../systemBack";
import { useInspectorCommands } from "../useInspectorCommands";
import { formatUiDateTime } from "../uiLocale";
import {
  openWorkChat,
  useWorkBoard,
  type WorkFileTarget,
  type WorkFileWorkspace,
  workAddParams,
  workCall,
  workFileWorkspace,
} from "../work";
import type { WorkAddDraft } from "../workOpen";
import {
  keepWorkViewPlace,
  readWorkViewPlace,
  type WorkViewPlace,
  workScrollElements,
  workScrollPart,
  workScrollView,
} from "../workViewMemory";
import {
  projectForWorkspace,
  readWorkScopeMemory,
  rememberWorkScope,
  rememberWorkWide,
  WORK_SCOPE_ALL,
  type WorkScope,
  type WorkWorkspace,
  workScopeFor,
  workspaceScopeKey,
  workTagCounts,
  workWorkspaceFilter,
  isCoordinatorWorkspace,
} from "../workScope";
import { BoardCard } from "./BoardCard";
import { ResizeSeparator } from "./ResizeSeparator";
import { ThreadEditor, type ThreadBox } from "./ThreadEditor";
import { WorkAddForm } from "./WorkAddForm";
import { peekReviewDraft } from "../reviewDrafts";
import {
  useWorkDraftItems,
  workAddDraft,
  workItemDraft,
  workItemDrafts,
} from "../workDrafts";
import {
  postWorkItemComment,
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
const COLUMN_WIDTHS_KEY = "mrReviewsWorkColumnWidths";
/** A column dragged narrower or wider stays in these bounds. */
export const WORK_COLUMN_MIN_WIDTH = 220;
export const WORK_COLUMN_MAX_WIDTH = 1600;
/** The board's keys: the review's, and zf to focus a column. */
const WORK_KEY_SEQUENCES: ReadonlySet<string> = new Set([
  ...REVIEW_KEY_SEQUENCES,
  "zf",
]);

/** The focused workspace, its panes' directories and ids as lines. */
type WorkWorkspaceSelection = Omit<WorkWorkspace, "cwds" | "paneIds"> & {
  cwds: string;
  paneIds: string;
};

function selectWorkWorkspace(state: State): WorkWorkspaceSelection | null {
  const workspace = state.workspaces.find((each) => each.focused);
  if (!workspace) return null;
  const panes = state.panes.filter(
    (pane) => pane.workspace_id === workspace.workspace_id,
  );
  return {
    connectionId: state.activeConnectionId,
    workspaceId: workspace.workspace_id,
    label: workspace.label,
    checkoutPath: workspace.worktree?.checkout_path ?? workspace.cwd ?? null,
    repoRoot: workspace.worktree?.repo_root ?? null,
    cwds: panes
      .map((pane) => pane.cwd ?? "")
      .filter(Boolean)
      .join("\n"),
    paneIds: panes.map((pane) => pane.pane_id).join("\n"),
  };
}

/**
 * Where an item added from a chat was added: its session's pane (the
 * server finds its workspace, and that workspace's tag).
 */
function draftPlace(draft: WorkAddDraft): {
  connectionId: string;
  paneId?: string;
  workspaceId?: string;
} {
  const pane = parseAgentAddress(draft.owner);
  return pane
    ? { connectionId: pane.connectionId, paneId: pane.paneId }
    : {
        connectionId: draft.workspace?.connectionId ?? "",
        ...(draft.workspace
          ? { workspaceId: draft.workspace.workspaceId }
          : {}),
      };
}

/** The workspace the page shows, as the board scopes by it. */
export function useWorkWorkspace(): WorkWorkspace | null {
  const selected = useStoreSelector(selectWorkWorkspace, shallowEqual);
  return useMemo(
    () =>
      selected
        ? {
            ...selected,
            cwds: selected.cwds ? selected.cwds.split("\n") : [],
            paneIds: selected.paneIds ? selected.paneIds.split("\n") : [],
          }
        : null,
    [selected],
  );
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

/** The columns' widths a project was given, by state; "*" for all projects. */
type WorkColumnWidths = Record<string, Partial<Record<WorkState, number>>>;

export function clampWorkColumnWidth(width: number): number {
  return Math.round(
    Math.min(WORK_COLUMN_MAX_WIDTH, Math.max(WORK_COLUMN_MIN_WIDTH, width)),
  );
}

function storedColumnWidths(): WorkColumnWidths {
  try {
    const value = JSON.parse(
      roamgateLocalStorage.getItem(COLUMN_WIDTHS_KEY) ?? "{}",
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as WorkColumnWidths)
      : {};
  } catch {
    return {};
  }
}

function keepColumnWidths(widths: WorkColumnWidths) {
  try {
    roamgateLocalStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    // Kept for this page only.
  }
}

/** The widths with one column's set, or dropped (null: back to the flex). */
export function withWorkColumnWidth(
  widths: WorkColumnWidths,
  project: string,
  state: WorkState,
  width: number | null,
): WorkColumnWidths {
  const columns = { ...widths[project] };
  if (width === null) delete columns[state];
  else columns[state] = width;
  const next = { ...widths };
  if (Object.keys(columns).length) next[project] = columns;
  else delete next[project];
  return next;
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

/** How the view closes. keepFocus: what it opened has the focus now. */
export type BoardCloseOptions = { keepFocus?: boolean };

export type WorkModeOptions = {
  /** The view shows this mode: its state lives, its keys answer. */
  enabled: boolean;
  mobile: boolean;
  /** A wide pane: the columns side by side (the view's rule). */
  board: boolean;
  /** The view fills the window, over the panes. */
  maximized: boolean;
  panelRef: RefObject<HTMLElement | null>;
  onClose: (options?: BoardCloseOptions) => void;
  /** An item to open on (a notification's link). */
  initialItem?: string;
  /** The upstreaming efforts the view knows: their names. */
  efforts?: readonly { id: string; name: string }[] | undefined;
  /** The requests the view knows: their titles, by URL. */
  requests?: readonly { url: string; title: string }[] | undefined;
  /** Shows an effort's view (the inbox mode's). */
  onOpenEffort?: (id: string) => void;
  /** The items this session owns (a chat's count): `owner:` searched. */
  initialOwner?: string;
  /** The add form started for a session (a chat's Add to Work). */
  initialAdd?: WorkAddDraft;
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
  /**
   * The workspace shown is its project's coordinator's: the boards show
   * every workspace's (the Reviews mode's Local reviews too).
   */
  coordinator: boolean;
};

export function useWorkMode({
  enabled,
  mobile,
  board,
  maximized,
  panelRef,
  onClose,
  initialItem,
  efforts,
  requests,
  onOpenEffort,
  initialOwner,
  initialAdd,
}: WorkModeOptions): WorkMode {
  const { board: data, error, reload } = useWorkBoard();
  const reviews = useReviewState();
  const workspace = useWorkWorkspace();
  const activeConnectionId = useStoreSelector(
    (state) => state.activeConnectionId,
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef<HTMLSelectElement>(null);
  const tagsRef = useRef<HTMLInputElement>(null);
  const [memory, setMemory] = useState(() => readWorkScopeMemory());
  /**
   * Where the board was left in this workspace: opened plainly, it shows
   * again there; opened on an item, a session's items or a form, not.
   */
  const [restored] = useState(() =>
    initialItem || initialOwner || initialAdd
      ? null
      : readWorkViewPlace(workspace ? workspaceScopeKey(workspace) : ""),
  );
  /**
   * The scope chosen on this board, for the workspace it was chosen in.
   * A session's items are looked for in every project.
   */
  const [choice, setChoice] = useState<{
    key: string;
    scope: WorkScope;
  } | null>(() =>
    initialOwner
      ? { key: workspace ? workspaceScopeKey(workspace) : "", scope: null }
      : null,
  );
  const [query, setQueryState] = useState(() =>
    initialOwner ? `owner:${initialOwner} ` : (restored?.query ?? ""),
  );
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
  /** The columns' widths, by project: dragged, then kept on release. */
  const [columnWidths, setColumnWidths] =
    useState<WorkColumnWidths>(storedColumnWidths);
  /** The one column shown, at full width (zf, its head's button). */
  const [focusedColumn, setFocusedColumn] = useState<WorkState | null>(
    restored?.focusedColumn ?? null,
  );
  const [selected, setSelected] = useState<string | null>(
    initialItem ?? restored?.selected ?? null,
  );
  const [detail, setDetail] = useState<string | null>(
    initialItem ?? restored?.detail ?? null,
  );
  const [compose, setCompose] = useState<"comment" | "reply" | null>(null);
  /** The detail's list, where its keys are (the chat threads' keys). */
  const detailListRef = useRef<HTMLDivElement>(null);
  const [adding, setAddingState] = useState(!!initialAdd || !!restored?.adding);
  /** The add form started from a chat: its words, owner and link. */
  const [draft, setDraft] = useState<WorkAddDraft | null>(
    initialAdd ?? restored?.draft ?? null,
  );
  /** The words `:add WORDS` starts the form with. */
  const [addText, setAddText] = useState<string | null>(null);
  /** A new `:add WORDS` draws the form again, with its words. */
  const [addSeq, setAddSeq] = useState(0);
  const setAdding = (next: boolean) => {
    setAddingState(next);
    if (!next) {
      setDraft(null);
      setAddText(null);
    }
  };
  /**
   * The add form, from anywhere in the view (the list, an item's detail:
   * left open under it, it shows again on Cancel or Back); `text` starts
   * it with those words.
   */
  const openAdd = (text?: string) => {
    if (text) {
      setDraft(null);
      setAddText(text);
      setAddSeq((seq) => seq + 1);
    }
    setCompose(null);
    setAddingState(true);
  };
  /**
   * The item just added, as the add answered it: its detail stays open
   * while its owner sorts it (until the user leaves it), drawn from this
   * until the board's next read has it.
   */
  const [watching, setWatching] = useState<WorkItem | null>(
    restored?.watching ?? null,
  );
  /** The watched item was on the board: gone from it later, it was split. */
  const watchSeen = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const keyState = useRef(EMPTY_KEY_STATE);
  /** s or t on a card: the detail opens with that box focused. */
  const pendingFocus = useRef<"state" | "tags" | null>(null);
  // The phone's Back closes the form, then the detail (the form opened
  // over an item goes back to it), then the view.
  useSystemBack(enabled && detail !== null, () => setDetail(null), "popup");
  useSystemBack(enabled && adding, () => setAdding(false), "popup");

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
  /**
   * Where an added item goes: a chat's to its session's project (the one
   * holding its workspace), else the scope shown, else the first.
   */
  const addProject =
    (draft ? projectForWorkspace(draft.workspace, projects)?.id : undefined) ??
    scope ??
    projects[0]?.id ??
    null;
  /** Where the add form keeps its unsent words: + shows "Draft" then. */
  const addDraft = addProject
    ? workAddDraft(
        addProject,
        draft ? (draft.workspace ?? null) : workspace,
        draft?.owner,
      )
    : undefined;
  const plainAddDraft = addProject
    ? workAddDraft(addProject, workspace)
    : undefined;
  const draftItems = useWorkDraftItems();
  const addHasDraft =
    !!plainAddDraft &&
    peekReviewDraft(plainAddDraft.session, plainAddDraft.key) !== undefined;
  const choose = (next: WorkScope) => {
    setChoice({ key: workspaceKey, scope: next });
    setMemory((current) => rememberWorkScope(current, workspace, next));
    setQuery("");
    setSelected(null);
  };
  /** The project shown and its subprojects: their items show. */
  const family = useMemo(
    () => (scope ? workProjectFamily(projects, scope) : null),
    [projects, scope],
  );
  const projectItems = useMemo(
    () =>
      family
        ? boardItems.filter((item) => family.includes(item.project))
        : boardItems,
    [boardItems, family],
  );
  /**
   * Opened from a workspace of the project that is not its coordinator's:
   * the board keeps that workspace's items (its tag) until the chip is
   * removed, which that workspace remembers.
   */
  const workspaceFilter = useMemo(
    () => workWorkspaceFilter({ workspace, projects, scope, memory }),
    [workspace, projects, scope, memory],
  );
  const workspaceTag = workspaceFilter?.on ? workspaceFilter.tag : null;
  const widen = (wide: boolean) => {
    if (!workspace) return;
    setMemory((current) => rememberWorkWide(current, workspace, wide));
    setSelected(null);
  };
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
    () =>
      filterWorkItems(projectItems, {
        query,
        ...(workspaceTag ? { tags: [workspaceTag] } : {}),
      }),
    [projectItems, query, workspaceTag],
  );
  const columns = useMemo(() => workColumns(items), [items]);
  /** On a wide pane, a column focused: drawn alone, unfolded, full width. */
  const focus = board ? focusedColumn : null;
  const drawnColumns = useMemo(
    () =>
      focus ? columns.filter((column) => column.state === focus) : columns,
    [columns, focus],
  );
  const isFoldedColumn = (state: WorkState) =>
    folded.has(state) && state !== focus;
  /** The columns as drawn: folded ones hold nothing the keys walk. */
  const columnKeys = useMemo(
    () =>
      drawnColumns.map((column) =>
        folded.has(column.state) && column.state !== focus
          ? []
          : column.items.map((item) => item.id),
      ),
    [drawnColumns, folded, focus],
  );
  /** The scope's column widths: "*" when every project shows. */
  const widthsKey = scope ?? "*";
  const widths = columnWidths[widthsKey] ?? {};
  const setColumnWidth = (
    state: WorkState,
    width: number | null,
    keep: boolean,
  ) =>
    setColumnWidths((current) => {
      const next = withWorkColumnWidth(current, widthsKey, state, width);
      if (keep) keepColumnWidths(next);
      return next;
    });
  /**
   * Focuses a column (null: every column again), its first item selected
   * when the selection is elsewhere.
   */
  const focusColumn = (state: WorkState | null) => {
    setFocusedColumn(state);
    if (!state) return;
    const column = columns.find((each) => each.state === state);
    if (!column?.items.some((item) => item.id === selected))
      setSelected(column?.items[0]?.id ?? null);
  };
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
  // Where the board is: kept for this workspace as it changes, shown
  // again when the view is.
  const scrollRef = useRef<Record<string, number>>(restored?.scroll ?? {});
  /** The offsets to give back once the view's content is drawn. */
  const scrollPending = useRef(!!restored);
  const scrollView = workScrollView({ detail, adding });
  const place: WorkViewPlace = {
    query,
    selected,
    detail,
    adding,
    draft,
    watching,
    focusedColumn,
    scroll: scrollRef.current,
  };
  const placeRef = useRef(place);
  placeRef.current = place;
  const placeKey = useRef(workspaceKey);
  // Another workspace shown under the view: its own place.
  if (placeKey.current !== workspaceKey) {
    placeKey.current = workspaceKey;
    const other = readWorkViewPlace(workspaceKey);
    setQueryState(other?.query ?? "");
    setSelected(other?.selected ?? null);
    setDetail(other?.detail ?? null);
    setAddingState(other?.adding ?? false);
    setDraft(other?.draft ?? null);
    setWatching(other?.watching ?? null);
    setFocusedColumn(other?.focusedColumn ?? null);
    scrollRef.current = other?.scroll ?? {};
    scrollPending.current = true;
  }
  useEffect(() => {
    keepWorkViewPlace(workspaceKey, placeRef.current);
  }, [
    workspaceKey,
    query,
    selected,
    detail,
    adding,
    draft,
    watching,
    focusedColumn,
  ]);
  // A view shown again (the board after an item): its offsets back.
  const shownView = useRef(scrollView);
  if (shownView.current !== scrollView) {
    shownView.current = scrollView;
    scrollPending.current = true;
  }
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!enabled || !panel || !data || !scrollPending.current) return;
    scrollPending.current = false;
    for (const element of workScrollElements(panel)) {
      const part = workScrollPart(element);
      const offset = part
        ? scrollRef.current[`${scrollView}:${part.part}`]
        : undefined;
      if (!part || offset === undefined) continue;
      if (part.axis === "top") element.scrollTop = offset;
      else element.scrollLeft = offset;
    }
  });
  // Each scroll is noted; kept a moment after it stops.
  useEffect(() => {
    const panel = panelRef.current;
    if (!enabled || !panel) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = (event: Event) => {
      const element = event.target instanceof Element ? event.target : null;
      const part = element ? workScrollPart(element) : null;
      if (!element || !part) return;
      scrollRef.current[`${workScrollView(placeRef.current)}:${part.part}`] =
        part.axis === "top" ? element.scrollTop : element.scrollLeft;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        keepWorkViewPlace(placeKey.current, placeRef.current);
      }, 150);
    };
    panel.addEventListener("scroll", onScroll, true);
    return () => {
      panel.removeEventListener("scroll", onScroll, true);
      if (timer) {
        clearTimeout(timer);
        keepWorkViewPlace(placeKey.current, placeRef.current);
      }
    };
  }, [enabled, panelRef]);
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

  /**
   * A pane, a chat or a review was shown: on a phone, or filling the
   * window, the view is over it and steps aside, its place kept for when
   * it shows again (Alt+W). Beside the page, it stays.
   */
  const stepAside = useCallback(() => {
    if (mobile || maximized) onClose({ keepFocus: true });
  }, [mobile, maximized, onClose]);

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
        stepAside();
      } catch (cause) {
        setFailure(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [stepAside],
  );

  /** A link's action, from the item's detail. */
  const openLink = useCallback(
    (link: WorkLink, item?: string) => {
      switch (link.kind) {
        case "review": {
          const snapshot = reviews.summaries.get(link.id);
          if (snapshot) {
            requestReviewShown(snapshot.session.connectionId, link.id);
            stepAside();
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
        case "branch":
        case "deploy": {
          // Its review (`SHA^..SHA`, a branch against the default one), in
          // the checkout the server finds it in.
          if (link.kind === "deploy" && link.sha === "decision") return;
          if (!item) return;
          setFailure(null);
          void openWorkLinkReview(item, link, activeConnectionId)
            .then((opened) => {
              if (typeof opened === "string") setFailure(opened);
              else if (opened) {
                requestReviewShown(opened.connectionId, opened.sessionId);
                stepAside();
              }
            })
            .catch((cause) =>
              setFailure(
                cause instanceof Error ? cause.message : String(cause),
              ),
            );
          return;
        }
        case "file":
          if (!item) return;
          setFailure(null);
          void openWorkFileLink(item, link, {
            activeConnectionId,
            workspaces: store.get().workspaces,
          })
            .then((why) => {
              if (why) setFailure(why);
              else stepAside();
            })
            .catch((cause) =>
              setFailure(
                cause instanceof Error ? cause.message : String(cause),
              ),
            );
          return;
        case "chat":
          void openWorkChat(link)
            .then((why) => {
              if (why) setFailure(why);
              else stepAside();
            })
            .catch((cause) =>
              setFailure(
                cause instanceof Error ? cause.message : String(cause),
              ),
            );
          return;
        default:
          return;
      }
    },
    [reviews.summaries, stepAside, onOpenEffort, activeConnectionId],
  );
  // The detail's reviews, read whole: a link to a thread is named by its
  // first words.
  const detailLinks = (
    boardItems.find((item) => item.id === detail) ??
    (watching?.id === detail ? watching : null)
  )?.links;
  const detailReviews = useReviewSnapshots(
    detailLinks
      ? {
          ids: detailLinks.flatMap((link) =>
            link.kind === "review" && link.thread ? [link.id] : [],
          ),
        }
      : null,
  );
  /** What names the detail's links: efforts, requests, reviews, items. */
  const linkNames = useMemo<WorkLinkNames>(
    () => ({
      effort: (id) => efforts?.find((each) => each.id === id)?.name,
      pr: (url) => requests?.find((each) => each.url === url)?.title,
      review: (id, thread) => {
        const snapshot = reviews.summaries.get(id);
        if (!snapshot) return undefined;
        const body = thread
          ? detailReviews.get(id)?.threads.find((each) => each.id === thread)
              ?.comments[0]?.body
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
    [efforts, requests, reviews.summaries, detailReviews, boardItems],
  );

  const selectedItem = items.find((item) => item.id === selected) ?? null;
  const detailItem = detail
    ? (boardItems.find((item) => item.id === detail) ??
      (watching?.id === detail && !watchSeen.current ? watching : null))
    : null;
  // Watching ends when its detail is left (Esc, back, another item); an
  // item that leaves the board while sorted was split or removed: said so.
  useEffect(() => {
    if (!watching) return;
    if (detail !== watching.id) {
      setWatching(null);
      watchSeen.current = false;
      return;
    }
    if (!data) return;
    if (boardItems.some((each) => each.id === watching.id)) {
      watchSeen.current = true;
      return;
    }
    if (!watchSeen.current) return;
    setWatching(null);
    watchSeen.current = false;
    setDetail(null);
    setNotice(
      `"${watching.title}" left the board while being sorted: split into other items, or removed`,
    );
  }, [watching, detail, data, boardItems]);
  /** Another one after this: the form again, the detail left. */
  const addAnother = () => {
    setDetail(null);
    setCompose(null);
    setNotice(null);
    setAdding(true);
  };
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
    // A column's handle steps with the arrows, Home and End.
    if (
      target?.classList.contains("work-column-resizer") &&
      /^(Arrow(Left|Right)|Home|End)$/.test(event.key)
    )
      return false;
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
    // The page keys of an item's detail, from out of its list: its list's.
    if (
      detailItem &&
      !adding &&
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      /^[dufb]$/.test(event.key) &&
      !target?.closest("[data-work-keys]")
    ) {
      const list = detailListRef.current;
      if (!list) return false;
      list.focus({ preventScroll: true });
      list.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: event.key,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      return true;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key === "Escape") {
      keyState.current = EMPTY_KEY_STATE;
      if (drag) dragCancel();
      else if (adding) {
        setAdding(false);
        // Opened over an item: back to it (its keys take the focus).
        if (!detail) back();
      } else if (detail) closeDetail();
      else if (focus) focusColumn(null);
      else if (query) setQuery("");
      else if (selected) setSelected(null);
      else return false;
      return true;
    }
    if (adding) return false;
    // The detail's list has the keys when it has the focus (the chat
    // threads' keys, and the detail's own through them).
    if (detailItem && target?.closest("[data-work-keys]")) return false;
    const fed = feedKey(keyState.current, event.key, WORK_KEY_SEQUENCES);
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
          key === "G" ||
          key === "zz" ||
          key === "zt" ||
          key === "zb" ||
          key === "{" ||
          key === "}")
      ) {
        // The keys go to the list, and this one (its count) with them.
        list.focus({ preventScroll: true });
        const typed = [
          ...(fed.count && fed.count > 1 ? String(fed.count) : ""),
          ...(key.startsWith("Arrow") ? [key] : key),
        ];
        for (const each of typed)
          list.dispatchEvent(
            new KeyboardEvent("keydown", { key: each, bubbles: true }),
          );
      } else if (key === "c") setCompose("comment");
      else if (key === "r") setCompose("reply");
      else if (key === "s") stateRef.current?.focus();
      else if (key === "t") tagsRef.current?.focus();
      else if (key === "o") void openOwner(detailItem);
      else if (key === "dd" && detailItem.state !== "done")
        markDone(detailItem);
      else if (key === "a") openAdd();
      else return false;
      return true;
    }
    const current = selectedItem;
    if (
      focus &&
      (key === "h" ||
        key === "l" ||
        key === "ArrowLeft" ||
        key === "ArrowRight" ||
        key === "Tab")
    ) {
      // Focused: the next column is focused in its turn.
      const at = columns.findIndex((column) => column.state === focus);
      const by =
        key === "h" || key === "ArrowLeft" || (key === "Tab" && event.shiftKey)
          ? -count
          : count;
      const next =
        columns[Math.max(0, Math.min(columns.length - 1, at + by))]?.state;
      if (next && next !== focus) focusColumn(next);
    } else if (key === "zf") {
      if (!board) return false;
      focusColumn(
        focus
          ? null
          : (current?.state ??
              columns.find((column) => column.items.length)?.state ??
              columns[0]?.state ??
              null),
      );
    } else if (
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
    } else if (key === "a") openAdd();
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

  // :add (:new-item), the inspector's prompt: the form, as a does;
  // :add WORDS starts it with them.
  const addCommand = {
    aliases: [] as string[],
    description:
      "add a work item (a, the + button); :add WORDS starts it with them",
    run: (argument: string) => openAdd(argument || undefined),
  };
  useInspectorCommands(
    enabled
      ? {
          commands: [
            { ...addCommand, name: "add", aliases: ["new-item"] },
            { ...addCommand, name: "new-item" },
          ],
        }
      : null,
  );

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
        aria-label={
          addHasDraft ? "Add an item (a): a draft is kept" : "Add an item (a)"
        }
        title={
          addHasDraft
            ? "Add an item (a): what you started writing is kept"
            : "Add an item (a)"
        }
        aria-pressed={adding}
        onClick={() => openAdd()}
      >
        <Plus size={16} />
        {addHasDraft ? (
          <span className="work-draft-dot" aria-hidden="true" />
        ) : null}
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
      {notice ? (
        <div className="work-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="ghost"
            onClick={() => setNotice(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
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
      {adding && addProject ? (
        <WorkAddForm
          key={addSeq}
          project={addProject}
          {...(addDraft ? { draft: addDraft } : {})}
          projectName={projectName(addProject)}
          {...(draft
            ? {
                initialText: draft.text,
                owner: draft.ownerName ?? draft.owner,
              }
            : addText
              ? { initialText: addText }
              : {})}
          onCancel={() => {
            setAdding(false);
            // Opened over an item: back to it (its keys take the focus).
            if (!detail) back();
          }}
          // A failure throws: the form says why, until dismissed.
          onAdd={async (params) => {
            setFailure(null);
            const { item } = await workCall<{ item: WorkItem }>(
              "add",
              workAddParams({
                ...params,
                project: addProject,
                ...(draft
                  ? {
                      owner: draft.owner,
                      ...(draft.links ? { links: draft.links } : {}),
                    }
                  : {}),
                // Where it was added: that workspace's tag, when it is
                // one of the project's (a chat's: its pane's).
                ...(draft
                  ? { workspace: draftPlace(draft) }
                  : workspace
                    ? {
                        workspace: {
                          connectionId: workspace.connectionId,
                          workspaceId: workspace.workspaceId,
                        },
                      }
                    : {}),
              }),
            );
            // Its detail, until the owner has sorted it (or the user
            // leaves): the owner's title, tags, state and reply show up
            // there as they come.
            watchSeen.current = false;
            setWatching(item);
            setNotice(null);
            setAdding(false);
            setSelected(item.id);
            setDetail(item.id);
          }}
        />
      ) : detailItem ? (
        <WorkDetail
          item={detailItem}
          project={
            detailItem.project === scope
              ? null
              : projectName(detailItem.project)
          }
          doneWhen={workDoneWhen(
            detailItem,
            projects.find((each) => each.id === detailItem.project),
          )}
          compose={compose}
          onCompose={setCompose}
          onComposeDone={() => setCompose(null)}
          onBack={closeDetail}
          onOpenOwner={() => void openOwner(detailItem)}
          onLink={(link) => openLink(link, detailItem.id)}
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
          sorting={
            watching?.id === detailItem.id
              ? {
                  sorter:
                    detailItem.owner?.session ??
                    projects.find((each) => each.id === detailItem.project)
                      ?.coordinator?.session ??
                    null,
                  onAddAnother: addAnother,
                }
              : null
          }
          onAdd={() => openAdd()}
          stateRef={stateRef}
          tagsRef={tagsRef}
          listRef={detailListRef}
        />
      ) : (
        <>
          {projects.length > 1 || workspaceFilter ? (
            <div className="work-filter-row">
              {projects.length > 1 ? (
                <select
                  className="work-scope-select"
                  aria-label="Project"
                  title="The project shown (with its subprojects): the workspace's, another, or all"
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
                  {workProjectTree(projects).map(({ project: each, depth }) => {
                    const ids = workProjectFamily(projects, each.id);
                    const open = boardItems.filter(
                      (item) =>
                        ids.includes(item.project) && item.state !== "done",
                    ).length;
                    return (
                      <option key={each.id} value={each.id}>
                        {"\u00a0\u00a0".repeat(depth)}
                        {each.name} ({open})
                      </option>
                    );
                  })}
                </select>
              ) : null}
              {workspaceFilter ? (
                workspaceFilter.on ? (
                  <button
                    type="button"
                    className="mr-reviews-chip is-label work-workspace-filter"
                    aria-label={`Remove the filter: only the items of ${workspaceFilter.label}`}
                    title={`Only the items added from ${workspaceFilter.label} (#${workspaceFilter.tag}): remove to see the whole project`}
                    onClick={() => {
                      widen(true);
                      back();
                    }}
                  >
                    <span>{workspaceFilter.label}</span>
                    <X size={11} aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="mr-reviews-chip work-workspace-filter is-off"
                    title={`Only the items added from ${workspaceFilter.label} (#${workspaceFilter.tag})`}
                    onClick={() => {
                      widen(false);
                      back();
                    }}
                  >
                    Only {workspaceFilter.label}
                  </button>
                )
              ) : null}
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
            {drawnColumns.map(({ state, items: inColumn }) => {
              // A list on a narrow pane leaves empty states out, but a card
              // being dragged can be dropped in any of them.
              if (!inColumn.length && !board && !drag) return null;
              const isFolded = isFoldedColumn(state);
              const width =
                board && !focus && !isFolded ? widths[state] : undefined;
              return (
                <div
                  key={state}
                  className={`mr-reviews-lane is-${state}${isFolded ? " is-folded" : ""}${focus === state ? " is-focused-column" : ""}${width ? " has-width" : ""}${drag?.over === state ? " is-drop-target" : ""}${drag?.item.state === state ? " is-drop-source" : ""}`}
                  role="group"
                  aria-label={WORK_STATE_TITLE[state]}
                  data-work-column={state}
                  {...(width
                    ? {
                        style: {
                          "--work-column-width": `${width}px`,
                        } as CSSProperties,
                      }
                    : {})}
                >
                  {board && !isFolded ? (
                    <button
                      type="button"
                      className="assistant-icon-button work-column-focus"
                      aria-pressed={focus === state}
                      aria-label={
                        focus === state
                          ? "Show every column"
                          : `Focus on ${WORK_STATE_TITLE[state]}`
                      }
                      title={
                        focus === state
                          ? "Show every column (zf, Esc)"
                          : `${WORK_STATE_TITLE[state]} alone, full width (zf)`
                      }
                      onClick={() => {
                        focusColumn(focus === state ? null : state);
                        back();
                      }}
                    >
                      {focus === state ? (
                        <Minimize2 size={12} />
                      ) : (
                        <Maximize2 size={12} />
                      )}
                    </button>
                  ) : null}
                  {board && !focus && !isFolded ? (
                    <ResizeSeparator
                      className="work-column-resizer"
                      label={`Resize ${WORK_STATE_TITLE[state]}`}
                      title="Drag to resize; double-click to reset"
                      value={width ?? 0}
                      valueMin={WORK_COLUMN_MIN_WIDTH}
                      valueMax={WORK_COLUMN_MAX_WIDTH}
                      {...(width ? { valueNow: width } : {})}
                      at={(clientX, separator) =>
                        clampWorkColumnWidth(
                          clientX -
                            (separator.parentElement?.getBoundingClientRect()
                              .left ?? 0),
                        )
                      }
                      step={(key, current, separator) => {
                        const from =
                          current ||
                          separator.parentElement?.getBoundingClientRect()
                            .width ||
                          WORK_COLUMN_MIN_WIDTH;
                        return clampWorkColumnWidth(
                          key === "Home"
                            ? WORK_COLUMN_MIN_WIDTH
                            : key === "End"
                              ? WORK_COLUMN_MAX_WIDTH
                              : from + (key === "ArrowLeft" ? -16 : 16),
                        );
                      }}
                      onChange={(next) => setColumnWidth(state, next, false)}
                      onCommit={(next) => setColumnWidth(state, next, true)}
                      onReset={() => setColumnWidth(state, null, true)}
                    />
                  ) : null}
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
                          project={
                            item.project === scope
                              ? null
                              : projectName(item.project)
                          }
                          selected={item.id === selected}
                          drafted={draftItems.has(item.id)}
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
              add · za fold · zf focus a column · / search (#tag) · [ ] Reviews
              · ? all keys
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
    coordinator: isCoordinatorWorkspace(workspace, projects),
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

/** How an ask was answered on this page: being sent, sent, or not sent. */
export type WorkAnswerState =
  | { phase: "sending" | "sent"; text: string }
  | { phase: "failed"; text: string; error: string };

/**
 * The answers of this page, by item and ask: a card and the item's detail
 * (or a card drawn again by a push) say the same, and a second tap, from
 * either, sends nothing.
 */
const workAnswers = new Map<string, WorkAnswerState>();
const workAnswerListeners = new Set<() => void>();
/** The words of a card's Reply box, kept while the card is drawn again. */
const workReplyBoxes = new Map<string, ThreadBox>();
/** The card's Reply box, among the item's drafts. */
const WORK_ASK_DRAFT = "ask";

function workAnswerKey(item: string, ask: string): string {
  return `${item}\n${ask}`;
}

function setWorkAnswer(key: string, state: WorkAnswerState) {
  workAnswers.set(key, state);
  for (const listener of workAnswerListeners) listener();
}

function subscribeWorkAnswers(listener: () => void): () => void {
  workAnswerListeners.add(listener);
  return () => workAnswerListeners.delete(listener);
}

/** Forgets the page's answers (tests). */
export function resetWorkAnswers() {
  workAnswers.clear();
  workReplyBoxes.clear();
  for (const listener of workAnswerListeners) listener();
}

/**
 * Answers an item's ask once: the user's comment, posted unless an answer
 * to that ask is being sent or was sent already (a double tap, a tap on
 * the card then on the detail). False when it was ignored.
 */
export function answerWorkAsk(
  item: string,
  ask: string,
  text: string,
  id?: string,
  post: (item: string, text: string, id?: string) => Promise<void> = (
    ...args
  ) => postWorkItemComment(...args),
  { reply = false }: { reply?: boolean } = {},
): Promise<boolean> {
  const key = workAnswerKey(item, ask);
  const current = workAnswers.get(key);
  // A tap answers once; a reply in the user's words may follow one.
  if (current?.phase === "sending") return Promise.resolve(false);
  if (current?.phase === "sent" && !reply) return Promise.resolve(false);
  setWorkAnswer(key, { phase: "sending", text });
  return post(item, text, id).then(
    () => {
      setWorkAnswer(key, { phase: "sent", text });
      return true;
    },
    (failure: unknown) => {
      setWorkAnswer(key, {
        phase: "failed",
        text,
        error: failure instanceof Error ? failure.message : String(failure),
      });
      return false;
    },
  );
}

/** The words a status says of an answer: its first line, short. */
function answerWords(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}...` : line;
}

/**
 * What the user has to do on a For you or Verify item (its `ask`), as a
 * highlighted line that wraps, with its answers as small buttons: a tap
 * posts the answer as the user's comment on the item, which reaches its
 * owner, once (the buttons wait while it is sent, and stay off once it
 * is). Reply opens the comment box right there, for an answer in the
 * user's own words (no "Something else" answer needed): Cmd+Enter or Send
 * posts it the same way, Esc or Cancel puts it away, the card stays
 * closed. Nothing in the other states or without an ask.
 */
export function WorkAsk({
  item,
  className = "",
}: {
  item: Pick<WorkItem, "id" | "state" | "ask" | "answers">;
  className?: string;
}) {
  const asked = workAskOf(item);
  const key = asked ? workAnswerKey(item.id, asked.ask) : "";
  const said = useSyncExternalStore(subscribeWorkAnswers, () =>
    key ? workAnswers.get(key) : undefined,
  );
  const [replying, setReplying] = useState(
    () =>
      !!workReplyBoxes.get(item.id)?.text.trim() ||
      peekReviewDraft(workItemDrafts(item.id), WORK_ASK_DRAFT) !== undefined,
  );
  if (!asked) return null;
  const sending = said?.phase === "sending";
  const answered = said?.phase === "sent";
  const answer = (text: string) => {
    void answerWorkAsk(item.id, asked.ask, text);
  };
  const openReply = () => {
    if (!workReplyBoxes.has(item.id)) workReplyBoxes.set(item.id, { text: "" });
    setReplying(true);
  };
  const closeReply = () => {
    workReplyBoxes.delete(item.id);
    setReplying(false);
  };
  return (
    <div
      className={`work-ask is-${item.state}${className ? ` ${className}` : ""}`}
      data-work-ask={item.id}
    >
      <p className="work-ask-text">
        <Hand size={12} aria-hidden="true" />
        <span>
          <span className="sr-only">
            {item.state === "you" ? "For you: " : "To verify: "}
          </span>
          {asked.ask}
        </span>
      </p>
      <span className="work-ask-answers" aria-label="Answers">
        {asked.answers.map((text) => (
          <button
            key={text}
            type="button"
            className={`work-ask-answer${answered && said.text === text ? " is-sent" : ""}`}
            disabled={sending || answered}
            aria-busy={(sending && said.text === text) || undefined}
            title={`Answer "${text}": a comment for the owner`}
            onClick={(event) => {
              event.stopPropagation();
              answer(text);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {text}
          </button>
        ))}
        {replying ? null : (
          <button
            type="button"
            className="work-ask-answer is-reply"
            disabled={sending}
            title="Answer in your own words: a comment for the owner"
            onClick={(event) => {
              event.stopPropagation();
              openReply();
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <MessageSquare size={11} aria-hidden="true" />
            {asked.answers.length ? "Something else" : "Reply"}
          </button>
        )}
      </span>
      {replying ? (
        // The box is the card's, not a way into it: clicks, keys and a
        // drag's press stay in it.
        // biome-ignore lint/a11y/noStaticElementInteractions: keeps its events
        <div
          className="work-ask-reply chat-thread is-draft"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <ThreadEditor
            placeholder="Your answer, in your own words..."
            kept={workReplyBoxes.get(item.id) ?? { text: "" }}
            draft={workItemDraft(item.id, WORK_ASK_DRAFT)}
            onLeave={() => {}}
            onClose={closeReply}
            onSave={(text, id) =>
              answerWorkAsk(item.id, asked.ask, text, id, undefined, {
                reply: true,
              }).then((sent) => {
                if (sent) closeReply();
              })
            }
          />
        </div>
      ) : null}
      {said ? (
        <small
          className={`work-ask-status${said.phase === "failed" ? " is-error" : ""}`}
          role={said.phase === "failed" ? "alert" : "status"}
        >
          {said.phase === "failed"
            ? `Not sent: ${said.error}`
            : said.phase === "sending"
              ? `Sending: ${answerWords(said.text)}`
              : `Sent: ${answerWords(said.text)}`}
        </small>
      ) : null}
    </div>
  );
}

function WorkCard({
  item,
  project,
  selected,
  drafted = false,
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
  /** A box of it has words not sent yet: "Draft" says so. */
  drafted?: boolean;
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
        <WorkAsk item={item} />
        <span className="mr-reviews-dense-chips" aria-label="Tags and owner">
          {drafted ? (
            <span
              className="mr-reviews-chip is-wait work-draft"
              title="A comment or reply you started writing is kept: open the item to go on"
            >
              Draft
            </span>
          ) : null}
          {item.questions ? (
            <span
              className="mr-reviews-chip is-wait work-decisions"
              title="Questions on parts of its description still open: answer them in the item"
            >
              {item.questions} question{item.questions === 1 ? "" : "s"} open
            </span>
          ) : null}
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
              className={`mr-reviews-chip is-label work-tag${isWorkWorkspaceTag(tag) ? " is-workspace" : ""}`}
              title={
                isWorkWorkspaceTag(tag)
                  ? `Added from the workspace ${workTagLabel(tag)}: only its items (#${tag} in the search)`
                  : `Only the items tagged ${tag} (#${tag} in the search)`
              }
              onClick={(event) => {
                event.stopPropagation();
                onTag(tag);
              }}
            >
              {isWorkWorkspaceTag(tag) ? (
                <LayoutGrid size={10} aria-hidden="true" />
              ) : null}
              {workTagLabel(tag)}
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
                  {group.kind === "file" ? (
                    <span className="work-link-chip-name">{group.label}</span>
                  ) : (
                    group.label
                  )}
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
  file: FileText,
  item: Link2,
  deploy: Rocket,
  chat: MessageSquareQuote,
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
      return "Review the branch in Changes";
    case "item":
      return "Open that item";
    case "deploy":
      return link.sha === "decision"
        ? null
        : "Review the landed commit in Changes";
    case "decision":
      return null;
    case "file":
      return link.line
        ? `Open the file at line ${link.line} in Files`
        : "Open the file in Files";
    case "chat":
      return link.entry
        ? "Open the message in its session's chat"
        : "Open its session's chat";
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
      {link.kind === "commit" ||
      link.kind === "branch" ||
      (link.kind === "deploy" && link.sha !== "decision") ? (
        <button
          type="button"
          className="assistant-icon-button"
          aria-label={
            link.kind === "branch" ? "Copy the branch's name" : "Copy the sha"
          }
          title={`Copy ${link.kind === "branch" ? link.name : link.sha.slice(0, 10)}`}
          onClick={() =>
            void navigator.clipboard
              ?.writeText(link.kind === "branch" ? link.name : link.sha)
              .catch(() => {})
          }
        >
          <Copy size={13} />
        </button>
      ) : null}
    </li>
  );
}

/** Where the server found a link's commit or branch (link_target). */
export type WorkLinkTarget = { connectionId: string | null; root: string };

/**
 * A commit, branch or landing link of an item, reviewed in Changes: the
 * server finds the checkout that holds it (the link's root, else the
 * project's), the review opens there. Answers the review and its
 * connection, or why it could not (the server's plain words, or another
 * connection to switch to); a failed review open says so itself.
 */
export async function openWorkLinkReview(
  item: string,
  link: Extract<WorkLink, { kind: "commit" | "branch" | "deploy" }>,
  activeConnectionId: string | null,
): Promise<{ sessionId: string; connectionId: string } | string | null> {
  const { target } = await workCall<{ target: WorkLinkTarget }>("link_target", {
    item,
    link,
  });
  if (!activeConnectionId) return "Roamgate is not connected to Herdr";
  if (target.connectionId && target.connectionId !== activeConnectionId)
    return `It is in ${target.root} on ${target.connectionId}: switch to that connection to review it`;
  const { openBranchReview, openCommitReview } = await import("../reviewOpen");
  const sessionId =
    link.kind === "branch"
      ? await openBranchReview(link.name, { path: target.root })
      : await openCommitReview(link.sha, { path: target.root });
  return sessionId ? { sessionId, connectionId: activeConnectionId } : null;
}

/**
 * A file link of an item, shown in a workspace's Files preview (rendered
 * when it renders, at its line when it names one), as a comment's file
 * link opens: the server says its checkout and connection. Answers why it
 * could not, or null.
 */
export async function openWorkFileLink(
  item: string,
  link: Extract<WorkLink, { kind: "file" }>,
  place: {
    activeConnectionId: string | null;
    workspaces: readonly WorkFileWorkspace[];
  },
): Promise<string | null> {
  const { target } = await workCall<{ target: WorkFileTarget }>("link_target", {
    item,
    link,
  });
  const connectionId = place.activeConnectionId;
  if (!connectionId) return "Roamgate is not connected to Herdr";
  if (target.connectionId && target.connectionId !== connectionId)
    return `It is in ${target.root} on ${target.connectionId}: switch to that connection to open it`;
  const absolute = isAbsoluteWorkPath(target.path)
    ? target.path
    : `${target.root.replace(/[\\/]+$/, "")}/${target.path}`;
  const workspaceId = workFileWorkspace(place.workspaces, absolute);
  if (!workspaceId) return "No workspace is open to show the file in";
  const opened = requestFileLinkOpen({
    connectionId,
    workspaceId,
    link: {
      root: target.root,
      path: target.path,
      ...(link.line ? { line: link.line } : {}),
    },
    newTab: false,
  });
  return opened ? null : "This page cannot show files";
}

/** How long an added item waits to be sorted before the detail says so. */
export const WORK_SORT_PATIENCE_MS = 2 * 60_000;

/**
 * The detail of an item just added: while its owner (the coordinator)
 * sorts it, says who is giving it a title, tags and a state; after
 * WORK_SORT_PATIENCE_MS with nobody on it, says so plainly instead of
 * waiting on; once sorted, says so (the detail above shows the result,
 * the thread the coordinator's reply). Add another is always there.
 */
export function WorkSortStatus({
  item,
  sorter,
  onAddAnother,
}: {
  item: Pick<WorkItem, "needsTriage" | "owner">;
  sorter: string | null;
  onAddAnother: () => void;
}) {
  const sorting = !!item.needsTriage;
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!sorting) return;
    setLate(false);
    const timer = setTimeout(() => setLate(true), WORK_SORT_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [sorting]);
  const phase = !sorting ? "sorted" : late || !sorter ? "unsorted" : "sorting";
  return (
    <div className={`work-sort is-${phase}`} data-work-sort={phase}>
      <p className="work-sort-text" role="status">
        {phase === "sorting" ? (
          <>
            <LoaderCircle
              size={13}
              className="work-sort-spin"
              aria-hidden="true"
            />
            <span>
              Sorting: {sorter} is giving it a title, tags and a state
            </span>
          </>
        ) : phase === "unsorted" ? (
          <>
            <Hand size={13} aria-hidden="true" />
            <span>
              {sorter
                ? "No one has sorted it yet; it stays marked on the board"
                : "The project has no coordinator to sort it; it stays marked on the board"}
            </span>
          </>
        ) : (
          <>
            <Check size={13} aria-hidden="true" />
            <span>
              Sorted
              {item.owner ? ` by ${item.owner.session}` : ""}: its title, tags
              and state are set
            </span>
          </>
        )}
      </p>
      <button type="button" className="ghost" onClick={onAddAnother}>
        <Plus size={13} /> Add another
      </button>
    </div>
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
  onAdd,
  back,
  sorting = null,
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
  /** a: the add form, over the detail (shown again on Cancel). */
  onAdd: () => void;
  back: () => void;
  /**
   * The item was just added: who sorts it (its owner, else the project's
   * coordinator), and Add another.
   */
  sorting?: { sorter: string | null; onAddAnother: () => void } | null;
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
      } else if (key === "a") onAdd();
      else return false;
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
          <ChevronLeft size={13} /> Back
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
        {sorting ? (
          <WorkSortStatus
            item={item}
            sorter={sorting.sorter}
            onAddAnother={sorting.onAddAnother}
          />
        ) : null}
        <WorkAsk item={item} className="is-detail" />
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
