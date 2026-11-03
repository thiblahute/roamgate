import { homedir } from "node:os";
import type { ActivityWorkspace, Subject, SubjectGroup } from "./protocol";

export type { Subject, SubjectGroup };

/**
 * A workspace's subject (docs/activity.md#subjects): the user's grouping of
 * it, by folder only. An explicit group the user made (the Workspaces tree)
 * wins; else the first directory level under a configured `subject_roots`
 * entry. Worktrees are never grouped by their repository. Computed when the
 * log is read, so a new root or group applies to past days too.
 */
export type SubjectWorkspace = Pick<
  ActivityWorkspace,
  "connection_id" | "name" | "path"
>;

/** The explicit groups holding a workspace, top first; null for none. */
export type ExplicitGroups = (
  workspace: SubjectWorkspace,
) => SubjectGroup[] | null;

export type SubjectOf = (workspace: SubjectWorkspace) => Subject | null;

/** Where a home directory can sit on a connection's host. */
const HOME_PREFIX = String.raw`(?:/Users/[^/]+|/home/[^/]+|/var/home/[^/]+|/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)`;

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimSlashes(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

type Root = { configured: string; label: string; match: RegExp[] };

function parseRoot(configured: string, home: string): Root | null {
  const root = trimSlashes(configured.trim());
  if (!root || root === "~") return null;
  const label = root.split(/[\\/]/).pop() ?? root;
  const rest = (pattern: string) =>
    new RegExp(`^${pattern}[\\\\/]([^\\\\/]+)(?:[\\\\/]|$)`);
  if (root.startsWith("~/")) {
    const tail = escape(root.slice(2)).replaceAll("/", "[\\\\/]");
    // The bridge's own home, and any user's home on another host: a root
    // under ~ means the same folder on every connection.
    return {
      configured: root,
      label,
      match: [
        rest(`${escape(trimSlashes(home))}[\\\\/]${tail}`),
        rest(`${HOME_PREFIX}[\\\\/]${tail}`),
      ],
    };
  }
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(root)) return null;
  return { configured: root, label, match: [rest(escape(root))] };
}

/**
 * The subject of each workspace. `roots` is `activity.subject_roots`;
 * `explicit` the user's groups, when Roamgate has them.
 */
export function subjectResolver(options: {
  roots: readonly string[];
  explicit?: ExplicitGroups;
  home?: string;
}): SubjectOf {
  const home = options.home ?? homedir();
  const roots = options.roots
    .map((root) => parseRoot(root, home))
    .filter((root): root is Root => root !== null)
    // The deepest root wins when roots nest.
    .sort((a, b) => b.configured.length - a.configured.length);
  return (workspace) => {
    const groups = options.explicit?.(workspace);
    if (groups?.length) {
      const nearest = groups[groups.length - 1]!;
      return {
        id: nearest.id,
        label: nearest.label,
        source: "explicit",
        path: null,
        groups,
      };
    }
    const path = workspace.path;
    if (!path) return null;
    for (const root of roots)
      for (const pattern of root.match) {
        const match = pattern.exec(path);
        if (!match) continue;
        const folder = match[1]!;
        const rootGroup = { id: `dir:${root.configured}`, label: root.label };
        const id = `dir:${root.configured}/${folder}`;
        return {
          id,
          label: folder,
          source: "directory",
          path: match[0].replace(/[\\/]$/, ""),
          groups: [rootGroup, { id, label: folder }],
        };
      }
    return null;
  };
}

/** The workspaces with their subjects. */
export function withSubjects<T extends ActivityWorkspace>(
  workspaces: T[],
  subjectOf: SubjectOf | undefined,
): T[] {
  if (!subjectOf) return workspaces;
  return workspaces.map((workspace) => ({
    ...workspace,
    subject: subjectOf(workspace),
  }));
}
