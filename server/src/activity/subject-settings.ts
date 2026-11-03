import { parseWorkspaceTree } from "../../../shared/workspaceTree";
import { normalizeActivitySettings } from "../config/gui-settings";
import { treeExplicitGroups } from "./subject-tree";
import { type SubjectOf, subjectResolver } from "./subjects";

/**
 * The subjects settings.json gives: the Workspaces tree's groups, then the
 * folders under `activity.subject_roots`. Takes the file's raw content, so
 * the command line reads it the way the server does.
 */
export function subjectsFromSettings(raw: unknown): SubjectOf {
  const settings =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const activity = normalizeActivitySettings(settings.activity);
  const tree =
    settings.workspace_tree === undefined
      ? null
      : parseWorkspaceTree(settings.workspace_tree);
  return subjectResolver({
    roots: activity.subject_roots,
    explicit: tree?.nodes.length ? treeExplicitGroups(tree) : undefined,
  });
}
