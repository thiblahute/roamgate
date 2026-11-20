import type { WorkItem, WorkProject } from "../../shared/work";

/**
 * What the Work board shows: the project of the workspace it was opened
 * from (the one whose root holds the workspace's checkout), or the one
 * chosen for that workspace, or all projects; and the tags as a filter
 * (a few by count, the rest behind Filters) rather than every tag at once.
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
};

/** A project id, or null for every project. */
export type WorkScope = string | null;

export const WORK_SCOPE_ALL = "all";
export const WORK_SCOPE_KEY = "roamgate.work.scope";
/** Tags shown on the row before Filters. */
export const WORK_TOP_TAGS = 8;

export type WorkScopeMemory = {
  /** The last scope chosen anywhere: the global entry points' default. */
  last?: string;
  /** The scope chosen in each workspace (its key). */
  byWorkspace: Record<string, string>;
};

/** The workspace as remembered: its checkout on its connection. */
export function workspaceScopeKey(workspace: WorkWorkspace): string {
  return `${workspace.connectionId}:${workspace.checkoutPath ?? workspace.workspaceId}`;
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root.replace(/\/+$/, "")}/`);
}

/** The project whose root holds the workspace's checkout, or null. */
export function projectForWorkspace(
  workspace: WorkWorkspace | null,
  projects: readonly WorkProject[],
): WorkProject | null {
  if (!workspace) return null;
  const paths = [workspace.checkoutPath, workspace.repoRoot].filter(
    (path): path is string => !!path,
  );
  if (!paths.length) return null;
  return (
    projects.find((project) =>
      project.roots.some(
        (root) =>
          root.connectionId === workspace.connectionId &&
          paths.some((path) => under(path, root.path)),
      ),
    ) ?? null
  );
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
    return {
      ...(typeof value?.last === "string" ? { last: value.last } : {}),
      byWorkspace,
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

/** The tags on the row: the most used ones not selected, a few. */
export function workTopTags(
  counts: readonly { tag: string; count: number }[],
  selected: readonly string[],
  limit = WORK_TOP_TAGS,
): string[] {
  return counts
    .filter(({ tag }) => !selected.includes(tag))
    .slice(0, limit)
    .map(({ tag }) => tag);
}
