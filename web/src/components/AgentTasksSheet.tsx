import {
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleX,
  Eye,
  Keyboard,
  LoaderCircle,
  LocateFixed,
  SquareTerminal,
  Users,
  Workflow,
  X,
} from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type AgentTask,
  type AgentTaskDetail,
  type WorkflowView,
  taskElapsed,
  taskStatusLabel,
  useAgentTasks,
} from "../agentTasks";
import {
  TASK_SHEET_KEYS,
  type SheetCommand,
  type WorkflowAgentView,
  type WorkflowRow,
  agentElapsedMs,
  agentKey,
  agentQuietMs,
  agentsProgress,
  followTarget,
  formatDuration,
  isPhaseCollapsed,
  nextKeyWhere,
  phaseKey,
  phaseOfAgent,
  reconcileKey,
  sheetCommand,
  shownKey,
  stepKey,
  taskNeedsAttention,
  workflowProgress,
  workflowRows,
} from "../agentTasksView";
import { activeTerminalInput } from "../activeTerminalInput";
import {
  type SheetPlace,
  type TaskPlace,
  backPlace,
  openingPlace,
  placeKey,
  readScroll,
  restoredAgent,
  scrollTarget,
  sheetPlace,
  taskPlace,
} from "../agentTasksMemory";
import type { Pane } from "../types";
import { useConnectionClient } from "../useConnectionClient";
import { AgentHistoryChat } from "./AgentHistoryChat";
import { groupHistoryChatItems } from "./agentHistoryView";
import { focusDialogElement } from "./dialogFocus";
import "./AgentTasksSheet.css";

const DETAIL_POLL_MS = 2000;
/** Rows a page key moves. */
const PAGE_ROWS = 8;
/** Pixels a line key scrolls an output or a conversation. */
const LINE_PX = 40;
/** An output within this of its end follows it. */
const OUTPUT_FOLLOW_PX = 24;

/** The open view's keys: true when it took the command. */
type ViewKeys = (command: SheetCommand) => boolean;
type ViewKeysRef = RefObject<ViewKeys | null>;

function TaskIcon({ task }: { task: AgentTask }) {
  if (task.kind === "agent") return <Bot size={15} aria-hidden="true" />;
  if (task.kind === "teammate") return <Users size={15} aria-hidden="true" />;
  if (task.kind === "workflow")
    return <Workflow size={15} aria-hidden="true" />;
  if (task.kind === "monitor") return <Eye size={15} aria-hidden="true" />;
  return <SquareTerminal size={15} aria-hidden="true" />;
}

function StateIcon({ state }: { state: string }) {
  if (state === "running")
    return (
      <LoaderCircle
        size={14}
        className="agent-task-spinner"
        aria-label="running"
      />
    );
  if (state === "failed" || state === "lost")
    return (
      <CircleX size={14} className="agent-task-failed" aria-label={state} />
    );
  if (state === "waiting") return null;
  return <Check size={14} className="agent-task-done" aria-label={state} />;
}

function rowElement(
  container: HTMLElement | null,
  key: string | null,
): HTMLElement | null {
  if (!container || key === null) return null;
  return container.querySelector<HTMLElement>(
    `[data-nav-key="${CSS.escape(key)}"]`,
  );
}

/**
 * Keeps a list's cursor on a row while the list changes live, and the
 * keyboard focus on it: moved by keys, or back on it when the row that had
 * focus went away.
 */
function useRowCursor(
  containerRef: RefObject<HTMLElement | null>,
  keys: readonly string[],
  cursor: string | null,
  setCursor: (key: string | null) => void,
) {
  const previous = useRef<readonly string[]>(keys);
  const pendingFocus = useRef(false);
  const programmatic = useRef(false);
  const focusRow = useCallback((row: HTMLElement) => {
    programmatic.current = true;
    row.focus({ preventScroll: true });
    programmatic.current = false;
    row.scrollIntoView({ block: "nearest" });
  }, []);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = keys;
    if (!keys.length) return;
    const next = reconcileKey(before, keys, cursor);
    if (next !== cursor) {
      setCursor(next);
      return;
    }
    const row = rowElement(containerRef.current, cursor);
    if (!row) return;
    const active = document.activeElement;
    if (
      pendingFocus.current ||
      active === null ||
      active === document.body ||
      !active.isConnected
    ) {
      pendingFocus.current = false;
      focusRow(row);
    }
  }, [containerRef, keys, cursor, setCursor, focusRow]);
  /** Moves the cursor and the focus with it. */
  const moveTo = useCallback(
    (key: string | null) => {
      if (key === null) return;
      if (key === cursor) {
        // The same row: no effect runs, so focus it here.
        const row = rowElement(containerRef.current, key);
        if (row) focusRow(row);
        return;
      }
      pendingFocus.current = true;
      setCursor(key);
    },
    [containerRef, cursor, setCursor, focusRow],
  );
  return { moveTo, programmatic };
}

/** j / k, pages, top and end for an output or a conversation. */
function scrollKeys(
  element: HTMLElement | null,
  command: SheetCommand,
): boolean {
  if (!element) return false;
  const page = Math.max(LINE_PX, element.clientHeight * 0.9);
  const by: Partial<Record<SheetCommand, number>> = {
    down: LINE_PX,
    up: -LINE_PX,
    pageDown: page,
    toggle: page,
    pageUp: -page,
  };
  const delta = by[command];
  if (delta !== undefined) {
    element.scrollTop += delta;
    return true;
  }
  if (command === "first") {
    element.scrollTop = 0;
    return true;
  }
  if (command === "last" || command === "follow") {
    element.scrollTop = element.scrollHeight;
    return true;
  }
  return false;
}

/**
 * The session's background commands, monitors and subagents: a list, and on
 * a tap one task's details, followed while it runs. Driven by keys too.
 * Closed and opened again, it comes back where it was left in that session.
 */
export function AgentTasksSheet({
  pane,
  tasks,
  session,
  initialTaskId = null,
  onClose,
}: {
  pane: Pane;
  tasks: AgentTask[];
  /** The session the tasks are of: where it was left is kept per session. */
  session: string | null;
  /** A task to open on (a chat's link to it), else the place left. */
  initialTaskId?: string | null;
  onClose: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const client = useConnectionClient();
  const place = useMemo(
    () => sheetPlace(placeKey(client.connectionId, pane.pane_id, session)),
    [client.connectionId, pane.pane_id, session],
  );
  const taskIds = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const [opening, setOpening] = useState(() =>
    openingPlace(place, taskIds, initialTaskId),
  );
  const open = tasks.find((task) => task.id === opening.taskId) ?? null;
  const sheetRef = useRef<HTMLDivElement>(null);
  const viewKeys = useRef<ViewKeys | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [listCursor, setListCursor] = useState<string | null>(
    () =>
      place.listCursor ??
      initialTaskId ??
      tasks.find((task) => task.status === "running")?.id ??
      tasks[0]?.id ??
      null,
  );
  useEffect(() => {
    place.taskId = opening.taskId;
    place.returnTo = opening.returnTo;
    place.listCursor = listCursor;
  }, [place, opening, listCursor]);
  const openTask = useCallback((id: string) => {
    setListCursor(id);
    setOpening({ taskId: id, returnTo: null });
  }, []);
  /** Back from a task: to the place beneath it, or the list on it. */
  const back = useCallback(() => {
    const next = backPlace(opening, taskIds);
    if (next.taskId === null && opening.taskId) setListCursor(opening.taskId);
    setOpening(next);
  }, [opening, taskIds]);
  const openId = open?.id ?? null;
  const openPlace = useMemo(
    () => (openId === null ? null : taskPlace(place, openId)),
    [place, openId],
  );

  // The sheet takes the focus, and gives it back when it closes.
  useEffect(() => {
    const previous = document.activeElement;
    const cancelFocus = focusDialogElement(sheetRef.current);
    return () => {
      cancelFocus();
      // Opened from the command menu, which is gone: back to the terminal.
      const target =
        previous instanceof HTMLElement &&
        previous.isConnected &&
        previous !== document.body
          ? previous
          : activeTerminalInput(document);
      target?.focus({ preventScroll: true });
    };
  }, []);

  const state = useRef({ helpOpen, open: !!open, onClose, back });
  state.current = { helpOpen, open: !!open, onClose, back };
  // Its keys, only while it is open, and only from inside it (or from
  // nothing focused): the terminal and the composer keep theirs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229)
        return;
      const backdrop = sheetRef.current?.parentElement;
      const target = event.target;
      if (
        !backdrop ||
        !(
          target === document.body ||
          (target instanceof Node && backdrop.contains(target))
        )
      )
        return;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true']")
      )
        return;
      const command = sheetCommand(event);
      if (!command) return;
      // Enter and Space press the sheet's own buttons (back, close, follow).
      if (
        (event.key === "Enter" || event.key === " ") &&
        target instanceof HTMLElement &&
        target.closest("button, a") &&
        !target.closest("[data-nav-key]")
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const current = state.current;
      if (current.helpOpen) {
        if (command === "help" || command === "back" || command === "close")
          setHelpOpen(false);
        return;
      }
      if (command === "help") {
        setHelpOpen(true);
        return;
      }
      if (viewKeys.current?.(command)) return;
      if (command === "back" && current.open) current.back();
      else if (command === "back" || command === "close") current.onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return createPortal(
    <div
      className="agent-tasks-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className="agent-tasks-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={open ? open.title : "Background tasks"}
        tabIndex={-1}
      >
        <div className="agent-tasks-head">
          {open ? (
            <button
              type="button"
              className="agent-history-icon"
              aria-label="All tasks"
              title="Back (Esc)"
              onClick={back}
            >
              <ChevronLeft size={16} />
            </button>
          ) : null}
          <strong>{open ? open.title : "Background tasks"}</strong>
          <button
            type="button"
            className="agent-history-icon agent-tasks-keys-button"
            aria-label="Keys"
            aria-pressed={helpOpen}
            title="Keys (?)"
            onClick={() => setHelpOpen((shown) => !shown)}
          >
            <Keyboard size={16} />
          </button>
          <button
            type="button"
            className="agent-history-icon"
            aria-label="Close"
            title="Close (q)"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        {open && openPlace ? (
          <TaskDetail
            key={open.id}
            pane={pane}
            task={open}
            now={now}
            place={openPlace}
            viewKeys={viewKeys}
          />
        ) : tasks.length ? (
          <TaskList
            tasks={tasks}
            now={now}
            cursor={listCursor}
            setCursor={setListCursor}
            place={place}
            viewKeys={viewKeys}
            onOpen={openTask}
          />
        ) : (
          <p className="agent-tasks-empty">
            Nothing ran in the background yet.
          </p>
        )}
        {helpOpen ? (
          <div className="agent-tasks-help" role="note" aria-label="Keys">
            <dl>
              {TASK_SHEET_KEYS.map(([keys, label]) => (
                <div key={keys}>
                  <dt>
                    {keys
                      .split(" ")
                      .map((key, index) =>
                        key === "/" ? (
                          <span key={index}> / </span>
                        ) : (
                          <kbd key={index}>{key}</kbd>
                        ),
                      )}
                  </dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/** The sheet over a pane's terminal, which reads the tasks itself. */
export function PaneAgentTasksSheet({
  pane,
  onClose,
}: {
  pane: Pane;
  onClose: () => void;
}) {
  const { tasks, session, loaded } = useAgentTasks(pane, true);
  // Opened where it was left, once it is known which session that is.
  if (!loaded) return null;
  return (
    <AgentTasksSheet
      pane={pane}
      tasks={tasks}
      session={session}
      onClose={onClose}
    />
  );
}

function TaskList({
  tasks,
  now,
  cursor,
  setCursor,
  place,
  viewKeys,
  onOpen,
}: {
  tasks: AgentTask[];
  now: number;
  cursor: string | null;
  setCursor: (id: string | null) => void;
  /** Where the list was scrolled, kept there. */
  place: SheetPlace;
  viewKeys: ViewKeysRef;
  onOpen: (id: string) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = place.listScroll;
  }, [place]);
  const keys = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const { moveTo } = useRowCursor(listRef, keys, cursor, setCursor);
  useEffect(() => {
    viewKeys.current = (command) => {
      const next = (direction: 1 | -1, matches: (task: AgentTask) => boolean) =>
        moveTo(
          nextKeyWhere(tasks, (task) => task.id, cursor, direction, matches) ??
            cursor,
        );
      const running = (task: AgentTask) => task.status === "running";
      switch (command) {
        case "down":
          moveTo(stepKey(keys, cursor, 1));
          return true;
        case "up":
          moveTo(stepKey(keys, cursor, -1));
          return true;
        case "pageDown":
          moveTo(stepKey(keys, cursor, PAGE_ROWS));
          return true;
        case "pageUp":
          moveTo(stepKey(keys, cursor, -PAGE_ROWS));
          return true;
        case "first":
          moveTo(keys[0] ?? null);
          return true;
        case "last":
          moveTo(keys[keys.length - 1] ?? null);
          return true;
        case "nextRunning":
          next(1, running);
          return true;
        case "previousRunning":
          next(-1, running);
          return true;
        case "nextFailed":
          next(1, taskNeedsAttention);
          return true;
        case "previousFailed":
          next(-1, taskNeedsAttention);
          return true;
        case "open":
        case "toggle":
          if (cursor !== null) onOpen(cursor);
          return true;
        default:
          return false;
      }
    };
    return () => {
      viewKeys.current = null;
    };
  });
  return (
    <ul
      ref={listRef}
      className="agent-tasks-list"
      onScroll={(event) => {
        place.listScroll = event.currentTarget.scrollTop;
      }}
    >
      {tasks.map((task) => (
        <li key={task.id}>
          <button
            type="button"
            data-nav-key={task.id}
            className={`agent-tasks-row is-${task.status}${task.id === cursor ? " is-cursor" : ""}`}
            onFocus={() => setCursor(task.id)}
            onClick={() => onOpen(task.id)}
          >
            <TaskIcon task={task} />
            <span className="agent-tasks-title">
              <strong>
                {task.name ? `${task.name}: ` : ""}
                {task.title}
              </strong>
              {task.detail ? <small>{task.detail}</small> : null}
            </span>
            <span className={`agent-task-status is-${task.status}`}>
              {task.status === "running" ? <StateIcon state="running" /> : null}
              {taskStatusLabel(task)}
            </span>
            <span className="agent-tasks-time">{taskElapsed(task, now)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TaskDetail({
  pane,
  task,
  now,
  place,
  viewKeys,
}: {
  pane: Pane;
  task: AgentTask;
  now: number;
  /** Where it was left: restored on mount, kept up to date. */
  place: TaskPlace;
  viewKeys: ViewKeysRef;
}) {
  const client = useConnectionClient();
  const rootRef = useRef<HTMLDivElement>(null);
  // In a workflow: the agent whose conversation shows, or its overview; an
  // agent no longer in the workflow gives its overview.
  const [workflowAgent, setWorkflowAgent] = useState<string | null>(() =>
    task.kind === "workflow"
      ? restoredAgent(place.workflowAgent, place.workflow)
      : null,
  );
  // What was last read shows at once, until it is read again.
  const [detail, setDetail] = useState<AgentTaskDetail | null>(() =>
    place.detail && place.detail.agent === workflowAgent
      ? (place.detail.value as AgentTaskDetail)
      : null,
  );
  // The workflow's last view: kept while an agent's conversation loads.
  const [workflow, setWorkflow] = useState<WorkflowView | null>(
    () => place.workflow ?? null,
  );
  const [error, setError] = useState("");
  const outputRef = useRef<HTMLPreElement>(null);
  const followOutput = useRef(true);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const running = task.status === "running";
  // The workflow overview's state, kept while one of its agents shows.
  const [cursor, setCursor] = useState<string | null>(() => place.cursor);
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(place.folds),
  );
  // Following stays as the reader left it; it starts on while it runs.
  const [follow, setFollow] = useState(() => place.follow ?? running);
  useEffect(() => {
    place.workflowAgent = workflowAgent;
    place.cursor = cursor;
    place.folds = [...folds];
    place.follow = follow;
  }, [place, workflowAgent, cursor, folds, follow]);
  // The scroll to go back to: of the content shown on return, and of the
  // overview, once each has something to scroll.
  const pendingContent = useRef(
    place.content && place.content.agent === workflowAgent
      ? place.content
      : null,
  );
  const pendingOverview = useRef<number | null>(
    workflowAgent ? null : place.scroll,
  );
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const result = (await client.call("agent_task.get", {
          pane_id: pane.pane_id,
          workspace_id: pane.workspace_id,
          tab_id: pane.tab_id,
          agent: pane.agent,
          task_id: task.id,
          ...(workflowAgent ? { agent_id: workflowAgent } : {}),
        })) as AgentTaskDetail;
        if (!live) return;
        setDetail(result);
        place.detail = { agent: workflowAgent, value: result };
        if (result.workflow) {
          setWorkflow(result.workflow);
          place.workflow = result.workflow;
        }
        setError("");
      } catch (caught) {
        if (!live) return;
        const message =
          caught instanceof Error ? caught.message : String(caught);
        // An agent the workflow no longer has: back to its overview.
        if (workflowAgent && /Unknown workflow agent/.test(message)) {
          pendingContent.current = null;
          setDetail(null);
          setWorkflowAgent(null);
          return;
        }
        setError(message);
      }
      // Followed while it runs; read once when it has ended.
      if (live && running) timer = window.setTimeout(load, DETAIL_POLL_MS);
    };
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [client, pane, place, running, task.id, workflowAgent]);
  // The output follows its end, as a terminal does, unless scrolled up.
  useEffect(() => {
    const pre = outputRef.current;
    if (pre && followOutput.current) pre.scrollTop = pre.scrollHeight;
  }, [detail?.output]);
  const items = useMemo(
    () => groupHistoryChatItems(detail?.entries ?? []),
    [detail?.entries],
  );
  const openAgent = useCallback((agentId: string) => {
    pendingContent.current = null;
    setDetail(null);
    setWorkflowAgent(agentId);
  }, []);
  const closeAgent = useCallback(() => {
    if (!workflowAgent) return;
    pendingContent.current = null;
    pendingOverview.current = place.scroll;
    setCursor(agentKey(workflowAgent));
    setDetail(null);
    setWorkflowAgent(null);
  }, [place, workflowAgent]);
  const conversation =
    task.kind === "agent" ||
    task.kind === "teammate" ||
    (task.kind === "workflow" && !!workflowAgent);
  const overview = task.kind === "workflow" && !workflowAgent;
  // Back where it was: the conversation or output once it shows, at its
  // end or at the same place; the overview once its rows show.
  const hasContent = conversation
    ? items.length > 0
    : detail?.output !== undefined;
  useLayoutEffect(() => {
    const saved = pendingContent.current;
    const element = conversation ? listRef.current : outputRef.current;
    if (overview || !saved || !element || !hasContent) return;
    pendingContent.current = null;
    element.scrollTop = scrollTarget(saved, element);
    if (!conversation) followOutput.current = saved.atEnd;
    // The conversation's own following reads where it now is.
    element.dispatchEvent(new Event("scroll"));
  }, [conversation, overview, hasContent]);
  useLayoutEffect(() => {
    const top = pendingOverview.current;
    if (!overview || top === null || !workflow || !rootRef.current) return;
    pendingOverview.current = null;
    rootRef.current.scrollTop = top;
  }, [overview, workflow]);
  const saveContentScroll = (element: HTMLElement | null) => {
    if (element && element.clientHeight > 0)
      place.content = { ...readScroll(element), agent: workflowAgent };
  };
  // Keys for an output or a conversation; the overview registers its own.
  useEffect(() => {
    if (task.kind === "workflow" && !workflowAgent) return;
    viewKeys.current = (command) => {
      if (command === "back" && workflowAgent) {
        closeAgent();
        return true;
      }
      if (conversation) return scrollKeys(listRef.current, command);
      if (command === "follow" || command === "last")
        followOutput.current = true;
      return scrollKeys(outputRef.current, command);
    };
    return () => {
      viewKeys.current = null;
    };
  });
  const agentLabel = workflowAgent
    ? workflow?.phases
        .flatMap((phase) => phase.agents)
        .find((agent) => agent.agentId === workflowAgent)?.label
    : undefined;
  return (
    <div
      ref={rootRef}
      className="agent-task-detail"
      onScroll={(event) => {
        if (overview) place.scroll = event.currentTarget.scrollTop;
      }}
    >
      <div className="agent-task-meta">
        <span className={`agent-task-status is-${task.status}`}>
          {running ? <StateIcon state="running" /> : null}
          {taskStatusLabel(task)}
        </span>
        <span>{taskElapsed(task, now)}</span>
        {task.kind === "agent" && task.detail ? (
          <span>{task.detail}</span>
        ) : null}
      </div>
      {task.kind !== "agent" && task.detail ? (
        <code className="agent-task-command">{task.detail}</code>
      ) : null}
      {workflowAgent ? (
        <button type="button" className="agent-task-back" onClick={closeAgent}>
          <ChevronLeft size={14} aria-hidden="true" />
          {agentLabel
            ? `${agentLabel}: back to the workflow`
            : "Back to the workflow"}
        </button>
      ) : null}
      {task.summary && !running && !workflowAgent ? (
        <p className="agent-task-summary">{task.summary}</p>
      ) : null}
      {error ? <p className="agent-tasks-empty">{error}</p> : null}
      {task.kind === "workflow" && !workflowAgent ? (
        <WorkflowOverview
          workflow={workflow}
          loaded={!!detail || !!workflow}
          running={running}
          now={now}
          cursor={cursor}
          setCursor={setCursor}
          folds={folds}
          setFolds={setFolds}
          follow={follow}
          setFollow={setFollow}
          viewKeys={viewKeys}
          onOpenAgent={openAgent}
        />
      ) : conversation ? (
        items.length ? (
          <div
            className="agent-task-conversation"
            onScrollCapture={() => saveContentScroll(listRef.current)}
          >
            <AgentHistoryChat
              items={items}
              listRef={listRef}
              contentRef={contentRef}
              onOpen={() => {}}
            />
          </div>
        ) : (
          <p className="agent-tasks-empty">
            {detail ? "No conversation recorded for it." : "Loading..."}
          </p>
        )
      ) : (
        <pre
          ref={outputRef}
          className="agent-task-output"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: scrolled by keys
          tabIndex={0}
          onScroll={(event) => {
            const pre = event.currentTarget;
            followOutput.current =
              pre.scrollHeight - pre.scrollTop - pre.clientHeight <
              OUTPUT_FOLLOW_PX;
            saveContentScroll(pre);
          }}
        >
          {detail
            ? detail.output || (running ? "No output yet." : "No output.")
            : "Loading..."}
        </pre>
      )}
    </div>
  );
}

const NO_PHASES: WorkflowView = { phases: [] };

/**
 * A workflow's phases in order, each with its progress and its agents: the
 * running phase open, done ones folded, failures marked. Following moves
 * the cursor to the running agent until the reader moves or scrolls.
 */
function WorkflowOverview({
  workflow,
  loaded,
  running,
  now,
  cursor,
  setCursor,
  folds,
  setFolds,
  follow,
  setFollow,
  viewKeys,
  onOpenAgent,
}: {
  workflow: WorkflowView | null;
  loaded: boolean;
  running: boolean;
  now: number;
  cursor: string | null;
  setCursor: (key: string | null) => void;
  folds: ReadonlyMap<string, boolean>;
  setFolds: (folds: ReadonlyMap<string, boolean>) => void;
  follow: boolean;
  setFollow: (follow: boolean) => void;
  viewKeys: ViewKeysRef;
  onOpenAgent: (agentId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const view = workflow ?? NO_PHASES;
  const rows = useMemo(() => workflowRows(view, folds), [view, folds]);
  const keys = useMemo(() => rows.map((row) => row.key), [rows]);
  const shown = shownKey(view, rows, cursor);
  const { moveTo, programmatic } = useRowCursor(
    containerRef,
    keys,
    shown,
    setCursor,
  );
  const progress = workflowProgress(view);
  const target = running && follow ? followTarget(view, cursor) : null;

  const fold = useCallback(
    (key: string, folded: boolean) => {
      const next = new Map(folds);
      next.set(key, folded);
      setFolds(next);
    },
    [folds, setFolds],
  );
  /** Puts an agent in view, unfolding its phase. */
  const reveal = useCallback(
    (key: string) => {
      if (!key.startsWith("agent:")) return;
      const phase = phaseOfAgent(view, key.slice("agent:".length));
      if (phase >= 0 && isPhaseCollapsed(view, phase, folds))
        fold(phaseKey(view.phases[phase]!, phase), false);
    },
    [view, folds, fold],
  );

  // Following: the cursor goes to the running agent as the run goes on,
  // and the list scrolls to keep it in sight.
  useEffect(() => {
    if (!target) return;
    if (target !== shown) {
      reveal(target);
      const container = containerRef.current;
      const active = document.activeElement;
      // The focus moves with it unless the reader put it elsewhere.
      if (
        active === null ||
        active === document.body ||
        container?.contains(active) ||
        active === container?.closest(".agent-tasks-sheet")
      )
        moveTo(target);
      else setCursor(target);
      return;
    }
    rowElement(containerRef.current, target)?.scrollIntoView({
      block: "nearest",
    });
  }, [target, shown, rows, reveal, moveTo, setCursor]);

  useEffect(() => {
    const allAgents = view.phases.flatMap((phase) => phase.agents);
    viewKeys.current = (command) => {
      const row = rows.find((each) => each.key === shown);
      const go = (key: string | null) => {
        setFollow(false);
        if (key === null) return;
        reveal(key);
        moveTo(key);
      };
      const nextAgent = (
        direction: 1 | -1,
        matches: (agent: WorkflowAgentView) => boolean,
      ) =>
        go(
          nextKeyWhere(
            allAgents,
            (agent) => agentKey(agent.agentId),
            cursor,
            direction,
            matches,
          ),
        );
      switch (command) {
        case "down":
          go(stepKey(keys, shown, 1));
          return true;
        case "up":
          go(stepKey(keys, shown, -1));
          return true;
        case "pageDown":
          go(stepKey(keys, shown, PAGE_ROWS));
          return true;
        case "pageUp":
          go(stepKey(keys, shown, -PAGE_ROWS));
          return true;
        case "first":
          go(keys[0] ?? null);
          return true;
        case "last":
          go(keys[keys.length - 1] ?? null);
          return true;
        case "nextRunning":
          nextAgent(1, (agent) => agent.state === "running");
          return true;
        case "previousRunning":
          nextAgent(-1, (agent) => agent.state === "running");
          return true;
        case "nextFailed":
          nextAgent(1, (agent) => agent.state === "failed");
          return true;
        case "previousFailed":
          nextAgent(-1, (agent) => agent.state === "failed");
          return true;
        case "follow":
          setFollow(!follow);
          return true;
        case "open":
          if (row?.kind === "agent") onOpenAgent(row.agent.agentId);
          else if (row?.kind === "phase") {
            setFollow(false);
            if (isPhaseCollapsed(view, row.phase, folds)) fold(row.key, false);
            else go(stepKey(keys, row.key, 1));
          }
          return true;
        case "toggle":
          if (row?.kind === "phase") {
            setFollow(false);
            fold(row.key, !isPhaseCollapsed(view, row.phase, folds));
          } else if (row?.kind === "agent") onOpenAgent(row.agent.agentId);
          return true;
        case "left":
          if (row?.kind === "agent") {
            const phase = view.phases[row.phase];
            if (phase && rows.some((each) => each.kind === "phase"))
              go(phaseKey(phase, row.phase));
          } else if (
            row?.kind === "phase" &&
            !isPhaseCollapsed(view, row.phase, folds)
          ) {
            setFollow(false);
            fold(row.key, true);
          }
          return true;
        default:
          return false;
      }
    };
    return () => {
      viewKeys.current = null;
    };
  });

  if (!loaded) return <p className="agent-tasks-empty">Loading...</p>;
  if (!view.phases.length)
    return <p className="agent-tasks-empty">No agent started yet.</p>;
  const active = progress.activePhase;
  const onRowFocus = (key: string) => {
    setCursor(key);
    if (!programmatic.current) setFollow(false);
  };
  return (
    <div
      ref={containerRef}
      className="agent-task-workflow"
      onWheel={() => setFollow(false)}
      onTouchMove={() => setFollow(false)}
    >
      <div className="agent-workflow-summary">
        <div
          className="agent-workflow-bar"
          role="progressbar"
          aria-label="Agents done"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
        >
          <span className="is-done" style={{ flexGrow: progress.done }} />
          <span className="is-failed" style={{ flexGrow: progress.failed }} />
          <span className="is-running" style={{ flexGrow: progress.running }} />
        </div>
        <div className="agent-workflow-counts">
          <span>
            <strong>
              {progress.done}/{progress.total}
            </strong>{" "}
            done
          </span>
          {progress.running ? (
            <span className="is-running">{progress.running} running</span>
          ) : null}
          {progress.failed ? (
            <span className="is-failed">{progress.failed} failed</span>
          ) : null}
          {active >= 0 && view.phases.length > 1 ? (
            <span className="agent-workflow-active">
              Phase {active + 1}/{view.phases.length}
              {view.phases[active]!.title
                ? `: ${view.phases[active]!.title}`
                : ""}
            </span>
          ) : null}
          {running ? (
            <button
              type="button"
              className={`agent-workflow-follow${follow ? " is-on" : ""}`}
              aria-pressed={follow}
              title="Follow the running agent (f)"
              onClick={() => setFollow(!follow)}
            >
              <LocateFixed size={13} aria-hidden="true" />
              Follow
            </button>
          ) : null}
        </div>
      </div>
      {rows.map((row) =>
        row.kind === "phase" ? (
          <PhaseRow
            key={row.key}
            row={row}
            view={view}
            active={row.phase === active}
            collapsed={isPhaseCollapsed(view, row.phase, folds)}
            cursor={row.key === shown}
            onFocus={() => onRowFocus(row.key)}
            onToggle={() => {
              setFollow(false);
              fold(row.key, !isPhaseCollapsed(view, row.phase, folds));
            }}
          />
        ) : (
          <AgentRow
            key={row.key}
            row={row}
            now={now}
            cursor={row.key === shown}
            followed={row.key === target}
            onFocus={() => onRowFocus(row.key)}
            onOpen={() => onOpenAgent(row.agent.agentId)}
          />
        ),
      )}
      {workflow?.result ? (
        <section className="agent-workflow-result">
          <h4>Result</h4>
          <pre className="agent-task-output">{workflow.result}</pre>
        </section>
      ) : null}
    </div>
  );
}

function PhaseRow({
  row,
  view,
  active,
  collapsed,
  cursor,
  onFocus,
  onToggle,
}: {
  row: Extract<WorkflowRow, { kind: "phase" }>;
  view: WorkflowView;
  active: boolean;
  collapsed: boolean;
  cursor: boolean;
  onFocus: () => void;
  onToggle: () => void;
}) {
  const phase = view.phases[row.phase]!;
  const progress = agentsProgress(phase.agents);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      data-nav-key={row.key}
      className={`agent-workflow-phase is-${progress.state}${active ? " is-active" : ""}${cursor ? " is-cursor" : ""}`}
      aria-expanded={!collapsed}
      onFocus={onFocus}
      onClick={onToggle}
    >
      <Chevron size={14} aria-hidden="true" />
      <StateIcon state={progress.state} />
      <span className="agent-workflow-phase-title">
        <span className="agent-workflow-phase-number">{row.phase + 1}.</span>{" "}
        {phase.title || "Agents"}
      </span>
      {progress.failed ? (
        <span className="agent-task-status is-failed">
          {progress.failed} failed
        </span>
      ) : null}
      <span className="agent-workflow-phase-count">
        {progress.done}/{progress.total}
      </span>
      <span className="agent-workflow-phase-bar" aria-hidden="true">
        <span
          style={{
            width: `${progress.total ? (100 * progress.done) / progress.total : 0}%`,
          }}
        />
      </span>
    </button>
  );
}

function AgentRow({
  row,
  now,
  cursor,
  followed,
  onFocus,
  onOpen,
}: {
  row: Extract<WorkflowRow, { kind: "agent" }>;
  now: number;
  cursor: boolean;
  followed: boolean;
  onFocus: () => void;
  onOpen: () => void;
}) {
  const { agent } = row;
  const elapsed = agentElapsedMs(agent, now);
  const quiet = agentQuietMs(agent, now);
  return (
    <button
      type="button"
      data-nav-key={row.key}
      className={`agent-workflow-agent is-${agent.state}${cursor ? " is-cursor" : ""}${followed ? " is-followed" : ""}`}
      onFocus={onFocus}
      onClick={onOpen}
    >
      <StateIcon state={agent.state} />
      <span className="agent-tasks-title">
        <strong>{agent.label}</strong>
        {agent.resultPreview ? (
          <small className="agent-workflow-preview">
            {agent.resultPreview}
          </small>
        ) : null}
      </span>
      <span className="agent-workflow-times">
        {elapsed !== undefined ? (
          <span className="agent-tasks-time">{formatDuration(elapsed)}</span>
        ) : null}
        {quiet !== undefined ? (
          <span className="agent-workflow-quiet">
            quiet {formatDuration(quiet)}
          </span>
        ) : null}
      </span>
    </button>
  );
}
