import {
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
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
  WORK_STATE_TITLE,
  WORK_STATES,
  type WorkItem,
  type WorkLink,
  type WorkProject,
  type WorkState,
  workDescriptionThread,
} from "../../../shared/work";
import { openAgentTask } from "../agentTasksOpen";
import { nextColumn, nextRow } from "../boardNavigation";
import { roamgateLocalStorage } from "../browserStorage";
import { requestReviewShown, useReviewState } from "../review";
import { EMPTY_KEY_STATE, feedKey } from "../reviewNavigation";
import {
  shallowEqual,
  type State,
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
  workTopTags,
} from "../workScope";
import { BoardCard } from "./BoardCard";
import { MobileSheetHandle } from "./MobileSheetHandle";
import { NoteBody } from "./ReviewNoteBody";
import { WorkAddForm } from "./WorkAddForm";
import { useWorkItemThreads, WorkItemThreads } from "./WorkItemThreads";
import "./WorkBoard.css";

/**
 * The board view's Work mode: the user's work items in the view's columns
 * by state (For you, Doing, Verify, Open, Done), the project of the
 * workspace the page shows (or the one chosen there, or all), filtered by
 * tags and words. Each card is an item: its title, tags, owner (a session
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
  const [tags, setTags] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(false);
  const [folded, setFolded] = useState<Set<WorkState>>(storedFolded);
  const [selected, setSelected] = useState<string | null>(initialItem ?? null);
  const [detail, setDetail] = useState<string | null>(initialItem ?? null);
  const [compose, setCompose] = useState<"comment" | "reply" | null>(null);
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const keyState = useRef(EMPTY_KEY_STATE);
  /** s or t on a card: the detail opens with that box focused. */
  const pendingFocus = useRef<"state" | "tags" | null>(null);
  // The phone's Back closes the filters, then the detail, then the view.
  useSystemBack(enabled && filters, () => setFilters(false), "popup");
  useSystemBack(
    enabled && !filters && (detail !== null || adding),
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
  const scopeProject = scope
    ? (projects.find((each) => each.id === scope) ?? null)
    : null;
  const choose = (next: WorkScope) => {
    setChoice({ key: workspaceKey, scope: next });
    setMemory((current) => rememberWorkScope(current, workspace, next));
    setTags([]);
    setSelected(null);
    setFilters(false);
  };
  const projectItems = useMemo(
    () =>
      scope ? boardItems.filter((item) => item.project === scope) : boardItems,
    [boardItems, scope],
  );
  const tagCounts = useMemo(() => workTagCounts(projectItems), [projectItems]);
  const topTags = useMemo(
    () => workTopTags(tagCounts, tags),
    [tagCounts, tags],
  );
  const tagChoices = useMemo(() => {
    const used = tagCounts.map(({ tag }) => tag);
    const suggested = scopeProject?.tags ?? [];
    return [...used, ...suggested.filter((tag) => !used.includes(tag))];
  }, [tagCounts, scopeProject]);
  const items = useMemo(
    () => filterWorkItems(projectItems, { tags, query }),
    [projectItems, tags, query],
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
        case "pr":
          window.open(link.url, "_blank", "noopener");
          return;
        case "item":
          setDetail(link.id);
          setSelected(link.id);
          return;
        case "commit":
        case "deploy":
          void navigator.clipboard?.writeText(link.sha).catch(() => {});
          return;
        default:
          return;
      }
    },
    [reviews.sessions, mobile, onClose],
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
      // The tag filters' box has its own keys (Esc closes the sheet).
      if (target?.closest("#work-filters-sheet")) return false;
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
      if (filters) setFilters(false);
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
    const fed = feedKey(keyState.current, event.key);
    keyState.current = fed.state;
    if (fed.type === "wait") return true;
    const count = fed.count ?? 1;
    const key = fed.key;
    if (detailItem) {
      if (key === "c") setCompose("comment");
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
    else if (key === "f") setFilters((open) => !open);
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
          tags={tagChoices}
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
          compose={compose}
          onComposeDone={() => setCompose(null)}
          onBack={closeDetail}
          onOpenOwner={() => void openOwner(detailItem)}
          onLink={openLink}
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
        />
      ) : (
        <>
          <div className="work-filter-row">
            {projects.length > 1 ? (
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
            ) : null}
            {tagCounts.length || tags.length ? (
              <div className="work-tags-strip" role="group" aria-label="Tags">
                {tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="work-chip is-selected"
                    aria-pressed="true"
                    title={`Without ${tag}`}
                    onClick={() =>
                      setTags((current) =>
                        current.filter((each) => each !== tag),
                      )
                    }
                  >
                    {tag}
                    <X size={11} aria-hidden="true" />
                  </button>
                ))}
                {topTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="work-chip"
                    aria-pressed="false"
                    onClick={() => setTags((current) => [...current, tag])}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            ) : null}
            {tagCounts.length ? (
              <button
                type="button"
                className={`work-chip work-filters-button${tags.length ? " is-selected" : ""}`}
                aria-expanded={filters}
                aria-controls="work-filters-sheet"
                title={`Every tag${mobile ? "" : " (f)"}`}
                onClick={() => setFilters((current) => !current)}
              >
                <SlidersHorizontal size={12} aria-hidden="true" />
                Filters
                {tags.length ? <small>{tags.length}</small> : null}
              </button>
            ) : null}
            {filters ? (
              <TagFilters
                counts={tagCounts}
                selected={tags}
                mobile={mobile}
                onToggle={(tag) =>
                  setTags((current) =>
                    current.includes(tag)
                      ? current.filter((each) => each !== tag)
                      : [...current, tag],
                  )
                }
                onClear={() => setTags([])}
                onClose={() => {
                  setFilters(false);
                  back();
                }}
              />
            ) : null}
          </div>
          {data && !items.length ? (
            <p className="assistant-hint">
              {projectItems.length
                ? "Nothing matches the filter."
                : "No work item yet: a (or the + button) adds one; agents add theirs with work_add."}
            </p>
          ) : null}
          <div className={board ? "mr-reviews-board" : "mr-reviews-sections"}>
            {columns.map(({ state, items: inColumn }) => {
              if (!inColumn.length && !board) return null;
              const isFolded = folded.has(state);
              return (
                <div
                  key={state}
                  className={`mr-reviews-lane is-${state}${isFolded ? " is-folded" : ""}`}
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
                          onSelect={() => select(item.id)}
                          onOpen={() => openDetail(item)}
                          onOpenOwner={() => void openOwner(item)}
                          onLink={openLink}
                          onDone={() => markDone(item)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
          {deployed ? (
            <p className="assistant-hint work-deployed">
              Deployed build {deployed.slice(0, 10)}: items whose commit it
              holds are done.
            </p>
          ) : null}
          {!mobile ? (
            <p className="assistant-hint mr-reviews-keys">
              j/k move · h/l columns · Enter open · c comment · s state · t tags
              · o the agent's work · dd done · a add · za fold · f filters · /
              search · [ ] Reviews · ? all keys
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
  onSelect,
  onOpen,
  onOpenOwner,
  onLink,
  onDone,
}: {
  item: WorkItem;
  /** Its project's name, when the board shows every project. */
  project: string | null;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onOpenOwner: () => void;
  onLink: (link: WorkLink) => void;
  onDone: () => void;
}) {
  return (
    <BoardCard
      selected={selected}
      className={`work-card is-${item.state}`}
      data={{ "data-work-item": item.id, "data-work-state": item.state }}
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
          {project ? (
            <span className="mr-reviews-chip is-tree">{project}</span>
          ) : null}
          {item.tags.map((tag) => (
            <span key={tag} className="mr-reviews-chip is-label">
              {tag}
            </span>
          ))}
          {item.owner ? <OwnerChip owner={item.owner} /> : null}
        </span>
      </div>
      <span className="mr-reviews-next">
        {item.links.map((link) => (
          <button
            key={`${link.kind}:${describeWorkLink(link)}`}
            type="button"
            className={`mr-reviews-chip work-link is-${link.kind}${link.kind === "deploy" ? " is-good" : ""}`}
            title={
              link.kind === "commit" || link.kind === "deploy"
                ? `${describeWorkLink(link)} (click copies the sha)`
                : describeWorkLink(link)
            }
            onClick={(event) => {
              event.stopPropagation();
              onLink(link);
            }}
          >
            {describeWorkLink(link)}
          </button>
        ))}
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

/**
 * An item's detail in the view, as a request's: its title and state, its
 * description (its text when it was added), what one sets (state, tags),
 * its owner (and the agent's work), its project, links and dates, its
 * buttons, then its thread, whose comments go to the owner session.
 */
function WorkDetail({
  item,
  project,
  compose,
  onComposeDone,
  onBack,
  onOpenOwner,
  onLink,
  onState,
  onDone,
  onReopen,
  onTags,
  onRemove,
  back,
  stateRef,
  tagsRef,
}: {
  item: WorkItem;
  project: string | null;
  compose: "comment" | "reply" | null;
  onComposeDone: () => void;
  onBack: () => void;
  onOpenOwner: () => void;
  onLink: (link: WorkLink) => void;
  onState: (state: WorkState) => void;
  onDone: () => void;
  onReopen: () => void;
  onTags: (tags: string[]) => void;
  onRemove: () => void;
  back: () => void;
  stateRef: RefObject<HTMLSelectElement | null>;
  tagsRef: RefObject<HTMLInputElement | null>;
}) {
  const api = useWorkItemThreads(item.id);
  const description = useMemo(
    () => workDescriptionOf(api.threads, item),
    [api.threads, item],
  );
  const owner = item.owner;
  return (
    <>
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
          <div className="work-description" aria-label="Description">
            <NoteBody text={description.comments[0]!.body} />
          </div>
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
              <dd className="mr-reviews-own">
                {item.links.map((link) => (
                  <button
                    key={`${link.kind}:${describeWorkLink(link)}`}
                    type="button"
                    className={`mr-reviews-chip work-link is-${link.kind}${link.kind === "deploy" ? " is-good" : ""}`}
                    title={
                      link.kind === "commit" || link.kind === "deploy"
                        ? `${describeWorkLink(link)} (click copies the sha)`
                        : describeWorkLink(link)
                    }
                    onClick={() => onLink(link)}
                  >
                    {describeWorkLink(link)}
                  </button>
                ))}
              </dd>
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
          onLeave={back}
        />
      </section>
    </>
  );
}

/**
 * Every tag of the scope with its count, to pick several: a list under
 * the Filters button, a bottom sheet on a phone, searched by typing.
 */
function TagFilters({
  counts,
  selected,
  mobile,
  onToggle,
  onClear,
  onClose,
}: {
  counts: readonly { tag: string; count: number }[];
  selected: readonly string[];
  mobile: boolean;
  onToggle: (tag: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // A phone's keyboard would cover the list: the list first there.
    if (!mobile) searchRef.current?.focus();
  }, [mobile]);
  const words = search.trim().toLowerCase();
  const shown = counts.filter(({ tag }) => !words || tag.includes(words));
  return (
    <>
      <div
        className="work-filters-backdrop"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        id="work-filters-sheet"
        className={`work-filters-sheet${mobile ? " is-sheet mobile-sheet" : ""}`}
        role="dialog"
        aria-label="Tag filters"
        onKeyDown={(event) => {
          // The board's keys stay out: letters search, Esc closes.
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          event.stopPropagation();
        }}
      >
        {mobile ? (
          <MobileSheetHandle
            label="Pull down to close the tag filters"
            onClose={onClose}
          />
        ) : null}
        <div className="work-filters-head">
          <label className="work-search">
            <Search size={13} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              placeholder="Find a tag"
              aria-label="Find a tag"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {selected.length ? (
            <button type="button" className="work-chip" onClick={onClear}>
              Clear {selected.length}
            </button>
          ) : null}
          <button
            type="button"
            className="assistant-icon-button"
            aria-label="Close the tag filters"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <ul className="work-filters-list">
          {shown.map(({ tag, count }) => {
            const on = selected.includes(tag);
            return (
              <li key={tag}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className={on ? "is-selected" : ""}
                  onClick={() => onToggle(tag)}
                >
                  <span className="work-filters-check" aria-hidden="true">
                    {on ? <Check size={12} /> : null}
                  </span>
                  <span className="work-filters-tag">{tag}</span>
                  <small>{count}</small>
                </button>
              </li>
            );
          })}
          {!shown.length ? (
            <li className="assistant-hint">No tag matches.</li>
          ) : null}
        </ul>
      </div>
    </>
  );
}
