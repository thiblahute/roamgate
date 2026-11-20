import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useState } from "react";
import type {
  ReviewMergeRequestLink,
  ReviewSnapshot,
  ReviewThread,
} from "../../../shared/review";
import { forgeDraftCount, localDraftCount } from "../changesForge";
import { copyTextWithFeedback } from "../copyText";
import { rememberReviewSnapshot, reviewCall } from "../review";
import { reviewAsMarkdown } from "../reviewModel";
import { mergeRequestNumber, reviewMrSwitch } from "../reviewMrSwitch";
import { store } from "../store";
import { plural } from "./MrThreadCard";
import { ReviewMenu, type ReviewMenuItem } from "./ReviewMenu";
import "./ChangesForge.css";

/*
 * A review's forge in Changes: the Local / GitLab switch (gm, :switch), your
 * drafts on the forge, the GitLab draft button that puts the comments waiting
 * here there as drafts, the More menu, and the GitLab section above the diff.
 * Nothing here submits or publishes: the forge's drafts are the user's to
 * submit there.
 */

/** What the page around Changes does for the switch. */
export type ForgeHost = {
  /** Shows another review in Changes (the merge request's). */
  onShowReview?: (snapshot: ReviewSnapshot) => void;
  /** Shows the checkout's local review (one of `reviews`, or a new one). */
  onOpenLocal?: (root: string, reviews: string[]) => void;
  /**
   * The request the merge request card shows (its chosen remote): the
   * switch opens that one rather than looking the branch's up.
   */
  requestUrl?: string;
};

const say = (message: string) =>
  store.notify({ kind: "info", message, autoDismissMs: 2200 });

/**
 * The Local / GitLab switch's state and actions, for the review shown (null
 * before its first comment: the scope's review is opened for the switch).
 */
export function useForgeMode({
  connectionId,
  snapshot,
  open,
  host,
}: {
  connectionId: string;
  snapshot: ReviewSnapshot | null;
  /** The shown scope's review, opened when it is not yet. */
  open: () => Promise<string>;
  host: ForgeHost;
}) {
  const session = snapshot?.session;
  const kind = session?.target.kind ?? "worktree";
  const sessionId = session?.id ?? null;
  // The branch's merge request, as the last switch found it: looked up
  // when switching, not on every showing (a forge lookup is slow, and
  // Changes shows often).
  const [found, setFound] = useState<ReviewMergeRequestLink | null>(null);
  const gitlab = !!session?.gitlab;
  const notifyNoMr = () =>
    say(
      kind === "mr"
        ? "The checkout is not on this merge request's branch."
        : "No open GitLab merge request found for this branch.",
    );
  const failed = (error: unknown) =>
    say(error instanceof Error ? error.message : String(error));
  /** gm, :switch, the switch: the local review and the forge's, both ways. */
  const switchMode = () => {
    if (kind === "mr") {
      const openLocal = host.onOpenLocal;
      if (!openLocal || !sessionId || !session) {
        notifyNoMr();
        return;
      }
      void reviewCall<{
        mergeRequest: ReviewMergeRequestLink | null;
        localReviews?: string[];
      }>(connectionId, "review.gitlab.find", {
        session_id: sessionId,
        local: true,
      })
        .then(({ mergeRequest, localReviews }) => {
          setFound(mergeRequest);
          if (!mergeRequest) notifyNoMr();
          else openLocal(session.root, localReviews ?? []);
        })
        .catch(failed);
      return;
    }
    if (kind !== "range" && kind !== "worktree") {
      notifyNoMr();
      return;
    }
    void (async () => {
      const id = await open();
      const { mergeRequest, snapshot: opened } = await reviewCall<{
        mergeRequest: ReviewMergeRequestLink | null;
        snapshot?: ReviewSnapshot;
      }>(connectionId, "review.gitlab.open", {
        session_id: id,
        ...(host.requestUrl ? { url: host.requestUrl } : {}),
      });
      setFound(mergeRequest);
      if (!mergeRequest || !opened) {
        notifyNoMr();
        return;
      }
      rememberReviewSnapshot(opened);
      host.onShowReview?.(opened);
    })().catch(failed);
  };
  const mrSwitch = session
    ? reviewMrSwitch(
        session,
        snapshot?.mergeRequest ?? null,
        found,
        !!host.onOpenLocal,
      )
    : null;
  const number = snapshot?.mergeRequest
    ? mergeRequestNumber(snapshot.mergeRequest.url)
    : null;
  return {
    gitlab,
    /** The switch shows: a merge request's, a branch's or the checkout's. */
    switchable: kind === "mr" || kind === "range" || kind === "worktree",
    switchMode,
    setGitlab: (on: boolean) => {
      if (on !== gitlab) switchMode();
    },
    mrSwitch,
    label: mrSwitch?.label ?? (number ? `MR !${number}` : null),
  };
}

export type ForgeMode = ReturnType<typeof useForgeMode>;

/** Opens the merge request's changes in a new tab (O, :open, :gitlab). */
export function openMergeRequest(snapshot: ReviewSnapshot | null) {
  // The branch's merge request, in the local review too (as the pane).
  const mr = snapshot?.mergeRequest;
  if (!mr) {
    say("This review is not about a GitLab merge request.");
    return;
  }
  window.open(`${mr.url}/diffs`, "_blank", "noopener");
}

/** The head's forge controls: the switch, the drafts, the More menu. */
export function ChangesForgeHead({
  connectionId,
  snapshot,
  forge,
  mode,
  threads,
  viewItems = [],
}: {
  connectionId: string;
  snapshot: ReviewSnapshot | null;
  forge: string;
  mode: ForgeMode;
  /** The review's threads as shown (the copy's comments). */
  threads: readonly ReviewThread[];
  /** How the diff is drawn (its context, the resolved threads), first. */
  viewItems?: readonly (ReviewMenuItem | null | false)[];
}) {
  const session = snapshot?.session;
  const mr = session?.gitlab ? snapshot?.mergeRequest : undefined;
  const drafts = snapshot && mr ? forgeDraftCount(snapshot.threads) : 0;
  const local = snapshot && session?.gitlab ? localDraftCount(snapshot) : 0;
  return (
    <>
      {mode.switchable ? (
        <div
          className="rv-mode-switch"
          role="group"
          aria-label="Review mode"
          title={mode.mrSwitch?.title}
        >
          {mode.label ? <span className="rv-mode-mr">{mode.label}</span> : null}
          <button
            type="button"
            className={mode.gitlab ? "" : "on"}
            aria-pressed={!mode.gitlab}
            title={
              mode.gitlab
                ? "Review the checkout's branch locally (gm, :switch)"
                : "A local review: your comments stay in Roamgate"
            }
            onClick={() => {
              if (mode.gitlab) mode.switchMode();
            }}
          >
            Local
          </button>
          <button
            type="button"
            className={mode.gitlab ? "on" : ""}
            aria-pressed={mode.gitlab}
            title={
              mode.gitlab
                ? `${forge} mode: the merge request's discussions are shown and your comments are draft notes`
                : `Use the branch's ${forge} merge request: its discussions, and your review as draft notes (gm, :switch)`
            }
            onClick={() => {
              if (!mode.gitlab) mode.switchMode();
            }}
          >
            {forge}
          </button>
        </div>
      ) : null}
      {mr && drafts > 0 ? (
        <a
          className="diff-forge-drafts"
          href={mr.url}
          target="_blank"
          rel="noreferrer"
          title={`Your pending review on ${forge}: Roamgate never submits it; submit it there`}
        >
          {drafts} draft{drafts === 1 ? "" : "s"} on {forge}
        </a>
      ) : null}
      {session && local > 0 ? (
        <button
          type="button"
          className="diff-forge-push"
          title={`Put the review comments waiting here (the local review's and the agent's drafts) on ${forge} as draft notes, not published; you submit the review there`}
          onClick={() =>
            void reviewCall<ReviewSnapshot>(
              connectionId,
              "review.gitlab.push",
              {
                session_id: session.id,
              },
            )
              .then(rememberReviewSnapshot)
              .catch((error) =>
                say(error instanceof Error ? error.message : String(error)),
              )
          }
        >
          {forge} draft ({local})
        </button>
      ) : null}
      <ReviewMenu
        className="rv-more diff-forge-more"
        title={`More: the diff's context, resolved threads, ${forge}, copying the review`}
        label={<MoreHorizontal size={14} />}
        items={[
          ...viewItems,
          mode.switchable && {
            label: `${forge} mode`,
            title: mode.gitlab
              ? `Reviewing the merge request from ${forge}: your comments are draft notes; uncheck for the local review`
              : `Review the branch's merge request from ${forge}: its diff, its discussions, and your review as draft notes`,
            checked: mode.gitlab,
            ...(mode.mrSwitch?.action === "gitlab" ? { hint: "gm" } : {}),
            onSelect: () => mode.setGitlab(!mode.gitlab),
          },
          !!mr && {
            label: `Open the merge request on ${forge}`,
            hint: "O",
            title: "Where you submit the review (:open)",
            onSelect: () => openMergeRequest(snapshot),
          },
          {
            label: "Copy the review as Markdown",
            title: "The overall comment, then each comment under its line",
            onSelect: () => {
              const text = reviewAsMarkdown(session?.summary ?? "", [
                ...threads,
              ]);
              if (!text.trim())
                say("Nothing to send yet: comment a line first.");
              else void copyTextWithFeedback(text);
            },
          },
        ]}
      />
    </>
  );
}

/**
 * The forge's section above the diff: its discussions counted, the open
 * ones on the whole request, the resolved ones folded under a summary.
 */
export function ChangesForgeSection({
  snapshot,
  forge,
  shown,
  placed,
  general,
  outside,
  onAllChanges,
  renderThread,
}: {
  snapshot: ReviewSnapshot;
  forge: string;
  /** The forge's discussions this view shows. */
  shown: readonly ReviewThread[];
  /** How many are drawn on their lines. */
  placed: number;
  /** Those on the whole request (or on an older head, not found again). */
  general: readonly ReviewThread[];
  /** Those on code outside the commit shown. */
  outside: number;
  onAllChanges: () => void;
  renderThread: (thread: ReviewThread) => ReactNode;
}) {
  if (snapshot.gitlabError)
    return (
      <p className="note diff-forge-note">
        {forge} comments unavailable: {snapshot.gitlabError}
      </p>
    );
  const mr = snapshot.mergeRequest;
  if (!mr)
    return (
      <p className="note diff-forge-note">
        Loading the merge request comments...
      </p>
    );
  const pending = snapshot.threads.filter(
    (thread) => thread.gitlab?.draftId !== undefined,
  ).length;
  const onRequest = shown.filter((thread) => !thread.anchor.path).length;
  const open = general.filter((thread) => !thread.resolved);
  const resolved = general.filter((thread) => thread.resolved);
  return (
    <section className="diff-forge" aria-label={forge}>
      <p className="note diff-forge-note">
        {forge}: {plural(shown.length, "discussion")}
        {onRequest ? ` (${onRequest} on the whole request)` : ""}
        {pending ? `, ${plural(pending, "pending draft")} of yours` : ""};{" "}
        {placed} shown on their lines below
        {outside ? (
          <>
            , {outside} on code outside this commit (
            <button type="button" className="link" onClick={onAllChanges}>
              all changes
            </button>
            )
          </>
        ) : null}
        .{mr.security ? " Security merge request: not shared with agents." : ""}
      </p>
      {open.length ? (
        <div className="mr-open">
          <h4>Open discussions ({open.length})</h4>
          {open.map((thread) => (
            <div key={thread.id}>{renderThread(thread)}</div>
          ))}
        </div>
      ) : null}
      {resolved.length ? (
        <details className="mr-other">
          <summary>Resolved ({resolved.length})</summary>
          {resolved.map((thread) => (
            <div key={thread.id}>{renderThread(thread)}</div>
          ))}
        </details>
      ) : null}
    </section>
  );
}
