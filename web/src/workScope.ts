import {
  type WorkItem,
  type WorkProject,
  workPlaceScope,
  workProjectFamily,
} from "../../shared/work";

/**
 * What the Work board shows: the project of the workspace it was opened
 * from (the one whose root holds the workspace's checkout), or the one
 * chosen for that workspace, or all projects; and the tags by count, the
 * search's completions for `#tag`.
 */

/** The workspace the page shows, as the board scopes by it. */
export type WorkWorkspace = {
  connectionId: string;
  workspaceId: string;
  label: string;
  /** The checkout (a linked worktree's own path), or the working directory. */
  checkoutPath: string | null;
  /** The repository's main checkout, for a linked worktree. */
  repoRoot: string | null;
  /** Its panes' working directories (a workspace with no checkout). */
  cwds?: readonly string[];
  /** Its panes' ids: the coordinator's pane may be one. */
  paneIds?: readonly string[];
};

/** A project id, or null for every project. */
export type WorkScope = string | null;

export const WORK_SCOPE_ALL = "all";
export const WORK_SCOPE_KEY = "roamgate.work.scope";

export type WorkScopeMemory = {
  /** The last scope chosen anywhere: the global entry points' default. */
  last?: string;
  /** The scope chosen in each workspace (its key). */
  byWorkspace: Record<string, string>;
  /**
   * The workspaces whose board was widened to the whole project (their
   * workspace filter removed): their keys.
   */
  wide?: string[];
};

/** The workspace as remembered: its checkout on its connection. */
export function workspaceScopeKey(workspace: WorkWorkspace): string {
  return `${workspace.connectionId}:${workspace.checkoutPath ?? workspace.workspaceId}`;
}

/** The workspace as the board places it. */
function placeOf(workspace: WorkWorkspace) {
  return {
    connectionId: workspace.connectionId,
    label: workspace.label,
    paths: [
      workspace.checkoutPath,
      workspace.repoRoot,
      ...(workspace.cwds ?? []),
    ].filter((path): path is string => !!path),
    paneIds: workspace.paneIds ?? [],
  };
}

/**
 * The workspace's project: the one its coordinator's pane is in, else
 * the one whose root holds its checkout (or its panes' directories) the
 * most closely; null when none.
 */
export function projectForWorkspace(
  workspace: WorkWorkspace | null,
  projects: readonly WorkProject[],
): WorkProject | null {
  if (!workspace) return null;
  return workPlaceScope(placeOf(workspace), projects)?.project ?? null;
}

/**
 * The workspace filter the board opens with: the workspace's tag, when
 * the workspace belongs to the project shown (or one of its subprojects)
 * and is not its project's coordinator's (whose board is the whole
 * project). `on` says whether it applies: not once it was removed there.
 */
export function workWorkspaceFilter(options: {
  workspace: WorkWorkspace | null;
  projects: readonly WorkProject[];
  scope: WorkScope;
  memory: WorkScopeMemory;
}): { tag: string; label: string; on: boolean } | null {
  const { workspace, projects, scope, memory } = options;
  if (!workspace || !scope) return null;
  const place = workPlaceScope(placeOf(workspace), projects);
  if (!place?.tag || place.coordinator) return null;
  if (!workProjectFamily(projects, scope).includes(place.project.id))
    return null;
  return {
    tag: place.tag,
    label: workspace.label,
    on: !memory.wide?.includes(workspaceScopeKey(workspace)),
  };
}

/** The workspace filter removed (wide) or put back, for that workspace. */
export function rememberWorkWide(
  memory: WorkScopeMemory,
  workspace: WorkWorkspace,
  wide: boolean,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): WorkScopeMemory {
  const key = workspaceScopeKey(workspace);
  const rest = (memory.wide ?? []).filter((each) => each !== key);
  const next: WorkScopeMemory = {
    ...memory,
    wide: wide ? [...rest, key].slice(-200) : rest,
  };
  try {
    storage?.setItem(WORK_SCOPE_KEY, JSON.stringify(next));
  } catch {
    // Private mode: this page only.
  }
  return next;
}

function valid(
  value: string | undefined,
  projects: readonly WorkProject[],
): WorkScope | undefined {
  if (value === WORK_SCOPE_ALL) return null;
  if (value && projects.some((project) => project.id === value)) return value;
  return undefined;
}

/**
 * The scope to show: the item's project when opened on one (a
 * notification), else in a workspace the scope chosen there or the
 * project its checkout is in, else the last scope chosen, else all.
 */
export function workScopeFor(options: {
  workspace: WorkWorkspace | null;
  projects: readonly WorkProject[];
  memory: WorkScopeMemory;
  item?: WorkItem | null;
}): {
  scope: WorkScope;
  why: "item" | "chosen" | "workspace" | "last" | "all";
} {
  const { workspace, projects, memory, item } = options;
  if (item && projects.some((project) => project.id === item.project))
    return { scope: item.project, why: "item" };
  if (workspace) {
    const chosen = valid(
      memory.byWorkspace[workspaceScopeKey(workspace)],
      projects,
    );
    if (chosen !== undefined) return { scope: chosen, why: "chosen" };
    const own = projectForWorkspace(workspace, projects);
    if (own) return { scope: own.id, why: "workspace" };
  }
  const last = valid(memory.last, projects);
  if (last !== undefined) return { scope: last, why: "last" };
  return { scope: null, why: "all" };
}

export function readWorkScopeMemory(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): WorkScopeMemory {
  try {
    const raw = storage?.getItem(WORK_SCOPE_KEY);
    const value = raw ? (JSON.parse(raw) as Partial<WorkScopeMemory>) : null;
    const byWorkspace: Record<string, string> = {};
    if (value?.byWorkspace && typeof value.byWorkspace === "object")
      for (const [key, scope] of Object.entries(value.byWorkspace))
        if (typeof scope === "string") byWorkspace[key] = scope;
    const wide = Array.isArray(value?.wide)
      ? value.wide.filter((key): key is string => typeof key === "string")
      : [];
    return {
      ...(typeof value?.last === "string" ? { last: value.last } : {}),
      byWorkspace,
      ...(wide.length ? { wide } : {}),
    };
  } catch {
    return { byWorkspace: {} };
  }
}

/** The scope chosen: for the workspace when in one, and as the last. */
export function rememberWorkScope(
  memory: WorkScopeMemory,
  workspace: WorkWorkspace | null,
  scope: WorkScope,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): WorkScopeMemory {
  const value = scope ?? WORK_SCOPE_ALL;
  const next: WorkScopeMemory = {
    ...memory,
    last: value,
    byWorkspace: workspace
      ? { ...memory.byWorkspace, [workspaceScopeKey(workspace)]: value }
      : memory.byWorkspace,
  };
  try {
    storage?.setItem(WORK_SCOPE_KEY, JSON.stringify(next));
  } catch {
    // Private mode: this page only.
  }
  return next;
}

/** The tags of the items, most used first, then by name. */
export function workTagCounts(
  items: readonly WorkItem[],
): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items)
    for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
