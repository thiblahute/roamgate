import { ChevronDown } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { workspaceRepoDirs } from "../changesRepo";
import type { InspectorCommand } from "../inspectorCommands";
import { useReviewState } from "../review";
import type { ReviewSnapshot } from "../../../shared/review";
import type { GitDiffSummaryMode } from "../gitDiffSummaryStore";
import type { WorkspaceRepo } from "../reviewModel";
import {
  repoLabel,
  scanRepos,
  workspaceRepos,
  worktreeOnly,
} from "../reviewRepos";
import { store, useStoreSelector } from "../store";
import { ThemedSelect } from "./ThemedSelect";
import "./ChangesScopeBar.css";

/*
 * Changes' scope line when it is the review (plan: review into the
 * inspector, phase 7): what is compared, said plainly, made of the controls
 * that change it, in every layout: the repository (the workspace's, as the
 * review pane's picker lists them: p, ( and )), the scope (the working
 * tree, the branch against its base, the agent's last step) and the base.
 */

/** The workspace's panes' directories, and its agents'. */
export function useWorkspaceRepoDirs(workspaceId: string): {
  dirs: string[];
  agentDirs: string[];
} {
  const panes = useStoreSelector((state) => state.panes);
  return useMemo(
    () =>
      workspaceRepoDirs(
        panes.filter((pane) => pane.workspace_id === workspaceId),
      ),
    [panes, workspaceId],
  );
}

/**
 * The workspace's repositories, as the review pane lists them: those its
 * panes' directories hold (and their subprojects), those its agents edit
 * (`dirs`, `agentDirs`: useWorkspaceRepoDirs), and those with a review;
 * scanned while `shown`.
 */
export function useChangesRepos(
  connectionId: string,
  workspaceId: string,
  ownRoot: string | undefined,
  shown: boolean,
  {
    dirs,
    agentDirs,
  }: { dirs: readonly string[]; agentDirs: readonly string[] },
): WorkspaceRepo[] {
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

/**
 * Changes' series (plan phases 7 and 8): the workspace's repositories as
 * the review pane goes through them, `p` (`:repo`) searching them, `(` and
 * `)` (`:prevrepo`, `:nextrepo`) the previous and next by path, never
 * wrapping. A repository picked comes with whether it has only uncommitted
 * work (its Working scope), as the review pane opens its worktree review.
 */
export function useChangesSeries({
  repos,
  shownRoot,
  onPick,
}: {
  repos: readonly WorkspaceRepo[];
  shownRoot: string | undefined;
  onPick: (root: string, worktree: boolean) => void;
}): {
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
  pick: (root: string) => void;
  step: (step: number) => void;
  commands: InspectorCommand[];
} {
  const [pickerOpen, setPickerOpen] = useState(false);
  const say = (message: string) =>
    store.notify({ kind: "info", message, autoDismissMs: 1800 });
  const pick = (root: string) => {
    const repo = repos.find((each) => each.root === root);
    onPick(root, repo ? worktreeOnly(repo) : false);
  };
  const step = (by: number) => {
    const at = repos.findIndex((repo) => repo.root === shownRoot);
    const next = repos[at + by];
    if (next && at >= 0) pick(next.root);
    else
      say(
        repos.length < 2
          ? "This workspace has a single repository here."
          : by > 0
            ? "The last repository"
            : "The first repository",
      );
  };
  return {
    pickerOpen,
    setPickerOpen,
    pick,
    step,
    commands: [
      {
        name: "repo",
        aliases: ["p"],
        description: "the workspace's repositories, searched as you type (p)",
        run: () => {
          if (repos.length < 2) {
            say("This workspace has a single repository here.");
            return;
          }
          setPickerOpen(true);
        },
      },
      {
        name: "nextrepo",
        description: "the next repository ())",
        run: () => step(1),
      },
      {
        name: "prevrepo",
        description: "the previous repository (()",
        run: () => step(-1),
      },
    ],
  };
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
  mode: GitDiffSummaryMode;
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

/**
 * A merge or pull request's review, as a phone's line names it: its number
 * and title ("!3326 rtpgccbwe: Fix ..."); undefined for any other review.
 */
export function changesReviewShortLabel(
  mergeRequest: { url: string; title: string } | undefined,
): string | undefined {
  if (!mergeRequest) return undefined;
  const gitlab = /\/-\/merge_requests\/(\d+)/.exec(mergeRequest.url);
  const github = /\/pull\/(\d+)/.exec(mergeRequest.url);
  const number = gitlab ? `!${gitlab[1]}` : github ? `#${github[1]}` : "";
  const title = mergeRequest.title.trim();
  return [number, title].filter(Boolean).join(" ") || undefined;
}

/** The scope's choice, as the line says it. */
export function changesScopeChoice(
  mode: GitDiffSummaryMode,
  branch: string | undefined,
  base: string | undefined,
): string {
  if (mode === "branch-main")
    return `${branch ? `branch ${branch}` : "this branch"} vs ${base || "its base"}`;
  if (mode === "last-step")
    return "Last step: what the agent's last step changed";
  return "Working tree: uncommitted changes";
}

/**
 * What the scope picker offers: the review shown, the working changes, the
 * branch against its automatic base and each other base, and Last step,
 * which a review from elsewhere does not have (no step of another
 * repository is taken).
 */
export function changesScopeOptions({
  review,
  branch,
  base,
  baseBranch,
  baseBranches,
  elsewhere,
}: {
  review?: { label: string } | undefined;
  branch?: string | undefined;
  base?: string | undefined;
  baseBranch: string;
  baseBranches: readonly string[];
  elsewhere: boolean;
}) {
  const branchValue = (each: string) => `branch:${each}`;
  return [
    ...(review
      ? [{ value: "review", label: review.label, detail: "the review shown" }]
      : []),
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
    // Last step is the workspace's own agent's work: no step of another
    // repository's (a review from elsewhere) is taken.
    ...(elsewhere
      ? []
      : [
          {
            value: "last-step",
            label: changesScopeChoice("last-step", branch, base),
          },
        ]),
  ];
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
  review,
  elsewhere = false,
  request,
}: {
  repos: readonly WorkspaceRepo[];
  /** The repository shown. */
  root: string | undefined;
  repoName: string | undefined;
  mode: GitDiffSummaryMode;
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
  onScope: (mode: GitDiffSummaryMode) => void;
  onBase: (branch: string) => void;
  /** A choice made: the keys back to the diff. */
  onDone: () => void;
  /**
   * A review shown as the scope (a range or compare opened by name): its
   * name, and the files of the view shown.
   */
  review?: {
    label: string;
    files?: number | undefined;
    /** Its name on a phone (changesReviewShortLabel). */
    short?: string | undefined;
  };
  /**
   * A review of a repository this workspace does not hold (its workspace
   * gone, an agent's without one), shown here all the same (D3).
   */
  elsewhere?: boolean;
  /** The shown review's own pull or merge request, as a chip. */
  request?: ReactNode;
}) {
  const name = repoName || root?.split("/").pop() || "Repository";
  const branchValue = (each: string) => `branch:${each}`;
  const scopeOptions = changesScopeOptions({
    review,
    branch,
    base,
    baseBranch,
    baseBranches,
    elsewhere,
  });
  const scopeValue = review
    ? "review"
    : mode === "branch-main"
      ? branchValue(baseBranch)
      : mode;
  const facts = review
    ? review.files === undefined
      ? ""
      : `${review.files} file${review.files === 1 ? "" : "s"}`
    : changesScopeFacts({ mode, commits, files, untracked });
  const label = `${name}${elsewhere ? " (from elsewhere)" : ""} · ${review ? review.label : changesScopeChoice(mode, branch, base)}${facts ? ` · ${facts}` : ""}`;
  return (
    <div className="changes-scope-bar" title={label} aria-label={label}>
      {elsewhere ? (
        <>
          <strong
            className="changes-scope-name"
            title={`${name}, from elsewhere: not a repository of this workspace (${root ?? ""}). Git actions are not offered here.`}
          >
            {name}
            <span
              className="changes-scope-elsewhere"
              aria-label="from elsewhere"
            >
              {" ↗"}
            </span>
          </strong>
        </>
      ) : repos.length > 1 ? (
        <>
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
          <span className="changes-scope-hint">
            {repos.length} repositories in this workspace; p searches, ( )
            switch
          </span>
        </>
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
        {...(review?.short
          ? {
              // Both names: the line shows the full one, a phone's the short.
              icon: (
                <>
                  <span className="themed-select-value changes-scope-value">
                    <span className="changes-scope-full">{review.label}</span>
                    <span className="changes-scope-short">{review.short}</span>
                  </span>
                  <ChevronDown size={13} aria-hidden="true" />
                </>
              ),
            }
          : {})}
        options={scopeOptions}
        onChange={(value) => {
          if (value === "review") return;
          if (value.startsWith("branch:")) {
            onBase(value.slice("branch:".length));
            onScope("branch-main");
          } else onScope(value as GitDiffSummaryMode);
        }}
        onSelectedClose={onDone}
      />
      <span className="changes-scope-facts">{facts}</span>
      {request}
    </div>
  );
}
