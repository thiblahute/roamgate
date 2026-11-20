import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  describeWorkLink,
  filterWorkItems,
  WORK_STATE_TITLE,
  WORK_STATES,
  type WorkItem,
  type WorkLink,
  type WorkProject,
  type WorkState,
} from "../../../shared/work";
import { openAgentTask } from "../agentTasksOpen";
import { useLayoutPreferences } from "../layoutPreferences";
import { openMrReviews } from "../mrReviewsOpen";
import { requestReviewShown, useReviewState } from "../review";
import {
  shallowEqual,
  type State,
  TASK_NOTIFICATION_ACTIVATE_EVENT,
  useStoreSelector,
} from "../store";
import { useSystemBack } from "../systemBack";
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
import { MobileSheetHandle } from "./MobileSheetHandle";
import { WorkItemThreads } from "./WorkItemThreads";
import "./WorkPanel.css";

/**
 * The Work board: the user's work items in columns by state (For you,
 * Doing, Verify, Open, Done), the project of the workspace the page shows
 * (or the one chosen there, or all), filtered by tags and words. Each
 * card is an item: its title, tags, owner (a session or its subagent,
 * whose work opens from the card), links; the selected card shows its
 * actions and its thread, whose comments go to the owner. The inbox's
 * keys work here; columns side by side when the panel is wide, one list
 * on a phone.
 */

/** From this width the columns stand side by side. */
const WIDE_MIN = 2 * 300 + 12 + 24;
const NO_ITEMS: WorkItem[] = [];
const NO_PROJECTS: WorkProject[] = [];

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
function ago(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** An element's width, followed as it changes. */
function useWidth(
  ref: { current: HTMLElement | null },
  enabled: boolean,
): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!enabled) return;
    const measure = () =>
      setWidth(Math.round(ref.current?.getBoundingClientRect().width ?? 0));
    measure();
    const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver })
      .ResizeObserver;
    const observer = Observer ? new Observer(measure) : null;
    if (observer && ref.current) observer.observe(ref.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [enabled, ref]);
  return enabled ? width : 0;
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

/**
 * j / k / h / l: the item `step` away (in its column when wide, through
 * every column in one list), or the column `side` away at the same height.
 */
export function workStep(
  columns: Column[],
  current: string | null,
  move: { step?: number; side?: number },
  wide: boolean,
): WorkItem | null {
  const shown = columns.filter((column) => column.items.length);
  if (!shown.length) return null;
  const col = shown.findIndex((column) =>
    column.items.some((item) => item.id === current),
  );
  if (col < 0) return shown[0]!.items[0] ?? null;
  const row = shown[col]!.items.findIndex((item) => item.id === current);
  if (move.side) {
    const next = Math.max(0, Math.min(shown.length - 1, col + move.side));
    const items = shown[next]!.items;
    return items[Math.min(row, items.length - 1)] ?? null;
  }
  const step = move.step ?? 0;
  if (wide) {
    const items = shown[col]!.items;
    return items[Math.max(0, Math.min(items.length - 1, row + step))] ?? null;
  }
  const all = shown.flatMap((column) => column.items);
  const at = all.findIndex((item) => item.id === current);
  return all[Math.max(0, Math.min(all.length - 1, at + step))] ?? null;
}

const HELP: [string, string][] = [
  ["j / k", "next / previous item"],
  ["h / l", "the column beside"],
  ["Enter", "open the item (its thread and actions)"],
  ["c / r", "comment / reply on the item"],
  ["s", "its state"],
  ["t", "its tags"],
  ["o", "open the owner's work (its session or subagent)"],
  ["dd", "done"],
  ["a", "add an item"],
  ["/", "search"],
  ["f", "the tag filters"],
  ["za", "fold the column"],
  ["Esc", "close"],
];

export function WorkPanel({
  onClose,
  initialItem,
}: {
  onClose: (options?: { keepFocus?: boolean }) => void;
  initialItem?: string;
}) {
  const { mobile } = useLayoutPreferences();
  const { board, error, reload } = useWorkBoard();
  const reviews = useReviewState();
  const workspace = useWorkWorkspace();
  const panelRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef<HTMLSelectElement>(null);
  const tagsRef = useRef<HTMLInputElement>(null);
  const [maximized, setMaximized] = useState(false);
  const width = useWidth(panelRef, !mobile);
  const wide = !mobile && width >= WIDE_MIN;
  const [memory, setMemory] = useState(() => readWorkScopeMemory());
  /** The scope chosen on this board, for the workspace it was chosen in. */
  const [choice, setChoice] = useState<{
    key: string;
    scope: WorkScope;
  } | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  /** The phone's search, opened from its icon: the head is the box then. */
  const [searching, setSearching] = useState(false);
  const [filters, setFilters] = useState(false);
  const [folded, setFolded] = useState<Set<WorkState>>(() => new Set(["done"]));
  const [selected, setSelected] = useState<string | null>(initialItem ?? null);
  const [compose, setCompose] = useState<"comment" | "reply" | null>(null);
  const [adding, setAdding] = useState(false);
  const [help, setHelp] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const pendingKey = useRef("");
  // The phone's Back closes the filters, then the search, then the board.
  useSystemBack(filters, () => setFilters(false), "popup");
  const searchShown = !mobile || searching || query !== "";
  const closeSearch = useCallback(() => {
    setSearching(false);
    setQuery("");
  }, []);
  useSystemBack(mobile && searchShown, closeSearch, "popup");
  useEffect(() => {
    if (searching) searchRef.current?.focus({ preventScroll: true });
  }, [searching]);
  useSystemBack(true, () => onClose(), "panel");

  const projects = board?.projects ?? NO_PROJECTS;
  const boardItems = board?.items ?? NO_ITEMS;
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
  const walkable = useMemo(
    () => columns.filter((column) => !folded.has(column.state)),
    [columns, folded],
  );
  const forYou = projectItems.filter((item) => item.state === "you").length;
  const forYouAll = boardItems.filter((item) => item.state === "you").length;
  const openCount = projectItems.filter((item) => item.state !== "done").length;
  const projectName = (id: string) =>
    projects.find((each) => each.id === id)?.name ?? id;
  /** The scope's name in the head: the workspace's when it is its project. */
  const scopeName = !board
    ? null
    : scope === null
      ? projects.length > 1
        ? "All projects"
        : null
      : workspace && ownProject?.id === scope
        ? workspace.label
        : projectName(scope);

  // An item asked for (a notification's link): its column unfolded, shown.
  useEffect(() => {
    if (!initialItem || !board) return;
    const item = board.items.find((each) => each.id === initialItem);
    if (!item) return;
    setFolded((current) => {
      if (!current.has(item.state)) return current;
      const next = new Set(current);
      next.delete(item.state);
      return next;
    });
    requestAnimationFrame(() =>
      panelRef.current
        ?.querySelector(`[data-work-item="${item.id}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  }, [initialItem, board]);

  const back = useCallback(
    () =>
      requestAnimationFrame(() =>
        panelRef.current?.focus({ preventScroll: true }),
      ),
    [],
  );
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

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

  const select = useCallback((id: string | null) => {
    setSelected(id);
    if (id)
      requestAnimationFrame(() =>
        panelRef.current
          ?.querySelector(`[data-work-item="${id}"]`)
          ?.scrollIntoView({ block: "nearest" }),
      );
  }, []);

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
    (item: WorkItem, link: WorkLink) => {
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
        case "effort":
          openMrReviews();
          return;
        case "item":
          select(link.id);
          return;
        case "commit":
        case "deploy":
          void navigator.clipboard?.writeText(link.sha).catch(() => {});
          return;
        default:
          void item;
      }
    },
    [reviews.sessions, mobile, onClose, select],
  );

  const selectedItem = items.find((item) => item.id === selected) ?? null;

  const markDone = (item: WorkItem) => void act("done", { item: item.id });

  function onKey(event: React.KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    // Boxes and menus keep their keys; Esc in the search gives them back.
    if (
      target.closest("input, textarea, select, [contenteditable], .cm-editor")
    ) {
      if (event.key === "Escape" && target !== panelRef.current) {
        event.preventDefault();
        event.stopPropagation();
        (target as HTMLInputElement).blur?.();
        back();
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = pendingKey.current + event.key;
    pendingKey.current = "";
    const count = 1;
    let handled = true;
    const go = (move: { step?: number; side?: number }) => {
      const next = workStep(walkable, selected, move, wide);
      if (next) select(next.id);
    };
    if (key === "j" || key === "ArrowDown") go({ step: count });
    else if (key === "k" || key === "ArrowUp") go({ step: -count });
    else if (key === "h" || key === "ArrowLeft") go({ side: -1 });
    else if (key === "l" || key === "ArrowRight") go({ side: 1 });
    else if (key === "Enter") {
      if (!selected) go({ step: 0 });
    } else if (key === "c" && selectedItem) setCompose("comment");
    else if (key === "r" && selectedItem) setCompose("reply");
    else if (key === "s" && selectedItem) stateRef.current?.focus();
    else if (key === "t" && selectedItem) tagsRef.current?.focus();
    else if (key === "o" && selectedItem) void openOwner(selectedItem);
    else if (key === "dd" && selectedItem && selectedItem.state !== "done")
      markDone(selectedItem);
    else if (key === "za" && selectedItem) toggleFold(selectedItem.state);
    else if (key === "a") setAdding(true);
    else if (key === "f") setFilters((current) => !current);
    else if (key === "/") {
      if (searchShown) searchRef.current?.focus();
      else setSearching(true);
    } else if (key === "?") setHelp((current) => !current);
    else if (key === "R") void reload();
    else if (key === "d" || key === "z" || key === "g") {
      pendingKey.current = key;
    } else if (key === "Escape") {
      if (filters) setFilters(false);
      else if (mobile && searchShown) closeSearch();
      else if (help) setHelp(false);
      else if (adding) setAdding(false);
      else if (selected) setSelected(null);
      else onClose();
    } else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function toggleFold(state: WorkState) {
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  }

  const deployed = board?.deployed;
  return (
    <section
      ref={panelRef}
      className={`assistant-panel work-panel ${mobile ? "is-mobile" : maximized ? "is-maximized" : "is-floating"}${wide ? " is-wide" : ""}`}
      aria-label="Work"
      data-workspace={workspaceKey || undefined}
      data-scope={scope ?? WORK_SCOPE_ALL}
      tabIndex={-1}
      onKeyDown={onKey}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest("button, a, input, textarea, select, [tabindex]"))
          requestAnimationFrame(() =>
            panelRef.current?.focus({ preventScroll: true }),
          );
      }}
    >
      <header
        className={`assistant-panel-head work-head${mobile && searchShown ? " is-searching" : ""}`}
      >
        <div className="work-title">
          <div className="assistant-panel-title">
            <strong>Work</strong>
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
          </div>
          <div className="work-status" role="status">
            {board
              ? `${forYou} for you · ${openCount} open${scope && forYouAll > forYou ? ` · ${forYouAll} for you in all` : ""}`
              : error
                ? `Not loaded: ${error}`
                : "Loading..."}
          </div>
        </div>
        {searchShown ? (
          <label className="work-search" aria-label="Search the items (/)">
            <Search size={13} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              enterKeyHint="search"
              placeholder="Search the items"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                  back();
                }
              }}
            />
          </label>
        ) : null}
        <div className="work-head-actions">
          {mobile && searchShown ? (
            <button
              type="button"
              className="assistant-icon-button"
              aria-label="Close the search"
              title="Close the search"
              onClick={() => {
                closeSearch();
                back();
              }}
            >
              <X size={16} />
            </button>
          ) : null}
          {mobile && !searchShown ? (
            <button
              type="button"
              className="assistant-icon-button"
              aria-label="Search the items"
              title="Search the items"
              onClick={() => setSearching(true)}
            >
              <Search size={16} />
            </button>
          ) : null}
          {mobile && searchShown ? null : (
            <button
              type="button"
              className="assistant-icon-button"
              aria-label="Add an item (a)"
              title="Add an item (a)"
              onClick={() => setAdding(true)}
            >
              <Plus size={16} />
            </button>
          )}
          {mobile && searchShown ? null : (
            <button
              type="button"
              className="assistant-icon-button"
              aria-label="Read again (R)"
              title="Read again (R)"
              onClick={() => void reload()}
            >
              <RefreshCw size={15} />
            </button>
          )}
          {mobile ? null : (
            <button
              type="button"
              className="assistant-icon-button"
              aria-label={maximized ? "Beside the page" : "Whole page"}
              title={
                maximized
                  ? "Beside the page"
                  : "Whole page: the columns side by side"
              }
              onClick={() => setMaximized((current) => !current)}
            >
              {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          )}
          {mobile ? null : (
            <button
              type="button"
              className="assistant-icon-button"
              aria-label="Keys (?)"
              title="Keys (?)"
              aria-pressed={help}
              onClick={() => setHelp((current) => !current)}
            >
              <HelpCircle size={15} />
            </button>
          )}
          {mobile && searchShown ? null : (
            <button
              type="button"
              className="assistant-icon-button"
              aria-label="Close (Esc)"
              title="Close (Esc)"
              onClick={() => onClose()}
            >
              <X size={16} />
            </button>
          )}
        </div>
      </header>
      <div className="work-body">
        {help ? (
          <dl className="work-help" aria-label="Keys">
            {HELP.map(([keys, what]) => (
              <div key={keys}>
                <dt>{keys}</dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {failure ? (
          <p className="work-threads-error" role="alert">
            {failure}
          </p>
        ) : null}
        <div className="work-filters">
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
          </div>
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
        {adding && (scope ?? projects[0]?.id) ? (
          <AddItem
            project={scope ?? projects[0]!.id}
            tags={tagChoices}
            onDone={() => {
              setAdding(false);
              back();
            }}
            onAdd={async (params) => {
              const ok = await act("add", {
                ...params,
                project: scope ?? projects[0]!.id,
              });
              if (ok) {
                setAdding(false);
                back();
              }
            }}
          />
        ) : null}
        {board && !items.length ? (
          <p className="work-empty">
            {projectItems.length
              ? "Nothing matches the filter."
              : "No work item yet: a (or the + button) adds one; agents add theirs with work_add."}
          </p>
        ) : null}
        <div
          className={`work-columns${wide ? " is-wide" : ""}`}
          aria-label="Board"
        >
          {columns.map(({ state, items: inColumn }) => {
            if (!inColumn.length && !wide) return null;
            const isFolded = folded.has(state);
            return (
              <div
                key={state}
                className={`work-column is-${state}${isFolded ? " is-folded" : ""}`}
                role="group"
                aria-label={WORK_STATE_TITLE[state]}
                data-work-column={state}
              >
                <button
                  type="button"
                  className="work-column-title"
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
                  <ul className="work-cards">
                    {inColumn.map((item) => (
                      <WorkCard
                        key={item.id}
                        item={item}
                        project={scope ? null : projectName(item.project)}
                        selected={item.id === selected}
                        onSelect={() => select(item.id)}
                        onOpenOwner={() => void openOwner(item)}
                        onLink={(link) => openLink(item, link)}
                        onState={(next) =>
                          void act("update", { item: item.id, state: next })
                        }
                        onDone={() => markDone(item)}
                        onReopen={() => void act("reopen", { item: item.id })}
                        onTags={(next) =>
                          void act("update", { item: item.id, tags: next })
                        }
                        onRemove={() => {
                          if (window.confirm(`Delete "${item.title}"?`))
                            void act("remove", { item: item.id });
                        }}
                        compose={item.id === selected ? compose : null}
                        onComposeDone={() => setCompose(null)}
                        back={back}
                        stateRef={item.id === selected ? stateRef : undefined}
                        tagsRef={item.id === selected ? tagsRef : undefined}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
        {deployed ? (
          <span className="work-deployed">
            Deployed build {deployed.slice(0, 10)}: items whose commit it holds
            are done.
          </span>
        ) : null}
      </div>
    </section>
  );
}

function WorkCard({
  item,
  project,
  selected,
  onSelect,
  onOpenOwner,
  onLink,
  onState,
  onDone,
  onReopen,
  onTags,
  onRemove,
  compose,
  onComposeDone,
  back,
  stateRef,
  tagsRef,
}: {
  item: WorkItem;
  /** Its project's name, when the board shows every project. */
  project: string | null;
  selected: boolean;
  onSelect: () => void;
  onOpenOwner: () => void;
  onLink: (link: WorkLink) => void;
  onState: (state: WorkState) => void;
  onDone: () => void;
  onReopen: () => void;
  onTags: (tags: string[]) => void;
  onRemove: () => void;
  compose: "comment" | "reply" | null;
  onComposeDone: () => void;
  back: () => void;
  stateRef?: React.RefObject<HTMLSelectElement | null>;
  tagsRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const owner = item.owner;
  return (
    <li
      className={`work-card is-${item.state}${selected ? " is-selected" : ""}`}
      data-work-item={item.id}
      data-work-state={item.state}
    >
      <button
        type="button"
        className="work-card-main"
        aria-current={selected ? "true" : undefined}
        aria-expanded={selected}
        onFocus={onSelect}
        onClick={onSelect}
      >
        <span className="work-card-title">{item.title}</span>
        <span className="work-card-meta">
          {project ? <span className="work-project">{project}</span> : null}
          {item.tags.map((tag) => (
            <span key={tag} className="work-tag">
              {tag}
            </span>
          ))}
          {owner ? (
            <span
              className="work-owner"
              title={
                owner.task
                  ? `Subagent ${owner.task} of ${owner.session}`
                  : owner.session
              }
            >
              <Bot size={11} />
              {owner.session}
              {owner.task ? ` · task ${owner.task.slice(0, 8)}` : ""}
            </span>
          ) : null}
          <span>
            {ago(
              item.state === "done"
                ? (item.doneAt ?? item.updatedAt)
                : item.updatedAt,
            )}
          </span>
          {item.by === "agent" ? <span>by an agent</span> : null}
        </span>
      </button>
      {item.links.length ? (
        <div className="work-links" aria-label="Links">
          {item.links.map((link) => (
            <button
              key={`${link.kind}:${describeWorkLink(link)}`}
              type="button"
              className={`work-link is-${link.kind}${link.kind === "deploy" ? " is-landed" : ""}`}
              title={
                link.kind === "commit" || link.kind === "deploy"
                  ? `${describeWorkLink(link)} (click copies the sha)`
                  : describeWorkLink(link)
              }
              onClick={() => onLink(link)}
            >
              <span>{describeWorkLink(link)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {selected ? (
        <>
          <div className="work-card-actions">
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
            {item.state === "done" ? (
              <button type="button" onClick={onReopen}>
                Reopen
              </button>
            ) : (
              <button type="button" className="is-primary" onClick={onDone}>
                Done (dd)
              </button>
            )}
            {owner ? (
              <button
                type="button"
                className="is-primary"
                title={
                  owner.task
                    ? `Open the subagent's work in ${owner.session} (o)`
                    : `Open the session ${owner.session} (o)`
                }
                onClick={onOpenOwner}
              >
                <Bot size={12} />{" "}
                {owner.task ? "Open the agent's work" : "Open the session"}
              </button>
            ) : null}
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
            <button type="button" onClick={onRemove}>
              Delete
            </button>
          </div>
          <WorkItemThreads
            item={item.id}
            compose={compose}
            onComposeDone={onComposeDone}
            onLeave={back}
          />
        </>
      ) : null}
    </li>
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
            <li className="work-empty">No tag matches.</li>
          ) : null}
        </ul>
      </div>
    </>
  );
}

function AddItem({
  project,
  tags,
  onAdd,
  onDone,
}: {
  project: string;
  tags: string[];
  onAdd: (params: {
    title: string;
    state: WorkState;
    tags: string[];
  }) => Promise<void>;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [state, setState] = useState<WorkState>("open");
  const [chosen, setChosen] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  const submit = () => {
    if (!title.trim()) return;
    void onAdd({
      title: title.trim(),
      state,
      tags: chosen.split(/[\s,]+/).filter(Boolean),
    });
  };
  return (
    <form
      className="work-add"
      aria-label={`Add an item to ${project}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onDone();
        }
      }}
    >
      <input
        ref={titleRef}
        placeholder="What needs doing"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <div className="work-add-row">
        <select
          aria-label="State"
          value={state}
          onChange={(event) => setState(event.target.value as WorkState)}
        >
          {WORK_STATES.filter((each) => each !== "done").map((each) => (
            <option key={each} value={each}>
              {WORK_STATE_TITLE[each]}
            </option>
          ))}
        </select>
        <input
          aria-label="Tags"
          placeholder={
            tags.length ? `tags: ${tags.slice(0, 4).join(", ")}...` : "tags"
          }
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
        />
        <button type="submit" className="is-primary" disabled={!title.trim()}>
          Add
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
