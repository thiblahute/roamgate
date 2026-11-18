import {
  ChevronLeft,
  MessageSquarePlus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ReviewThread } from "../../../shared/review";
import {
  MR_DISPOSITIONS,
  type MrDisposition,
  type MrEffort,
  type MrEffortChanges,
  type MrEffortSummary,
  type MrMatchProposal,
  fixupTargets,
  type MrPlan,
  upstreamWorkspaceHome,
} from "../../../shared/mrReviews";
import type { WorkspaceRef } from "../../../shared/workspaceTree";
import {
  mrReviewsCall,
  onMrReviewsChange,
  orderMrRequests,
} from "../mrReviews";
import { type ShownReply, showReply } from "../mrReviewFlow";
import { EMPTY_KEY_STATE, feedKey } from "../reviewNavigation";
import { useWorkspaceTree } from "../workspaceTreeStore";
import { EFFORT_KEYS } from "../mrReviewsKeys";
import {
  type EffortPoint,
  EffortThreadsAt,
  EffortThreadsProvider,
  effortItemProps,
  pointKey,
  pointOf,
  selectedIn,
  useEffortSelection,
  useEffortThreads,
} from "./EffortThreads";
import { ConfirmDialog } from "./ModalDialogs";
import "./MrEffortView.css";

/**
 * Upstreaming efforts in Reviews: a card per effort at the top of Mine
 * (progress by disposition), and the effort's view: Progress (bar, counts,
 * burndown, breakdown by directory), Ledger (every commit, selectable,
 * dispositions set in bulk with Undo, fuzzy matches confirmed or
 * rejected, `d` its diff in the head workspace's Changes), Plans (planned requests and their parts),
 * Feeders and What changed since the user last looked. Delete (`:delete`)
 * takes its declaration out after a confirmation, with Undo.
 */

export const DISPOSITION_TITLE: Record<MrDisposition, string> = {
  upstream: "upstream",
  in_review: "in review",
  in_part: "in a part",
  planned: "planned",
  not_for_upstream: "not for upstream",
  superseded: "superseded",
  unsorted: "unsorted",
};

export type LedgerCommit = {
  key: string;
  sha: string;
  patchId: string;
  subject: string;
  author: string;
  authorDate: number;
  files: string[];
  dir: string;
  disposition: MrDisposition;
  note?: string;
  upstreamAnyway?: boolean;
};

type EffortDetail = {
  effort: MrEffort;
  summary?: MrEffortSummary;
  commits: LedgerCommit[];
  feeders: { ref: string; notReady: number; drift: number }[];
  daily: { date: string; counts: Partial<Record<MrDisposition, number>> }[];
  journal: { id: number; at: string; by: string; summary: string }[];
  proposals?: Record<string, MrMatchProposal[]>;
  plans?: MrPlan[];
  changes?: MrEffortChanges;
};

/** The bar of an effort: one segment per disposition. */
export function EffortBar({ summary }: { summary: MrEffortSummary }) {
  const total = summary.total || 1;
  return (
    <div className="mr-effort-bar" role="img" aria-label={countsText(summary)}>
      {MR_DISPOSITIONS.map((each) =>
        summary.counts[each] ? (
          <span
            key={each}
            className={`is-${each}`}
            style={{ width: `${(100 * summary.counts[each]!) / total}%` }}
            title={`${summary.counts[each]} ${DISPOSITION_TITLE[each]}`}
          />
        ) : null,
      )}
    </div>
  );
}

export function countsText(summary: MrEffortSummary): string {
  const parts = MR_DISPOSITIONS.flatMap((each) =>
    summary.counts[each]
      ? [`${summary.counts[each]} ${DISPOSITION_TITLE[each]}`]
      : [],
  );
  return `${summary.total} commits: ${parts.join(", ") || "none read yet"}${summary.notReady ? `; ${summary.notReady} not ready in feeders` : ""}`;
}

/** An effort's card at the top of Mine. */
export function MrEffortCard({
  summary,
  onOpen,
  onLeader,
}: {
  summary: MrEffortSummary;
  onOpen: () => void;
  onLeader: () => void;
}) {
  const done = summary.counts.upstream ?? 0;
  return (
    <li className="mr-effort-card" data-mr-effort={summary.id}>
      <button
        type="button"
        className="assistant-task-row mr-reviews-row"
        title="Open the effort (Enter, i)"
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === "i") {
            event.preventDefault();
            onOpen();
          } else if (event.key === "c") {
            event.preventDefault();
            onLeader();
          }
        }}
      >
        <div className="mr-reviews-dense-head">
          <strong>
            <span className="mr-reviews-number">effort</span> {summary.name}
          </strong>
          <span className="mr-reviews-dense-chips">
            <span className="mr-reviews-chip is-tree">
              {done} of {summary.total} upstream
            </span>
            {summary.notReady ? (
              <span className="mr-reviews-chip is-wait">
                {summary.notReady} not ready
              </span>
            ) : null}
            {summary.changed ? (
              <span
                className="mr-reviews-chip is-changed"
                title="What changed since you last looked"
              >
                {summary.changed} changed
              </span>
            ) : null}
            {summary.proposals ? (
              <span
                className="mr-reviews-chip is-wait"
                title="Upstream commits that look like these: confirm or reject"
              >
                {summary.proposals} to confirm
              </span>
            ) : null}
            {summary.plans ? (
              <span className="mr-reviews-chip is-tree">
                {summary.plans.accepted} planned
                {summary.plans.proposed
                  ? `, ${summary.plans.proposed} proposed`
                  : ""}
              </span>
            ) : null}
            {summary.overlaps.length ? (
              <span
                className="mr-reviews-chip is-wait"
                title={summary.overlaps.map((each) => each.proposal).join("\n")}
              >
                overlaps {summary.overlaps.map((each) => each.with).join(", ")}
              </span>
            ) : null}
          </span>
        </div>
        <EffortBar summary={summary} />
        <span className="mr-reviews-next">
          <span className="mr-reviews-next-text">
            {summary.error ?? countsText(summary)}
          </span>
          <small className="mr-reviews-dense-meta">
            {summary.source} to {summary.target}
          </small>
        </span>
      </button>
      <span className="mr-reviews-move">
        <button
          type="button"
          className="ghost mr-effort-leader"
          title="Its leader: the Claude session of its head workspace (c)"
          onClick={onLeader}
        >
          Leader
        </button>
      </span>
    </li>
  );
}

/** A small burndown: commits left (not upstream) per day. */
function Burndown({ daily }: { daily: EffortDetail["daily"] }) {
  if (daily.length < 2)
    return <p className="assistant-hint">The burndown starts tomorrow.</p>;
  const left = daily.map((day) =>
    Object.entries(day.counts).reduce(
      (sum, [key, value]) =>
        key === "upstream" || key === "not_for_upstream" || key === "superseded"
          ? sum
          : sum + (value ?? 0),
      0,
    ),
  );
  const max = Math.max(1, ...left);
  const points = left
    .map(
      (value, index) =>
        `${(index / (left.length - 1)) * 300},${80 - (value / max) * 76}`,
    )
    .join(" ");
  return (
    <svg
      className="mr-effort-burndown"
      viewBox="0 0 300 80"
      role="img"
      aria-label={`Commits left: from ${left[0]} to ${left[left.length - 1]}`}
    >
      <polyline points={points} fill="none" />
    </svg>
  );
}

const ROW_HEIGHT = 26;

/** The ledger: every commit, virtualized, with keys. */
export function MrLedgerTable({
  commits,
  selected,
  cursor,
  onCursor,
  onToggle,
  proposals,
  threads,
}: {
  commits: LedgerCommit[];
  selected: ReadonlySet<string>;
  cursor: number;
  onCursor: (index: number) => void;
  onToggle: (key: string) => void;
  proposals?: Record<string, MrMatchProposal[]>;
  /** Open threads on a commit of the ledger, by its key. */
  threads?: ReadonlyMap<string, number>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const height = 420;
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - 10);
  const last = Math.min(
    commits.length,
    first + Math.ceil(height / ROW_HEIGHT) + 20,
  );
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const y = cursor * ROW_HEIGHT;
    if (y < box.scrollTop) box.scrollTop = y;
    else if (y + ROW_HEIGHT > box.scrollTop + box.clientHeight)
      box.scrollTop = y + ROW_HEIGHT - box.clientHeight;
  }, [cursor]);
  return (
    <div
      ref={ref}
      className="mr-ledger"
      role="grid"
      aria-label="Ledger"
      aria-rowcount={commits.length}
      onScroll={(event) => setTop(event.currentTarget.scrollTop)}
    >
      <div
        style={{ height: commits.length * ROW_HEIGHT, position: "relative" }}
      >
        {commits.slice(first, last).map((commit, offset) => {
          const index = first + offset;
          return (
            <div
              key={commit.key}
              role="row"
              aria-selected={selected.has(commit.key)}
              aria-rowindex={index + 1}
              {...effortItemProps(ledgerPoint(commit), null)}
              className={`mr-ledger-row${index === cursor ? " is-cursor" : ""}${selected.has(commit.key) ? " is-selected" : ""}`}
              style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
              onClick={(event) => {
                onCursor(index);
                if (event.shiftKey || event.metaKey || event.ctrlKey)
                  onToggle(commit.key);
              }}
            >
              <code>{commit.sha.slice(0, 10)}</code>
              <span className="mr-ledger-subject" title={commit.subject}>
                {threads?.get(commit.key) ? (
                  <span
                    className="mr-effort-thread-count"
                    title="Open threads on it: under the ledger when the cursor is on it"
                  >
                    {threads.get(commit.key)}
                  </span>
                ) : null}
                {commit.subject}
              </span>
              <span className="mr-ledger-author">{commit.author}</span>
              <span className="mr-ledger-dir">{commit.dir}</span>
              <span
                className={`mr-ledger-disposition is-${commit.disposition}`}
              >
                {DISPOSITION_TITLE[commit.disposition]}
                {commit.upstreamAnyway ? ", upstream anyway" : ""}
              </span>
              {proposals?.[commit.key]?.length ? (
                <span
                  className="mr-ledger-note is-proposal"
                  title={proposals[commit.key]!.map(
                    (each, at) =>
                      `${at + 1}. ${each.sha.slice(0, 10)} ${each.subject} (${each.score}: ${each.why})`,
                  ).join("\n")}
                >
                  like {proposals[commit.key]![0]!.sha.slice(0, 8)} (
                  {proposals[commit.key]![0]!.score})
                </span>
              ) : (
                <span className="mr-ledger-note" title={commit.note}>
                  {commit.note ?? ""}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type Tab = "progress" | "ledger" | "plans" | "feeders" | "changes";

/** A commit as one points at it: by its ledger key, which follows rebases. */
function commitPoint(
  tab: Tab,
  commit: LedgerCommit,
  plan?: string,
): EffortPoint {
  return {
    tab,
    item: {
      kind: "commit",
      key: commit.key,
      label: `${commit.sha.slice(0, 10)} ${commit.subject}`.slice(0, 300),
    },
    ...(plan ? { plan } : {}),
  };
}

const ledgerPoint = (commit: LedgerCommit) => commitPoint("ledger", commit);

const TABS: { tab: Tab; label: string; key: string }[] = [
  { tab: "progress", label: "Progress", key: "P" },
  { tab: "ledger", label: "Ledger", key: "L" },
  { tab: "plans", label: "Plans", key: "R" },
  { tab: "feeders", label: "Feeders", key: "F" },
  { tab: "changes", label: "What changed", key: "W" },
];

/** One effort, maximized in the panel. */
export function MrEffortView({
  id,
  onBack,
  onLeader,
  onJump,
  say,
}: {
  id: string;
  onBack: () => void;
  onLeader: () => void;
  /** Goes to a workspace (a commit's review opened there). */
  onJump?: (connectionId: string, workspaceId: string) => void;
  /** A few words where Undo shows; with an action when it can be undone. */
  say: (label: string, undo?: () => Promise<unknown>) => void;
}) {
  const [detail, setDetail] = useState<EffortDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("progress");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  /** Asking before deleting the effort. */
  const [deleting, setDeleting] = useState(false);
  const [history, setHistory] = useState<Record<string, unknown>[] | null>(
    null,
  );
  /** Two versions of the history picked for `d`, and their diff. */
  const [versions, setVersions] = useState<string[]>([]);
  const [diff, setDiff] = useState<string | null>(null);
  const keyState = useRef(EMPTY_KEY_STATE);
  const rootRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const commandRef = useRef<HTMLInputElement>(null);
  /** What a click or j / k points at outside the ledger, to comment on. */
  const [pointed, setPointed] = useState<EffortPoint | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  /** A thread gone to (n, gn): focused once drawn. */
  const [goingTo, setGoingTo] = useState<string | null>(null);
  const lastThread = useRef<string | null>(null);
  // A comment box closed: the keys come back to the view.
  const back = useCallback(
    () =>
      requestAnimationFrame(() =>
        rootRef.current?.focus({ preventScroll: true }),
      ),
    [],
  );
  const threads = useEffortThreads(id, back);
  const selection = useEffortSelection(rootRef);

  const load = useCallback(
    () =>
      mrReviewsCall<EffortDetail>("effort.get", { id })
        .then((value) => {
          setDetail(value);
          setError(null);
        })
        .catch((cause) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        ),
    [id],
  );
  useEffect(() => {
    void load();
    return onMrReviewsChange((push) => {
      if (push.effort?.id === id || push.changed.includes("efforts"))
        void load();
    });
  }, [id, load]);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (command !== null) commandRef.current?.focus();
  }, [command]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (detail?.commits ?? []).filter((commit) =>
      words.every((word) => {
        const at = word.indexOf(":");
        const [key, value] =
          at > 0 ? [word.slice(0, at), word.slice(at + 1)] : ["", word];
        if (key === "disposition")
          return commit.disposition === value.replace(/-/g, "_");
        if (key === "dir") return commit.dir.toLowerCase().startsWith(value);
        if (key === "file")
          return commit.files.some((file) =>
            file.toLowerCase().includes(value),
          );
        if (key === "author")
          return commit.author.toLowerCase().includes(value);
        return (
          commit.subject.toLowerCase().includes(value) ||
          commit.sha.startsWith(value)
        );
      }),
    );
  }, [detail, query]);

  /** Where c comments: the ledger's cursor, else what was pointed at. */
  const currentPoint = (): EffortPoint => {
    if (tab === "ledger" && shown[cursor]) return ledgerPoint(shown[cursor]!);
    if (pointed && pointed.tab === tab) return pointed;
    return { tab };
  };

  /** c: on the words selected, else on what the cursor is on. */
  const commentHere = () => {
    const words = selectedIn(rootRef.current);
    if (words) threads.comment(pointOf(words.element, tab), words.quote);
    else if (threads.draft) focusDraft();
    else threads.comment(currentPoint());
  };

  const focusDraft = () =>
    requestAnimationFrame(() =>
      rootRef.current
        ?.querySelector<HTMLElement>(".mr-effort-thread.is-draft .cm-content")
        ?.focus(),
    );

  /** Threads in the order of the view: tab, then where they are in it. */
  const ordered = useMemo(() => {
    const order = new Map(TABS.map((each, index) => [each.tab, index]));
    const commitAt = new Map(
      (detail?.commits ?? []).map((commit, index) => [commit.key, index]),
    );
    const planAt = new Map(
      (detail?.plans ?? []).map((plan, index) => [plan.id, index]),
    );
    const place = (thread: (typeof threads.threads)[number]) => {
      const part = thread.anchor.effort!;
      const item = part.item;
      if (!item) return -1;
      if (part.tab === "plans")
        return (
          (planAt.get(part.plan ?? (item.kind === "plan" ? item.key : "")) ??
            0) *
            10_000 +
          (item.kind === "commit" ? 1 + (commitAt.get(item.key) ?? 0) : 0)
        );
      return item.kind === "commit" ? (commitAt.get(item.key) ?? 0) : 0;
    };
    return [...threads.threads].sort(
      (a, b) =>
        (order.get(a.anchor.effort!.tab) ?? 0) -
          (order.get(b.anchor.effort!.tab) ?? 0) ||
        place(a) - place(b) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  }, [threads.threads, detail]);

  /** Shows a thread: its tab, its commit under the ledger's cursor. */
  const goToThread = (threadId: string) => {
    const thread = threads.threads.find((each) => each.id === threadId);
    const part = thread?.anchor.effort;
    if (!thread || !part) return;
    lastThread.current = thread.id;
    setTab(part.tab);
    if (part.tab === "ledger" && part.item?.kind === "commit") {
      const key = part.item.key;
      const at = shown.findIndex((commit) => commit.key === key);
      if (at >= 0) setCursor(at);
      else {
        const all = detail?.commits.findIndex((commit) => commit.key === key);
        if (all !== undefined && all >= 0) {
          setQuery("");
          setCursor(all);
        }
      }
    }
    setGoingTo(thread.id);
  };

  /** n / N: the next or previous thread; gn / gN only the open ones. */
  const stepThread = (step: 1 | -1, openOnly: boolean) => {
    const list = openOnly
      ? ordered.filter((thread) => !thread.resolved)
      : ordered;
    if (!list.length) {
      say(openOnly ? "No open thread" : "No thread");
      return;
    }
    const at = list.findIndex((thread) => thread.id === lastThread.current);
    const next =
      at < 0
        ? step > 0
          ? 0
          : list.length - 1
        : (at + step + list.length) % list.length;
    goToThread(list[next]!.id);
  };

  useEffect(() => {
    if (!goingTo) return;
    const frame = requestAnimationFrame(() => {
      const element = rootRef.current?.querySelector<HTMLElement>(
        `.mr-effort-thread[data-thread-id="${CSS.escape(goingTo)}"]`,
      );
      if (!element) return;
      element.scrollIntoView({ block: "nearest" });
      element.focus({ preventScroll: true });
      setGoingTo(null);
    });
    return () => cancelAnimationFrame(frame);
  });

  /** j / k outside the ledger: from one thing one comments on to the next. */
  const movePointed = (step: number) => {
    const items = [
      ...(rootRef.current?.querySelectorAll<HTMLElement>(
        "[data-effort-item]",
      ) ?? []),
    ];
    if (!items.length) return;
    const at = pointed
      ? items.findIndex(
          (item) => pointKey(pointOf(item, tab)) === pointKey(pointed),
        )
      : -1;
    const next =
      items[Math.max(0, Math.min(items.length - 1, at < 0 ? 0 : at + step))]!;
    setPointed(pointOf(next, tab));
    next.scrollIntoView({ block: "nearest" });
  };

  const targets = () =>
    selected.size ? [...selected] : shown[cursor] ? [shown[cursor]!.key] : [];

  const setDisposition = async (
    disposition: string,
    extra: { reason?: string; pointer?: string } = {},
  ) => {
    const commits = targets();
    if (!commits.length) return;
    try {
      const done = await mrReviewsCall<{ changed: number; journal: number }>(
        "ledger.set",
        { id, commits, disposition, ...extra },
      );
      setSelected(new Set());
      say(
        `${done.changed} commit${done.changed === 1 ? "" : "s"} ${disposition.replace(/_/g, " ")}`,
        () => mrReviewsCall("ledger.undo", { id, journal: done.journal }),
      );
      await load();
    } catch (cause) {
      say(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** Calls a write and says what it did, with Undo when journaled. */
  const write = async (
    method: string,
    params: Record<string, unknown>,
    label: (done: any) => string,
  ) => {
    try {
      const done = await mrReviewsCall<any>(method, { id, ...params });
      setSelected(new Set());
      say(
        label(done),
        typeof done?.journal === "number"
          ? () => mrReviewsCall("ledger.undo", { id, journal: done.journal })
          : undefined,
      );
      await load();
      return done;
    } catch (cause) {
      say(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  };

  /** Confirms or rejects the proposals of the targeted commits. */
  const decide = (accept: boolean, which: string) => {
    const decisions = targets().flatMap((key) => {
      const list = detail?.proposals?.[key] ?? [];
      const picked =
        which === "all" && !accept
          ? list
          : [list[Math.max(0, (Number(which) || 1) - 1)]].filter(Boolean);
      return picked.map((each) => ({
        commit: key,
        match: each!.sha,
        accept,
      }));
    });
    if (!decisions.length) {
      say("No proposal on that commit");
      return;
    }
    void write("ledger.match", { decisions }, (done) =>
      accept
        ? `${done.accepted} match${done.accepted === 1 ? "" : "es"} confirmed`
        : `${done.rejected} rejected`,
    );
  };

  const plans = detail?.plans ?? [];
  const planNamed = (name: string) =>
    plans.find(
      (plan) =>
        plan.id === name || plan.name.toLowerCase() === name.toLowerCase(),
    );

  /** `:plan NAME`: the commits into that planned request (made when new). */
  const plan = (name: string) => {
    const commits = targets();
    if (!name || !commits.length) {
      say("Say a name: :plan NAME");
      return;
    }
    const existing = planNamed(name);
    void write(
      "ledger.plans",
      existing
        ? { action: "edit", plan: existing.id, add: commits }
        : { action: "propose", name, commits, accepted: true },
      () =>
        `${commits.length} commit${commits.length === 1 ? "" : "s"} planned in ${name}`,
    );
  };

  const makePart = (name: string, branch?: string) =>
    void write(
      "effort.part",
      { plan: name, ...(branch ? { branch } : {}) },
      (done) =>
        done.conflict
          ? `Part ${done.branch}: ${done.picked} of ${done.of} picked, stopped ${done.conflict.folding ? "folding fixups " : ""}at ${String(done.conflict.sha).slice(0, 10)} (${done.conflict.files.join(", ") || "empty"}): resolve it there`
          : done.error
            ? `Part ${done.branch}: ${done.picked} of ${done.of} on its branch: ${done.error}`
            : done.from
              ? done.ported
                ? `Part ${done.branch} made from ${done.from}, a port of the plan (${done.differs?.summary ?? "it differs from the plan's commits"}): nothing picked`
                : `Part ${done.branch} made from ${done.from}, which holds its ${done.of} commits: nothing picked`
              : `Part ${done.branch} made${done.base ? ` on ${done.base}` : ""} with ${done.picked} commits${done.folded ? `, ${done.folded} fixup${done.folded === 1 ? "" : "s"} folded` : ""}${done.unfolded?.length ? `, ${done.unfolded.length} fixup${done.unfolded.length === 1 ? "" : "s"} left as commits (target not in the part)` : ""}${done.skipped?.length ? ` (${done.skipped.length} already in the target, skipped)` : ""}`,
    );

  /**
   * `d` (D32): the commit's diff (or, with `from`, two versions of it) in
   * the head workspace's Changes; the page goes there as Enter on a
   * request goes to its home, and the Reviews pane hides.
   */
  const openCommit = async (sha: string, from?: string) => {
    const answer = await mrReviewsCall<
      Partial<ShownReply> & { connectionId: string; workspaceId: string }
    >("effort.open_commit", { id, sha, ...(from ? { from } : {}) });
    if (answer.snapshot && answer.sessionId)
      await showReply(answer as ShownReply);
    onJump?.(answer.connectionId, answer.workspaceId);
  };

  const showCommit = (sha: string) =>
    void openCommit(sha).catch((cause) =>
      say(cause instanceof Error ? cause.message : String(cause)),
    );

  const diffText = (from: string, to: string) =>
    void mrReviewsCall<{ text: string }>("effort.diff", { id, from, to })
      .then((answer) => setDiff(answer.text || "(no difference)"))
      .catch((cause) =>
        say(cause instanceof Error ? cause.message : String(cause)),
      );

  // Two versions in the head workspace's Changes; here as text when that
  // workspace cannot show them (not open, no review there).
  const diffVersions = (from: string, to: string) =>
    void openCommit(to, from).catch((cause) => {
      say(cause instanceof Error ? cause.message : String(cause));
      diffText(from, to);
    });

  /**
   * Deletes its declaration (its ledger stays on disk under its id), says
   * so with Undo and goes back to the inbox. No branch or worktree moves.
   */
  const deleteEffort = async () => {
    const name = detail?.effort.name ?? id;
    try {
      const done = await mrReviewsCall<{ version: number }>("effort.delete", {
        id,
      });
      say(
        `Deleted the effort ${name}`,
        done.version
          ? () => orderMrRequests({ op: "undo", version: done.version })
          : undefined,
      );
      onBack();
    } catch (cause) {
      say(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const runCommand = (text: string) => {
    setCommand(null);
    rootRef.current?.focus({ preventScroll: true });
    const [name = "", ...rest] = text.trim().replace(/^:/, "").split(/\s+/);
    const argument = rest.join(" ").trim();
    if (name === "mark") {
      const [what = "", ...why] = rest;
      const disposition = what.replace(/-/g, "_");
      const value =
        disposition === "not_upstream" ? "not_for_upstream" : disposition;
      void setDisposition(value, why.length ? { reason: why.join(" ") } : {});
    } else if (name === "supersede")
      void setDisposition("superseded", argument ? { pointer: argument } : {});
    else if (name === "plan") plan(argument);
    else if (name === "confirm") decide(true, argument || "1");
    else if (name === "reject") decide(false, argument || "1");
    else if (name === "accept" || name === "drop") {
      const found = planNamed(argument);
      if (!found) say(`No planned request ${argument}`);
      else
        void write(
          "ledger.plans",
          { action: name, plan: found.id },
          () => `${found.name} ${name === "drop" ? "dropped" : "accepted"}`,
        );
    } else if (name === "split") {
      // :split NEW: the selected commits out of their plan, into a new one.
      const commits = targets();
      const from = plans.find((each) =>
        commits.every((key) => each.commits.includes(key)),
      );
      if (!argument) say("Say the new plan's name: :split NEW");
      else if (!from || !commits.length)
        say("Select commits of one planned request first");
      else
        void write(
          "ledger.plans",
          { action: "split", plan: from.id, name: argument, commits },
          () => `Split ${argument} out of ${from.name}`,
        );
    } else if (name === "part") {
      // :part [NAME]: that plan's part, else the plan of the commit here.
      const here = shown[cursor]?.key;
      const found = argument
        ? planNamed(argument)
        : plans.find((each) => !!here && each.commits.includes(here));
      if (!found)
        say(
          argument
            ? `No planned request ${argument}`
            : "Say which plan: :part NAME",
        );
      else makePart(found.id);
    } else if (name === "seen")
      void mrReviewsCall("effort.seen", { id }).then(load);
    else if (name === "unsort") void setDisposition("unsorted");
    else if (name === "refresh")
      void mrReviewsCall("effort.refresh", { id }).then(load);
    else if (name === "delete") setDeleting(true);
    else if (name) say(`Not a command: ${name}`);
  };

  const onKey = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target === commandRef.current) {
      if (event.key === "Escape") setCommand(null);
      else if (event.key === "Enter") runCommand(command ?? "");
      else return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (target === searchRef.current) {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        rootRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (helpOpen) setHelpOpen(false);
      else if (diff) setDiff(null);
      else if (history) setHistory(null);
      else if (selected.size) setSelected(new Set());
      else onBack();
      return;
    }
    // d is a prefix elsewhere (dd); here it is the diff, at once.
    if (
      event.key === "d" &&
      tab === "ledger" &&
      !keyState.current.pending &&
      !keyState.current.count
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (history && versions.length === 2)
        diffVersions(versions[0]!, versions[1]!);
      else if (shown[cursor]) showCommit(shown[cursor]!.sha);
      return;
    }
    const fed = feedKey(keyState.current, event.key);
    keyState.current = fed.state;
    if (fed.type === "wait") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const move = (to: number) => {
      const next = Math.max(0, Math.min(shown.length - 1, to));
      setCursor(next);
      if (anchor !== null) {
        const [a, b] = [Math.min(anchor, next), Math.max(anchor, next)];
        setSelected(new Set(shown.slice(a, b + 1).map((each) => each.key)));
      }
    };
    const count = fed.count ?? 1;
    let handled = true;
    const tabKey = TABS.find((each) => each.key === fed.key);
    if (tabKey) setTab(tabKey.tab);
    else if (fed.key === "c") commentHere();
    else if (fed.key === "C") threads.comment({ tab });
    else if (fed.key === "gl") onLeader();
    else if (fed.key === "n" || fed.key === "N")
      stepThread(fed.key === "n" ? 1 : -1, false);
    else if (fed.key === "gn" || fed.key === "gN")
      stepThread(fed.key === "gn" ? 1 : -1, true);
    else if (fed.key === "?") setHelpOpen((open) => !open);
    else if (fed.key === ":") setCommand("");
    else if (tab !== "ledger") {
      if (fed.key === "j" || fed.key === "ArrowDown") movePointed(count);
      else if (fed.key === "k" || fed.key === "ArrowUp") movePointed(-count);
      else handled = false;
    } else if (fed.key === "j" || fed.key === "ArrowDown") move(cursor + count);
    else if (fed.key === "k" || fed.key === "ArrowUp") move(cursor - count);
    else if (fed.key === "gg") move((fed.count ?? 1) - 1);
    else if (fed.key === "G") move(fed.count ? fed.count - 1 : shown.length);
    else if (fed.key === "x" && shown[cursor]) {
      const key = shown[cursor]!.key;
      setSelected((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    } else if (fed.key === "V") {
      if (anchor === null) {
        setAnchor(cursor);
        setSelected(new Set(shown[cursor] ? [shown[cursor]!.key] : []));
      } else setAnchor(null);
    } else if (fed.key === "/") searchRef.current?.focus();
    else if (fed.key === "u") {
      const last = detail?.journal[detail.journal.length - 1];
      if (last)
        void mrReviewsCall("ledger.undo", { id, journal: last.id })
          .then(() => say(`Undid: ${last.summary}`))
          .then(load);
    } else if ((fed.key === "zo" || fed.key === "Enter") && shown[cursor])
      void mrReviewsCall<{ versions: Record<string, unknown>[] }>(
        "effort.history",
        { id, key: shown[cursor]!.key },
      ).then((answer) => {
        setHistory(answer.versions);
        setVersions([]);
        setDiff(null);
      });
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const summary = detail?.summary;
  const dirs = useMemo(() => {
    const out = new Map<string, Partial<Record<MrDisposition, number>>>();
    for (const commit of detail?.commits ?? []) {
      const counts = out.get(commit.dir) ?? {};
      counts[commit.disposition] = (counts[commit.disposition] ?? 0) + 1;
      out.set(commit.dir, counts);
    }
    return [...out].sort(
      (a, b) =>
        Object.values(b[1]).reduce((x, y) => x + (y ?? 0), 0) -
        Object.values(a[1]).reduce((x, y) => x + (y ?? 0), 0),
    );
  }, [detail]);

  const hasThreadsAt = (point: EffortPoint) =>
    threads.at(point).length > 0 ||
    (!!threads.draft && pointKey(threads.draft.point) === pointKey(point));
  /** Open threads on each commit of the ledger, for its rows. */
  const ledgerThreads = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads.threads) {
      const part = thread.anchor.effort!;
      if (
        part.tab === "ledger" &&
        part.item?.kind === "commit" &&
        !thread.resolved
      )
        counts.set(part.item.key, (counts.get(part.item.key) ?? 0) + 1);
    }
    return counts;
  }, [threads.threads]);
  /**
   * The tab's threads whose item it no longer shows (a plan dropped, a
   * commit gone from the source): listed with the tab's own, none lost.
   */
  const away = useMemo(() => {
    if (!detail || !summary) return [];
    const drawn = new Set<string>();
    const add = (point: EffortPoint) => drawn.add(pointKey(point));
    if (tab === "progress") {
      for (const point of counterPoints(summary)) add(point);
      for (const [dir] of dirs.slice(0, 30))
        add({ tab, item: { kind: "directory", key: dir } });
    } else if (tab === "ledger")
      for (const commit of detail.commits) add(ledgerPoint(commit));
    else if (tab === "plans") {
      const bykey = new Map(detail.commits.map((each) => [each.key, each]));
      for (const plan of detail.plans ?? []) {
        add({ tab, item: { kind: "plan", key: plan.id } });
        for (const key of plan.commits.slice(0, 12)) {
          const commit = bykey.get(key);
          if (commit) add(commitPoint(tab, commit, plan.id));
        }
      }
    } else if (tab === "feeders")
      for (const feeder of detail.feeders)
        add({ tab, item: { kind: "feeder", key: feeder.ref } });
    else if (tab === "changes" && detail.changes) {
      const bykey = new Map(detail.commits.map((each) => [each.key, each]));
      for (const [title, keys] of changeLists(detail.changes)) {
        add({ tab, item: { kind: "change", key: title } });
        for (const key of keys.slice(0, 30)) {
          const commit = bykey.get(key);
          if (commit) add(commitPoint(tab, commit));
        }
      }
      for (const title of ["Feeders landed", "Parts merged"])
        add({ tab, item: { kind: "change", key: title } });
    }
    return threads.threads.filter((thread: ReviewThread) => {
      const part = thread.anchor.effort!;
      if (part.tab !== tab || !part.item) return false;
      return !drawn.has(
        pointKey({
          tab: part.tab,
          item: part.item,
          ...(part.plan ? { plan: part.plan } : {}),
        }),
      );
    });
  }, [detail, summary, tab, dirs, threads.threads]);

  let body: ReactNode;
  if (error) body = <p className="assistant-error">{error}</p>;
  else if (!detail || !summary)
    body = <p className="assistant-hint">Reading the effort...</p>;
  else if (tab === "progress")
    body = (
      <div className="mr-effort-progress">
        <EffortBar summary={summary} />
        <EffortCounts summary={summary} pointed={pointed} />
        {counterPoints(summary).map((point) => (
          <EffortThreadsAt key={pointKey(point)} point={point} />
        ))}
        {summary.overlaps.length ? (
          <ul className="mr-effort-overlaps" aria-label="Overlaps">
            {summary.overlaps.map((each) => (
              <li key={each.with}>
                {each.shared} commits also in {each.with} ({each.relation}):{" "}
                {each.proposal}
              </li>
            ))}
          </ul>
        ) : null}
        <Burndown daily={detail.daily} />
        <table className="mr-effort-dirs">
          <thead>
            <tr>
              <th>Directory</th>
              {MR_DISPOSITIONS.map((each) => (
                <th key={each}>{DISPOSITION_TITLE[each]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dirs.slice(0, 30).map(([dir, counts]) => {
              const point: EffortPoint = {
                tab: "progress",
                item: { kind: "directory", key: dir },
              };
              return (
                <Fragment key={dir}>
                  <tr {...effortItemProps(point, pointed)}>
                    <td>{dir}</td>
                    {MR_DISPOSITIONS.map((each) => (
                      <td key={each}>{counts[each] ?? ""}</td>
                    ))}
                  </tr>
                  {hasThreadsAt(point) ? (
                    <tr className="mr-effort-threads-row">
                      <td colSpan={MR_DISPOSITIONS.length + 1}>
                        <EffortThreadsAt point={point} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  else if (tab === "ledger")
    body = (
      <>
        <input
          ref={searchRef}
          type="search"
          className="mr-reviews-search"
          aria-label="Filter the ledger"
          placeholder="Filter (/): words, disposition:, dir:, file:, author:"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
        />
        <p className="assistant-hint">
          {shown.length} of {detail.commits.length}
          {selected.size ? ` · ${selected.size} selected` : ""} · j/k move · x
          select · V range · :mark not-upstream REASON · :supersede REF · :plan
          NAME · :confirm [N] · :reject [N|all] · :unsort · u undo · d its diff
          in the head workspace · Enter its history
        </p>
        <MrLedgerTable
          commits={shown}
          selected={selected}
          cursor={cursor}
          onCursor={setCursor}
          onToggle={(key) =>
            setSelected((current) => {
              const next = new Set(current);
              if (!next.delete(key)) next.add(key);
              return next;
            })
          }
          {...(detail.proposals ? { proposals: detail.proposals } : {})}
          threads={ledgerThreads}
        />
        {shown[cursor] ? (
          <EffortThreadsAt point={ledgerPoint(shown[cursor]!)} />
        ) : null}
        {shown[cursor] && detail.proposals?.[shown[cursor]!.key]?.length ? (
          <section
            className="mr-effort-proposals"
            aria-label="Proposed matches"
          >
            <h4>Upstream commits that look like it</h4>
            <ol>
              {detail.proposals[shown[cursor]!.key]!.map((each) => (
                <li key={each.sha}>
                  <code>{each.sha.slice(0, 10)}</code> {each.subject}{" "}
                  <small>
                    {each.author} · {each.score} · {each.why}
                  </small>{" "}
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      void write(
                        "ledger.match",
                        {
                          decisions: [
                            {
                              commit: shown[cursor]!.key,
                              match: each.sha,
                              accept: true,
                            },
                          ],
                        },
                        () => "Match confirmed",
                      )
                    }
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      void write(
                        "ledger.match",
                        {
                          decisions: [
                            {
                              commit: shown[cursor]!.key,
                              match: each.sha,
                              accept: false,
                            },
                          ],
                        },
                        () => "Rejected",
                      )
                    }
                  >
                    Reject
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {history ? (
          <section className="mr-effort-history" aria-label="Its versions">
            <h4>Its versions, oldest first</h4>
            <p className="assistant-hint">
              Pick two, then d (or Diff) compares them in the head workspace.
            </p>
            <ol>
              {history.map((version, index) => {
                const sha = String(version.sha);
                return (
                  <li key={index}>
                    <label>
                      <input
                        type="checkbox"
                        checked={versions.includes(sha)}
                        onChange={() =>
                          setVersions((current) =>
                            current.includes(sha)
                              ? current.filter((each) => each !== sha)
                              : [...current, sha].slice(-2),
                          )
                        }
                      />{" "}
                      <code>{sha.slice(0, 10)}</code> {String(version.subject)}{" "}
                      <small>
                        {String(version.where)} ·{" "}
                        {String(version.seenAt).slice(0, 16).replace("T", " ")}
                      </small>
                    </label>
                  </li>
                );
              })}
            </ol>
            {versions.length === 2 ? (
              <button
                type="button"
                className="ghost"
                onClick={() => diffVersions(versions[0]!, versions[1]!)}
              >
                Diff
              </button>
            ) : null}
            {diff !== null ? (
              <pre className="mr-effort-diff" aria-label="Between the two">
                {diff}
              </pre>
            ) : null}
          </section>
        ) : null}
      </>
    );
  else if (tab === "plans")
    body = (
      <PlansList
        detail={detail}
        write={write}
        makePart={makePart}
        pointed={pointed}
      />
    );
  else if (tab === "changes")
    body = (
      <WhatChanged
        detail={detail}
        pointed={pointed}
        onSeen={() => void mrReviewsCall("effort.seen", { id }).then(load)}
      />
    );
  else
    body = detail.feeders.length ? (
      <ul className="mr-effort-feeders" aria-label="Feeders">
        {detail.feeders.map((feeder) => {
          const point: EffortPoint = {
            tab: "feeders",
            item: { kind: "feeder", key: feeder.ref },
          };
          return (
            <li key={feeder.ref} {...effortItemProps(point, pointed)}>
              <code>{feeder.ref.replace(/^refs\/(heads|remotes)\//, "")}</code>:{" "}
              {feeder.notReady} not on the source yet, {feeder.drift} behind it
              <EffortThreadsAt point={point} />
            </li>
          );
        })}
      </ul>
    ) : (
      <p className="assistant-hint">
        No feeder: say which branches land into the source with effort_set.
      </p>
    );

  return (
    <EffortThreadsProvider value={threads}>
      <section
        ref={rootRef}
        tabIndex={-1}
        className="mr-effort-view"
        aria-label={`Effort ${detail?.effort.name ?? ""}`}
        onKeyDown={onKey}
        onClick={(event) => {
          // A click points at what it is on, for c to comment on.
          const target = event.target as Element;
          if (tab === "ledger" || target.closest(".mr-effort-thread")) return;
          const item = target.closest("[data-effort-item]");
          if (item) setPointed(pointOf(item, tab));
        }}
      >
        <div className="assistant-section-heading">
          <button type="button" className="ghost" onClick={onBack}>
            <ChevronLeft size={13} /> All reviews
          </button>
          <strong>{detail?.effort.name}</strong>
          <button
            type="button"
            className="ghost"
            title="Read it again now"
            onClick={() =>
              void mrReviewsCall("effort.refresh", { id }).then(load)
            }
          >
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            className="ghost"
            onClick={onLeader}
            title="The Claude session of its head workspace (gl)"
          >
            Leader session
          </button>
          <button
            type="button"
            className="ghost mr-effort-comment"
            title="Comment for the leader session on the words selected, else on what the cursor is on (c); on the tab (C)"
            // Keeps the words selected while pressed.
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={commentHere}
          >
            <MessageSquarePlus size={13} /> Comment
          </button>
          {threads.open ? (
            <button
              type="button"
              className="mr-reviews-chip is-changed mr-effort-open-threads"
              title="Open threads on this effort: the next one (gn)"
              onClick={() => stepThread(1, true)}
            >
              {threads.open} open thread{threads.open === 1 ? "" : "s"}
            </button>
          ) : null}
          {threads.waiting ? (
            <span
              className="mr-reviews-chip is-wait mr-effort-waiting"
              role="status"
              title={threads.waiting.reason}
            >
              {threads.waiting.count}{" "}
              {threads.waiting.noLeader
                ? "waiting for the leader session"
                : "not delivered"}
            </span>
          ) : null}
          <button
            type="button"
            className="ghost"
            title="Delete this effort, after a confirmation (:delete)"
            onClick={() => setDeleting(true)}
          >
            <Trash2 size={13} /> {"Delete effort\u2026"}
          </button>
        </div>
        <nav className="assistant-primary-nav" aria-label="Effort views">
          {TABS.map((each) => (
            <button
              key={each.tab}
              type="button"
              className="ghost"
              aria-pressed={tab === each.tab}
              title={each.key}
              onClick={() => setTab(each.tab)}
            >
              {each.label}
              {each.tab === "changes" && summary?.changed
                ? ` (${summary.changed})`
                : ""}
            </button>
          ))}
        </nav>
        {detail && summary ? (
          <EffortThreadsAt point={{ tab }} extra={away} />
        ) : null}
        {body}
        {threads.error ? (
          <p className="assistant-error" role="alert">
            {threads.error}{" "}
            <button
              type="button"
              className="ghost"
              onClick={threads.clearError}
            >
              Dismiss
            </button>
          </p>
        ) : null}
        {helpOpen ? (
          <div className="agent-tasks-help" role="note" aria-label="Keys">
            <dl>
              {EFFORT_KEYS.map(([keys, label]) => (
                <div key={keys}>
                  <dt>
                    {keys
                      .split(" ")
                      .map((key, index) =>
                        key === "/" ? (
                          <span key={index}> / </span>
                        ) : (
                          <kbd key={index}>{key}</kbd>
                        ),
                      )}
                  </dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
        {selection
          ? createPortal(
              <button
                type="button"
                className="chat-thread-select mr-effort-select"
                style={{ left: selection.x, top: selection.y }}
                // Keeps the selection while the button is pressed.
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  threads.comment(
                    pointOf(selection.element, tab),
                    selection.quote,
                  );
                }}
              >
                Comment
              </button>,
              document.body,
            )
          : null}
        {command !== null ? (
          <div className="mr-reviews-command">
            <span aria-hidden="true">:</span>
            <input
              ref={commandRef}
              type="text"
              aria-label="Ledger command"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onBlur={() => setCommand(null)}
            />
          </div>
        ) : null}
        <ConfirmDialog
          open={deleting}
          title={`Delete the effort ${detail?.effort.name ?? ""}?`}
          message={`${detail?.effort.name ?? "This effort"} leaves Reviews with its card, its ledger marks, its plans and its history${summary ? ` (${summary.total} commits)` : ""}. Its parts' branches and worktrees stay as they are, and so do the other efforts. Undo brings it all back.`}
          confirmLabel="Delete effort"
          danger
          onConfirm={() => void deleteEffort()}
          onClose={() => {
            setDeleting(false);
            rootRef.current?.focus({ preventScroll: true });
          }}
        />
      </section>
    </EffortThreadsProvider>
  );
}

/** The counts of the Progress tab, each one a place to comment on. */
function counterPoints(summary: MrEffortSummary): EffortPoint[] {
  return [
    "total",
    ...MR_DISPOSITIONS.filter((each) => summary.counts[each]),
    ...(summary.notReady ? ["not_ready"] : []),
  ].map((key) => ({
    tab: "progress",
    item: { kind: "counter", key },
  }));
}

/** countsText, each count one can point at. */
function EffortCounts({
  summary,
  pointed,
}: {
  summary: MrEffortSummary;
  pointed: EffortPoint | null;
}) {
  const at = (key: string, label: string): EffortPoint => ({
    tab: "progress",
    item: { kind: "counter", key, label },
  });
  const parts = MR_DISPOSITIONS.filter((each) => summary.counts[each]);
  return (
    <p className="mr-effort-counts">
      <span
        {...effortItemProps(at("total", `${summary.total} commits`), pointed)}
      >
        {summary.total} commits
      </span>
      :{" "}
      {parts.length
        ? parts.map((each, index) => {
            const label = `${summary.counts[each]} ${DISPOSITION_TITLE[each]}`;
            return (
              <Fragment key={each}>
                {index ? ", " : ""}
                <span {...effortItemProps(at(each, label), pointed)}>
                  {label}
                </span>
              </Fragment>
            );
          })
        : "none read yet"}
      {summary.notReady ? (
        <>
          ;{" "}
          <span
            {...effortItemProps(
              at("not_ready", `${summary.notReady} not ready in feeders`),
              pointed,
            )}
          >
            {summary.notReady} not ready in feeders
          </span>
        </>
      ) : null}
    </p>
  );
}

/** Planned requests: accepted, proposed, their parts. */
function PlansList({
  detail,
  write,
  makePart,
  pointed,
}: {
  detail: EffortDetail;
  pointed: EffortPoint | null;
  write: (
    method: string,
    params: Record<string, unknown>,
    label: (done: any) => string,
  ) => Promise<unknown>;
  makePart: (name: string) => void;
}) {
  const plans = detail.plans ?? [];
  const bykey = new Map(detail.commits.map((commit) => [commit.key, commit]));
  const names = new Map(plans.map((plan) => [plan.id, plan.name]));
  if (!plans.length)
    return (
      <p className="assistant-hint">
        No planned request yet. The leader session proposes them (gl), or select
        commits in the Ledger and :plan NAME.
      </p>
    );
  return (
    <ul className="mr-effort-plans" aria-label="Planned requests">
      {plans.map((plan) => (
        <li
          key={plan.id}
          className={`is-${plan.state}`}
          {...effortItemProps(
            {
              tab: "plans",
              item: { kind: "plan", key: plan.id, label: plan.name },
            },
            pointed,
          )}
        >
          <div className="mr-reviews-dense-head">
            <strong>{plan.name}</strong>
            <span className="mr-reviews-dense-chips">
              <span className="mr-reviews-chip is-tree">
                {plan.state === "accepted" ? "accepted" : "proposed"}
              </span>
              <span className="mr-reviews-chip">
                {plan.commits.length} commit
                {plan.commits.length === 1 ? "" : "s"}
              </span>
              {plan.dependsOn.length ? (
                <span className="mr-reviews-chip is-wait">
                  after{" "}
                  {plan.dependsOn
                    .map((each) => names.get(each) ?? each)
                    .join(", ")}
                </span>
              ) : null}
              {plan.by === "agent" ? (
                <span className="mr-reviews-chip">by Claude</span>
              ) : null}
            </span>
          </div>
          <EffortThreadsAt
            point={{ tab: "plans", item: { kind: "plan", key: plan.id } }}
          />
          <ol className="mr-effort-plan-commits">
            {(() => {
              // Fixups fold into their targets when the part is made.
              const known = plan.commits.map((key) => bykey.get(key));
              const targets = fixupTargets(
                known.map((commit) => commit ?? { sha: "", subject: "" }),
              );
              const folds = (index: number) => {
                const target = targets[index];
                if (target === undefined || !known[index] || plan.part?.from)
                  return null;
                if (target < 0)
                  return "its target is not in this plan: it stays a commit";
                const into = known[target]?.sha.slice(0, 10) ?? "";
                return plan.part
                  ? `folded into ${into} in the part`
                  : `folded into ${into} when the part is made`;
              };
              return plan.commits.slice(0, 12).map((key, index) => {
                const commit = bykey.get(key);
                const point = commit
                  ? commitPoint("plans", commit, plan.id)
                  : null;
                const note = folds(index);
                return (
                  <li
                    key={key}
                    {...(point ? effortItemProps(point, pointed) : {})}
                  >
                    <code>{commit?.sha.slice(0, 10) ?? "gone"}</code>{" "}
                    {commit?.subject ?? "no longer on the source"}
                    {note ? (
                      <span className="mr-effort-plan-fold"> ({note})</span>
                    ) : null}
                    {point ? <EffortThreadsAt point={point} /> : null}
                  </li>
                );
              });
            })()}
            {plan.commits.length > 12 ? (
              <li>and {plan.commits.length - 12} more</li>
            ) : null}
          </ol>
          {plan.part ? (
            <p className="assistant-hint">
              Part <code>{plan.part.branch}</code> in {plan.part.path}
              {plan.part.from ? (
                <>
                  {" "}
                  from <code>{plan.part.from}</code>
                  {plan.part.ported
                    ? " (ported: differs from the plan's commits)"
                    : null}
                </>
              ) : plan.part.base ? (
                <>
                  {" "}
                  on <code>{plan.part.base}</code>
                </>
              ) : null}
              {plan.part.conflict
                ? `: stopped ${plan.part.conflict.folding ? "folding fixups " : ""}at ${plan.part.conflict.sha.slice(0, 10)} ${plan.part.conflict.subject} (${plan.part.conflict.files.join(", ") || "empty"}); resolve it there`
                : ""}
            </p>
          ) : null}
          <div className="assistant-task-buttons">
            {plan.state === "proposed" ? (
              <button
                type="button"
                className="primary"
                onClick={() =>
                  void write(
                    "ledger.plans",
                    { action: "accept", plan: plan.id },
                    () => `${plan.name} accepted`,
                  )
                }
              >
                Accept
              </button>
            ) : null}
            {plan.state === "accepted" && !plan.part ? (
              <button
                type="button"
                className="primary"
                title="A worktree in the effort's group with these commits picked"
                onClick={() => makePart(plan.id)}
              >
                Make its part
              </button>
            ) : null}
            <button
              type="button"
              className="ghost"
              onClick={() =>
                void write(
                  "ledger.plans",
                  { action: "drop", plan: plan.id },
                  () => `${plan.name} dropped`,
                )
              }
            >
              Drop
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** What changed since the user last looked at the effort. */
/** What changed's lists of commits, by their heading. */
function changeLists(changes: MrEffortChanges): [string, string[]][] {
  return [
    ["New unsorted commits", changes.unsorted],
    ["Landed upstream", changes.landed],
    ["Now in review", changes.inReview],
    ["Matches to confirm (Ledger, :confirm or :reject)", changes.proposals],
    ["Upstream anyway (said not for upstream)", changes.upstreamAnyway],
  ];
}

/** A part of What changed, by its heading. */
function changePoint(title: string): EffortPoint {
  return { tab: "changes", item: { kind: "change", key: title } };
}

function WhatChanged({
  detail,
  pointed,
  onSeen,
}: {
  detail: EffortDetail;
  pointed: EffortPoint | null;
  onSeen: () => void;
}) {
  const changes = detail.changes;
  const bykey = new Map(detail.commits.map((commit) => [commit.key, commit]));
  const heading = (title: string, children: ReactNode) => (
    <>
      <h4 {...effortItemProps(changePoint(title), pointed)}>{children}</h4>
      <EffortThreadsAt point={changePoint(title)} />
    </>
  );
  const list = (title: string, keys: string[]) =>
    keys.length ? (
      <section key={title}>
        {heading(
          title,
          <>
            {title} ({keys.length})
          </>,
        )}
        <ul>
          {keys.slice(0, 30).map((key) => {
            const commit = bykey.get(key);
            const point = commit ? commitPoint("changes", commit) : null;
            return (
              <li key={key} {...(point ? effortItemProps(point, pointed) : {})}>
                <code>{commit?.sha.slice(0, 10)}</code> {commit?.subject ?? key}
                {point ? <EffortThreadsAt point={point} /> : null}
              </li>
            );
          })}
          {keys.length > 30 ? <li>and {keys.length - 30} more</li> : null}
        </ul>
      </section>
    ) : null;
  const [unsorted, landed, inReview, proposals, upstreamAnyway] = changes
    ? changeLists(changes)
    : [];
  if (!changes) return <p className="assistant-hint">Nothing read yet.</p>;
  const empty =
    !changes.unsorted.length &&
    !changes.landed.length &&
    !changes.inReview.length &&
    !changes.feeders.length &&
    !changes.partsMerged.length &&
    !changes.proposals.length &&
    !changes.upstreamAnyway.length;
  return (
    <div className="mr-effort-changes" aria-label="What changed">
      <p className="assistant-hint">
        Since{" "}
        {changes.since
          ? changes.since.slice(0, 16).replace("T", " ")
          : "the first reading"}
        .{" "}
        <button type="button" className="ghost" onClick={onSeen}>
          Seen (:seen)
        </button>
      </p>
      {empty ? <p>Nothing new.</p> : null}
      {list(...unsorted!)}
      {list(...landed!)}
      {list(...inReview!)}
      {changes.feeders.length ? (
        <section>
          {heading("Feeders landed", "Feeders landed")}
          <ul>
            {changes.feeders.map((each) => (
              <li key={each.ref}>
                <code>{each.ref.replace(/^refs\/(heads|remotes)\//, "")}</code>:{" "}
                {each.landed} commit{each.landed === 1 ? "" : "s"} reached the
                source
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {changes.partsMerged.length ? (
        <section>
          {heading("Parts merged", "Parts merged")}
          <ul>
            {changes.partsMerged.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {list(...proposals!)}
      {list(...upstreamAnyway!)}
    </div>
  );
}

/** What a menu opens the declaring with: the home and the source. */
export type MrDeclarePrefill = {
  /** A group node id, or a workspace's `upstreamWorkspaceHome`. */
  home?: string;
  /** The source branch (the head workspace's branch). */
  source?: string;
};

/**
 * Declaring an effort on a group or a workspace headed upstream, its
 * overlaps shown first.
 */
export function MrEffortDeclare({
  groups,
  workspaces = [],
  initial,
  onDone,
  onCancel,
}: {
  /** The groups headed upstream, by id. */
  groups: string[];
  /** The workspaces headed upstream by themselves. */
  workspaces?: WorkspaceRef[];
  initial?: MrDeclarePrefill;
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const tree = useWorkspaceTree();
  const named = [
    ...groups.flatMap((id) => {
      const node = tree.nodes.find((each) => each.id === id);
      return node?.kind === "group" ? [{ id, label: node.label }] : [];
    }),
    ...workspaces.map((ref) => ({
      id: upstreamWorkspaceHome(ref),
      label: ref.label || ref.path || "Workspace",
    })),
  ];
  const [picked, setGroup] = useState(initial?.home ?? "");
  // The homes may arrive after the form opens: the one asked for, else the
  // first.
  const group = named.some((each) => each.id === picked)
    ? picked
    : (named[0]?.id ?? "");
  const [name, setName] = useState("");
  const [source, setSource] = useState(initial?.source ?? "");
  const [target, setTarget] = useState("origin/main");
  const [feeders, setFeeders] = useState("");
  const [preview, setPreview] = useState<MrEffortSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const params = () => ({
    group,
    ...(name.trim() ? { name: name.trim() } : {}),
    source: source.trim(),
    target: target.trim(),
    feeders: feeders.split(/[\s,]+/).filter(Boolean),
  });
  const run = async (method: "effort.preview" | "effort.set") => {
    setBusy(true);
    setError(null);
    try {
      const answer = await mrReviewsCall<{
        effort: MrEffort;
        preview?: MrEffortSummary;
      }>(method, params());
      if (method === "effort.preview") setPreview(answer.preview ?? null);
      else onDone(answer.effort.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!named.length)
    return (
      <p className="assistant-hint">
        Mark a workspace or a group of the Workspaces tree as Headed upstream
        first (the workspace or group menu), with the source's clone among its
        workspaces.
      </p>
    );
  return (
    <form
      className="mr-override-form"
      aria-label="Declare an effort"
      onSubmit={(event) => {
        event.preventDefault();
        void run(preview ? "effort.set" : "effort.preview");
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <label>
        <span>Home</span>
        <select
          value={group}
          onChange={(event) => setGroup(event.target.value)}
        >
          {named.map((each) => (
            <option key={each.id} value={each.id}>
              {each.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Source</span>
        <input
          type="text"
          value={source}
          placeholder="the branch followed (an exact ref when ambiguous)"
          onChange={(event) => {
            setSource(event.target.value);
            setPreview(null);
          }}
        />
      </label>
      <label>
        <span>Target</span>
        <input
          type="text"
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
            setPreview(null);
          }}
        />
      </label>
      <label>
        <span>Feeders</span>
        <input
          type="text"
          value={feeders}
          placeholder="branches landing into the source (optional)"
          onChange={(event) => setFeeders(event.target.value)}
        />
      </label>
      <label>
        <span>Name</span>
        <input
          type="text"
          value={name}
          placeholder="the group's name"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {preview ? (
        <div className="mr-effort-preview" role="status">
          <EffortBar summary={preview} />
          <p>{countsText(preview)}</p>
          {preview.overlaps.map((each) => (
            <p key={each.with}>
              {each.shared} commits also in {each.with}: {each.proposal}
            </p>
          ))}
        </div>
      ) : null}
      {error ? (
        <p className="assistant-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="assistant-task-buttons">
        <button
          type="submit"
          className="primary"
          disabled={busy || !source.trim()}
        >
          {busy ? "Reading..." : preview ? "Declare it" : "Preview"}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
