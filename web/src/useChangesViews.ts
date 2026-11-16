import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ReviewCommit,
  ReviewDiff,
  ReviewTarget,
} from "../../shared/review";
import { reviewDiffAsChanges, stepView, viewName } from "./changesViews";
import { reviewCall } from "./review";
import { ReviewDiffs } from "./reviewDiffLoad";
import { followCommit } from "./reviewFollow";
import { type CommitChoice, commitChoices, searchCommits } from "./reviewModel";
import { findFile } from "./reviewNavigation";
import { readReviewPlace, writeReviewPlace } from "./reviewPlace";
import { store } from "./store";
import { useReloadOnReconnect } from "./useReloadOnReconnect";
import type { GitDiffEntry, GitDiffFile } from "./types";

/*
 * The review's views in Changes (plan: review into the inspector, phase
 * 6), as the review pane's commit bar has them: all the changes, or one
 * commit at a time (`<` `>`, `gc`, `:commit`, `:all`), oldest first, the
 * commit's message as a file; a branch with nothing of its own shows its
 * history, latest first. After a reload the commit shown is followed
 * through a rebase or a reword (reviewFollow.ts). The view shown is kept
 * per review (reviewPlace.ts). Reads only: a scope with no review yet is
 * read by its target (`review.diff` with no session), never opened.
 */

/** Where the views are read: the review's session, or the scope's target. */
export type ViewsSource =
  | { sessionId: string }
  | { workspaceId: string; path: string; target: ReviewTarget };

export type ChangesViews = {
  /** Whether the views apply (a review of commits shown). */
  active: boolean;
  /** The review's commits, oldest first; null until read (or none apply). */
  commits: ReviewCommit[] | null;
  /** The commits are the review shown's, read at its remembered view. */
  ready: boolean;
  /** A branch with nothing of its own: its history, latest first. */
  history: boolean;
  /** The commit shown; null for all the changes. */
  sha: string | null;
  current: ReviewCommit | null;
  /** How the bar names the view; null with no commits to step through. */
  name: { head: string; subject: string } | null;
  /**
   * The view's files when Changes' own are not what it shows (a commit, or
   * a review whose all-changes view is not the scope's).
   */
  shown: { entries: GitDiffEntry[]; files: Record<string, GitDiffFile> } | null;
  loading: boolean;
  /** What the views said last: loading a commit, why one failed. */
  status: string;
  /** The last read failed (Retry reads it again). */
  failed: boolean;
  /** The code changed since it was read: a reload shows it. */
  changed: boolean;
  /** The head the view's diff was read at (the review's, for all changes). */
  headSha: string | null;
  picker: { query: string; at: number; choices: CommitChoice[] } | null;
  /**
   * A view shown: all the changes (null) or a commit; `gone`: a commit no
   * longer in the review (a thread's, rewritten out), named as it was.
   */
  show: (
    sha: string | null,
    gone?: { subject?: string; parent?: string },
  ) => void;
  step: (direction: 1 | -1) => void;
  openPicker: (query?: string) => void;
  movePicker: (step: number) => void;
  setPickerQuery: (query: string) => void;
  pick: (choice: CommitChoice | undefined) => void;
  /** `:commit` and `:commits`: by number, words, or the picker. */
  command: (name: "commit" | "commits", argument: string) => void;
  reload: () => void;
  /**
   * A path found in no file of the view shown: the nearest other view
   * with a file whose path matches, gone to; false when none has.
   */
  searchElsewhere: (pattern: string) => Promise<string | null>;
  /**
   * A file as the view shows it (its new side: the commit's, the head's),
   * for the lines Changes reveals around a hunk.
   */
  readFile: (path: string) => Promise<string>;
};

const say = (message: string) => store.notify({ kind: "info", message });

export function useChangesViews({
  connectionId,
  source,
  enabled,
  native,
  placeKey,
  where,
}: {
  connectionId: string;
  source: ViewsSource | null;
  /** The views apply (a review of commits, on "in Changes"). */
  enabled: boolean;
  /** Changes' own files are the all-changes view (the Branch scope). */
  native: boolean;
  /** Where the view shown is remembered. */
  placeKey: string;
  where: { root: string; workspaceId: string };
}): ChangesViews {
  const active = enabled && !!source;
  const sourceKey = source ? JSON.stringify(source) : "";
  const [generation, setGeneration] = useState(0);
  const [commits, setCommits] = useState<ReviewCommit[] | null>(null);
  /** The place the commits were read for. */
  const [readFor, setReadFor] = useState("");
  const [sha, setSha] = useState<string | null>(null);
  /** A commit shown that is no longer in the review (a thread's). */
  const [goneCommit, setGoneCommit] = useState<ReviewCommit | null>(null);
  const [diff, setDiff] = useState<ReviewDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  /** Why the last read failed; null once one succeeds. */
  const [failure, setFailure] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [pickerState, setPickerState] = useState<{
    query: string;
    at: number;
  } | null>(null);
  const diffs = useRef(new ReviewDiffs<ReviewDiff>());
  const shaRef = useRef(sha);
  shaRef.current = sha;
  const commitsRef = useRef(commits);
  commitsRef.current = commits;
  /** The place was read for this review: a reload follows the view. */
  const placeRead = useRef("");

  const call = useCallback(
    <T>(method: string, params: Record<string, unknown> = {}) => {
      const from = JSON.parse(sourceKey || "{}") as ViewsSource;
      return reviewCall<T>(connectionId, method, {
        ...("sessionId" in from
          ? { session_id: from.sessionId }
          : {
              workspace_id: from.workspaceId,
              checkout: from.path,
              target: from.target,
            }),
        ...params,
      });
    },
    [connectionId, sourceKey],
  );

  // A review shown anew: its views are read anew.
  // biome-ignore lint/correctness/useExhaustiveDependencies: by its key
  useEffect(() => {
    diffs.current.clear();
    setDiff(null);
    setChanged(false);
    setPickerState(null);
    if (!active) {
      setCommits(null);
      setSha(null);
    }
  }, [active, sourceKey]);

  // The commits, the view: the one remembered, else the oldest commit; a
  // reload follows the commit shown.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const first = placeRead.current !== placeKey;
    const remembered = first ? readReviewPlace(placeKey) : null;
    const known = commitsRef.current;
    const was: {
      commit: string | null;
      subject?: string;
      index?: number;
      count?: number;
    } | null = first
      ? remembered
      : (() => {
          const shown = shaRef.current;
          const index = known?.findIndex((c) => c.sha === shown) ?? -1;
          return {
            commit: shown,
            ...(index >= 0
              ? {
                  subject: known![index]!.subject,
                  index,
                  count: known!.length,
                }
              : {}),
          };
        })();
    void call<{
      commits: ReviewCommit[];
      patchIds?: Record<string, string>;
    }>("review.commits", {
      recheck: true,
      ...(was?.commit ? { follow: was.commit } : {}),
    }).then(
      (result) => {
        if (cancelled) return;
        placeRead.current = placeKey;
        const list = result.commits;
        const start = list[0]?.sha ?? null;
        let next: string | null;
        if (!was) next = start;
        else if (was.commit === null)
          next = list[0]?.history === true ? start : null;
        else {
          const found = followCommit(
            {
              sha: was.commit,
              ...(was.subject !== undefined ? { subject: was.subject } : {}),
              ...(was.index !== undefined ? { index: was.index } : {}),
              ...(was.count !== undefined ? { count: was.count } : {}),
            },
            list,
            result.patchIds,
          );
          next = found?.sha ?? start;
          const label = found
            ? `${found.index + 1}/${list.length} ${found.sha.slice(0, 8)}`
            : "";
          if (found?.how === "nearest")
            say(`The commit you were on is gone; showing ${label}.`);
          else if (found && found.how !== "same")
            say(`Following the rewritten commit: ${label}.`);
        }
        setCommits(list);
        setReadFor(placeKey);
        setSha(next);
      },
      (error: unknown) => {
        if (cancelled) return;
        placeRead.current = placeKey;
        // Read before: the review stays on the view it shows.
        if (commitsRef.current === null) {
          setCommits([]);
          setSha(null);
        }
        const message = error instanceof Error ? error.message : String(error);
        setFailure(message);
        setStatus(`Cannot load the diff: ${message}`);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, call, generation, placeKey]);

  const index = commits?.findIndex((commit) => commit.sha === sha) ?? -1;
  const current =
    index >= 0
      ? commits![index]!
      : sha && goneCommit?.sha === sha
        ? goneCommit
        : null;
  const history = commits?.[0]?.history === true;
  /** The view comes from the review's diff, not Changes' own files. */
  const own = !active || commits === null || (sha === null && native);

  // The view's diff, when not Changes' own; the latest request wins.
  useEffect(() => {
    if (own) {
      setDiff(null);
      setLoading(false);
      return;
    }
    const request = diffs.current.begin(sha ?? "");
    if (request.cached) {
      setDiff(request.cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    if (sha) setStatus(`Loading commit ${sha.slice(0, 8)}...`);
    void call<ReviewDiff>("review.diff", sha ? { commit: sha } : {}).then(
      (loaded) => {
        if (!request.done(loaded)) return;
        setDiff(loaded);
        setStatus("");
        setFailure(null);
        setLoading(false);
      },
      (error: unknown) => {
        if (!request.current()) return;
        setLoading(false);
        const message = error instanceof Error ? error.message : String(error);
        setFailure(message);
        setStatus(`Cannot load the diff: ${message}`);
      },
    );
  }, [call, own, sha, generation]);

  // The view shown is remembered with the review.
  useEffect(() => {
    if (!active || commits === null || placeRead.current !== placeKey) return;
    const at = commits.findIndex((commit) => commit.sha === sha);
    writeReviewPlace(placeKey, {
      ...(readReviewPlace(placeKey) ?? {}),
      commit: sha,
      ...(at >= 0
        ? { subject: commits[at]!.subject, index: at, count: commits.length }
        : {}),
    });
  }, [active, commits, sha, placeKey]);

  // The code as read, checked every few seconds: a change offers a reload.
  const loadedState = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    loadedState.current = null;
    setChanged(false);
    void call<{ state: string }>("review.state").then(
      (result) => {
        if (!cancelled) loadedState.current = result.state || null;
      },
      () => {},
    );
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || document.hidden || loadedState.current === null) return;
      busy = true;
      try {
        const { state } = await call<{ state: string }>("review.state");
        if (!cancelled && state && state !== loadedState.current)
          setChanged(true);
      } catch {
      } finally {
        busy = false;
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, call, generation]);

  const shown = useMemo(
    () => (own || !diff ? null : reviewDiffAsChanges(diff, where, current)),
    [own, diff, where, current],
  );

  const choices = useMemo(
    () => commitChoices(commits ?? [], !history),
    [commits, history],
  );
  const show = useCallback(
    (next: string | null, gone?: { subject?: string; parent?: string }) => {
      setPickerState(null);
      setGoneCommit(
        next && gone
          ? {
              sha: next,
              parent: gone.parent ?? null,
              author: "",
              date: "",
              subject: gone.subject ?? next.slice(0, 8),
              body: "",
            }
          : null,
      );
      setSha(next);
    },
    [],
  );
  const openPicker = (query = "") => {
    if (choices.length < 2) {
      say("This review has a single commit.");
      return;
    }
    const listed = searchCommits(choices, query);
    setPickerState({
      query,
      at: Math.max(
        0,
        listed.findIndex((choice) => choice.sha === sha),
      ),
    });
  };
  const picked = pickerState ? searchCommits(choices, pickerState.query) : [];

  const searchElsewhere = async (pattern: string): Promise<string | null> => {
    if (!active || !commits) return null;
    const views = commits
      .map((commit) => commit.sha as string | null)
      .filter((each) => each !== sha);
    if (sha !== null && !history) views.push(null);
    for (const view of views) {
      const request = diffs.current.begin(view ?? "", { shown: false });
      let viewDiff = request.cached;
      if (!viewDiff) {
        try {
          viewDiff = await call<ReviewDiff>(
            "review.diff",
            view ? { commit: view } : {},
          );
        } catch {
          continue;
        }
        if (!request.done(viewDiff)) return null;
      }
      const at = findFile(
        viewDiff.files.map((file) => (file.commitMessage ? null : file.path)),
        pattern,
        -1,
      );
      if (at < 0) continue;
      const path = viewDiff.files[at]!.path;
      const position = commits.findIndex((c) => c.sha === view);
      show(view);
      say(
        view
          ? `${path}: in commit ${position + 1}/${commits.length}`
          : `${path}: in all changes`,
      );
      return path;
    }
    return null;
  };

  // A read the lost connection failed: read again once it is back (one
  // try each time it comes back; another failure waits for Retry).
  const reloadViews = () => {
    diffs.current.clear();
    setChanged(false);
    setGeneration((value) => value + 1);
  };
  useReloadOnReconnect(active ? failure : null, connectionId, reloadViews);

  return {
    active,
    commits: active ? commits : null,
    history,
    sha: active ? sha : null,
    current: active ? current : null,
    ready: active && commits !== null && readFor === placeKey,
    name: active && commits?.length ? viewName(commits, current) : null,
    shown,
    loading,
    status,
    failed: active && failure !== null,
    changed,
    picker: pickerState ? { ...pickerState, choices: picked } : null,
    show,
    step: (direction) => {
      if (!commits?.length) {
        say("This review has a single commit.");
        return;
      }
      const next = stepView(commits, sha, direction);
      if (next) show(next.sha);
    },
    openPicker,
    movePicker: (step) =>
      setPickerState((state) =>
        state
          ? {
              ...state,
              at: Math.max(0, Math.min(picked.length - 1, state.at + step)),
            }
          : state,
      ),
    setPickerQuery: (query) => setPickerState({ query, at: 0 }),
    pick: (choice) => {
      setPickerState(null);
      if (choice && choice.sha !== sha) show(choice.sha);
    },
    command: (name, argument) => {
      const words = argument.trim();
      if (name === "commit" && !words) {
        if (!history) show(null);
        return;
      }
      if (name === "commit" && /^\d+$/.test(words)) {
        const at = Number(words) - 1;
        if (commits?.[at]) show(commits[at]!.sha);
        return;
      }
      // A single match goes there; else the picker shows them.
      const matches = searchCommits(choices, words);
      if (words && matches.length === 1) {
        if (matches[0]!.sha !== sha) show(matches[0]!.sha);
      } else openPicker(words);
    },
    reload: reloadViews,
    searchElsewhere,
    headSha: diff?.headSha ?? null,
    readFile: async (path) => {
      // The view's head: a commit's own, else the review's head.
      const rev = diff?.headSha ?? (sha || "HEAD");
      const { text } = await call<{ text: string }>("review.file", {
        path,
        rev,
      });
      return text;
    },
  };
}
