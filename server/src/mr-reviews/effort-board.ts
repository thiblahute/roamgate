import type { MrEffort, MrInboxEntry, MrPlan } from "../../../shared/mrReviews";
import { requestOfBranch, type UpstreamBranch } from "./upstream";

/**
 * The inbox entry of each planned request of an effort, for its Board:
 * the request its part's branch is (by the branch's name, else by the
 * patch ids of its commits, as the inbox links branches), else that
 * branch's own row (not proposed yet). A part whose checkout was not read
 * (not ahead of its target, not headed upstream) is found by its branch's
 * name among the user's requests. Nothing here asks a forge: the entries
 * are the inbox's as computed.
 */
export function effortPlanEntries(input: {
  effort: Pick<MrEffort, "group">;
  plans: readonly MrPlan[];
  branches: readonly UpstreamBranch[];
  entries: readonly MrInboxEntry[];
  patchIds: ReadonlyMap<string, ReadonlySet<string>>;
}): Record<string, MrInboxEntry> {
  const requests = input.entries.filter(
    (entry) => !entry.branch && !entry.unavailable,
  );
  const byKey = new Map(input.entries.map((entry) => [entry.key, entry]));
  // The effort's project: the target its branches are compared with.
  const projects = new Set(
    input.branches
      .filter((branch) => branch.member.group === input.effort.group)
      .map(
        (branch) =>
          `${branch.provider}:${branch.host.toLowerCase()}/${branch.project.toLowerCase()}`,
      ),
  );
  const inProject = (entry: MrInboxEntry) =>
    !projects.size ||
    projects.has(
      `${entry.provider}:${entry.host.toLowerCase()}/${entry.project.toLowerCase()}`,
    );
  const out: Record<string, MrInboxEntry> = {};
  for (const plan of input.plans) {
    const part = plan.part;
    if (!part) continue;
    const branch =
      input.branches.find(
        (each) =>
          each.member.connectionId === part.connectionId &&
          each.member.path === part.path,
      ) ??
      input.branches.find(
        (each) =>
          each.branch === part.branch &&
          each.member.group === input.effort.group,
      );
    if (branch) {
      const request = requestOfBranch(branch, requests, input.patchIds);
      const found = request ? byKey.get(request.key) : byKey.get(branch.key);
      if (found) out[plan.id] = found;
      continue;
    }
    const named = requests.filter(
      (entry) =>
        entry.reasons.includes("authored") &&
        entry.state !== "closed" &&
        entry.sourceBranch === part.branch &&
        inProject(entry),
    );
    const found =
      named.find((entry) => entry.state === "open") ?? named[0] ?? undefined;
    if (found) out[plan.id] = found;
  }
  return out;
}
