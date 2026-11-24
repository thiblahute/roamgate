import { Check, ChevronDown, GitBranch } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { workspaceRepoDirs } from "../changesRepo";
import {
  type CompareRefs,
  compareRefsFromNames,
  type RankedRef,
  rankCompareRefs,
  refLabel,
} from "../compareRefs";
import { matchSearch, searchTokens } from "../fuzzyMatch";
import type { InspectorCommand } from "../inspectorCommands";
import { useReviewState } from "../review";
import type { ReviewHead, ReviewSummarySession } from "../../../shared/review";
import type { GitDiffSummaryMode } from "../gitDiffSummaryStore";
import type { WorkspaceRepo } from "../reviewModel";
import {
  repoLabel,
  scanRepos,
  workspaceRepos,
  worktreeOnly,
} from "../reviewRepos";
import { store, useStoreSelector } from "../store";
import { useSystemBack } from "../systemBack";
import {
  type ActionDefinition,
  type ActionGroupDefinition,
  ActionList,
  useActionListBrowsing,
} from "./ActionList";
import { ThemedSelect } from "./ThemedSelect";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import "./ChangesScopeBar.css";

/*
 * Changes' scope line when it is the review: what is compared, said plainly,
 * made of the controls that change it, in every layout: the repository (the
 * workspace's, picked with p, ( and )), the scope (the working tree, the
 * branch against its base, the agent's last step) and the base.
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
 * The workspace's repositories: those its panes' directories hold (and their
 * subprojects), those its agents edit (`dirs`, `agentDirs`:
 * useWorkspaceRepoDirs), and those with a review; scanned while `shown`.
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
    // Without a repository of its own (its folder holds repositories
    // without being one), its panes' and agents' directories still have.
    if (!shown || (!ownRoot && !dirsKey && !agentKey)) return;
    let cancelled = false;
    void scanRepos(
      connectionId,
      [...(ownRoot ? [ownRoot] : []), ...(dirsKey ? dirsKey.split("\n") : [])],
      agentKey ? agentKey.split("\n") : [],
    ).then((repos) => {
      if (!cancelled) setScanned(repos);
    });
    return () => {
      cancelled = true;
    };
  }, [connectionId, ownRoot, dirsKey, agentKey, shown]);
  const { summaries } = useReviewState();
  return useMemo(() => {
    // The workspace's own checkout stands for the review the list is of;
    // without one, its reviews and scanned repositories alone.
    const own = {
      root: ownRoot ?? "",
      connectionId,
      workspaceId,
    } as ReviewSummarySession;
    return workspaceRepos(scanned, summaries.values(), own);
  }, [connectionId, ownRoot, scanned, summaries, workspaceId]);
}

/**
 * Whether the picker has a repository to go to: another than the one shown,
 * or any when none is (the workspace's folder is not a repository).
 */
export function hasOtherRepo(
  repos: readonly WorkspaceRepo[],
  shownRoot: string | undefined,
): boolean {
  return repos.some((repo) => repo.root !== shownRoot);
}

/**
 * Changes' series: the workspace's repositories, `p` (`:repo`) searching
 * them, `(` and `)` (`:prevrepo`, `:nextrepo`) the previous and next by path,
 * never wrapping. A repository picked comes with whether it has only
 * uncommitted work (its Working scope).
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
    const next = at < 0 ? repos[by > 0 ? 0 : repos.length - 1] : repos[at + by];
    // None shown yet (the workspace's folder is not one): the first or last.
    if (next && (at >= 0 || !shownRoot)) pick(next.root);
    else
      say(
        !hasOtherRepo(repos, shownRoot)
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
          if (!hasOtherRepo(repos, shownRoot)) {
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

/** A sha as a short name: its first 8 characters; a ref as it is. */
function shortRef(ref: string): string {
  return /^[0-9a-f]{12,40}$/i.test(ref) ? ref.slice(0, 8) : ref;
}

/**
 * A review the scope picker offers, named as what it shows: "commit
 * d2726424 Fix it" (its subject as last shown, `remembered`), "range
 * a..b", "branch topic vs main", "topic-old vs topic" for a compare, "MR
 * !12 Title", "Last step".
 */
export function workspaceReviewLabel(
  snapshot: ReviewHead | undefined,
  remembered?: string,
): string {
  if (!snapshot) return remembered ?? "A review";
  const { target, title } = snapshot.session;
  if (target.kind === "mr") {
    const short = changesReviewShortLabel(snapshot.mergeRequest);
    const gitlab = /\/-\/merge_requests\/(\d+)/.exec(target.url);
    const github = /\/pull\/(\d+)/.exec(target.url);
    return short
      ? `${gitlab ? "MR" : github ? "PR" : "MR"} ${short}`
      : gitlab
        ? `MR !${gitlab[1]}`
        : github
          ? `PR #${github[1]}`
          : `MR ${title}`;
  }
  if (target.kind === "step") return "Last step";
  if (target.kind !== "range") return remembered ?? title;
  const { base, head } = target;
  if (!target.compare && [`${head}^`, `${head}~1`, `${head}~`].includes(base)) {
    // Its subject as last shown ("d2726424 Fix it"), else its sha.
    const named =
      remembered && remembered.startsWith(head.slice(0, 8))
        ? remembered
        : shortRef(head);
    return `commit ${named}`;
  }
  if (target.compare) return `${shortRef(base)} vs ${shortRef(head)}`;
  if (/^[0-9a-f]{7,40}$/i.test(head) || head === "HEAD")
    return `range ${shortRef(base)}..${shortRef(head)}`;
  return `branch ${head} vs ${shortRef(base)}`;
}

/** The scope's choice, as the line says it. */
export function changesScopeChoice(
  mode: GitDiffSummaryMode,
  branch: string | undefined,
  base: string | undefined,
): string {
  if (mode === "branch-main")
    return `${branch ? `branch ${branch}` : "this branch"} vs ${base ? refLabel(base) : "its base"}`;
  if (mode === "last-step")
    return "Last step: what the agent's last step changed";
  return "Working tree: uncommitted changes";
}

/** How long ago `at` was, said plainly: "now", "5 min ago", "3 h ago". */
export function shownAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** A review opened lately in the workspace, as the scope picker lists it. */
export type ChangesRecentReview = {
  id: string;
  label: string;
  /** When it was last shown, said plainly ("2 h ago"). */
  when: string;
  /** Its code is gone (or its request merged) but it has open threads. */
  outdated?: boolean;
};

/**
 * What the scope picker offers: the review shown, the working changes, the
 * branch against its automatic base and each other base, and Last step,
 * which a review from elsewhere does not have (no step of another
 * repository is taken).
 */
export function changesScopeOptions({
  review,
  reviews = [],
  branch,
  base,
  baseBranch,
  baseBranches,
  elsewhere,
}: {
  review?: { label: string } | undefined;
  /** The workspace's other reviews opened lately, the latest first. */
  reviews?: readonly ChangesRecentReview[];
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
    ...reviews.map((each) => ({
      value: `review:${each.id}`,
      label: each.label,
      detail: each.outdated
        ? `outdated: its code is gone, its open threads kept · ${each.when}`
        : `opened here ${each.when}`,
    })),
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
  reviews,
  onReview,
  elsewhere = false,
  request,
  loadRefs,
  onCompare,
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
   * gone, an agent's without one), shown here all the same.
   */
  elsewhere?: boolean;
  /** The shown review's own pull or merge request, as a chip. */
  request?: ReactNode;
  /** The workspace's other reviews opened lately, offered as scopes. */
  reviews?: readonly ChangesRecentReview[];
  /** One of `reviews` picked. */
  onReview?: (sessionId: string) => void;
  /**
   * The refs the picker searches (the server's `git.refs`), read as it
   * opens; the summary's branch names until they come.
   */
  loadRefs?: () => Promise<CompareRefs>;
  /**
   * Another branch's comparison picked: `head` against `base` (short
   * names), or against its automatic base without one. Shown as a review.
   */
  onCompare?: (head: string, base: string | undefined) => void;
}) {
  const name = repoName || root?.split("/").pop() || "Repository";
  const branchValue = (each: string) => `branch:${each}`;
  const scopeOptions = changesScopeOptions({
    review,
    ...(reviews ? { reviews } : {}),
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
      ) : repos.length > 1 || hasOtherRepo(repos, root) ? (
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
          {/* The repositories' keys, said to screen readers (the title
              shows them). */}
          <span className="changes-scope-hint sr-only">
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
      <ChangesScopePicker
        value={scopeValue}
        options={scopeOptions}
        label={
          scopeOptions.find((option) => option.value === scopeValue)?.label ??
          scopeValue
        }
        {...(review?.short
          ? { short: { full: review.label, short: review.short } }
          : {})}
        branch={branch}
        baseBranches={baseBranches}
        {...(loadRefs ? { loadRefs } : {})}
        onOption={(value) => {
          if (value === "review") return;
          if (value.startsWith("review:")) {
            onReview?.(value.slice("review:".length));
            return;
          }
          if (value.startsWith("branch:")) {
            onBase(value.slice("branch:".length));
            onScope("branch-main");
          } else onScope(value as GitDiffSummaryMode);
        }}
        {...(onCompare ? { onCompare } : {})}
        onDone={onDone}
      />
      <span className="changes-scope-facts">{facts}</span>
      {request}
    </div>
  );
}

/** A ref's line under its name: why it is offered, its kind, its age. */
function rankedRefDetail(ref: RankedRef, now: number): string {
  return [
    ref.reason,
    ref.kind === "branch" ? "" : ref.kind,
    ref.date ? shownAgo(ref.date * 1000, now) : "",
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
}

/**
 * What Changes compares, picked by search: the scopes (the reviews shown
 * lately, the working tree, the branch against its automatic base, Last
 * step), then every branch, remote branch and recent tag to compare
 * against, ranked (rankCompareRefs) and searched as the workspace search
 * is. The head, the checked-out branch until another is picked, is its
 * first choice after the scopes: picking it lists the refs to review, Esc
 * back. Up / Down, then j / k, move; Enter or a tap picks; Esc closes.
 */
export function ChangesScopePicker({
  value,
  options,
  label,
  short,
  branch,
  baseBranches,
  loadRefs,
  onOption,
  onCompare,
  onDone,
}: {
  value: string;
  options: readonly { value: string; label: string; detail?: string }[];
  /** The trigger's name: the scope or review shown. */
  label: string;
  /** Both names of a review: the line shows the full one, a phone's the short. */
  short?: { full: string; short: string };
  branch: string | undefined;
  baseBranches: readonly string[];
  loadRefs?: () => Promise<CompareRefs>;
  /** One of `options` picked (`branch:REF` for a base of the branch). */
  onOption: (value: string) => void;
  onCompare?: (head: string, base: string | undefined) => void;
  /** A choice made: the keys back to the diff. */
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [side, setSide] = useState<"base" | "head">("base");
  /** The head picked, a full ref; null: the checked-out branch. */
  const [head, setHead] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<CompareRefs | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const picked = useRef(false);
  const browse = useActionListBrowsing(inputRef);
  useSystemBack(open, () => setOpen(false), "popup");
  const loadRefsRef = useRef(loadRefs);
  loadRefsRef.current = loadRefs;
  useEffect(() => {
    const load = loadRefsRef.current;
    if (!open || !load) return;
    let cancelled = false;
    load().then(
      (refs) => {
        if (!cancelled) setLoaded(refs);
      },
      // The summary's branch names stay offered.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [open]);
  const refs = loaded ?? compareRefsFromNames(baseBranches, branch);
  const current = refs.current ?? (branch ? `refs/heads/${branch}` : undefined);
  const headRef = head ?? current;
  const headLabel = headRef ? refLabel(headRef) : "HEAD";
  const otherHead = head !== null && head !== current;
  const now = Date.now();
  const tokens = searchTokens(search);
  const searched = (title: string, detail: string | undefined) => {
    if (!tokens.length) return {};
    const match = matchSearch(tokens, [title, detail]);
    return match ? { titleHighlights: match.highlights[0] ?? [] } : null;
  };
  const close = () => {
    picked.current = true;
    setOpen(false);
  };
  const changeSearch = (next: string) => {
    setSearch(next);
    browse.searched();
  };
  const pickSide = (next: "base" | "head") => {
    setSide(next);
    changeSearch("");
    inputRef.current?.focus({ preventScroll: true });
  };
  const refAction = (
    ref: RankedRef,
    run: () => void,
    checked = false,
  ): ActionDefinition => ({
    key: `ref:${ref.name}`,
    icon: checked ? (
      <Check size={14} aria-hidden="true" />
    ) : (
      <GitBranch size={14} aria-hidden="true" />
    ),
    title: ref.label,
    ...(ref.highlights ? { titleHighlights: ref.highlights } : {}),
    detail: rankedRefDetail(ref, now) || undefined,
    run,
  });
  const groups: ActionGroupDefinition[] = [];
  if (side === "head") {
    groups.push({
      heading: "Head: the branch to review",
      actions: rankCompareRefs(refs, search, { withCurrent: true }).map((ref) =>
        refAction(
          ref,
          () => {
            setHead(ref.name === current ? null : ref.name);
            pickSide("base");
          },
          ref.name === headRef,
        ),
      ),
    });
  } else {
    const scopes: ActionDefinition[] = (
      otherHead
        ? [
            {
              value: "compare:",
              label: `branch ${headLabel} vs its base`,
              detail: "against its base, found automatically",
            },
          ]
        : // Bases of the branch are the refs below, searched.
          options.filter(
            (option) =>
              !option.value.startsWith("branch:") || option.value === "branch:",
          )
    ).flatMap((option) => {
      const match = searched(option.label, option.detail);
      if (!match) return [];
      return [
        {
          key: option.value,
          icon:
            option.value === value && !otherHead ? (
              <Check size={14} aria-hidden="true" />
            ) : null,
          title: option.label,
          ...match,
          ...(option.detail ? { detail: option.detail } : {}),
          run: () => {
            close();
            if (option.value === "compare:") onCompare?.(headLabel, undefined);
            else onOption(option.value);
          },
        },
      ];
    });
    if (onCompare) {
      const title = `Head: ${headLabel}`;
      const detail = "pick another branch to compare";
      const match = searched(title, detail);
      if (match)
        scopes.push({
          key: "head",
          title,
          ...match,
          detail,
          run: () => pickSide("head"),
        });
    }
    if (scopes.length) groups.push({ heading: "", actions: scopes });
    groups.push({
      heading: `Compare ${headLabel} against`,
      actions: rankCompareRefs(refs, search, {
        exclude: headRef,
        // Another head: the checked-out branch is a base like any.
        withCurrent: otherHead,
      }).map((ref) =>
        refAction(
          ref,
          () => {
            close();
            // The checked-out branch against a branch: its Branch scope.
            if (!otherHead && ref.kind !== "tag")
              onOption(`branch:${ref.name}`);
            else onCompare?.(headLabel, ref.label);
          },
          !otherHead && value === `branch:${ref.name}`,
        ),
      ),
    });
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          picked.current = false;
          setSearch("");
          setSide("base");
          setHead(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="themed-select-trigger changes-scope-mode"
          aria-label="What Changes compares"
          title="What Changes compares (:working, :branch, :last); search a branch to compare against"
        >
          <span className="themed-select-value changes-scope-value">
            {short ? (
              <>
                <span className="changes-scope-full">{short.full}</span>
                <span className="changes-scope-short">{short.short}</span>
              </>
            ) : (
              label
            )}
          </span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="themed-select-content changes-scope-picker"
        align="start"
        collisionPadding={8}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          if (picked.current) {
            event.preventDefault();
            onDone();
          }
          picked.current = false;
        }}
        onEscapeKeyDown={(event) => {
          event.stopPropagation();
          // Picking the head: Esc goes back to the bases.
          if (side === "head") {
            event.preventDefault();
            pickSide("base");
          }
        }}
      >
        <ActionList
          className="changes-scope-picker-list"
          label="What Changes compares"
          groups={groups}
          search={search}
          onSearch={changeSearch}
          onRun={(action) => action.run?.()}
          placeholder={
            side === "head"
              ? "Head: search the branch to review"
              : `Compare ${headLabel} against: search a branch or tag`
          }
          emptyText={
            loaded || !loadRefs ? "Nothing matches." : "Reading the branches..."
          }
          // Ranked already: shown in this order.
          rank={() => 1}
          topResults={false}
          inputRef={inputRef}
          onKeyDown={browse.onKeyDown}
        />
      </PopoverContent>
    </Popover>
  );
}
