import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  ExternalLink,
  GripVertical,
  House,
  HousePlus,
  Keyboard,
  LoaderCircle,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Settings,
} from "lucide-react";
import {
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { forgeKind } from "../../../shared/forge";
import {
  MR_LANE_TITLE,
  type MrHostState,
  type MrInboxEntry,
  type MrItem,
  type MrOverrideField,
  type MrReason,
  type MrSavedView,
  type MrSection,
  type MrWorkspaceLink,
  mrHomeLinks,
  mrHomePrompt,
  mrRefLabel,
} from "../../../shared/mrReviews";
import {
  mrFilterCompletions,
  mrFilterMatches,
} from "../../../shared/mrReviewsFilter";
import {
  mrBotFailedLabel,
  mrBotLabel,
  mrMergeTime,
} from "../../../shared/mrReviewsMerge";
import { nextColumn, nextRow } from "../boardNavigation";
import { roamgateLocalStorage } from "../browserStorage";
import { useLayoutPreferences } from "../layoutPreferences";
import {
  hideMrRequest,
  loadMrReviewsSettings,
  mrReviewsCall,
  onMrReviewsChange,
  type MrOverrideEdit,
  orderMrRequests,
  overrideMrRequest,
  pinMrRequest,
  saveMrPanel,
  unhideMrRequest,
  unpinMrRequest,
  useMrInbox,
  useMrWorkspaceLinks,
} from "../mrReviews";
import { mrAgentItem, setMrAgentOpener } from "../mrReviewsAgent";
import {
  checkoutMrReview,
  type MrClaudeState,
  mrClaude,
  openMrReview,
  openMrReviewInHome,
  setMrClone,
  showMrClaude,
  startMrReviewHome,
} from "../mrReviewFlow";
import {
  MR_REVIEWS_KEYS,
  moveMrKey,
  mrMatches,
  mrPastedRequest,
  orderMrEntries,
} from "../mrReviewsOrder";
import { WORK_KEYS } from "../mrReviewsKeys";
import { EMPTY_KEY_STATE, feedKey } from "../reviewNavigation";
import {
  keepFoldedLanes,
  type MrLaneRow,
  mrLaneGroups,
  mrLaneSiblings,
  storedFoldedLanes,
} from "../mrReviewsLanes";
import { type BoardMode, requestMrFileOpen } from "../mrReviewsOpen";
import type { ReviewSnapshot } from "../../../shared/review";
import {
  getReviewSnapshot,
  rememberReviewSnapshot,
  requestReviewShown,
  reviewCall,
  useReviewState,
} from "../review";
import { useReviewActivity } from "../reviewActivity";
import { describeReviewTarget, rankReviews } from "../reviewModel";
import {
  localReviewKey,
  localReviewOfKey,
  localReviewsOf,
  movedReviews,
} from "../localReviews";
import { LocalReviewsLane } from "./LocalReviewsLane";
import { MrOverrideForm, MrOverrideSummary, refOfKey } from "./MrOverrideForm";
import { store, useStoreSelector } from "../store";
import { formatUiDateTime } from "../uiLocale";
import { MrReviewsChat } from "./MrReviewsChat";
import {
  MrEffortCard,
  MrEffortDeclare,
  type MrDeclarePrefill,
  MrEffortView,
} from "./MrEffortView";
import { MrReviewsSettingsView } from "./MrReviewsSettings";
import { BoardCard } from "./BoardCard";
import { ShortcutHelp } from "./ShortcutHelp";
import type { WorkOpen } from "../workOpen";
import {
  type BoardCloseOptions,
  useWorkMode,
  useWorkWorkspace,
} from "./WorkBoard";
import "./AssistantPanel.css";
import "./AssistantTasks.css";
import "./AgentTasksSheet.css";
import "./MrReviewsPanel.css";

/**
 * The board, Ranger's sibling: the same panel, head, list rows and state
 * chips, list/detail split and Escape order, in two modes that are two of
 * the workspace inspector's tabs, Work and Reviews ([ ], gt, the Work and
 * Reviews shortcuts, WorkspaceInspectorHost): the
 * reviews inbox (two sections: the requests that are the user's, review
 * requested, assigned, mentioned, and Claude's suggestions from the
 * followed projects, one's own requests in lanes) and the Work board (the
 * user's work items in columns by state, WorkBoard.tsx). The columns, the
 * card frame, the keys and the detail flow are one code path.
 */

/** The view's modes: the reviews inbox, the Work board. */
export type { BoardMode };

const MODE_TITLE: Record<BoardMode, string> = { mr: "Reviews", work: "Work" };

type View = "list" | "settings" | "chat";

/** A request the reviews agent showed, as an inbox entry to open. */
function entryOf(item: MrItem): MrInboxEntry {
  return {
    ...item,
    section: item.reasons.includes("authored")
      ? "authored"
      : item.reasons.length
        ? "mine"
        : "suggested",
    unread: null,
    isNew: false,
  };
}

/** What opening a request needs from the user. */
type Prompt =
  | {
      kind: "clone";
      entry: MrInboxEntry;
      host: string;
      project: string;
      connections: { id: string; label: string }[];
    }
  | { kind: "dirty"; entry: MrInboxEntry; changes: string[] }
  | { kind: "kept"; entry: MrInboxEntry; branch: string }
  | { kind: "busy"; entry: MrInboxEntry; with: string | null }
  | { kind: "claude"; entry: MrInboxEntry; state: MrClaudeState }
  | { kind: "error"; entry: MrInboxEntry; message: string };

function MrPrompt({
  prompt,
  busy,
  onDismiss,
  onRetry,
  onAnswer,
  onWaitClaude,
}: {
  prompt: Prompt;
  busy: boolean;
  onDismiss: () => void;
  onRetry: (entry: MrInboxEntry) => void;
  onAnswer: (entry: MrInboxEntry, local: "wip" | "discard") => void;
  onWaitClaude?: (entry: MrInboxEntry) => void;
}) {
  const [connection, setConnection] = useState(
    prompt.kind === "clone" ? (prompt.connections[0]?.id ?? "") : "",
  );
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const label = mrRefLabel(prompt.entry);
  return (
    <section
      className="assistant-task-overview mr-reviews-prompt"
      role="alertdialog"
      aria-label={`Opening ${label}`}
    >
      {prompt.kind === "clone" ? (
        <>
          <h3 className="mr-reviews-section-title">Where is your clone?</h3>
          <p className="assistant-hint">
            No checkout of {prompt.project} ({prompt.host}) was found in your
            workspaces. Its review worktree goes next to your clone, as{" "}
            <code>&lt;clone&gt;.worktrees/review</code>.
          </p>
          <div className="mr-reviews-settings-add">
            <select
              aria-label="Connection"
              value={connection}
              onChange={(event) => setConnection(event.target.value)}
            >
              {prompt.connections.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
            <input
              aria-label="Path of the clone"
              placeholder="/path/to/clone"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </div>
          {error ? (
            <p className="assistant-task-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="assistant-task-buttons">
            <button
              type="button"
              className="primary"
              disabled={busy || !connection || !path.startsWith("/")}
              onClick={() =>
                void setMrClone({
                  host: prompt.host,
                  project: prompt.project,
                  provider: prompt.entry.provider,
                  connectionId: connection,
                  path: path.trim(),
                }).then(
                  () => onRetry(prompt.entry),
                  (cause) =>
                    setError(
                      cause instanceof Error ? cause.message : String(cause),
                    ),
                )
              }
            >
              Use this clone
            </button>
            <button type="button" className="ghost" onClick={onDismiss}>
              Cancel
            </button>
          </div>
        </>
      ) : prompt.kind === "dirty" ? (
        <>
          <h3 className="mr-reviews-section-title">
            The review worktree has local changes
          </h3>
          <p className="assistant-hint">
            The review of {label} is open; checking out its head would touch
            these files. Nothing is changed until you choose.
          </p>
          <ul className="mr-reviews-changes">
            {prompt.changes.map((line) => (
              <li key={line}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
          <div className="assistant-task-buttons">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => onAnswer(prompt.entry, "wip")}
            >
              Keep them as a WIP commit on a review/ branch
            </button>
            <button
              type="button"
              className="ghost danger-text"
              disabled={busy}
              onClick={() => onAnswer(prompt.entry, "discard")}
            >
              Discard them
            </button>
            <button type="button" className="ghost" onClick={onDismiss}>
              Leave the checkout as it is
            </button>
          </div>
        </>
      ) : prompt.kind === "busy" ? (
        <>
          <h3 className="mr-reviews-section-title">Claude is busy</h3>
          <p className="assistant-hint">
            The review of {label} is open. The workspace's Claude is in the
            middle of a turn
            {prompt.with ? ` on ${prompt.with.replace(/^.*\//, "")}` : ""}; it
            is not stopped.
          </p>
          <div className="assistant-task-buttons">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => onWaitClaude?.(prompt.entry)}
            >
              Switch when it is done
            </button>
            <button type="button" className="ghost" onClick={onDismiss}>
              Leave it on its request
            </button>
          </div>
        </>
      ) : prompt.kind === "claude" ? (
        <>
          <h3 className="mr-reviews-section-title">Claude</h3>
          <p className="assistant-hint">
            {prompt.state.state === "foreign"
              ? "A Claude that is not this request's runs in the review workspace; it is left alone. Exit it there to use the request's own."
              : prompt.state.state === "starting"
                ? "Claude is starting in the review workspace (it may ask to trust the folder there)."
                : prompt.state.state === "error"
                  ? prompt.state.message
                  : prompt.state.state === "none"
                    ? "The review workspace has no pane for Claude."
                    : "Claude is ready."}
          </p>
          <div className="assistant-task-buttons">
            <button type="button" className="ghost" onClick={onDismiss}>
              OK
            </button>
          </div>
        </>
      ) : prompt.kind === "kept" ? (
        <>
          <h3 className="mr-reviews-section-title">Changes kept</h3>
          <p className="assistant-hint">
            Your changes are committed on <code>{prompt.branch}</code>; the
            worktree is on {label} now.
          </p>
          <div className="assistant-task-buttons">
            <button type="button" className="ghost" onClick={onDismiss}>
              OK
            </button>
          </div>
        </>
      ) : (
        <>
          <h3 className="mr-reviews-section-title">Cannot open {label}</h3>
          <p className="assistant-task-error" role="alert">
            {prompt.message}
          </p>
          <div className="assistant-task-buttons">
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => onRetry(prompt.entry)}
            >
              Try again
            </button>
            <button type="button" className="ghost" onClick={onDismiss}>
              Close
            </button>
          </div>
        </>
      )}
    </section>
  );
}

const REASON_LABEL: Record<MrReason, string> = {
  review_requested: "review requested",
  assigned: "assigned",
  mentioned: "mentioned",
  authored: "yours",
};

const SECTIONS = ["pinned", "mine", "authored", "suggested"] as const;

const SECTION_TITLE: Record<MrSection, string> = {
  pinned: "Pinned",
  mine: "To review",
  authored: "Mine",
  suggested: "Suggested",
};

/**
 * What the list shows: everything, the requests to review, the user's own,
 * or a saved view (`view:NAME`).
 */
export type MrFilter = "all" | "review" | "mine" | `view:${string}`;
const FILTERS: MrFilter[] = ["all", "review", "mine"];
const FILTER_TITLE: Record<string, string> = {
  all: "All",
  review: "To review",
  mine: "Mine",
};
const filterTitle = (filter: MrFilter) =>
  FILTER_TITLE[filter] ?? filter.slice("view:".length);
const FILTER_KEY = "mrReviewsFilter";
/** The search kept for the next run (and the server's copy's time). */
const SEARCH_KEY = "mrReviewsSearch";
const PANEL_AT_KEY = "mrReviewsPanelAt";
/** How long the search waits for more typing before it is kept. */
const SEARCH_SAVE_MS = 600;

function storedFilter(): MrFilter {
  try {
    const value = roamgateLocalStorage.getItem(FILTER_KEY);
    return FILTERS.includes(value as MrFilter) || value?.startsWith("view:")
      ? (value as MrFilter)
      : "all";
  } catch {
    return "all";
  }
}

function storedText(key: string): string {
  try {
    return roamgateLocalStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** A filter the panel knows, else everything. */
function validFilter(value: string): MrFilter {
  return FILTERS.includes(value as MrFilter) || value.startsWith("view:")
    ? (value as MrFilter)
    : "all";
}

/** Two searches the same once spaces are set aside. */
function sameSearch(a: string, b: string): boolean {
  const norm = (text: string) =>
    text.trim().split(/\s+/).join(" ").toLowerCase();
  return norm(a) === norm(b);
}

function keep(key: string, value: string) {
  try {
    roamgateLocalStorage.setItem(key, value);
  } catch {
    // Kept for this page only when the browser keeps nothing.
  }
}

/** Whether a request is the user's own (pinned or not). */
function isOwn(entry: MrInboxEntry): boolean {
  return entry.reasons.includes("authored");
}

/** Whether a section's request is shown under a filter. */
function filtered(
  entry: MrInboxEntry,
  filter: MrFilter,
  views: MrSavedView[] = [],
): boolean {
  if (filter === "all") return true;
  if (filter.startsWith("view:")) {
    const name = filter.slice("view:".length).toLowerCase();
    const view = views.find((each) => each.name.toLowerCase() === name);
    return !view || mrFilterMatches(entry, view.query);
  }
  return filter === "mine" ? isOwn(entry) : !isOwn(entry);
}

function relative(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** What changed since the user looked, each in a few words. */
export function changeLabels(entry: MrInboxEntry): string[] {
  if (entry.isNew) return ["new"];
  const unread = entry.unread;
  if (!unread?.changed) return [];
  const parts = [
    ...(unread.state ? [unread.state] : []),
    ...("pipeline" in unread ? [`pipeline ${unread.pipeline ?? "gone"}`] : []),
    ...(unread.newApprovals?.length
      ? [`approved by ${unread.newApprovals.join(", ")}`]
      : []),
    ...(unread.conflicts === true
      ? ["conflicts"]
      : unread.conflicts === false
        ? ["conflicts gone"]
        : []),
    ...(unread.unresolved !== undefined
      ? [`${unread.unresolved} unresolved`]
      : []),
    ...(unread.newCommits ? ["new commits"] : []),
    ...(unread.newNotes
      ? [`${unread.newNotes} new comment${unread.newNotes === 1 ? "" : "s"}`]
      : []),
  ];
  return parts.length ? parts : ["updated"];
}

/** What changed since the user looked, in a few words; null when nothing. */
export function unreadLabel(entry: MrInboxEntry): string | null {
  const parts = changeLabels(entry);
  return parts.length ? parts.join(", ") : null;
}

/**
 * For one's own request: only what its chips do not already show (its
 * pipeline, approvals, conflicts, threads and state are chips).
 */
export function ownUnreadLabel(entry: MrInboxEntry): string | null {
  if (entry.isNew) return null;
  const unread = entry.unread;
  if (!unread?.changed) return null;
  const parts = [
    ...(unread.newCommits ? ["new commits"] : []),
    ...(unread.newNotes
      ? [`${unread.newNotes} new comment${unread.newNotes === 1 ? "" : "s"}`]
      : []),
  ];
  return parts.length ? parts.join(", ") : null;
}

const MERGE_FROM = {
  label: "the label was added",
  approval: "the last approval",
  update: "the last update",
} as const;

/**
 * A merge scheduled by a label and a bot merging it (section 15), as
 * chips: "merge after 2 days · mergeable Thu 14:00", "queued to merge by
 * marge-bot", "marge-bot could not merge".
 */
export function mergeChips(
  entry: MrInboxEntry,
  now = Date.now(),
): {
  label: string;
  tone: "good" | "bad" | "wait";
  changed: boolean;
  title?: string;
}[] {
  const merge = entry.merge;
  if (!merge) return [];
  const chips: ReturnType<typeof mergeChips> = [];
  const { after, bot } = merge;
  if (bot?.failed)
    chips.push({
      label: mrBotFailedLabel(bot),
      tone: "bad",
      changed: false,
      title: `${bot.failed.reason} (${formatUiDateTime(bot.failed.at)})`,
    });
  else if (bot?.queued)
    chips.push({
      label: mrBotLabel(bot),
      tone: "good",
      changed: false,
      title: `Recognized by ${bot.via === "auto_merge" ? "auto-merge being set" : bot.via === "queue" ? "the forge's merge queue" : bot.via === "label" ? "its queue label" : `${bot.name} being its ${bot.via}`}`,
    });
  if (after)
    chips.push({
      label: `merge after ${after.delay} · mergeable ${after.ready ? "now" : mrMergeTime(after.at, now)}`,
      tone: after.ready ? "good" : "wait",
      changed: false,
      title: `Label "${after.label}": ${after.delay} from when ${MERGE_FROM[after.from]} (${formatUiDateTime(after.since)}), mergeable ${formatUiDateTime(after.at)}`,
    });
  return chips;
}

const BOT_VIA = {
  assignee: "it is assigned",
  reviewer: "it is a reviewer",
  label: "its queue label",
  queue: "the forge's merge queue",
  auto_merge: "auto-merge being set",
} as const;

/** The detail's Merge line: the scheduled merge and the bot, in full. */
function MergeDetail({ merge }: { merge: NonNullable<MrInboxEntry["merge"]> }) {
  const { after, bot } = merge;
  return (
    <dd className="mr-reviews-merge">
      {bot ? (
        <span>
          {bot.failed
            ? `${mrBotFailedLabel(bot)} (${formatUiDateTime(bot.failed.at)}): ${bot.failed.reason}`
            : `${mrBotLabel(bot)}, recognized by ${bot.via === "assignee" || bot.via === "reviewer" ? `${bot.name}: ${BOT_VIA[bot.via]}` : BOT_VIA[bot.via]}`}
        </span>
      ) : null}
      {after ? (
        <span>
          {`"${after.label}": mergeable ${after.ready ? `since ${formatUiDateTime(after.at)}` : formatUiDateTime(after.at)}, ${after.delay} from when ${MERGE_FROM[after.from]} (${formatUiDateTime(after.since)})`}
        </span>
      ) : null}
    </dd>
  );
}

/** Where one of the user's own requests stands, as chips. */
export function ownChips(entry: MrInboxEntry): {
  label: string;
  tone: "good" | "bad" | "wait";
  changed: boolean;
  title?: string;
}[] {
  const own = entry.own;
  if (!own) return mergeChips(entry);
  const unread = entry.unread?.changed ? entry.unread : null;
  const chips: ReturnType<typeof ownChips> = mergeChips(entry);
  if (entry.pipeline)
    chips.push({
      label: `pipeline ${entry.pipeline}`,
      tone:
        entry.pipeline === "success"
          ? "good"
          : entry.pipeline === "failed"
            ? "bad"
            : "wait",
      changed: !!unread && "pipeline" in unread,
    });
  if (own.changesRequested.length)
    chips.push({
      label: `changes requested by ${own.changesRequested.join(", ")}`,
      tone: "bad",
      changed: false,
    });
  if (own.approvedBy.length || own.approved)
    chips.push({
      label: own.approvedBy.length
        ? `approved by ${own.approvedBy.join(", ")}`
        : "approved",
      tone: "good",
      changed: !!unread?.newApprovals?.length,
    });
  if (own.unresolved)
    chips.push({
      label: `${own.unresolved} unresolved`,
      tone: "wait",
      changed: unread?.unresolved !== undefined,
    });
  if (own.conflicts)
    chips.push({
      label: "conflicts",
      tone: "bad",
      changed: unread?.conflicts === true,
    });
  else if (own.needsRebase)
    chips.push({ label: "needs rebase", tone: "wait", changed: false });
  return chips;
}

function linkTitle(link: MrWorkspaceLink): string {
  const why = link.why
    .map((each) =>
      each === "branch"
        ? "on its branch"
        : each === "name"
          ? "named after it"
          : "its review workspace",
    )
    .join(", ");
  return `${link.label || link.workspaceId} on ${link.connectionLabel} (${why})`;
}

/** The row's house button: its home, else its other workspace, and its key. */
function goTitle(link: MrWorkspaceLink, home: boolean, count: number): string {
  const more = count > 1 ? `; ${count - 1} more in its details (2w...)` : "";
  return `Go to its ${home ? "home" : "workspace"}: ${link.label || link.workspaceId} (w)${more}`;
}

function draftsLabel(entry: MrInboxEntry): string | null {
  if (!entry.drafts) return null;
  return `${entry.drafts} draft${entry.drafts === 1 ? "" : "s"} on ${entry.provider === "gitlab" ? "GitLab" : "GitHub"}`;
}

function stateLabel(entry: MrInboxEntry): string {
  if (entry.state !== "open") return entry.state;
  return entry.draft ? "draft" : "open";
}

function PipelineDot({ status }: { status: MrInboxEntry["pipeline"] }) {
  if (!status) return null;
  return (
    <span
      className={`mr-reviews-pipeline is-${status}`}
      title={`Pipeline: ${status}`}
      role="img"
      aria-label={`Pipeline ${status}`}
    />
  );
}

function hostProblem(host: MrHostState): string | null {
  if (host.state === "ok" || host.state === "pending")
    return host.message ?? null;
  return host.message ?? `${host.host}: ${host.state.replace(/_/g, " ")}`;
}

/** Moving a request in the user's order: by drag, or up / down. */
export type MrRowMove = {
  /** Pressed and dragged with the mouse (not on a phone). */
  drag?: {
    dragging: boolean;
    drop: "before" | "after" | null;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: () => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
  };
  /** Its up / down buttons, shown on the selected one. */
  onStep?: (step: -1 | 1) => void;
  canUp?: boolean;
  canDown?: boolean;
};

type MrChip = ReturnType<typeof ownChips>[number];

/** Chips a row's caller adds (an effort's Board: its plan's). */
export type MrExtraChip = {
  label: string;
  tone: "good" | "bad" | "wait" | "tree";
  title?: string;
};

/**
 * A branch headed upstream: its commits, how far behind, local changes,
 * "not proposed yet"; a request from one: that branch and what is not
 * pushed there.
 */
export function branchChips(
  entry: MrInboxEntry,
): { label: string; tone: "good" | "bad" | "wait" | "tree" }[] {
  const chips: { label: string; tone: "good" | "bad" | "wait" | "tree" }[] = [];
  const branch = entry.branch;
  if (branch) {
    if (entry.unsent) chips.push({ label: "not proposed yet", tone: "wait" });
    chips.push({
      label: `${branch.ahead} commit${branch.ahead === 1 ? "" : "s"}`,
      tone: "tree",
    });
    if (branch.below) chips.push({ label: `on ${branch.below}`, tone: "tree" });
    if (branch.behind)
      chips.push({ label: `${branch.behind} behind`, tone: "wait" });
    if (branch.dirty)
      chips.push({ label: `${branch.dirty} changed`, tone: "wait" });
    if (branch.unpushed)
      chips.push({ label: `${branch.unpushed} unpushed`, tone: "wait" });
    return chips;
  }
  if (entry.fromBranch)
    chips.push({ label: `from ${entry.fromBranch}`, tone: "tree" });
  if (entry.local?.unpushed)
    chips.push({ label: `${entry.local.unpushed} unpushed`, tone: "wait" });
  if (entry.local?.dirty)
    chips.push({ label: `${entry.local.dirty} changed`, tone: "wait" });
  return chips;
}

/** A row's page on the forge: its request's, or its pushed branch's. */
export function mrForgeUrl(
  entry: Pick<MrInboxEntry, "url" | "branch">,
): string | undefined {
  return (entry.branch ? entry.branch.url : entry.url) || undefined;
}

/** The forge's name: "GitLab", "GitHub". */
export function mrForgeName(entry: Pick<MrInboxEntry, "provider">): string {
  return entry.provider === "gitlab" ? "GitLab" : "GitHub";
}

/**
 * A row's reference and title: a link to its page on the forge (a new
 * tab), the rest of the card opening it here.
 */
function MrRowTitle({ entry }: { entry: MrInboxEntry }) {
  const url = mrForgeUrl(entry);
  const label = (
    <>
      <span className="mr-reviews-number">{mrRefLabel(entry, true)}</span>{" "}
      <span className="mr-reviews-title">{entry.title}</span>
    </>
  );
  return (
    <strong>
      {url ? (
        <a
          className="mr-reviews-forge-link"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={-1}
          title={`Open on ${mrForgeName(entry)} (o)`}
          onClick={(event) => event.stopPropagation()}
        >
          {label}
        </a>
      ) : (
        label
      )}
    </strong>
  );
}

/** A request's row as it always was: others' requests, suggestions. */
function MrRowBody({
  entry,
  chips,
  unread,
  drafts,
}: {
  entry: MrInboxEntry;
  chips: MrChip[];
  unread: string | null;
  drafts: string | null;
}) {
  return (
    <>
      <div>
        <MrRowTitle entry={entry} />
        {entry.unavailable ? null : (
          <span className={`assistant-task-state is-${stateLabel(entry)}`}>
            {stateLabel(entry)}
          </span>
        )}
      </div>
      {entry.unavailable ? (
        <span className="mr-reviews-row-meta mr-reviews-unavailable">
          {entry.unavailable}
        </span>
      ) : (
        <span className="mr-reviews-row-meta">
          <PipelineDot status={entry.pipeline} />
          {entry.project} · {entry.author} · {relative(entry.updatedAt)}
        </span>
      )}
      {entry.section === "suggested" && entry.reason ? (
        <small className="mr-reviews-reason">{entry.reason}</small>
      ) : entry.reasons.some((reason) => reason !== "authored") ? (
        <small>
          {entry.reasons
            .filter((reason) => reason !== "authored")
            .map((reason) => REASON_LABEL[reason])
            .join(", ")}
        </small>
      ) : null}
      {chips.length ? (
        <small className="mr-reviews-own" aria-label="Where it stands">
          {chips.map((chip) => (
            <span
              key={chip.label}
              className={`mr-reviews-chip is-${chip.tone}${chip.changed ? " is-changed" : ""}`}
              title={chip.title}
            >
              {chip.label}
            </span>
          ))}
        </small>
      ) : null}
      {unread || drafts ? (
        <small className="mr-reviews-badges">
          {unread ? (
            <em className="mr-reviews-unread" title="Since you last looked">
              {unread}
            </em>
          ) : null}
          {drafts ? <em className="mr-reviews-drafts">{drafts}</em> : null}
        </small>
      ) : null}
    </>
  );
}

/**
 * One's own request, dense: reference, title and chips on one line, the
 * next step on the second (set by hand, or from its status).
 */
function MrDenseRow({
  entry,
  chips,
  tree,
  unread,
  drafts,
  extra,
}: {
  entry: MrInboxEntry;
  chips: MrChip[];
  tree?: MrLaneRow;
  unread: string | null;
  drafts: string | null;
  extra?: MrExtraChip[];
}) {
  const next = entry.next;
  const fromOverride = next?.from === "override";
  const outdated = fromOverride && entry.overrideOutdated;
  const state = stateLabel(entry);
  return (
    <>
      <div className="mr-reviews-dense-head">
        <MrRowTitle entry={entry} />
        <span className="mr-reviews-dense-chips" aria-label="Where it stands">
          {state !== "open" ? (
            <span className={`assistant-task-state is-${state}`}>{state}</span>
          ) : null}
          {tree?.after ? (
            <span className="mr-reviews-chip is-tree">{tree.after}</span>
          ) : null}
          {tree?.children ? (
            <span className="mr-reviews-chip is-tree">
              blocks {tree.children}
            </span>
          ) : null}
          {chips.map((chip) => (
            <span
              key={chip.label}
              className={`mr-reviews-chip is-${chip.tone}${chip.changed ? " is-changed" : ""}`}
              title={chip.title}
            >
              {chip.label}
            </span>
          ))}
          {branchChips(entry).map((chip) => (
            <span
              key={`branch:${chip.label}`}
              className={`mr-reviews-chip is-${chip.tone}`}
            >
              {chip.label}
            </span>
          ))}
          {entry.override?.labels?.map((label) => (
            <span key={`label:${label}`} className="mr-reviews-chip is-label">
              {label}
            </span>
          ))}
          {extra?.map((chip) => (
            <span
              key={`extra:${chip.label}`}
              className={`mr-reviews-chip is-${chip.tone}`}
              title={chip.title}
            >
              {chip.label}
            </span>
          ))}
        </span>
      </div>
      <span className="mr-reviews-next">
        {next ? (
          <span
            className={`mr-reviews-next-text${fromOverride ? " is-set" : ""}${outdated ? " is-outdated" : ""}`}
            title={
              outdated
                ? "Set before the request moved on: check it (e to edit, E to clear)"
                : undefined
            }
          >
            {next.text}
          </span>
        ) : null}
        {fromOverride ? (
          <small className="mr-reviews-setby">
            {outdated
              ? "changed since"
              : next?.by === "agent"
                ? "set by Claude"
                : "set by you"}
          </small>
        ) : next?.from === "inferred" ? (
          <small className="mr-reviews-setby" title="Inferred by Claude">
            inferred
          </small>
        ) : null}
        <small className="mr-reviews-dense-meta">
          <PipelineDot status={entry.pipeline} />
          {entry.project}
          {entry.branch ? ` · ${entry.branch.workspaceLabel}` : ""} ·{" "}
          {relative(entry.updatedAt)}
          {entry.override?.link ? " · link (gx)" : ""}
        </small>
        {unread ? (
          <em className="mr-reviews-unread" title="Since you last looked">
            {unread}
          </em>
        ) : null}
        {drafts ? <em className="mr-reviews-drafts">{drafts}</em> : null}
      </span>
    </>
  );
}

export function MrReviewRow({
  entry,
  selected,
  onSelect,
  onOpen,
  move,
  onRemove,
  links,
  onGoWorkspace,
  onTogglePin,
  onStartHome,
  tree,
  onToggleChildren,
  extra,
  itemProps,
}: {
  /** More chips, after its own (an effort's Board: its plan's). */
  extra?: MrExtraChip[];
  /** More attributes of its item (an effort's Board: what c comments on). */
  itemProps?: Record<string, string | undefined>;
  /** Makes it a home (gH): shown on the selected request without one. */
  onStartHome?: () => void;
  /** In a lane: its depth, children, and parent. */
  tree?: MrLaneRow;
  /** Folds or unfolds the requests drawn under it (za). */
  onToggleChildren?: () => void;
  entry: MrInboxEntry;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  move?: MrRowMove;
  /** Takes it out of the view (d); on the selected row, always on a broken pin. */
  onRemove?: () => void;
  /** Its workspaces, on every connection. */
  links?: MrWorkspaceLink[];
  onGoWorkspace?: (link: MrWorkspaceLink) => void;
  /** Pins it on top, or unpins it (P); on the selected row. */
  onTogglePin?: () => void;
}) {
  const dense = !!entry.lane;
  const unread = dense ? ownUnreadLabel(entry) : unreadLabel(entry);
  const drafts = draftsLabel(entry);
  // Dense rows say a pipeline that passed by its dot alone.
  const chips = ownChips(entry).filter(
    (chip) => !dense || chip.label !== "pipeline success" || chip.changed,
  );
  const homes = mrHomeLinks(links);
  const first = homes[0] ?? links?.[0];
  const drag = move?.drag;
  const depth = tree?.depth ?? 0;
  const url = mrForgeUrl(entry);
  const go = first && onGoWorkspace ? first : null;
  const startHome =
    selected &&
    onStartHome &&
    !homes.length &&
    !entry.unavailable &&
    !entry.branch;
  const pin = selected && onTogglePin && !entry.unavailable && !entry.branch;
  const remove = onRemove && !entry.branch && (selected || entry.unavailable);
  const classes = [
    go || (remove && entry.unavailable) ? "has-action" : "",
    drag?.dragging ? "is-dragging" : "",
    drag?.drop ? `is-drop-${drag.drop}` : "",
    depth ? "is-child" : "",
    tree?.last ? "is-last-child" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <BoardCard
      selected={selected}
      unread={!!unread}
      className={classes}
      style={
        depth
          ? ({ "--mr-depth": depth } as unknown as CSSProperties)
          : undefined
      }
      // The card: a link to the forge inside, so not a <button>. Enter, as
      // every key, is the panel's (the Board's).
      data={{ "data-mr-key": entry.key }}
      item={{
        ...itemProps,
        draggable: drag ? true : undefined,
        onDragStart: drag?.onDragStart,
        onDragOver: drag?.onDragOver,
        onDragLeave: drag?.onDragLeave,
        onDrop: drag?.onDrop,
        onDragEnd: drag?.onDragEnd,
      }}
      onSelect={onSelect}
      onOpen={onOpen}
      extra={
        tree?.children ? (
          <span className="mr-reviews-fold-place">
            <button
              type="button"
              className="assistant-icon-button mr-reviews-fold"
              aria-label={
                tree.collapsed
                  ? "Show the requests after it"
                  : "Fold the requests after it"
              }
              aria-expanded={!tree.collapsed}
              title={`${tree.collapsed ? "Show" : "Fold"} the ${tree.children} request${tree.children === 1 ? "" : "s"} waiting for it (za)`}
              onClick={onToggleChildren}
            >
              {tree.collapsed ? (
                <ChevronRight size={14} />
              ) : (
                <ChevronDown size={14} />
              )}
            </button>
          </span>
        ) : null
      }
      // Its actions, over the card's top right corner: never beside it, so
      // a card keeps its width selected or not. Its home stays; the others
      // show on hover and on the selected card.
      actions={
        <>
          {drag ? (
            <span
              className="mr-reviews-grip mr-reviews-action-more"
              title="Drag to reorder (J / K)"
              aria-hidden="true"
            >
              <GripVertical size={13} />
            </span>
          ) : null}
          {url ? (
            <a
              className="assistant-icon-button mr-reviews-forge mr-reviews-action-more"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              tabIndex={selected ? 0 : -1}
              aria-label={`Open on ${mrForgeName(entry)} (o)`}
              title={`Open on ${mrForgeName(entry)} (o)`}
            >
              <ExternalLink size={14} />
            </a>
          ) : null}
          {startHome ? (
            <button
              type="button"
              className="assistant-icon-button mr-reviews-action-more"
              aria-label="Start a review with a home (gH)"
              title="Start a review with a home (gH): a workspace of its own with a Claude session told its job"
              onClick={onStartHome}
            >
              <HousePlus size={14} />
            </button>
          ) : null}
          {pin ? (
            <button
              type="button"
              className="assistant-icon-button mr-reviews-action-more"
              aria-label={entry.section === "pinned" ? "Unpin (P)" : "Pin (P)"}
              title={
                entry.section === "pinned" ? "Unpin (P)" : "Pin it on top (P)"
              }
              aria-pressed={entry.section === "pinned"}
              onClick={onTogglePin}
            >
              {entry.section === "pinned" ? (
                <PinOff size={14} />
              ) : (
                <Pin size={14} />
              )}
            </button>
          ) : null}
          {remove ? (
            <button
              type="button"
              className={`assistant-icon-button${entry.unavailable && !selected ? "" : " mr-reviews-action-more"}`}
              aria-label={
                entry.section === "pinned" ? "Unpin (dd)" : "Hide (dd)"
              }
              title={
                entry.section === "pinned"
                  ? "Unpin (dd)"
                  : "Hide it from the view (dd, u undoes)"
              }
              onClick={onRemove}
            >
              <EyeOff size={14} />
            </button>
          ) : null}
          {selected && move?.onStep ? (
            <>
              <button
                type="button"
                className="assistant-icon-button mr-reviews-action-more"
                aria-label="Move up (K)"
                title="Move up (K)"
                disabled={!move.canUp}
                onClick={() => move.onStep?.(-1)}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                className="assistant-icon-button mr-reviews-action-more"
                aria-label="Move down (J)"
                title="Move down (J)"
                disabled={!move.canDown}
                onClick={() => move.onStep?.(1)}
              >
                <ArrowDown size={14} />
              </button>
            </>
          ) : null}
          {go ? (
            <button
              type="button"
              className="assistant-icon-button mr-reviews-workspace"
              aria-label={goTitle(go, homes.length > 0, links!.length)}
              title={goTitle(go, homes.length > 0, links!.length)}
              onClick={() => onGoWorkspace!(go)}
            >
              <House size={14} />
              {links!.length > 1 ? <small>{links!.length}</small> : null}
            </button>
          ) : null}
        </>
      }
    >
      {dense ? (
        <MrDenseRow
          entry={entry}
          chips={chips}
          tree={tree}
          unread={unread}
          drafts={drafts}
          {...(extra ? { extra } : {})}
        />
      ) : (
        <MrRowBody
          entry={entry}
          chips={chips}
          unread={unread}
          drafts={drafts}
        />
      )}
    </BoardCard>
  );
}

function MrDetail({
  entry,
  onBack,
  actions,
  links,
  onGoWorkspace,
  board,
  editor,
}: {
  entry: MrInboxEntry;
  onBack: () => void;
  actions?: ReactNode;
  /** Lane, next step and what was set by hand (dl rows). */
  board?: ReactNode;
  /** The form to set them, while editing (e). */
  editor?: ReactNode;
  links?: MrWorkspaceLink[];
  onGoWorkspace?: (link: MrWorkspaceLink) => void;
}) {
  const chips = ownChips(entry);
  const unread = unreadLabel(entry);
  const drafts = draftsLabel(entry);
  const kind = forgeKind(entry.provider);
  if (entry.branch)
    return (
      <MrBranchDetail
        entry={entry}
        onBack={onBack}
        actions={actions}
        board={board}
        editor={editor}
        links={links}
        onGoWorkspace={onGoWorkspace}
      />
    );
  return (
    <>
      <div className="assistant-section-heading">
        <button type="button" className="ghost" onClick={onBack}>
          <ChevronLeft size={13} /> All reviews
        </button>
      </div>
      <section className="assistant-task-overview mr-reviews-detail">
        <div className="assistant-task-heading">
          <h3>
            <span className="mr-reviews-number">{mrRefLabel(entry)}</span>{" "}
            {entry.title}
          </h3>
          <span className={`assistant-task-state is-${stateLabel(entry)}`}>
            {stateLabel(entry)}
          </span>
        </div>
        {entry.reason ? (
          <p className="mr-reviews-reason">{entry.reason}</p>
        ) : null}
        {editor}
        <dl className="assistant-task-metadata">
          {board}
          <div>
            <dt>Author</dt>
            <dd>{entry.author}</dd>
          </div>
          <div>
            <dt>Branches</dt>
            <dd>
              {entry.sourceBranch} → {entry.targetBranch}
            </dd>
          </div>
          <div>
            <dt>Pipeline</dt>
            <dd>
              <PipelineDot status={entry.pipeline} /> {entry.pipeline ?? "none"}
            </dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatUiDateTime(entry.updatedAt)}</dd>
          </div>
          {entry.reasons.length ? (
            <div>
              <dt>Why</dt>
              <dd>{entry.reasons.map((r) => REASON_LABEL[r]).join(", ")}</dd>
            </div>
          ) : null}
          {chips.length ? (
            <div>
              <dt>Where it stands</dt>
              <dd className="mr-reviews-own">
                {chips.map((chip) => (
                  <span
                    key={chip.label}
                    className={`mr-reviews-chip is-${chip.tone}${chip.changed ? " is-changed" : ""}`}
                    title={chip.title}
                  >
                    {chip.label}
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
          {entry.merge ? (
            <div>
              <dt>Merge</dt>
              <MergeDetail merge={entry.merge} />
            </div>
          ) : null}
          <div>
            <dt>Since you looked</dt>
            <dd>{unread ?? "nothing new"}</dd>
          </div>
          <div>
            <dt>Workspaces</dt>
            <dd>
              {links?.length ? (
                <ul className="mr-reviews-links" aria-label="Its workspaces">
                  {links.map((link, index) => (
                    <li key={`${link.connectionId}\n${link.workspaceId}`}>
                      <button
                        type="button"
                        className="ghost"
                        title={`${linkTitle(link)} (${index ? `${index + 1}w` : "w"})`}
                        onClick={() => onGoWorkspace?.(link)}
                      >
                        <House size={13} /> {link.label || link.workspaceId}
                      </button>{" "}
                      <small>
                        {link.connectionLabel} ·{" "}
                        {link.why
                          .map((each) =>
                            each === "branch"
                              ? "on its branch"
                              : each === "name"
                                ? "named after it"
                                : "review workspace",
                          )
                          .join(", ")}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                "none of your workspaces is on its branch or named after it"
              )}
            </dd>
          </div>
          <div>
            <dt>Your drafts</dt>
            <dd>
              {drafts ?? (entry.drafts === 0 ? "none" : "not read yet")}
              {entry.drafts ? (
                <>
                  {" "}
                  <a href={entry.url} target="_blank" rel="noreferrer">
                    submit them on the {kind}
                  </a>
                </>
              ) : null}
            </dd>
          </div>
        </dl>
        <div className="assistant-task-buttons">
          {actions}
          <a
            className="button ghost"
            href={entry.url}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={13} /> Open on{" "}
            {entry.provider === "gitlab" ? "GitLab" : "GitHub"}
          </a>
        </div>
      </section>
    </>
  );
}

/** A branch headed upstream: its checkout, its commits, its next step. */
function MrBranchDetail({
  entry,
  onBack,
  actions,
  board,
  editor,
  links,
  onGoWorkspace,
}: {
  entry: MrInboxEntry;
  onBack: () => void;
  actions?: ReactNode;
  board?: ReactNode;
  editor?: ReactNode;
  links?: MrWorkspaceLink[];
  onGoWorkspace?: (link: MrWorkspaceLink) => void;
}) {
  const branch = entry.branch!;
  const link = links?.[0];
  return (
    <>
      <div className="assistant-section-heading">
        <button type="button" className="ghost" onClick={onBack}>
          <ChevronLeft size={13} /> All reviews
        </button>
      </div>
      <section className="assistant-task-overview mr-reviews-detail">
        <div className="assistant-task-heading">
          <h3>
            <span className="mr-reviews-number">{branch.name}</span>{" "}
            {entry.title}
          </h3>
          <span className="assistant-task-state is-draft">
            {entry.unsent ? "not proposed yet" : "branch"}
          </span>
        </div>
        {editor}
        <dl className="assistant-task-metadata">
          {board}
          <div>
            <dt>Headed to</dt>
            <dd>
              {entry.project} {entry.targetBranch} ({branch.target}):{" "}
              {branch.ahead} ahead, {branch.behind} behind
            </dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd>
              <button
                type="button"
                className="ghost"
                title="Go to it (w, Enter)"
                onClick={() => link && onGoWorkspace?.(link)}
              >
                <House size={13} /> {branch.workspaceLabel}
              </button>{" "}
              <small>
                {branch.connectionLabel} · {branch.path}
              </small>
            </dd>
          </div>
          {branch.dirty || branch.unpushed ? (
            <div>
              <dt>Local</dt>
              <dd>
                {[
                  branch.dirty
                    ? `${branch.dirty} file${branch.dirty === 1 ? "" : "s"} changed`
                    : "",
                  branch.unpushed ? `${branch.unpushed} not pushed` : "",
                ]
                  .filter(Boolean)
                  .join(", ")}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Commits</dt>
            <dd>
              <ol className="mr-branch-commits" aria-label="Its commits">
                {branch.commits.map((commit) => (
                  <li key={commit.sha}>
                    <code>{commit.sha.slice(0, 10)}</code> {commit.subject}
                  </li>
                ))}
                {branch.ahead > branch.commits.length ? (
                  <li>
                    <small>
                      and {branch.ahead - branch.commits.length} more
                    </small>
                  </li>
                ) : null}
              </ol>
            </dd>
          </div>
        </dl>
        <div className="assistant-task-buttons">{actions}</div>
      </section>
    </>
  );
}

/**
 * The pane width from which the lanes show as a board's columns: two
 * columns of 420 px, with the body's padding and the gap.
 */
export const MR_BOARD_MIN_WIDTH = 2 * 420 + 12 + 24;

/** An element's width, followed as it changes (0 where nothing is laid out). */
export function usePanelWidth(
  ref: { current: HTMLElement | null },
  enabled: boolean,
): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!enabled) return;
    const measure = () =>
      setWidth(Math.round(ref.current?.getBoundingClientRect().width ?? 0));
    measure();
    const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver })
      .ResizeObserver;
    const observer = Observer ? new Observer(measure) : null;
    if (observer && ref.current) observer.observe(ref.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [enabled, ref]);
  return enabled ? width : 0;
}

export function MrReviewsPanel({
  onClose,
  initialSelect,
  initialOpen,
  initialView,
  initialDeclare,
  renderActions,
  onOpenEntry,
  mode: modeAsked,
  onModeChange,
  expanded = false,
  onExpand,
  onKeyFirst,
  initialWorkItem,
  initialWork,
  initialLocal,
}: {
  /** The Reviews mode on its Local reviews: the first one selected. */
  initialLocal?: boolean;
  /** keepFocus: a review was shown; the focus is the review's now. */
  onClose: (options?: BoardCloseOptions) => void;
  /**
   * The mode shown: the inspector's tab. With onModeChange, the panel's
   * own switches ([ ], an effort's link) ask for the other tab.
   */
  mode?: BoardMode;
  onModeChange?: (mode: BoardMode) => void;
  /** The inspector fills the window: a session or a review opened steps aside. */
  expanded?: boolean;
  /** Asks the inspector to fill the window (an effort's view). */
  onExpand?: () => void;
  /** The inspector's keys first (gt, gT): true when it took the key. */
  onKeyFirst?: (event: KeyboardEvent) => boolean;
  /** The Work board: an item to open on (a notification's link). */
  initialWorkItem?: string;
  /** The Work board: a session's items, or its add form started. */
  initialWork?: Pick<WorkOpen, "owner" | "add">;
  /** A request to open at once (the command menu). */
  initialOpen?: string;
  /** The request to show selected (from a review: the one shown). */
  initialSelect?: string;
  /** The reviews agent's chat at once (a voice answer's card), or declaring an effort. */
  initialView?: "chat" | "declare";
  /** Declaring: the home and source a menu fills in. */
  initialDeclare?: MrDeclarePrefill;
  /** Step (b) on: the buttons of a request's detail (Review...). */
  renderActions?: (entry: MrInboxEntry) => ReactNode;
  /** Opening a request (Enter without a workspace, a click): its review (else its detail). */
  onOpenEntry?: (entry: MrInboxEntry) => void;
}) {
  const { mobile } = useLayoutPreferences();
  const { inbox, error, reload } = useMrInbox();
  const [view, setView] = useState<View>(
    initialView === "chat" ? "chat" : "list",
  );
  // The inspector's tab, or the panel's own mode (a test's panel alone).
  const [ownMode, setOwnMode] = useState<BoardMode>(
    () => modeAsked ?? (initialWorkItem || initialWork ? "work" : "mr"),
  );
  const mode: BoardMode = onModeChange && modeAsked ? modeAsked : ownMode;
  const setMode = (next: BoardMode) => {
    if (onModeChange) onModeChange(next);
    else setOwnMode(next);
  };
  const [storedChoice, setFilterState] = useState<MrFilter>(storedFilter);
  const views = useMemo(() => inbox?.views ?? [], [inbox]);
  const filters: MrFilter[] = [
    ...FILTERS,
    ...views.map((view) => `view:${view.name}` as const),
  ];
  // A view deleted meanwhile (here or elsewhere): everything.
  const filter: MrFilter =
    !storedChoice.startsWith("view:") ||
    views.some(
      (view) =>
        view.name.toLowerCase() ===
        storedChoice.slice("view:".length).toLowerCase(),
    )
      ? storedChoice
      : "all";
  const setFilter = (next: MrFilter) => {
    setFilterState(next);
    keep(FILTER_KEY, next);
    queuePanel({ filter: next }, 0);
  };
  const [selected, setSelected] = useState<string | null>(
    initialSelect ?? null,
  );
  const [detail, setDetail] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const openedAt = useRef(Date.now());
  const entries = useMemo(() => inbox?.entries ?? [], [inbox]);
  /** The order just changed here, until the bridge has it. */
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const order = useMemo(
    () => localOrder ?? inbox?.order ?? [],
    [localOrder, inbox],
  );
  const bySection = useMemo(() => {
    const groups: Record<MrSection, MrInboxEntry[]> = {
      pinned: [],
      mine: [],
      authored: [],
      suggested: [],
    };
    for (const entry of entries) groups[entry.section].push(entry);
    return {
      pinned: orderMrEntries(groups.pinned, order),
      mine: orderMrEntries(groups.mine, order),
      authored: orderMrEntries(groups.authored, order),
      suggested: orderMrEntries(groups.suggested, order),
    };
  }, [entries, order]);
  /**
   * The search (/): the requests shown, each section narrowed. Kept for
   * the next run and the user's other devices (mr_reviews.panel), with the
   * filter: written a moment after the typing stops, taken from the
   * bridge when another device wrote it later.
   */
  const [query, setQueryState] = useState(() => storedText(SEARCH_KEY));
  const panelAt = useRef(storedText(PANEL_AT_KEY));
  const pendingPanel = useRef<{ search?: string; filter?: string }>({});
  const panelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelSaving = useRef(0);
  const flushPanel = () => {
    if (panelTimer.current) clearTimeout(panelTimer.current);
    panelTimer.current = null;
    const change = pendingPanel.current;
    pendingPanel.current = {};
    if (!Object.keys(change).length) return;
    panelSaving.current++;
    void saveMrPanel(change)
      .then(({ panel }) => {
        if (panel?.at && panel.at > panelAt.current) {
          panelAt.current = panel.at;
          keep(PANEL_AT_KEY, panel.at);
        }
      })
      .catch(() => {})
      .finally(() => {
        panelSaving.current--;
      });
  };
  const queuePanel = (
    change: { search?: string; filter?: string },
    delay: number,
  ) => {
    pendingPanel.current = { ...pendingPanel.current, ...change };
    if (panelTimer.current) clearTimeout(panelTimer.current);
    panelTimer.current = setTimeout(flushPanel, delay);
  };
  const setQuery = (next: string) => {
    setQueryState(next);
    keep(SEARCH_KEY, next);
    queuePanel({ search: next }, SEARCH_SAVE_MS);
  };
  // Closed while typing: kept all the same.
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount only
  useEffect(() => () => flushPanel(), []);
  const serverPanel = inbox?.panel;
  useEffect(() => {
    if (!serverPanel?.at || serverPanel.at <= panelAt.current) return;
    // What is being typed or saved here wins; the next read says again.
    if (panelTimer.current || panelSaving.current) return;
    panelAt.current = serverPanel.at;
    keep(PANEL_AT_KEY, serverPanel.at);
    setQueryState(serverPanel.search);
    keep(SEARCH_KEY, serverPanel.search);
    const next = validFilter(serverPanel.filter);
    setFilterState(next);
    keep(FILTER_KEY, next);
  }, [serverPanel]);
  /** The saved view the search is, shown selected (filter All only). */
  const searchView =
    filter === "all" && query.trim()
      ? views.find((view) => sameSearch(view.query, query))
      : undefined;
  const searchRef = useRef<HTMLInputElement>(null);
  // The search completes keys, then values (Tab, the arrows), as the
  // inspector's : line does.
  const [searchFocused, setSearchFocused] = useState(false);
  const [completionAt, setCompletionAt] = useState(-1);
  const [completionsOff, setCompletionsOff] = useState(false);
  // A request's URL (or group/project!12) in the search is one to add (or
  // to go to, when the list has it), not words to search for.
  const pastedQuery = mrPastedRequest(query);
  const pastedEntry = pastedQuery
    ? entries.find(
        (entry) =>
          entry.url &&
          (pastedQuery === entry.url ||
            pastedQuery.startsWith(`${entry.url.replace(/\/$/, "")}/`)),
      )
    : undefined;
  const completions = useMemo(() => {
    if (!searchFocused || completionsOff || mrPastedRequest(query)) return [];
    const last = /\S*$/.exec(query)?.[0] ?? "";
    if (!last.replace(/^-/, "")) return [];
    return mrFilterCompletions(query, entries).filter(
      (each) => each.insert.trimEnd() !== query.trimEnd(),
    );
  }, [query, entries, searchFocused, completionsOff]);
  const complete = (index: number) => {
    const chosen = completions[Math.max(0, index)];
    if (!chosen) return false;
    setQuery(chosen.insert);
    setCompletionAt(-1);
    setSelected(null);
    return true;
  };
  const shown = useMemo(() => {
    const wanted = (entry: MrInboxEntry) =>
      filtered(entry, filter, views) && mrMatches(entry, query);
    return {
      pinned: bySection.pinned.filter(wanted),
      mine: bySection.mine.filter(wanted),
      authored: bySection.authored.filter(wanted),
      suggested: bySection.suggested.filter(wanted),
    };
  }, [bySection, query, filter, views]);
  // One's own requests in lanes: folded lanes kept on this device, the
  // requests under a parent folded with it (za).
  const [folded, setFoldedState] = useState<Set<string>>(storedFoldedLanes);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // A bridge from before lanes gives none: the plain list then.
  const lanesOn = shown.authored.some((entry) => entry.lane);
  const laneGroups = useMemo(
    () => (lanesOn ? mrLaneGroups(shown.authored, { folded, collapsed }) : []),
    [shown.authored, folded, collapsed, lanesOn],
  );
  const toggleLane = (lane: string) =>
    setFoldedState((current) => {
      const next = new Set(current);
      if (!next.delete(lane)) next.add(lane);
      keepFoldedLanes(next);
      return next;
    });
  const toggleChildren = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  /** The rows as drawn, in order: what j / k walk. */
  const ordered = SECTIONS.flatMap((section) =>
    section === "authored" && lanesOn
      ? laneGroups.flatMap((group) => group.rows.map((row) => row.entry))
      : shown[section],
  );
  /** The sections the filter shows. */
  const visibleSections = SECTIONS.filter(
    (section) =>
      (section !== "pinned" || bySection.pinned.length) &&
      // A view shows the sections it keeps something of.
      (!filter.startsWith("view:") || shown[section].length) &&
      (filter === "all" ||
        filter.startsWith("view:") ||
        (filter === "mine"
          ? section === "authored" ||
            (section === "pinned" && bySection.pinned.some(isOwn))
          : section !== "authored" &&
            (section !== "pinned" ||
              bySection.pinned.some((entry) => !isOwn(entry))))),
  );
  /**
   * A wide pane shows a board: each lane (and each other section) a column
   * of its own, side by side, scrolling on its own. Narrow panes and
   * phones keep the one stacked list.
   */
  const panelWidth = usePanelWidth(panelRef, !mobile);
  const board = !mobile && panelWidth >= MR_BOARD_MIN_WIDTH;
  const boardRef = useRef<HTMLDivElement>(null);
  /** The Work mode's content and keys, live while shown. */
  const work = useWorkMode({
    enabled: mode === "work",
    mobile,
    board,
    maximized: expanded,
    panelRef,
    onClose,
    ...(initialWorkItem ? { initialItem: initialWorkItem } : {}),
    ...(initialWork?.owner ? { initialOwner: initialWork.owner } : {}),
    ...(initialWork?.add ? { initialAdd: initialWork.add } : {}),
    efforts: inbox?.efforts,
    requests: inbox?.entries,
    // An item's effort link: the inbox mode's view of that effort.
    onOpenEffort: (id) => {
      setMode("mr");
      openEffort(id);
    },
  });
  /**
   * Local reviews: Roamgate's own reviews of the workspace's checkouts
   * (every workspace's from a coordinator's, or widened), ranked with
   * their news first; their branches read checkout by checkout, each chip
   * shown as its checkout answers.
   */
  const reviewState = useReviewState();
  const reviewWorkspace = useWorkWorkspace();
  const [localWide, setLocalWide] = useState(false);
  const localScope =
    work.coordinator || localWide || !reviewWorkspace
      ? null
      : {
          connectionId: reviewWorkspace.connectionId,
          workspaceId: reviewWorkspace.workspaceId,
        };
  const localScopeKey = localScope
    ? `${localScope.connectionId}\n${localScope.workspaceId}`
    : "";
  const localOn = mode === "mr" && view === "list";
  const localKnown = useMemo(
    () => (localOn ? localReviewsOf(reviewState.summaries.values(), null) : []),
    [localOn, reviewState.summaries],
  );
  const localReviews = useMemo(
    () => (localScope ? localReviewsOf(localKnown, localScope) : localKnown),
    // The scope is its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [localKnown, localScopeKey],
  );
  const localBranches = useReviewActivity(
    useMemo(
      () =>
        localReviews.map(({ session }) => ({
          id: session.id,
          connectionId: session.connectionId,
          root: session.root,
        })),
      [localReviews],
    ),
  );
  const localItems = useMemo(() => {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word && !word.includes(":"));
    return rankReviews(localReviews, movedReviews(localBranches)).filter(
      ({ snapshot: { session } }) => {
        if (!words.length) return true;
        const text =
          `${session.title} ${session.root} ${describeReviewTarget(session.target)}`.toLowerCase();
        return words.every((word) => text.includes(word));
      },
    );
  }, [localReviews, localBranches, query]);
  const localKeys = localItems.map((item) =>
    localReviewKey(item.snapshot.session.id),
  );
  /** Drawn when the page knows a local review, or when asked for. */
  const localShown = localOn && (localKnown.length > 0 || !!initialLocal);
  const workspaceLabels = useStoreSelector((state) =>
    state.workspaces
      .map((each) => `${each.workspace_id}\t${each.label}`)
      .join("\n"),
  );
  const localWorkspaceLabels = useMemo(
    () =>
      new Map(
        (workspaceLabels ? workspaceLabels.split("\n") : []).map(
          (line) => line.split("\t") as [string, string],
        ),
      ),
    [workspaceLabels],
  );
  // Opened on Local reviews: the first one selected, once listed.
  const localPicked = useRef(false);
  const firstLocal = localKeys[0];
  useEffect(() => {
    if (!initialLocal || localPicked.current || !firstLocal) return;
    localPicked.current = true;
    setSelected(firstLocal);
  }, [initialLocal, firstLocal]);

  /** The sections drawn: an empty Suggested takes no column on the board. */
  const drawnSections = board
    ? visibleSections.filter(
        (section) => section !== "suggested" || shown.suggested.length,
      )
    : visibleSections;
  /** The board's columns, left to right, with the rows each shows. */
  const columns: MrInboxEntry[][] = board
    ? drawnSections.flatMap((section) =>
        section === "authored" && lanesOn
          ? laneGroups.map((group) => group.rows.map((row) => row.entry))
          : [shown[section]],
      )
    : [];
  const columnKeys = [
    ...(board && localShown ? [localKeys] : []),
    ...columns.map((rows) => rows.map((entry) => entry.key)),
  ];
  /** Every row's key as drawn, in order: what j / k, gg and G walk. */
  const walkKeys = [
    ...(localShown ? localKeys : []),
    ...ordered.map((entry) => entry.key),
  ];
  /** h / l, Tab: the column on the left or right, at the same height. */
  const moveColumn = (step: number) => {
    const next = nextColumn(columnKeys, selected, step);
    if (next) setSelected(next);
    return true;
  };

  /** The rows a row moves among (J / K, drag): its section, or its lane. */
  const siblingsOf = (entry: MrInboxEntry): MrInboxEntry[] =>
    entry.section === "authored" && lanesOn
      ? mrLaneSiblings(laneGroups, entry.key)
      : shown[entry.section];
  const links = useMrWorkspaceLinks(
    useMemo(() => entries.map((entry) => entry.key), [entries]),
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const helpOpenRef = useRef(helpOpen);
  helpOpenRef.current = helpOpen;
  const [orderError, setOrderError] = useState<string | null>(null);
  const detailEntry = detail
    ? entries.find((entry) => entry.key === detail)
    : undefined;
  const detailHome = detailEntry
    ? mrHomeLinks(links[detailEntry.key])[0]
    : undefined;

  useEffect(() => {
    if (initialSelect) setSelected(initialSelect);
  }, [initialSelect]);

  // The selected row follows the keys and stays in view.
  useEffect(() => {
    if (!selected) return;
    const row = panelRef.current?.querySelector<HTMLElement>(
      `[data-mr-key="${CSS.escape(selected)}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Focus the panel on open, so its keys work at once; again a moment
  // later, as a closing menu hands the focus back to its button.
  useEffect(() => {
    const take = () => {
      const panel = panelRef.current;
      const active = document.activeElement as HTMLElement | null;
      if (!panel || panel.contains(active)) return;
      // Not from a box the user went to type in since.
      if (active?.closest?.("input, textarea, select, [contenteditable]"))
        if (Date.now() - openedAt.current > 300) return;
      panel.focus({ preventScroll: true });
    };
    take();
    const timers = [0, 80, 250].map((ms) => setTimeout(take, ms));
    return () => timers.forEach(clearTimeout);
  }, []);

  const markSeen = (entry: MrInboxEntry) =>
    void mrReviewsCall("seen", { key: entry.key })
      .then(() => reload())
      .catch(() => {});

  const showDetail = (entry: MrInboxEntry) => {
    setSelected(entry.key);
    setDetail(entry.key);
    markSeen(entry);
  };

  /** Its workspace, on its connection: the panel steps aside. */
  const goWorkspace = (entry: MrInboxEntry, link: MrWorkspaceLink) => {
    markSeen(entry);
    void store
      .jumpToConnectionWorkspace(link.connectionId, link.workspaceId)
      .catch(() => {});
    onClose({ keepFocus: true });
  };

  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  /** Its review, in the project's review workspace. */
  const open = async (entry: MrInboxEntry, checkout?: "now" | "later") => {
    setSelected(entry.key);
    if (entry.branch) {
      showDetail(entry);
      return;
    }
    if (onOpenEntry) {
      onOpenEntry(entry);
      return;
    }
    setOpening(entry.key);
    setPrompt(null);
    try {
      const outcome = await openMrReview(entry, checkout ? { checkout } : {});
      if (outcome.kind === "needClone") {
        setPrompt({
          kind: "clone",
          entry,
          host: outcome.host,
          project: outcome.project,
          connections: outcome.connections,
        });
        return;
      }
      if (outcome.checkout.state === "dirty") {
        setPrompt({ kind: "dirty", entry, changes: outcome.checkout.changes });
        return;
      }
      if (outcome.checkout.state === "error") {
        setPrompt({ kind: "error", entry, message: outcome.checkout.message });
        return;
      }
      if (outcome.claude?.state === "busy") {
        setPrompt({ kind: "busy", entry, with: outcome.claude.with });
        return;
      }
      onClose({ keepFocus: true });
    } catch (error) {
      setPrompt({
        kind: "error",
        entry,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpening(null);
    }
  };

  const answerDirty = async (entry: MrInboxEntry, local: "wip" | "discard") => {
    setOpening(entry.key);
    try {
      const state = await checkoutMrReview(entry.key, local);
      if (state.state === "done") {
        setPrompt(
          state.kept ? { kind: "kept", entry, branch: state.kept } : null,
        );
        if (!state.kept) onClose({ keepFocus: true });
      } else if (state.state === "dirty")
        setPrompt({ kind: "dirty", entry, changes: state.changes });
      else
        setPrompt({
          kind: "error",
          entry,
          message:
            state.state === "error" ? state.message : "the checkout failed",
        });
    } catch (error) {
      setPrompt({
        kind: "error",
        entry,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpening(null);
    }
  };

  /** The busy Claude finishes its turn, then switches (in the bridge). */
  const waitClaude = async (entry: MrInboxEntry) => {
    setOpening(entry.key);
    try {
      const state = await mrClaude(entry.key, "switch");
      if (state.state === "busy")
        setPrompt({ kind: "busy", entry, with: state.with });
      else {
        setPrompt(null);
        onClose({ keepFocus: true });
      }
    } catch (error) {
      setPrompt({
        kind: "error",
        entry,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpening(null);
    }
  };

  /** Review with Claude, or Ask Claude (its session, shown). */
  const withClaude = async (entry: MrInboxEntry, review: boolean) => {
    if (entry.branch) {
      say("A branch has no request yet: c works once it is proposed");
      return;
    }
    setOpening(entry.key);
    try {
      // Its review first: the workspace, the checkout, the session.
      if (!entry.review) {
        const outcome = await openMrReview(entry, { checkout: "now" });
        if (outcome.kind !== "shown" || outcome.checkout.state !== "done") {
          await open(entry, "now");
          return;
        }
      } else if (entry.review) {
        await mrReviewsCall("checkout", { key: entry.key, local: "refuse" });
      }
      const state = await mrClaude(entry.key, review ? "review" : "start");
      if (state.state === "busy") {
        setPrompt({ kind: "busy", entry, with: state.with });
        return;
      }
      if (state.state !== "ready" && state.state !== "starting") {
        setPrompt({ kind: "claude", entry, state });
        return;
      }
      const connectionId = entry.review?.connectionId;
      if (!review && connectionId)
        await showMrClaude(connectionId, state.paneId);
      if (state.state === "starting")
        setPrompt({ kind: "claude", entry, state });
      else onClose({ keepFocus: true });
    } catch (error) {
      setPrompt({
        kind: "error",
        entry,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpening(null);
    }
  };

  // The command menu's request: opened as soon as the inbox knows it.
  const openedInitial = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!initialOpen || openedInitial.current) return;
    const listed = entries.find((each) => each.key === initialOpen);
    // One the reviews agent showed may be in no list.
    const shown = listed ? undefined : mrAgentItem(initialOpen);
    const entry = listed ?? (shown ? entryOf(shown) : undefined);
    if (!entry) return;
    openedInitial.current = true;
    void openRef.current(entry);
  }, [entries, initialOpen]);

  // A review the agent shows, asked from here: this panel's own flow.
  useEffect(() => {
    setMrAgentOpener((item) => void openRef.current(entryOf(item)));
    return () => setMrAgentOpener(null);
  }, []);

  const feedback = (
    entry: MrInboxEntry,
    verdict: "not_interested" | "more_like_this",
  ) =>
    void mrReviewsCall("feedback", {
      key: entry.key,
      verdict: entry.feedback === verdict ? null : verdict,
    }).then(() => reload());

  const move = (step: number) => {
    // On the board, j / k stay in the column.
    const next = nextRow(board ? columnKeys : null, walkKeys, selected, step);
    if (next) setSelected(next);
  };

  /**
   * Moves a request in the user's order: shown here at once, and sent as an
   * operation on the server's latest order (never a whole list that another
   * device or the agent may have changed since). Every device follows by push.
   */
  const saveSeq = useRef(0);
  const reorder = (key: string, target: string, place: "before" | "after") => {
    const section = entries.find((entry) => entry.key === key)?.section;
    const other = entries.find((entry) => entry.key === target)?.section;
    if (!section || section !== other) return;
    const keys = (list: MrInboxEntry[]) => list.map((entry) => entry.key);
    const moved = moveMrKey(keys(bySection[section]), key, target, place);
    setLocalOrder(
      SECTIONS.flatMap((each) =>
        each === section ? moved : keys(bySection[each]),
      ),
    );
    setOrderError(null);
    const seq = ++saveSeq.current;
    void orderMrRequests({ op: place, keys: [key], target })
      .then(() => reload())
      .then(
        () => {
          if (seq === saveSeq.current) setLocalOrder(null);
        },
        (cause) =>
          setOrderError(
            `Your order was not saved: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      );
  };

  /** The selected request `step` places down (up when negative), as shown. */
  const shiftSelected = (step: number) => {
    const current = entries.find((entry) => entry.key === selected);
    if (!current) return;
    const list = siblingsOf(current);
    const at = list.findIndex((entry) => entry.key === current.key);
    if (at < 0) return;
    const to = Math.min(list.length - 1, Math.max(0, at + step));
    if (to === at) return;
    reorder(current.key, list[to]!.key, step > 0 ? "after" : "before");
  };

  // Dragging a request onto another, in its section (a mouse; on a phone
  // the selected one has up and down buttons).
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{
    key: string;
    place: "before" | "after";
  } | null>(null);
  const endDrag = () => {
    setDragging(null);
    setDropAt(null);
  };
  const sectionOf = (key: string | null) =>
    entries.find((entry) => entry.key === key)?.section;
  const rowMove = (entry: MrInboxEntry): MrRowMove => {
    const list = siblingsOf(entry);
    const at = list.indexOf(entry);
    return {
      onStep: (step) => {
        setSelected(entry.key);
        reorder(
          entry.key,
          list[Math.min(list.length - 1, Math.max(0, at + step))]!.key,
          step > 0 ? "after" : "before",
        );
      },
      canUp: at > 0,
      canDown: at >= 0 && at < list.length - 1,
      ...(mobile
        ? {}
        : {
            drag: {
              dragging: dragging === entry.key,
              drop: dropAt?.key === entry.key ? dropAt.place : null,
              onDragStart: (event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", entry.key);
                setDragging(entry.key);
                setSelected(entry.key);
              },
              onDragOver: (event) => {
                if (
                  !dragging ||
                  dragging === entry.key ||
                  sectionOf(dragging) !== entry.section ||
                  !list.some((each) => each.key === dragging)
                )
                  return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const rect = event.currentTarget.getBoundingClientRect();
                const place =
                  event.clientY < rect.top + rect.height / 2
                    ? "before"
                    : "after";
                if (dropAt?.key !== entry.key || dropAt.place !== place)
                  setDropAt({ key: entry.key, place });
              },
              onDragLeave: () => {
                if (dropAt?.key === entry.key) setDropAt(null);
              },
              onDrop: (event) => {
                event.preventDefault();
                const place = dropAt?.key === entry.key ? dropAt.place : null;
                const from = dragging;
                endDrag();
                if (from && place) reorder(from, entry.key, place);
              },
              onDragEnd: endDrag,
            },
          }),
    };
  };

  // Adding a request by URL (p's transient prompt, :add, a paste), and
  // removing one from the view with an undo.
  const addRef = useRef<HTMLInputElement>(null);
  /** The add prompt's text; null: closed. */
  const [addText, setAddText] = useState<string | null>(null);
  useEffect(() => {
    if (addText !== null && document.activeElement !== addRef.current)
      addRef.current?.focus();
  }, [addText]);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [undo, setUndo] = useState<{
    label: string;
    key: string;
    /** Absent: only said (the agent's pin, which has no Undo). */
    run?: () => Promise<unknown>;
  } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );
  const hidden = inbox?.hidden ?? [];

  /** Pins what was typed, pasted or dropped: a URL, or project!12. */
  const add = async (text: string) => {
    const value = text.trim();
    if (!value || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const { key } = await pinMrRequest(value);
      setQuery("");
      await reload();
      setSelected(key);
    } catch (cause) {
      setAddError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAdding(false);
    }
  };

  /** Out of the view: a pinned request is unpinned, another one hidden. */
  const remove = (entry: MrInboxEntry) => {
    if (entry.branch) {
      say(
        "A branch leaves Reviews when its workspace is not headed upstream (its menu in Workspaces)",
      );
      return;
    }
    const at = ordered.findIndex((each) => each.key === entry.key);
    const next = ordered[at + 1] ?? ordered[at - 1];
    if (selected === entry.key) setSelected(next?.key ?? null);
    setDetail(null);
    // A button that goes with its row leaves the focus on nothing: the
    // panel keeps the keys.
    panelRef.current?.focus({ preventScroll: true });
    void hideMrRequest(entry.key)
      .then(({ action }) => {
        if (undoTimer.current) clearTimeout(undoTimer.current);
        setUndo({
          label: `${action === "unpinned" ? "Unpinned" : "Removed"} ${mrRefLabel(entry, true)}`,
          key: entry.key,
          run: () =>
            action === "unpinned"
              ? pinMrRequest(entry.url)
              : unhideMrRequest(entry.key),
        });
        undoTimer.current = setTimeout(() => setUndo(null), 10_000);
        return reload();
      })
      .catch((cause) =>
        setOrderError(
          `Could not remove it: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
  };

  /**
   * Pins a request on top (every device follows), or unpins it: it goes
   * back to the section a query lists it in. Undo takes it back.
   */
  const togglePin = (entry: MrInboxEntry, want?: boolean) => {
    const pinned = entry.section === "pinned";
    const pin = want ?? !pinned;
    if (pin === pinned || entry.unavailable || entry.branch) return;
    setOrderError(null);
    const label = mrRefLabel(entry, true);
    void (pin ? pinMrRequest(entry.url) : unpinMrRequest(entry.key))
      .then(() => {
        if (undoTimer.current) clearTimeout(undoTimer.current);
        setUndo({
          label: `${pin ? "Pinned" : "Unpinned"} ${label}`,
          key: entry.key,
          run: () =>
            pin ? unpinMrRequest(entry.key) : pinMrRequest(entry.url),
        });
        undoTimer.current = setTimeout(() => setUndo(null), 10_000);
        return reload();
      })
      .then(() => setSelected(entry.key))
      .catch((cause) =>
        setOrderError(
          `Could not ${pin ? "pin" : "unpin"} it: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
  };

  // What the agent changed in the list, here and on the user's other
  // devices: said, with Undo when it can be taken back.
  useEffect(
    () =>
      onMrReviewsChange((push) => {
        if (push.by !== "agent" || !push.summary) return;
        if (undoTimer.current) clearTimeout(undoTimer.current);
        const version = push.undo;
        setUndo({
          label: push.summary,
          key: "",
          ...(version === undefined
            ? {}
            : { run: () => orderMrRequests({ op: "undo", version }) }),
        });
        undoTimer.current = setTimeout(() => setUndo(null), 10_000);
      }),
    [],
  );

  const undoRemoval = () => {
    if (!undo?.run) return;
    const { run, key } = undo;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(null);
    void run()
      .then(() => reload())
      .then(() => {
        if (key) setSelected(key);
      })
      .catch((cause) =>
        setOrderError(
          `Could not undo it: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
  };

  const restore = (key: string) =>
    void unhideMrRequest(key)
      .then(() => reload())
      .catch((cause) =>
        setOrderError(
          `Could not restore it: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );

  // What one sets by hand on a request (e, E, :note...): said, with Undo.
  const [editing, setEditing] = useState<string | null>(null);
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const setOverride = async (
    entry: MrInboxEntry,
    edit: MrOverrideEdit,
    label: string,
  ): Promise<boolean> => {
    setOverrideBusy(true);
    setOverrideError(null);
    try {
      const result = await overrideMrRequest(entry.key, edit);
      if (undoTimer.current) clearTimeout(undoTimer.current);
      const version = result.version;
      setUndo({
        label: result.changed
          ? `${label} on ${mrRefLabel(entry, true)}`
          : `Nothing changed on ${mrRefLabel(entry, true)}`,
        key: entry.key,
        ...(result.changed && version
          ? { run: () => orderMrRequests({ op: "undo", version }) }
          : {}),
      });
      undoTimer.current = setTimeout(() => setUndo(null), 10_000);
      await reload();
      return true;
    } catch (cause) {
      setOverrideError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setOverrideBusy(false);
    }
  };
  /** Saves the search as a view (shown at once), or deletes one. */
  const saveView = async (action: "save" | "delete", name: string) => {
    try {
      const result = await mrReviewsCall<{
        changed: boolean;
        name: string;
        version?: number;
      }>("view", {
        action,
        name,
        ...(action === "save" ? { query: query.trim() } : {}),
      });
      await reload();
      if (action === "save") {
        setFilter(`view:${result.name}`);
        setQuery("");
      } else if (filter === `view:${result.name}`) setFilter("all");
      if (undoTimer.current) clearTimeout(undoTimer.current);
      const version = result.version;
      setUndo({
        label: `${action === "save" ? "Saved" : "Deleted"} the view ${result.name}`,
        key: "",
        ...(result.changed && version
          ? { run: () => orderMrRequests({ op: "undo", version }) }
          : {}),
      });
      undoTimer.current = setTimeout(() => setUndo(null), 10_000);
    } catch (cause) {
      say(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** Opens a request's link (gx): a URL in a tab, a path in Files. */
  const openLink = (entry: MrInboxEntry) => {
    const link = entry.override?.link;
    if (!link) {
      say(`${mrRefLabel(entry, true)} has no link: set one with e or :link`);
      return;
    }
    if (/^https?:\/\//i.test(link)) {
      window.open(link, "_blank", "noopener");
      return;
    }
    const where = links[entry.key]?.[0];
    if (!where) {
      say(`No workspace of ${mrRefLabel(entry, true)} to show ${link} in`);
      return;
    }
    requestMrFileOpen({
      connectionId: where.connectionId,
      workspaceId: where.workspaceId,
      path: link,
    });
    goWorkspace(entry, where);
  };
  /** A branch will be a request (not proposed yet), or is a branch again (b). */
  const toggleUnsent = (entry: MrInboxEntry, title?: string) => {
    if (!entry.branch) {
      say("b works on a branch headed upstream");
      return;
    }
    const want = title !== undefined || !entry.unsent;
    void mrReviewsCall<{ changed: boolean; version?: number }>("unsent", {
      key: entry.key,
      unsent: want,
      ...(title ? { title } : {}),
    })
      .then((result) => {
        if (undoTimer.current) clearTimeout(undoTimer.current);
        const version = result.version;
        setUndo({
          label: want
            ? `${entry.branch!.name} will be a request`
            : `${entry.branch!.name} is a branch again`,
          key: entry.key,
          ...(result.changed && version
            ? { run: () => orderMrRequests({ op: "undo", version }) }
            : {}),
        });
        undoTimer.current = setTimeout(() => setUndo(null), 10_000);
        return reload();
      })
      .catch((cause) =>
        say(cause instanceof Error ? cause.message : String(cause)),
      );
  };

  /** Starts editing what is set by hand on a request (e). */
  const edit = (entry: MrInboxEntry) => {
    showDetail(entry);
    setOverrideError(null);
    setEditing(entry.key);
  };
  const clearOverride = (
    entry: MrInboxEntry,
    field: MrOverrideField | "all",
  ) => {
    if (!entry.override) {
      say(`Nothing is set by hand on ${mrRefLabel(entry, true)}`);
      return;
    }
    void setOverride(
      entry,
      { clear: field === "all" ? "all" : [field] },
      field === "all" ? "Cleared what was set by hand" : `Cleared ${field}`,
    );
  };

  // Upstreaming efforts: their view, their declaration, their leader.
  const [effortView, setEffortView] = useState<string | null>(null);
  const [declaring, setDeclaring] = useState(initialView === "declare");
  const [leaderAsk, setLeaderAsk] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const efforts = inbox?.efforts ?? [];
  const openEffort = (id: string) => {
    setDetail(null);
    setDeclaring(false);
    setEffortView(id);
    if (!mobile && !expanded) onExpand?.();
  };
  const closeEffort = () => {
    setEffortView(null);
    setDeclaring(false);
    panelRef.current?.focus({ preventScroll: true });
  };
  /** Its leader: the Claude session of its head workspace (D15, D18). */
  const leader = async (id: string, start = false) => {
    const effort = efforts.find((each) => each.id === id);
    try {
      const answer = await mrReviewsCall<{
        state: "ready" | "none" | "busy" | "starting";
        connectionId: string;
        workspaceId: string;
      }>("effort.leader", { id, ...(start ? { start: true } : {}) });
      setLeaderAsk(null);
      if (answer.state === "none") {
        setLeaderAsk({ id, name: effort?.name ?? id });
        return;
      }
      if (answer.state === "busy") {
        say("Every pane of its head workspace runs something: open a free one");
        return;
      }
      await store
        .jumpToConnectionWorkspace(answer.connectionId, answer.workspaceId)
        .catch(() => {});
      onClose({ keepFocus: true });
    } catch (cause) {
      say(cause instanceof Error ? cause.message : String(cause));
    }
  };
  /** Says something where Undo shows, with Undo when it can be undone. */
  const sayUndo = (label: string, run?: () => Promise<unknown>) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ label, key: "", ...(run ? { run } : {}) });
    undoTimer.current = setTimeout(() => setUndo(null), 10_000);
  };

  /** A count and the g of gg, as the review pane reads them. */
  const keyState = useRef(EMPTY_KEY_STATE);

  /** Says something for a few seconds where Undo shows. */
  const say = (label: string) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ label, key: "" });
    undoTimer.current = setTimeout(() => setUndo(null), 6_000);
  };

  /** A local review, by id, as the lane lists it. */
  const localReview = (sessionId: string) =>
    localItems.find((item) => item.snapshot.session.id === sessionId)?.snapshot
      .session;
  /** Its connection is not reached: said, and nothing done. */
  const localOffline = (sessionId: string): boolean => {
    const branch = localBranches.get(sessionId);
    if (branch?.state !== "offline") return false;
    say(`That review is on ${branch.connection}, which is offline`);
    return true;
  };
  /**
   * A local review shown in its workspace's Changes (Enter): the board
   * goes to its workspace first, as a request's review does.
   */
  const openLocal = (sessionId: string) => {
    const session = localReview(sessionId);
    if (!session || localOffline(sessionId)) return;
    const { connectionId, workspaceId } = session;
    const current = store.get();
    const focused = current.workspaces.find((each) => each.focused);
    const there =
      !workspaceId ||
      (connectionId === current.activeConnectionId &&
        focused?.workspace_id === workspaceId);
    void (
      there
        ? Promise.resolve()
        : store
            .jumpToConnectionWorkspace(connectionId, workspaceId)
            .catch(() => {})
    ).then(() => requestReviewShown(connectionId, sessionId));
    onClose({ keepFocus: true });
  };
  /** Its workspace (w), the board stepping aside. */
  const goLocalWorkspace = (sessionId: string) => {
    const session = localReview(sessionId);
    if (!session?.workspaceId || localOffline(sessionId)) return;
    void store
      .jumpToConnectionWorkspace(session.connectionId, session.workspaceId)
      .catch(() => {});
    onClose({ keepFocus: true });
  };
  /**
   * Discards a local review (dd): its whole snapshot kept first, which u
   * (or Undo) brings back with its threads.
   */
  const discardLocal = async (sessionId: string) => {
    const session = localReview(sessionId);
    if (!session || localOffline(sessionId)) return;
    const { connectionId } = session;
    const key = localReviewKey(sessionId);
    const at = walkKeys.indexOf(key);
    if (selected === key)
      setSelected(walkKeys[at + 1] ?? walkKeys[at - 1] ?? null);
    panelRef.current?.focus({ preventScroll: true });
    try {
      const snapshot =
        getReviewSnapshot(sessionId) ??
        (await reviewCall<ReviewSnapshot>(connectionId, "review.get", {
          session_id: sessionId,
        }));
      await reviewCall(connectionId, "review.remove", {
        session_id: sessionId,
      });
      sayUndo(`Discarded ${session.title || "the review"}`, async () => {
        rememberReviewSnapshot(
          await reviewCall<ReviewSnapshot>(connectionId, "review.import", {
            snapshot,
          }),
        );
        setSelected(key);
      });
    } catch (cause) {
      say(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** The selected request in the middle of the list, or at its top or bottom. */
  const placeSelected = (where: "center" | "start" | "end") => {
    if (!selected) return;
    const row = panelRef.current
      ?.querySelector<HTMLElement>(`[data-mr-key="${CSS.escape(selected)}"]`)
      ?.closest<HTMLElement>(".mr-reviews-item");
    row?.scrollIntoView({ block: where });
  };

  /** Its n-th workspace (w, 2w). */
  const goNthWorkspace = (entry: MrInboxEntry, n: number) => {
    const found = links[entry.key] ?? [];
    const link = found[n - 1];
    if (link) goWorkspace(entry, link);
    else
      say(
        found.length
          ? `${mrRefLabel(entry, true)} has ${found.length} workspace${found.length === 1 ? "" : "s"}`
          : `None of your workspaces is on ${mrRefLabel(entry, true)}'s branch or named after it`,
      );
  };

  /**
   * A request's default action (Enter, a click, Review): its review in its
   * home, the first of its own workspaces (on its branch, named after it,
   * made for it); only a request with none opens in the project's shared
   * review workspace. A branch goes to its workspace.
   */
  const enter = (entry: MrInboxEntry) => {
    const home = mrHomeLinks(links[entry.key])[0];
    if (!home) {
      const link = entry.branch ? links[entry.key]?.[0] : undefined;
      if (link) goWorkspace(entry, link);
      else void open(entry);
      return;
    }
    if (entry.branch || entry.unavailable) {
      goWorkspace(entry, home);
      return;
    }
    void openInHome(entry, home);
  };
  const openInHome = async (entry: MrInboxEntry, home: MrWorkspaceLink) => {
    setSelected(entry.key);
    setOpening(entry.key);
    setPrompt(null);
    try {
      await openMrReviewInHome(entry, home);
      markSeen(entry);
      onClose({ keepFocus: true });
    } catch (cause) {
      // Its workspace at least (the review could not be shown there).
      say(
        `Its review did not open in ${home.label || "its home"}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      goWorkspace(entry, home);
    } finally {
      setOpening(null);
    }
  };

  // The home prompt as the settings say, for the tooltip.
  const [homePrompt, setHomePrompt] = useState("");
  useEffect(() => {
    let live = true;
    void loadMrReviewsSettings()
      .then((value) => {
        if (live) setHomePrompt(value.homePrompt ?? "");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [view]);
  const homePromptOf = (entry: MrInboxEntry) =>
    mrHomePrompt(homePrompt, {
      url: entry.url,
      ref: mrRefLabel(entry),
      title: entry.title,
      author: entry.author,
      target: entry.targetBranch,
      source: entry.sourceBranch,
      project: entry.project,
    });
  /**
   * "Start a review with a home" (gH, :home): a workspace of its own on
   * its head, placed with the project's reviews, a Claude told its job;
   * the request goes there from now on.
   */
  const startHome = async (entry: MrInboxEntry) => {
    if (entry.branch) {
      say("A branch has no request yet: its home is its own workspace");
      return;
    }
    setSelected(entry.key);
    setOpening(entry.key);
    setPrompt(null);
    say(`Making ${mrRefLabel(entry, true)} a home...`);
    try {
      const started = await startMrReviewHome(entry);
      markSeen(entry);
      if (started.agent.state === "foreign")
        say("Its home's pane runs another agent: Claude was not started");
      onClose({ keepFocus: true });
    } catch (cause) {
      setPrompt({
        kind: "error",
        entry,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setOpening(null);
    }
  };

  // The command line (:), as the review pane's.
  const [command, setCommand] = useState<string | null>(null);
  const commandRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (command !== null && document.activeElement !== commandRef.current)
      commandRef.current?.focus();
  }, [command]);
  const runCommand = (text: string) => {
    const [name = "", ...rest] = text.trim().replace(/^:/, "").split(/\s+/);
    const current =
      detailEntry ?? ordered.find((entry) => entry.key === selected);
    setCommand(null);
    panelRef.current?.focus({ preventScroll: true });
    if (!name) return;
    const argument = rest.join(" ").trim();
    const OVERRIDE_COMMANDS = [
      "note",
      "whose",
      "label",
      "unlabel",
      "link",
      "after",
      "stale",
      "clear",
      "edit",
    ];
    if (OVERRIDE_COMMANDS.includes(name)) {
      if (!current) {
        say("Select a request first");
        return;
      }
      const labels = current.override?.labels ?? [];
      const given = argument
        .split(",")
        .map((each) => each.trim())
        .filter(Boolean);
      if (name === "edit") edit(current);
      else if (name === "note")
        void setOverride(
          current,
          argument ? { set: { next: argument } } : { clear: ["next"] },
          argument ? "Next step set" : "Next step cleared",
        );
      else if (name === "whose")
        void setOverride(
          current,
          argument ? { set: { whose: argument } } : { clear: ["whose"] },
          argument ? `On: ${argument}` : "Who it is on cleared",
        );
      else if (name === "label")
        void setOverride(
          current,
          { set: { labels: [...labels, ...given] } },
          `Labelled ${given.join(", ")}`,
        );
      else if (name === "unlabel")
        void setOverride(
          current,
          {
            set: {
              labels: labels.filter(
                (label) =>
                  !given.some(
                    (each) => each.toLowerCase() === label.toLowerCase(),
                  ),
              ),
            },
          },
          `Unlabelled ${given.join(", ")}`,
        );
      else if (name === "link")
        void setOverride(
          current,
          argument ? { set: { link: argument } } : { clear: ["link"] },
          argument ? "Link set" : "Link cleared",
        );
      else if (name === "after")
        void setOverride(
          current,
          argument
            ? {
                set: {
                  dependsOn: [
                    ...(current.override?.dependsOn ?? []),
                    ...argument.split(/[\s,]+/).filter(Boolean),
                  ],
                },
              }
            : { clear: ["dependsOn"] },
          argument ? `Waits for ${argument}` : "Waits for nothing",
        );
      else if (name === "stale")
        void setOverride(
          current,
          current.override?.stale
            ? { clear: ["stale"] }
            : { set: { stale: true } },
          current.override?.stale ? "No longer stale" : "Marked stale",
        );
      else {
        const field = (
          {
            whose: "whose",
            next: "next",
            note: "next",
            after: "dependsOn",
            depends: "dependsOn",
            labels: "labels",
            label: "labels",
            link: "link",
            stale: "stale",
          } as Record<string, MrOverrideField>
        )[argument];
        if (argument && !field)
          say(
            `Not a field: ${argument} (whose, next, after, labels, link, stale)`,
          );
        else clearOverride(current, field ?? "all");
      }
      return;
    }
    if (name === "effort" || name === "declare") {
      const found = argument
        ? efforts.find(
            (each) =>
              each.id === argument ||
              each.name.toLowerCase() === argument.toLowerCase(),
          )
        : undefined;
      if (found) openEffort(found.id);
      else if (argument && name === "effort")
        say(
          efforts.length
            ? `No effort named ${argument}: ${efforts.map((each) => each.name).join(", ")}`
            : "No effort yet: :declare one",
        );
      else {
        setEffortView(null);
        setDetail(null);
        setDeclaring(true);
      }
      return;
    }
    if (name === "unsent") {
      if (!current) say("Select a branch first");
      else toggleUnsent(current, argument || undefined);
      return;
    }
    if (name === "view" || name === "save" || name === "delview") {
      const wanted = argument.replace(/^"|"$/g, "");
      if (name === "view") {
        const found = views.find(
          (each) => each.name.toLowerCase() === wanted.toLowerCase(),
        );
        if (found) setFilter(`view:${found.name}`);
        else
          say(
            views.length
              ? `No view named ${wanted}: ${views.map((each) => each.name).join(", ")}`
              : "No saved view yet: search, then :save NAME",
          );
      } else if (!wanted) say(`:${name} needs a view's name`);
      else if (name === "save" && !query.trim())
        say("Type a search first (/), then :save NAME");
      else void saveView(name === "save" ? "save" : "delete", wanted);
      return;
    }
    // :add URL (or :pin URL) adds a request; :add alone opens its prompt.
    if (name === "add" || (name === "pin" && argument)) {
      if (argument) void add(argument);
      else setAddText("");
      return;
    }
    if (name === "pin" || name === "unpin") {
      if (!current) say("Select a request first");
      else togglePin(current, name === "pin");
    } else if (name === "home") {
      if (!current) say("Select a request first");
      else void startHome(current);
    } else if (name === "all" || name === "review" || name === "mine")
      setFilter(name);
    else if (name === "refresh" || name === "e") void reload(true);
    else if (name === "infer") {
      // Whose move it is, read again now for the selected own row.
      if (!current || (!current.branch && current.section !== "authored"))
        say("Select one of your own requests or branches first");
      else {
        say("Inferring...");
        void mrReviewsCall<{ next?: { text: string } | null }>("infer", {
          key: current.key,
        })
          .then((answer) => {
            say(answer.next ? `Next: ${answer.next.text}` : "Inferred");
            return reload();
          })
          .catch((cause) =>
            say(cause instanceof Error ? cause.message : String(cause)),
          );
      }
    } else if (name === "help" || name === "h") setHelpOpen(true);
    else say(`Not a command: ${[name, ...rest].join(" ")}`);
  };

  /** The other mode's key: [ or ], outside a box. */
  const modeKey = (event: KeyboardEvent, typing: boolean): boolean => {
    if (
      typing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      (event.key !== "[" && event.key !== "]")
    )
      return false;
    setMode(mode === "work" ? "mr" : "work");
    return true;
  };

  /** One key in the panel; true when the panel took it. */
  const onKey = (event: KeyboardEvent): boolean => {
    // The help takes its own keys (ShortcutHelp).
    if (event.isComposing || helpOpen) return false;
    if (mode === "work") {
      const typing =
        event.target instanceof HTMLElement &&
        (event.target.closest(
          "input, textarea, select, [contenteditable], .cm-editor",
        ) ?? null) !== null;
      if (modeKey(event, typing)) return true;
      if (work.onKey(event)) return true;
      if (typing || event.metaKey || event.ctrlKey || event.altKey)
        return false;
      if (event.key === "Escape") {
        onClose();
        return true;
      }
      if (event.key === "?") {
        setHelpOpen((open) => !open);
        return true;
      }
      return false;
    }
    // An effort's view, or the declaration, has its own keys.
    if ((effortView || declaring) && view === "list") return false;
    // An effort's card has the focus: Enter, i and c are its own.
    if (
      event.target instanceof HTMLElement &&
      event.target.closest(".mr-effort-card") &&
      (event.key === "Enter" || event.key === "i" || event.key === "c")
    )
      return false;
    // Another handler may have marked it (a chat's Escape, say): the panel
    // still owns its keys while it has the focus.
    if (event.isComposing) return false;
    const typing =
      event.target instanceof HTMLElement &&
      (event.target.closest("input, textarea, select, [contenteditable]") ??
        null) !== null;
    if (view === "chat") {
      // The chat's message box keeps its keys, and Vim the Escape that
      // ends insert mode; in normal mode Escape leaves the box.
      const editor =
        event.target instanceof HTMLElement
          ? event.target.closest(".cm-editor")
          : null;
      const vimInsert =
        !!editor && !editor.querySelector(".cm-scroller.cm-vimMode");
      if (event.key === "Escape" && typing && !vimInsert) {
        panelRef.current?.focus({ preventScroll: true });
        return true;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey)
        return false;
      if (event.key === "Escape") {
        if (prompt) setPrompt(null);
        else setView("list");
        // The focus may have been in the chat, which goes: the panel keeps
        // the keys.
        panelRef.current?.focus({ preventScroll: true });
        return true;
      }
      if (event.key === "i" || event.key === "a" || event.key === "Enter") {
        focusComposer();
        return true;
      }
      return false;
    }
    // The command line: Enter runs it, Esc leaves it.
    if (event.target === commandRef.current) {
      if (event.key === "Escape") {
        setCommand(null);
        panelRef.current?.focus({ preventScroll: true });
      } else if (event.key === "Enter") runCommand(command ?? "");
      else return false;
      return true;
    }
    // The add prompt: Enter pins what it holds, Esc closes it.
    if (event.target === addRef.current) {
      if (event.key === "Escape") {
        setAddText(null);
        setAddError(null);
        panelRef.current?.focus({ preventScroll: true });
      } else if (event.key === "Enter" && !event.isComposing) {
        const text = addText ?? "";
        setAddText(null);
        panelRef.current?.focus({ preventScroll: true });
        void add(text);
      } else return false;
      return true;
    }
    // The search box: Enter goes to the selected (or first) request
    // found (its workspace, else its review), the arrows move, Esc clears
    // it and goes back to the list.
    if (event.target === searchRef.current) {
      const key = event.ctrlKey ? `C-${event.key}` : event.key;
      const open = completions.length > 0;
      if (open && key === "Tab") {
        complete(completionAt);
        return true;
      }
      if (open && (key === "ArrowDown" || key === "C-n")) {
        setCompletionAt((at) => (at + 1) % completions.length);
        return true;
      }
      if (open && (key === "ArrowUp" || key === "C-p")) {
        setCompletionAt((at) => (at <= 0 ? completions.length : at) - 1);
        return true;
      }
      if (open && key === "Enter" && completionAt >= 0) {
        complete(completionAt);
        return true;
      }
      if (open && key === "Escape") {
        setCompletionsOff(true);
        setCompletionAt(-1);
        return true;
      }
      if (key === "Escape") {
        setQuery("");
        panelRef.current?.focus({ preventScroll: true });
      } else if (key === "ArrowDown" || key === "C-n") move(1);
      else if (key === "ArrowUp" || key === "C-p") move(-1);
      else if (key === "Enter" && pastedQuery && !pastedEntry) {
        // A request's URL searched for: Enter adds it.
        panelRef.current?.focus({ preventScroll: true });
        void add(pastedQuery);
      } else if (key === "Enter" && localReviewOfKey(selected)) {
        panelRef.current?.focus({ preventScroll: true });
        openLocal(localReviewOfKey(selected)!);
      } else if (key === "Enter") {
        const found =
          pastedEntry ??
          ordered.find((entry) => entry.key === selected) ??
          ordered[0];
        panelRef.current?.focus({ preventScroll: true });
        if (found) enter(found);
      } else return false;
      return true;
    }
    if (event.key === "Escape") {
      keyState.current = EMPTY_KEY_STATE;
      if (editing) setEditing(null);
      else if (prompt) setPrompt(null);
      else if (view === "settings") setView("list");
      else if (detail) setDetail(null);
      else if (hiddenOpen) setHiddenOpen(false);
      else if (query) setQuery("");
      // Hidden as it is: brought back full screen when it was.
      else onClose();
      return true;
    }
    if (
      !typing &&
      view === "list" &&
      detailEntry &&
      !prompt &&
      !editing &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const fed = feedKey(keyState.current, event.key);
      keyState.current = fed.state;
      if (fed.type === "wait") return fed.state.pending === "g";
      if (fed.key === "e") edit(detailEntry);
      else if (fed.key === "b") toggleUnsent(detailEntry);
      else if (fed.key === "E") clearOverride(detailEntry, "all");
      else if (fed.key === "gx") openLink(detailEntry);
      else if (fed.key === "gH") void startHome(detailEntry);
      else if (fed.key === ":") setCommand("");
      else return false;
      return true;
    }
    if (typing || view !== "list" || detail || prompt) return false;
    if (modeKey(event, typing)) return true;
    if (
      event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      shiftSelected(event.key === "ArrowUp" ? -1 : 1);
      return true;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const fed = feedKey(keyState.current, event.key);
    keyState.current = fed.state;
    if (fed.type === "wait") return true;
    const count = fed.count ?? 1;
    const current = ordered.find((entry) => entry.key === selected);
    const localCurrent = localReviewOfKey(selected);
    if (
      board &&
      (fed.key === "h" ||
        fed.key === "l" ||
        fed.key === "ArrowLeft" ||
        fed.key === "ArrowRight" ||
        fed.key === "Tab")
    ) {
      moveColumn(
        fed.key === "h" ||
          fed.key === "ArrowLeft" ||
          (fed.key === "Tab" && event.shiftKey)
          ? -count
          : count,
      );
    } else if (fed.key === "j" || fed.key === "ArrowDown") {
      move(count);
    } else if (fed.key === "k" || fed.key === "ArrowUp") {
      move(-count);
    } else if (fed.key === "gg" || fed.key === "Home") {
      const at = Math.min(walkKeys.length, fed.count ?? 1) - 1;
      if (at >= 0) setSelected(walkKeys[at]!);
    } else if (fed.key === "G" || fed.key === "End") {
      const at = Math.min(walkKeys.length, fed.count ?? walkKeys.length) - 1;
      if (at >= 0) setSelected(walkKeys[at]!);
    } else if (fed.key === "zz" || fed.key === "zt" || fed.key === "zb") {
      placeSelected(
        fed.key === "zz" ? "center" : fed.key === "zt" ? "start" : "end",
      );
    } else if (fed.key === "J") {
      shiftSelected(count);
    } else if (fed.key === "K") {
      shiftSelected(-count);
    } else if (fed.key === "/") {
      searchRef.current?.focus();
      searchRef.current?.select();
    } else if (fed.key === "?") {
      setHelpOpen((open) => !open);
    } else if (localCurrent && event.key === "Enter") {
      openLocal(localCurrent);
    } else if (
      localCurrent &&
      (fed.key === "dd" || event.key === "Delete" || event.key === "x")
    ) {
      void discardLocal(localCurrent);
    } else if (localCurrent && event.key === "w") {
      goLocalWorkspace(localCurrent);
    } else if (event.key === "Enter" && current) {
      enter(current);
    } else if (event.key === "i" && current) {
      showDetail(current);
    } else if (event.key === "c" && current) {
      void withClaude(current, false);
    } else if (event.key === "o" && current?.branch) {
      if (current.branch.url)
        window.open(current.branch.url, "_blank", "noopener");
      else say(`${current.branch.name} is not on the forge yet`);
    } else if (event.key === "o" && current) {
      window.open(current.url, "_blank", "noopener");
      markSeen(current);
    } else if (event.key === "w" && current) {
      goNthWorkspace(current, count);
    } else if (event.key === "P" && current) {
      togglePin(current);
    } else if (fed.key === "b" && current) {
      toggleUnsent(current);
    } else if (fed.key === "e" && current) {
      edit(current);
    } else if (fed.key === "E" && current) {
      clearOverride(current, "all");
    } else if (fed.key === "gx" && current) {
      openLink(current);
    } else if (fed.key === "gH" && current) {
      void startHome(current);
    } else if (
      (fed.key === "za" || fed.key === "zc" || fed.key === "zo") &&
      current
    ) {
      const row = laneGroups
        .flatMap((group) => group.rows)
        .find((each) => each.entry.key === current.key);
      if (row?.children) toggleChildren(current.key);
      else if (current.lane && current.section === "authored") {
        // The lane folds away: the selection goes to the next row shown.
        const lane = laneGroups.find((group) =>
          group.rows.some((each) => each.entry.key === current.key),
        )?.lane;
        if (lane) {
          const after = ordered.slice(ordered.indexOf(current) + 1);
          const next = after.find(
            (each) =>
              !laneGroups
                .find((g) => g.lane === lane)
                ?.rows.some((r) => r.entry.key === each.key),
          );
          toggleLane(lane);
          if (next) setSelected(next.key);
        }
      }
    } else if (event.key === "f") {
      setFilter(filters[(filters.indexOf(filter) + 1) % filters.length]!);
    } else if (event.key === "F") {
      setFilter(
        filters[
          (filters.indexOf(filter) + filters.length - 1) % filters.length
        ]!,
      );
    } else if (event.key === ":") {
      setCommand("");
    } else if (event.key === "r") {
      void reload(true);
    } else if (event.key === "a") {
      showChat();
    } else if (event.key === "p") {
      setAddText("");
    } else if ((fed.key === "dd" || event.key === "Delete") && current) {
      remove(current);
    } else if (event.key === "u" && undo?.run) {
      undoRemoval();
    } else if (event.key === "H") {
      setHiddenOpen((open) => !open);
    } else if (event.key === "x" && current) {
      // A suggestion: not interested (kept, and Claude learns from it); any
      // other request: out of the view, as dd.
      if (current.section === "suggested") feedback(current, "not_interested");
      else remove(current);
    } else if (event.key === "+" && current?.section === "suggested") {
      feedback(current, "more_like_this");
    } else return false;
    return true;
  };

  /**
   * The chat's message box, once it is there (its Vim editor loads on
   * first use), unless the user went elsewhere meanwhile.
   */
  const focusComposer = () => {
    let tries = 0;
    const take = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const box = panel.querySelector<HTMLElement>(
        ".mr-reviews-chat .agent-history-composer textarea, .mr-reviews-chat .agent-history-composer [contenteditable='true']",
      );
      if (box) {
        box.focus({ preventScroll: true });
        return;
      }
      const active = document.activeElement;
      if (active && active !== document.body && !panel.contains(active)) return;
      if (++tries < 30) setTimeout(take, 100);
    };
    take();
  };
  /** Its message box takes the focus once the chat is there. */
  const [composerFocus, setComposerFocus] = useState(
    initialView === "chat" ? 1 : 0,
  );
  const showChat = () => {
    setPrompt(null);
    setDetail(null);
    setView("chat");
    setComposerFocus((count) => count + 1);
  };

  // The panel's keys, taken on the window before the page's other key
  // handlers (a chat's, a terminal's) while the focus is in the panel.
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  const onKeyFirstRef = useRef(onKeyFirst);
  onKeyFirstRef.current = onKeyFirst;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      const target = event.target as Node | null;
      if (!panel || !target || !panel.contains(target)) return;
      // The inspector's own keys (gt, gT) come first: they leave the tab.
      if (!helpOpenRef.current && onKeyFirstRef.current?.(event)) {
        keyState.current = EMPTY_KEY_STATE;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (onKeyRef.current(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", listener, { capture: true });
    return () =>
      window.removeEventListener("keydown", listener, { capture: true });
  }, []);

  const problems = (inbox?.hosts ?? [])
    .map(hostProblem)
    .filter((line): line is string => !!line);
  const status = inbox?.refreshing
    ? "Refreshing"
    : inbox?.refreshedAt
      ? `Updated ${relative(inbox.refreshedAt)}`
      : "Not read yet";

  /** Local reviews: the first column of the board, atop the list. */
  const localLane = localShown ? (
    <LocalReviewsLane
      items={localItems}
      branches={localBranches}
      selected={selected}
      scope={{
        label: localScope ? (reviewWorkspace?.label ?? null) : null,
        fixed: work.coordinator || !reviewWorkspace,
        canNarrow: localWide,
      }}
      workspaceLabels={localWorkspaceLabels}
      onScope={(wide) => {
        setLocalWide(wide);
        if (localReviewOfKey(selected)) setSelected(null);
      }}
      onSelect={setSelected}
      onOpen={openLocal}
      onDiscard={(id) => void discardLocal(id)}
    />
  ) : null;

  /** The efforts' cards: atop Mine, or across the board's top. */
  const effortCards = efforts.length ? (
    <ul className="assistant-task-list mr-effort-cards" aria-label="Efforts">
      {efforts
        .filter(
          (each) =>
            !query ||
            each.name.toLowerCase().includes(query.toLowerCase()) ||
            query.toLowerCase().includes(`effort:${each.name.toLowerCase()}`),
        )
        .map((each) => (
          <MrEffortCard
            key={each.id}
            summary={each}
            onOpen={() => openEffort(each.id)}
            onLeader={() => void leader(each.id)}
          />
        ))}
    </ul>
  ) : null;

  const toast = undo ? (
    <div className="mr-reviews-undo" role="status">
      <span>
        {undo.label}
        {/[.!?]$/.test(undo.label) ? "" : "."}
      </span>
      {undo.run ? (
        <button type="button" className="ghost" onClick={undoRemoval}>
          Undo (u)
        </button>
      ) : null}
    </div>
  ) : null;

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      className={`assistant-panel mr-reviews-panel${mobile ? " is-mobile" : ""}${expanded ? " is-maximized" : ""}${board ? " is-board" : ""} is-${mode}`}
      aria-label={MODE_TITLE[mode]}
      onKeyDown={(event) => {
        // The chat's Vim editor keeps an Escape it takes (insert mode);
        // one it leaves gives the keys back to the panel.
        if (
          view !== "chat" ||
          event.key !== "Escape" ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          !(event.target as HTMLElement).closest(".cm-editor")
        )
          return;
        event.preventDefault();
        panelRef.current?.focus({ preventScroll: true });
      }}
      onPaste={(event) => {
        // A URL pasted into the panel (not into a box) is added.
        if (view !== "list" || mode !== "mr") return;
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, select, [contenteditable]"))
          return;
        const pasted = mrPastedRequest(
          event.clipboardData?.getData("text") ?? "",
        );
        if (!pasted) return;
        event.preventDefault();
        void add(pasted);
      }}
      onMouseDown={(event) => {
        // A click anywhere in the panel gives it the keys.
        const target = event.target as HTMLElement;
        if (!target.closest("button, a, input, textarea, select, [tabindex]"))
          requestAnimationFrame(() =>
            panelRef.current?.focus({ preventScroll: true }),
          );
      }}
    >
      <header className="assistant-panel-head">
        <div>
          <div className="assistant-panel-meta">
            {mode === "work" ? (
              work.meta
            ) : (
              <>
                <nav
                  className="assistant-primary-nav"
                  aria-label="Reviews views"
                >
                  <button
                    type="button"
                    className="ghost"
                    aria-pressed={view === "list"}
                    onClick={() => setView("list")}
                  >
                    Inbox
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    aria-pressed={view === "chat"}
                    title="Ask the reviews agent (a)"
                    onClick={showChat}
                  >
                    Chat
                  </button>
                </nav>
                <span
                  className={`assistant-panel-status${inbox?.refreshing ? " is-busy" : ""}`}
                >
                  {status}
                </span>
              </>
            )}
          </div>
        </div>
        {mode === "work" ? (
          work.actions
        ) : (
          <>
            {mobile && view === "list" ? (
              // No keys on a phone: the prompt p opens, from the head.
              <button
                type="button"
                className="assistant-icon-button"
                aria-label="Add a request"
                title="Add a request: paste its URL"
                onClick={() => setAddText("")}
              >
                <Plus size={16} />
              </button>
            ) : null}
            <button
              type="button"
              className="assistant-icon-button"
              aria-label="Refresh (r)"
              title="Refresh (r)"
              disabled={inbox?.refreshing}
              onClick={() => void reload(true)}
            >
              <RefreshCw size={16} />
            </button>
          </>
        )}
        <button
          type="button"
          className="assistant-icon-button"
          aria-label="Keys (?)"
          title="Keys (?)"
          aria-pressed={helpOpen}
          onClick={() => setHelpOpen((open) => !open)}
        >
          <Keyboard size={16} />
        </button>
        {mode === "mr" ? (
          <button
            type="button"
            className="assistant-icon-button"
            aria-label="Reviews settings"
            title={
              view === "settings"
                ? "Back to the list (Esc)"
                : "Settings: hosts, followed projects, checkout"
            }
            aria-pressed={view === "settings"}
            onClick={() => setView(view === "settings" ? "list" : "settings")}
          >
            <Settings size={16} />
          </button>
        ) : null}
      </header>
      {error ? (
        <div className="assistant-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
      {orderError ? (
        <div className="assistant-error" role="alert">
          <span>{orderError}</span>
          <button
            type="button"
            className="ghost"
            onClick={() => setOrderError(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {mode === "work" ? (
        <div className="assistant-tasks mr-reviews-body is-work">
          {work.inner ? null : (
            <input
              ref={work.searchRef}
              type="search"
              className="mr-reviews-search"
              data-dictation="off"
              aria-label="Search the items"
              placeholder="Search (/): words, #tag, owner"
              value={work.query}
              role="combobox"
              aria-expanded={work.completions.length > 0}
              aria-controls="work-completions"
              aria-autocomplete="list"
              onFocus={() => work.onSearchFocus(true)}
              onBlur={() => work.onSearchFocus(false)}
              onChange={(event) => work.setQuery(event.target.value)}
            />
          )}
          {!work.inner && work.completions.length ? (
            <ul
              id="work-completions"
              className="mr-reviews-completions"
              role="listbox"
              aria-label="Tags"
            >
              {work.completions.map((each, index) => (
                <li
                  key={each.tag}
                  role="option"
                  aria-selected={index === work.completionAt}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    work.complete(index);
                  }}
                >
                  #{each.tag}
                </li>
              ))}
            </ul>
          ) : null}
          {work.body}
        </div>
      ) : view === "chat" ? (
        <div className="mr-reviews-chat">
          {prompt ? (
            <MrPrompt
              prompt={prompt}
              busy={opening !== null}
              onDismiss={() => setPrompt(null)}
              onRetry={(entry) => void open(entry)}
              onAnswer={(entry, local) => void answerDirty(entry, local)}
              onWaitClaude={(entry) => void waitClaude(entry)}
            />
          ) : null}
          <MrReviewsChat
            mobile={mobile}
            focusRequest={composerFocus}
            onFocusComposer={focusComposer}
            onOpen={(item) => void open(entryOf(item))}
            onError={(message) => setChatError(message)}
          />
          {chatError ? (
            <div className="assistant-error" role="alert">
              <span>{chatError}</span>
              <button
                type="button"
                className="ghost"
                onClick={() => setChatError(null)}
              >
                Dismiss
              </button>
            </div>
          ) : null}
        </div>
      ) : view === "settings" ? (
        <>
          <div className="assistant-section-heading mr-reviews-back">
            <button
              type="button"
              className="ghost"
              onClick={() => setView("list")}
            >
              <ChevronLeft size={13} /> Inbox
            </button>
          </div>
          <MrReviewsSettingsView onSaved={() => void reload(true)} />
        </>
      ) : (
        <div
          className="assistant-tasks mr-reviews-body"
          onDragOver={(event) => {
            // A link dragged in from elsewhere (not a row being moved).
            if (dragging) return;
            const types = Array.from(event.dataTransfer?.types ?? []);
            if (types.includes("text/uri-list") || types.includes("text/plain"))
              event.preventDefault();
          }}
          onDrop={(event) => {
            if (dragging) return;
            const data = event.dataTransfer;
            const dropped = mrPastedRequest(
              (
                data?.getData("text/uri-list") ||
                data?.getData("text/plain") ||
                ""
              )
                .split(/\r?\n/)
                .find((line) => line && !line.startsWith("#")) ?? "",
            );
            if (!dropped) return;
            event.preventDefault();
            void add(dropped);
          }}
        >
          {prompt ? (
            <MrPrompt
              prompt={prompt}
              busy={opening !== null}
              onDismiss={() => setPrompt(null)}
              onRetry={(entry) => void open(entry)}
              onAnswer={(entry, local) => void answerDirty(entry, local)}
              onWaitClaude={(entry) => void waitClaude(entry)}
            />
          ) : null}
          {opening && !prompt ? (
            <p className="assistant-hint" role="status">
              Opening the review...
            </p>
          ) : null}
          {leaderAsk ? (
            <div
              className="assistant-hint mr-effort-leader-ask"
              role="alertdialog"
            >
              <p>
                No Claude session runs in the head workspace of {leaderAsk.name}
                . Start one there? It leads the effort: keeps the ledger,
                proposes planned requests, asks you to decide.
              </p>
              <div className="assistant-task-buttons">
                <button
                  type="button"
                  className="primary"
                  onClick={() => void leader(leaderAsk.id, true)}
                >
                  Start it
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setLeaderAsk(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {declaring ? (
            <MrEffortDeclare
              groups={inbox?.upstreamGroups ?? []}
              workspaces={inbox?.upstreamWorkspaces ?? []}
              {...(initialDeclare ? { initial: initialDeclare } : {})}
              onCancel={closeEffort}
              onDone={(id) => {
                setDeclaring(false);
                void reload().then(() => openEffort(id));
              }}
            />
          ) : effortView ? (
            <>
              <MrEffortView
                id={effortView}
                onBack={closeEffort}
                onLeader={() => void leader(effortView)}
                onJump={(connectionId, workspaceId) => {
                  void store
                    .jumpToConnectionWorkspace(connectionId, workspaceId)
                    .catch(() => {});
                  onClose({ keepFocus: true });
                }}
                say={sayUndo}
                entries={entries}
                links={links}
                wide={board}
                onEnter={enter}
                onGoWorkspace={goWorkspace}
                onStartHome={(entry) => void startHome(entry)}
                editor={(entry, close) => (
                  <MrOverrideForm
                    entry={entry}
                    known={entries}
                    busy={overrideBusy}
                    error={overrideError}
                    onCancel={close}
                    onSave={(change) => {
                      if (!change) {
                        close();
                        return;
                      }
                      void setOverride(entry, change, "Saved").then((ok) => {
                        if (ok) close();
                      });
                    }}
                  />
                )}
              />
              {toast}
            </>
          ) : detailEntry ? (
            <MrDetail
              entry={detailEntry}
              links={links[detailEntry.key]}
              onGoWorkspace={(link) => goWorkspace(detailEntry, link)}
              onBack={() => {
                setEditing(null);
                setDetail(null);
              }}
              board={
                <MrOverrideSummary
                  entry={detailEntry}
                  onSelect={(key) => {
                    if (!entries.some((each) => each.key === key)) {
                      say(`${refOfKey(key) ?? key} is not in your list`);
                      return;
                    }
                    setEditing(null);
                    setDetail(null);
                    setSelected(key);
                  }}
                  onClear={(field) => clearOverride(detailEntry, field)}
                />
              }
              editor={
                editing === detailEntry.key ? (
                  <MrOverrideForm
                    entry={detailEntry}
                    known={entries}
                    busy={overrideBusy}
                    error={overrideError}
                    onCancel={() => {
                      setEditing(null);
                      panelRef.current?.focus({ preventScroll: true });
                    }}
                    onSave={(change) => {
                      if (!change) {
                        setEditing(null);
                        panelRef.current?.focus({ preventScroll: true });
                        return;
                      }
                      void setOverride(detailEntry, change, "Saved").then(
                        (ok) => {
                          if (!ok) return;
                          setEditing(null);
                          panelRef.current?.focus({ preventScroll: true });
                        },
                      );
                    }}
                  />
                ) : null
              }
              actions={
                detailEntry.branch ? (
                  <>
                    <button
                      type="button"
                      className="primary"
                      title="It will be a request: listed as not proposed yet until it opens (b, :unsent)"
                      onClick={() => toggleUnsent(detailEntry)}
                    >
                      {detailEntry.unsent
                        ? "Back to a branch"
                        : "Will be a request"}
                    </button>
                    {editing !== detailEntry.key ? (
                      <button
                        type="button"
                        className="ghost"
                        title="Set who it is on, the next step, what it waits for, labels, a link (e)"
                        onClick={() => edit(detailEntry)}
                      >
                        Set by hand
                      </button>
                    ) : null}
                  </>
                ) : (
                  <>
                    {editing !== detailEntry.key ? (
                      <button
                        type="button"
                        className="ghost"
                        title="Set who it is on, the next step, what it waits for, labels, a link (e)"
                        onClick={() => edit(detailEntry)}
                      >
                        Set by hand
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="primary"
                      disabled={opening === detailEntry.key}
                      title={
                        detailHome
                          ? `Its review in its home, ${detailHome.label || detailHome.workspaceId} (Enter)`
                          : "Its review in the project's review workspace (Enter)"
                      }
                      onClick={() => enter(detailEntry)}
                    >
                      {opening === detailEntry.key
                        ? "Opening..."
                        : detailHome
                          ? "Review in its home"
                          : "Review"}
                    </button>
                    <button
                      type="button"
                      className={detailHome ? "ghost" : "primary"}
                      disabled={opening === detailEntry.key}
                      title={`A workspace of its own on its head, with a Claude session told (gH, :home): ${homePromptOf(detailEntry)}`}
                      onClick={() => void startHome(detailEntry)}
                    >
                      <HousePlus size={13} /> Start a review with a home
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={opening === detailEntry.key}
                      title="Check out its head in the project's review worktree"
                      onClick={() => void open(detailEntry, "now")}
                    >
                      Check out
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={opening === detailEntry.key}
                      title="Claude reads the request and leaves its threads in the review pane; nothing goes to the forge"
                      onClick={() => void withClaude(detailEntry, true)}
                    >
                      Review with Claude
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={opening === detailEntry.key}
                      title="This request's own Claude session, in its review workspace"
                      onClick={() => void withClaude(detailEntry, false)}
                    >
                      Ask Claude
                    </button>
                    {detailEntry.section !== "pinned" ? (
                      <button
                        type="button"
                        className="ghost"
                        title="Pin it on top (P, :pin)"
                        onClick={() => togglePin(detailEntry, true)}
                      >
                        <Pin size={13} /> Pin
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ghost"
                      title={
                        detailEntry.section === "pinned"
                          ? "Unpin it (P, dd)"
                          : "Remove it from the view (dd)"
                      }
                      onClick={() => remove(detailEntry)}
                    >
                      {detailEntry.section === "pinned" ? "Unpin" : "Remove"}
                    </button>
                    {renderActions?.(detailEntry)}
                    {detailEntry.section === "suggested" ? (
                      <>
                        <button
                          type="button"
                          className="ghost"
                          aria-pressed={
                            detailEntry.feedback === "more_like_this"
                          }
                          onClick={() =>
                            feedback(detailEntry, "more_like_this")
                          }
                        >
                          More like this
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          aria-pressed={
                            detailEntry.feedback === "not_interested"
                          }
                          onClick={() =>
                            feedback(detailEntry, "not_interested")
                          }
                        >
                          Not interested
                        </button>
                      </>
                    ) : null}
                  </>
                )
              }
            />
          ) : !inbox ? (
            <>
              {localLane ? (
                <div className="mr-reviews-sections">{localLane}</div>
              ) : null}
              <div className="assistant-panel-empty">
                <LoaderCircle className="assistant-spinner" size={24} />
              </div>
            </>
          ) : (
            <>
              {problems.length ? (
                <div className="assistant-hint mr-reviews-hosts">
                  {problems.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              ) : null}
              {addError ? (
                <p className="assistant-error" role="alert">
                  {addError}
                </p>
              ) : null}
              {entries.length ? (
                <input
                  ref={searchRef}
                  type="search"
                  className="mr-reviews-search"
                  aria-label="Search the reviews"
                  placeholder="Search (/): words, project:, label:, lane:, waiting:, state:..."
                  value={query}
                  role="combobox"
                  aria-expanded={completions.length > 0}
                  aria-controls="mr-reviews-completions"
                  aria-autocomplete="list"
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => setSearchFocused(false)}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSelected(null);
                    setCompletionAt(-1);
                    setCompletionsOff(false);
                  }}
                />
              ) : null}
              {pastedQuery && !pastedEntry ? (
                <button
                  type="button"
                  className="ghost mr-reviews-add-offer"
                  title="Pin it to your reviews (Enter in the search)"
                  disabled={adding}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void add(pastedQuery)}
                >
                  <Plus size={14} /> Add this request <span>{pastedQuery}</span>
                </button>
              ) : null}
              {entries.length && completions.length ? (
                <ul
                  id="mr-reviews-completions"
                  className="mr-reviews-completions"
                  role="listbox"
                  aria-label="Completions"
                >
                  {completions.slice(0, 12).map((each, index) => (
                    <li
                      key={each.label}
                      role="option"
                      aria-selected={index === completionAt}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        complete(index);
                      }}
                    >
                      {each.label}
                    </li>
                  ))}
                </ul>
              ) : null}
              {entries.length ? (
                <nav
                  className="assistant-primary-nav mr-reviews-filter"
                  aria-label="Show"
                >
                  {filters.map((each) => (
                    <button
                      key={each}
                      type="button"
                      aria-pressed={
                        searchView
                          ? each === `view:${searchView.name}`
                          : filter === each
                      }
                      className={`ghost${each.startsWith("view:") ? " mr-reviews-view-chip" : ""}`}
                      title={
                        each.startsWith("view:")
                          ? `${views.find((view) => `view:${view.name}` === each)?.query ?? ""} (f / F, :view ${filterTitle(each)}, :delview to delete it)`
                          : `${filterTitle(each)} (f / F, :${each})`
                      }
                      onClick={() => setFilter(each)}
                    >
                      {filterTitle(each)}
                      {each === "all" ? null : (
                        <span>
                          {
                            entries.filter(
                              (entry) =>
                                filtered(entry, each, views) &&
                                (entry.section !== "suggested" ||
                                  each !== "mine"),
                            ).length
                          }
                        </span>
                      )}
                    </button>
                  ))}
                </nav>
              ) : null}
              {hidden.length ? (
                <div className="mr-reviews-hidden">
                  <button
                    type="button"
                    className="ghost"
                    aria-pressed={hiddenOpen}
                    title="Requests you removed, back when something happens on them (H)"
                    onClick={() => setHiddenOpen((open) => !open)}
                  >
                    {hidden.length} hidden
                  </button>
                  {hiddenOpen ? (
                    <ul aria-label="Hidden requests">
                      {hidden.map((each) => (
                        <li key={each.key}>
                          <span>
                            <span className="mr-reviews-number">
                              {mrRefLabel(each, true)}
                            </span>{" "}
                            {each.title}
                          </span>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => restore(each.key)}
                          >
                            Restore
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {board && visibleSections.includes("authored")
                ? effortCards
                : null}
              <div
                ref={boardRef}
                className={board ? "mr-reviews-board" : "mr-reviews-sections"}
              >
                {localLane}
                {drawnSections.map((section) => (
                  <section
                    key={section}
                    className={`mr-reviews-section${section === "authored" && lanesOn ? " has-lanes" : ""}`}
                    aria-label={SECTION_TITLE[section]}
                  >
                    <h3 className="mr-reviews-section-title">
                      {SECTION_TITLE[section]}
                      <span>
                        {query || filter !== "all"
                          ? `${shown[section].length} of ${bySection[section].length}`
                          : bySection[section].length}
                      </span>
                    </h3>
                    {section === "authored" && !board ? effortCards : null}
                    {section === "authored" && lanesOn ? (
                      laneGroups.map((group) => (
                        <div
                          key={group.lane}
                          className={`mr-reviews-lane is-${group.lane}${group.folded ? " is-folded" : ""}`}
                          role="group"
                          aria-label={MR_LANE_TITLE[group.lane]}
                        >
                          <button
                            type="button"
                            className="mr-reviews-lane-title"
                            aria-expanded={!group.folded}
                            title={`${group.folded ? "Expand" : "Fold"} ${MR_LANE_TITLE[group.lane]} (za)`}
                            onClick={() => toggleLane(group.lane)}
                          >
                            {group.folded ? (
                              <ChevronRight size={13} />
                            ) : (
                              <ChevronDown size={13} />
                            )}
                            {MR_LANE_TITLE[group.lane]}
                            <span>{group.count}</span>
                          </button>
                          {!group.folded &&
                          group.count >
                            group.rows.filter(
                              (row) => row.entry.lane === group.lane,
                            ).length ? (
                            <p className="assistant-hint mr-reviews-lane-hint">
                              {(() => {
                                const under =
                                  group.count -
                                  group.rows.filter(
                                    (row) => row.entry.lane === group.lane,
                                  ).length;
                                return `${under} drawn under the request${under === 1 ? "" : "s"} ${under === 1 ? "it waits" : "they wait"} for`;
                              })()}
                            </p>
                          ) : null}
                          {group.rows.length ? (
                            <ul className="assistant-task-list">
                              {group.rows.map((row) => (
                                <MrReviewRow
                                  key={row.entry.key}
                                  entry={row.entry}
                                  tree={row}
                                  onToggleChildren={() =>
                                    toggleChildren(row.entry.key)
                                  }
                                  selected={row.entry.key === selected}
                                  onSelect={() => setSelected(row.entry.key)}
                                  onOpen={() => enter(row.entry)}
                                  move={rowMove(row.entry)}
                                  onRemove={() => remove(row.entry)}
                                  links={links[row.entry.key]}
                                  onGoWorkspace={(link) =>
                                    goWorkspace(row.entry, link)
                                  }
                                  onTogglePin={() => togglePin(row.entry)}
                                  onStartHome={() => void startHome(row.entry)}
                                />
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      ))
                    ) : shown[section].length ? (
                      <ul className="assistant-task-list">
                        {shown[section].map((entry) => (
                          <MrReviewRow
                            key={entry.key}
                            entry={entry}
                            selected={entry.key === selected}
                            onSelect={() => setSelected(entry.key)}
                            onOpen={() => enter(entry)}
                            move={rowMove(entry)}
                            onRemove={() => remove(entry)}
                            links={links[entry.key]}
                            onGoWorkspace={(link) => goWorkspace(entry, link)}
                            onTogglePin={() => togglePin(entry)}
                            onStartHome={() => void startHome(entry)}
                          />
                        ))}
                      </ul>
                    ) : bySection[section].length ? (
                      <p className="assistant-hint">Nothing matches.</p>
                    ) : (
                      <p className="assistant-hint">
                        {section === "mine"
                          ? inbox.refreshedAt
                            ? "Nothing waits for you."
                            : "Reading the forges..."
                          : section === "authored"
                            ? inbox.refreshedAt
                              ? "No request of yours is open."
                              : "Reading the forges..."
                            : inbox.curation.state === "off"
                              ? "Follow projects in the settings to get suggestions."
                              : inbox.curation.state === "running"
                                ? "Claude is picking suggestions..."
                                : "No suggestion right now."}
                      </p>
                    )}
                  </section>
                ))}
              </div>
              {!mobile ? (
                <p className="assistant-hint mr-reviews-keys">
                  j/k move · Enter its review in its home, else review · gH a
                  home · i details · e set next step, who is it on · w workspace
                  · P pin · f all, to review, mine · za fold · c Claude · o on
                  the forge · J/K reorder · / search · : command · p add by URL
                  · dd remove · ? all keys
                </p>
              ) : null}
              {toast}
            </>
          )}
        </div>
      )}
      {command !== null ? (
        <div className="mr-reviews-command">
          <span aria-hidden="true">:</span>
          <input
            ref={commandRef}
            type="text"
            aria-label="Command"
            placeholder="note, whose, after, label, link, clear, pin, add URL, mine, refresh"
            autoComplete="off"
            spellCheck={false}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onBlur={() => setCommand(null)}
          />
        </div>
      ) : null}
      {addText !== null ? (
        <div className="mr-reviews-command mr-reviews-adder">
          <span aria-hidden="true">Add</span>
          <input
            ref={addRef}
            type="text"
            aria-label="Add a merge or pull request"
            placeholder="paste a merge or pull request URL, or group/project!12"
            autoComplete="off"
            spellCheck={false}
            value={addText}
            onChange={(event) => {
              setAddText(event.target.value);
              setAddError(null);
            }}
            onBlur={() => setAddText(null)}
          />
        </div>
      ) : null}
      {helpOpen ? (
        <ShortcutHelp
          title={`${MODE_TITLE[mode]} keys`}
          rows={mode === "work" ? WORK_KEYS : MR_REVIEWS_KEYS}
          command={runCommand}
          target={() => panelRef.current}
          onClose={() => setHelpOpen(false)}
        />
      ) : null}
    </aside>
  );
}
