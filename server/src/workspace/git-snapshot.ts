import { STEP_SNAPSHOT_SH, fillTemplate } from "../assets"; // All writes before publication belong to one fixed, exclusively created directory.
// In particular, a killed shell must not unlink storage still used by its child.
export function worktreeSnapshotCommand(
  root: string,
  quote: (value: string) => string,
) {
  return fillTemplate(STEP_SNAPSHOT_SH, { root: quote(root) });
}
