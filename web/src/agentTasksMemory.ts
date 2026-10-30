/**
 * Where the tasks sheet was left, per connection, pane and session, so that
 * closing and reopening it comes back there. Kept in the page only.
 */
import type { WorkflowView } from "../../server/src/agent/session-tasks";

/** An output's or a conversation's scroll: at its end, or where it was. */
export type ContentScroll = { top: number; atEnd: boolean };

/** Within a task: the workflow overview's state, and what showed. */
export type TaskPlace = {
  /** The workflow agent whose conversation showed, or the overview. */
  workflowAgent: string | null;
  cursor: string | null;
  /** The phases the reader folded (true) or unfolded (false). */
  folds: [string, boolean][];
  /** Following the running agent; null until the reader chose. */
  follow: boolean | null;
  /** The overview's scroll. */
  scroll: number;
  /** The output's or conversation's scroll, for the agent it was of. */
  content: (ContentScroll & { agent: string | null }) | null;
  /** The last workflow read, shown at once on return. */
  workflow?: WorkflowView;
  /** The last details read, for the agent they were of. */
  detail?: { agent: string | null; value: unknown };
};

export type SheetPlace = {
  /** The task shown, or null for the list. */
  taskId: string | null;
  /** Where going back from a task opened on its own returns. */
  returnTo: string | null;
  listCursor: string | null;
  listScroll: number;
  tasks: Map<string, TaskPlace>;
};

/** Sessions remembered at most; the oldest left go first. */
const MAX_PLACES = 50;
/** Tasks remembered at most per session. */
const MAX_TASK_PLACES = 20;
/** Within this of its end, a scroll is at the end. */
const AT_END_PX = 24;

const places = new Map<string, SheetPlace>();

export function placeKey(
  connectionId: string | null,
  paneId: string,
  session: string | null,
): string {
  return JSON.stringify([connectionId, paneId, session]);
}

/** The place for a key, made empty the first time; most recent last. */
export function sheetPlace(key: string): SheetPlace {
  let place = places.get(key);
  if (place) places.delete(key);
  else
    place = {
      taskId: null,
      returnTo: null,
      listCursor: null,
      listScroll: 0,
      tasks: new Map(),
    };
  places.set(key, place);
  while (places.size > MAX_PLACES) {
    const oldest = places.keys().next().value;
    if (oldest === undefined) break;
    places.delete(oldest);
  }
  return place;
}

export function forgetPlaces() {
  places.clear();
}

export function emptyTaskPlace(): TaskPlace {
  return {
    workflowAgent: null,
    cursor: null,
    folds: [],
    follow: null,
    scroll: 0,
    content: null,
  };
}

/** A task's place within the sheet's, made empty the first time. */
export function taskPlace(place: SheetPlace, taskId: string): TaskPlace {
  let own = place.tasks.get(taskId);
  if (own) place.tasks.delete(taskId);
  else own = emptyTaskPlace();
  place.tasks.set(taskId, own);
  while (place.tasks.size > MAX_TASK_PLACES) {
    const oldest = place.tasks.keys().next().value;
    if (oldest === undefined) break;
    place.tasks.delete(oldest);
  }
  return own;
}

type Opening = { taskId: string | null; returnTo: string | null };

/**
 * What a sheet opening shows: the task asked for, with the place left to
 * go back to beneath it, or the place left; a task gone gives the list.
 */
export function openingPlace(
  place: Pick<SheetPlace, "taskId" | "returnTo">,
  taskIds: readonly string[],
  requested: string | null,
): Opening {
  const exists = (id: string | null): id is string =>
    id !== null && taskIds.includes(id);
  if (exists(requested))
    return {
      taskId: requested,
      returnTo:
        exists(place.taskId) && place.taskId !== requested
          ? place.taskId
          : null,
    };
  const taskId = exists(place.taskId) ? place.taskId : null;
  return {
    taskId,
    returnTo:
      taskId && exists(place.returnTo) && place.returnTo !== taskId
        ? place.returnTo
        : null,
  };
}

/** Back from a task: to the place beneath it, or the list. */
export function backPlace(
  place: Pick<SheetPlace, "taskId" | "returnTo">,
  taskIds: readonly string[],
): Opening {
  const beneath = place.returnTo;
  if (beneath !== null && beneath !== place.taskId && taskIds.includes(beneath))
    return { taskId: beneath, returnTo: null };
  return { taskId: null, returnTo: null };
}

/** The workflow agent to show again, unless the workflow has no such one. */
export function restoredAgent(
  agentId: string | null,
  workflow: WorkflowView | undefined,
): string | null {
  if (agentId === null || !workflow) return agentId;
  return workflow.phases.some((phase) =>
    phase.agents.some((agent) => agent.agentId === agentId),
  )
    ? agentId
    : null;
}

type Scroller = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export function readScroll(element: Scroller): ContentScroll {
  return {
    top: element.scrollTop,
    atEnd:
      element.scrollHeight - element.scrollTop - element.clientHeight <
      AT_END_PX,
  };
}

/** Where to scroll an element back to: its end, or the same place. */
export function scrollTarget(saved: ContentScroll, element: Scroller): number {
  const end = Math.max(0, element.scrollHeight - element.clientHeight);
  return saved.atEnd ? end : Math.min(Math.max(0, saved.top), end);
}
