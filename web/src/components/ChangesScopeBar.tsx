import { useEffect, useMemo, useState } from "react";
import { workspaceRepoDirs } from "../changesRepo";
import { useReviewState } from "../review";
import type { ReviewSnapshot } from "../../../shared/review";
import type { WorkspaceRepo } from "../reviewModel";
import { repoLabel, scanRepos, workspaceRepos } from "../reviewRepos";
import { useStoreSelector } from "../store";
import { ThemedSelect } from "./ThemedSelect";
import "./ChangesScopeBar.css";

/*
 * Changes' scope line when it is the review (plan: review into the
 * inspector, phase 7): what is compared, said plainly, made of the controls
 * that change it, in every layout: the repository (the workspace's, as the
 * review pane's picker lists them: p, ( and )), the scope (the working
 * tree, the branch against its base, the agent's last step) and the base.
 */

export type ChangesScope = "working" | "branch-main" | "last-step";

/**
 * The workspace's repositories, as the review pane lists them: those its
 * panes' directories hold (and their subprojects), those its agents edit,
 * and those with a review; scanned while `shown`.
 */
export function useChangesRepos(
  connectionId: string,
  workspaceId: string,
  ownRoot: string | undefined,
  shown: boolean,
): WorkspaceRepo[] {
  const panes = useStoreSelector((state) => state.panes);
  const { dirs, agentDirs } = useMemo(
    () =>
      workspaceRepoDirs(
        panes.filter((pane) => pane.workspace_id === workspaceId),
      ),
    [panes, workspaceId],
  );
  const dirsKey = dirs.join("\n");
  const agentKey = agentDirs.join("\n");
  const [scanned, setScanned] = useState<WorkspaceRepo[]>([]);
  useEffect(() => {
    if (!shown || !ownRoot) return;
    let cancelled = false;
    void scanRepos(
      connectionId,
      [ownRoot, ...(dirsKey ? dirsKey.split("\n") : [])],
      agentKey ? agentKey.split("\n") : [],
    ).then((repos) => {
      if (!cancelled) setScanned(repos);
    });
    return () => {
      cancelled = true;
    };
  }, [connectionId, ownRoot, dirsKey, agentKey, shown]);
  const { sessions } = useReviewState();
  return useMemo(() => {
    if (!ownRoot) return [];
    // The workspace's own checkout stands for the review the list is of.
    const own = {
      root: ownRoot,
      connectionId,
      workspaceId,
    } as ReviewSnapshot["session"];
    return workspaceRepos(scanned, sessions.values(), own);
  }, [connectionId, ownRoot, scanned, sessions, workspaceId]);
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** What the line says after its controls: the commits and the files. */
export function changesScopeFacts({
  mode,
  commits,
  files,
  untracked,
}: {
  mode: ChangesScope;
  commits?: number;
  files: number;
  untracked?: number;
}): string {
  const facts: string[] = [];
  if (mode === "branch-main" && commits !== undefined)
    facts.push(plural(commits, "commit"));
  if (!files) facts.push("no change");
  else if (mode === "working" && untracked && untracked === files)
    facts.push(`${plural(files, "file")}, all untracked`);
  else if (mode === "working" && untracked)
    facts.push(`${plural(files, "file")} (${untracked} untracked)`);
  else facts.push(plural(files, "file"));
  return facts.join(" · ");
}

/** The scope's choice, as the line says it. */
export function changesScopeChoice(
  mode: ChangesScope,
  branch: string | undefined,
  base: string | undefined,
): string {
  if (mode === "branch-main")
    return `${branch ? `branch ${branch}` : "this branch"} vs ${base || "its base"}`;
  if (mode === "last-step")
    return "Last step: what the agent's last step changed";
  return "Working tree: uncommitted changes";
}

export function ChangesScopeBar({
  repos,
  root,
  repoName,
  mode,
  branch,
  base,
  baseBranch,
  baseBranches,
  commits,
  files,
  untracked,
  pickerOpen,
  onPickerOpen,
  onPickRepo,
  onScope,
  onBase,
  onDone,
}: {
  repos: readonly WorkspaceRepo[];
  /** The repository shown. */
  root: string | undefined;
  repoName: string | undefined;
  mode: ChangesScope;
  branch?: string;
  /** The base the Branch scope compares against, resolved. */
  base?: string;
  /** Compare against: the branch picked, "" for automatic. */
  baseBranch: string;
  baseBranches: readonly string[];
  commits?: number;
  files: number;
  untracked?: number;
  pickerOpen: boolean;
  onPickerOpen: (open: boolean) => void;
  onPickRepo: (root: string) => void;
  onScope: (mode: ChangesScope) => void;
  onBase: (branch: string) => void;
  /** A choice made: the keys back to the diff. */
  onDone: () => void;
}) {
  const name = repoName || root?.split("/").pop() || "Repository";
  const branchValue = (each: string) => `branch:${each}`;
  const scopeOptions = [
    {
      value: "working",
      label: changesScopeChoice("working", branch, base),
    },
    {
      value: branchValue(""),
      label: changesScopeChoice(
        "branch-main",
        branch,
        baseBranch ? undefined : base,
      ),
      detail: "against its base, found automatically",
    },
    ...[...new Set([...baseBranches, ...(baseBranch ? [baseBranch] : [])])]
      .filter((each) => each)
      .map((each) => ({
        value: branchValue(each),
        label: changesScopeChoice("branch-main", branch, each),
        detail: "Compare against",
      })),
    {
      value: "last-step",
      label: changesScopeChoice("last-step", branch, base),
    },
  ];
  const scopeValue = mode === "branch-main" ? branchValue(baseBranch) : mode;
  const label = `${name} · ${changesScopeChoice(mode, branch, base)} · ${changesScopeFacts({ mode, commits, files, untracked })}`;
  return (
    <div className="changes-scope-bar" title={label} aria-label={label}>
      {repos.length > 1 ? (
        <ThemedSelect
          className="changes-scope-repo"
          aria-label="Repository (p; ( and ) the previous and next)"
          title="Repository (p; ( and ) the previous and next)"
          value={root ?? ""}
          placeholder={name}
          open={pickerOpen}
          onOpenChange={onPickerOpen}
          searchPlaceholder="Repository: name, branch or path"
          emptyText="No repository matches."
          options={repos.map((repo) => ({
            value: repo.root,
            label: repo.root.split("/").pop() || repo.root,
            detail:
              `${repoLabel(repo).split(" · ").slice(1).join(" · ")} ${repo.root}`.trim(),
            keywords: [repo.root, repo.branch ?? ""],
          }))}
          onChange={onPickRepo}
          onSelectedClose={onDone}
        />
      ) : (
        <strong className="changes-scope-name" title={root}>
          {name}
        </strong>
      )}
      <span className="changes-scope-sep" aria-hidden="true">
        ·
      </span>
      <ThemedSelect
        className="changes-scope-mode"
        aria-label="What Changes compares"
        title="What Changes compares (:working, :branch, :last)"
        value={scopeValue}
        options={scopeOptions}
        onChange={(value) => {
          if (value.startsWith("branch:")) {
            onBase(value.slice("branch:".length));
            onScope("branch-main");
          } else onScope(value as ChangesScope);
        }}
        onSelectedClose={onDone}
      />
      <span className="changes-scope-facts">
        {changesScopeFacts({ mode, commits, files, untracked })}
      </span>
    </div>
  );
}
