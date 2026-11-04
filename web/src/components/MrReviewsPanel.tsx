import {
  ChevronLeft,
  ExternalLink,
  LoaderCircle,
  Maximize2,
  Minimize2,
  RefreshCw,
  Settings,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { forgeKind, forgeRefLabel } from "../../../shared/forge";
import type {
  MrHostState,
  MrInboxEntry,
  MrReason,
  MrSection,
} from "../../../shared/mrReviews";
import { useLayoutPreferences } from "../layoutPreferences";
import { mrReviewsCall, useMrInbox } from "../mrReviews";
import { checkoutMrReview, openMrReview, setMrClone } from "../mrReviewFlow";
import { formatUiDateTime } from "../uiLocale";
import { MrReviewsSettingsView } from "./MrReviewsSettings";
import "./AssistantPanel.css";
import "./AssistantTasks.css";
import "./MrReviewsPanel.css";

/**
 * The reviews inbox, Ranger's sibling: the same right-hand panel, head,
 * list rows and state chips, list/detail split and Escape order. Two
 * sections: the requests that are the user's (review requested, assigned,
 * mentioned) and Claude's suggestions from the followed projects.
 */

type View = "list" | "settings";

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
  | { kind: "error"; entry: MrInboxEntry; message: string };

function MrPrompt({
  prompt,
  busy,
  onDismiss,
  onRetry,
  onAnswer,
}: {
  prompt: Prompt;
  busy: boolean;
  onDismiss: () => void;
  onRetry: (entry: MrInboxEntry) => void;
  onAnswer: (entry: MrInboxEntry, local: "wip" | "discard") => void;
}) {
  const [connection, setConnection] = useState(
    prompt.kind === "clone" ? (prompt.connections[0]?.id ?? "") : "",
  );
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const label = forgeRefLabel(prompt.entry);
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
};

const SECTION_TITLE: Record<MrSection, string> = {
  mine: "For you",
  suggested: "Suggested",
};

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

/** What changed since the user looked, in a few words; null when nothing. */
export function unreadLabel(entry: MrInboxEntry): string | null {
  if (entry.isNew) return "new";
  const unread = entry.unread;
  if (!unread?.changed) return null;
  const parts = [
    ...(unread.newCommits ? ["new commits"] : []),
    ...(unread.newNotes
      ? [`${unread.newNotes} new comment${unread.newNotes === 1 ? "" : "s"}`]
      : []),
  ];
  return parts.length ? parts.join(", ") : "updated";
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

export function MrReviewRow({
  entry,
  selected,
  onSelect,
  onOpen,
}: {
  entry: MrInboxEntry;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const unread = unreadLabel(entry);
  const drafts = draftsLabel(entry);
  return (
    <li>
      <button
        type="button"
        className={`assistant-task-row mr-reviews-row${selected ? " is-selected" : ""}${unread ? " is-unread" : ""}`}
        aria-current={selected ? "true" : undefined}
        data-mr-key={entry.key}
        onFocus={onSelect}
        onClick={onOpen}
      >
        <div>
          <strong>
            <span className="mr-reviews-number">
              {forgeRefLabel(entry, true)}
            </span>{" "}
            {entry.title}
          </strong>
          <span className={`assistant-task-state is-${stateLabel(entry)}`}>
            {stateLabel(entry)}
          </span>
        </div>
        <span className="mr-reviews-row-meta">
          <PipelineDot status={entry.pipeline} />
          {entry.project} · {entry.author} · {relative(entry.updatedAt)}
        </span>
        {entry.section === "suggested" && entry.reason ? (
          <small className="mr-reviews-reason">{entry.reason}</small>
        ) : entry.reasons.length ? (
          <small>{entry.reasons.map((r) => REASON_LABEL[r]).join(", ")}</small>
        ) : null}
        {unread || drafts ? (
          <small className="mr-reviews-badges">
            {unread ? <em className="mr-reviews-unread">{unread}</em> : null}
            {drafts ? <em className="mr-reviews-drafts">{drafts}</em> : null}
          </small>
        ) : null}
      </button>
    </li>
  );
}

function MrDetail({
  entry,
  onBack,
  actions,
}: {
  entry: MrInboxEntry;
  onBack: () => void;
  actions?: ReactNode;
}) {
  const unread = unreadLabel(entry);
  const drafts = draftsLabel(entry);
  const kind = forgeKind(entry.provider);
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
            <span className="mr-reviews-number">{forgeRefLabel(entry)}</span>{" "}
            {entry.title}
          </h3>
          <span className={`assistant-task-state is-${stateLabel(entry)}`}>
            {stateLabel(entry)}
          </span>
        </div>
        {entry.reason ? (
          <p className="mr-reviews-reason">{entry.reason}</p>
        ) : null}
        <dl className="assistant-task-metadata">
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
          <div>
            <dt>Since you looked</dt>
            <dd>{unread ?? "nothing new"}</dd>
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

export function MrReviewsPanel({
  onClose,
  initialSelect,
  initialOpen,
  renderActions,
  onOpenEntry,
}: {
  /** keepFocus: a review was shown; the focus is the review's now. */
  onClose: (options?: { keepFocus?: boolean }) => void;
  /** A request to open at once (the command menu). */
  initialOpen?: string;
  /** The request to show selected (from a review: the one shown). */
  initialSelect?: string;
  /** Step (b) on: the buttons of a request's detail (Review...). */
  renderActions?: (entry: MrInboxEntry) => ReactNode;
  /** Enter on a request: its review (else its detail). */
  onOpenEntry?: (entry: MrInboxEntry) => void;
}) {
  const { mobile } = useLayoutPreferences();
  const { inbox, error, reload } = useMrInbox();
  const [view, setView] = useState<View>("list");
  const [maximized, setMaximized] = useState(false);
  const [selected, setSelected] = useState<string | null>(
    initialSelect ?? null,
  );
  const [detail, setDetail] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const openedAt = useRef(Date.now());
  const entries = useMemo(() => inbox?.entries ?? [], [inbox]);
  const bySection = useMemo(() => {
    const groups: Record<MrSection, MrInboxEntry[]> = {
      mine: [],
      suggested: [],
    };
    for (const entry of entries) groups[entry.section].push(entry);
    return groups;
  }, [entries]);
  const ordered = [...bySection.mine, ...bySection.suggested];
  const detailEntry = detail
    ? entries.find((entry) => entry.key === detail)
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

  const showDetail = (entry: MrInboxEntry) => {
    setSelected(entry.key);
    setDetail(entry.key);
    void mrReviewsCall("seen", { key: entry.key }).catch(() => {});
  };

  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  /** Its review, in the project's review workspace. */
  const open = async (entry: MrInboxEntry, checkout?: "now" | "later") => {
    setSelected(entry.key);
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

  // The command menu's request: opened as soon as the inbox knows it.
  const openedInitial = useRef(false);
  useEffect(() => {
    if (!initialOpen || openedInitial.current) return;
    const entry = entries.find((each) => each.key === initialOpen);
    if (!entry) return;
    openedInitial.current = true;
    void open(entry);
    // biome-ignore lint/correctness/useExhaustiveDependencies: once
  }, [entries, initialOpen]);

  const feedback = (
    entry: MrInboxEntry,
    verdict: "not_interested" | "more_like_this",
  ) =>
    void mrReviewsCall("feedback", {
      key: entry.key,
      verdict: entry.feedback === verdict ? null : verdict,
    }).then(() => reload());

  const move = (step: number) => {
    if (!ordered.length) return;
    const at = ordered.findIndex((entry) => entry.key === selected);
    const next =
      at < 0
        ? step > 0
          ? 0
          : ordered.length - 1
        : Math.min(ordered.length - 1, Math.max(0, at + step));
    setSelected(ordered[next]!.key);
  };

  /** One key in the panel; true when the panel took it. */
  const onKey = (event: KeyboardEvent): boolean => {
    // Another handler may have marked it (a chat's Escape, say): the panel
    // still owns its keys while it has the focus.
    if (event.isComposing) return false;
    const typing =
      event.target instanceof HTMLElement &&
      (event.target.closest("input, textarea, select, [contenteditable]") ??
        null) !== null;
    if (event.key === "Escape") {
      if (prompt) setPrompt(null);
      else if (view === "settings") setView("list");
      else if (detail) setDetail(null);
      else if (maximized && !mobile) setMaximized(false);
      else onClose();
      return true;
    }
    if (typing || view !== "list" || detail || prompt) return false;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const current = ordered.find((entry) => entry.key === selected);
    if (event.key === "j" || event.key === "ArrowDown") {
      move(1);
    } else if (event.key === "k" || event.key === "ArrowUp") {
      move(-1);
    } else if (event.key === "Enter" && current) {
      void open(current);
    } else if (event.key === "i" && current) {
      showDetail(current);
    } else if (event.key === "o" && current) {
      window.open(current.url, "_blank", "noopener");
    } else if (event.key === "r") {
      void reload(true);
    } else if (event.key === "x" && current?.section === "suggested") {
      feedback(current, "not_interested");
    } else if (event.key === "+" && current?.section === "suggested") {
      feedback(current, "more_like_this");
    } else return false;
    return true;
  };

  // The panel's keys, taken on the window before the page's other key
  // handlers (a chat's, a terminal's) while the focus is in the panel.
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      const target = event.target as Node | null;
      if (!panel || !target || !panel.contains(target)) return;
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

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      className={`assistant-panel mr-reviews-panel ${mobile ? "is-mobile" : maximized ? "is-maximized" : "is-floating"}`}
      aria-label="Reviews"
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
          <div className="assistant-panel-title">
            <strong>Reviews</strong>
          </div>
          <div className="assistant-panel-meta">
            <span
              className={`assistant-panel-status${inbox?.refreshing ? " is-busy" : ""}`}
            >
              {status}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="assistant-icon-button"
          aria-label="Refresh"
          title="Refresh (r)"
          disabled={inbox?.refreshing}
          onClick={() => void reload(true)}
        >
          <RefreshCw size={16} />
        </button>
        {!mobile ? (
          <button
            type="button"
            className="assistant-icon-button"
            title={maximized ? "Restore window" : "Maximize window"}
            aria-label={maximized ? "Restore Reviews" : "Maximize Reviews"}
            aria-pressed={maximized}
            onClick={() => setMaximized((current) => !current)}
          >
            {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        ) : null}
        <button
          type="button"
          className="assistant-icon-button"
          aria-label="Reviews settings"
          title="Hosts, followed projects, checkout"
          aria-pressed={view === "settings"}
          onClick={() => setView(view === "settings" ? "list" : "settings")}
        >
          <Settings size={16} />
        </button>
        <button
          type="button"
          className="assistant-icon-button"
          aria-label="Close Reviews"
          title="Close"
          onClick={() => onClose()}
        >
          <X size={16} />
        </button>
      </header>
      {error ? (
        <div className="assistant-error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
      {view === "settings" ? (
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
        <div className="assistant-tasks mr-reviews-body">
          {prompt ? (
            <MrPrompt
              prompt={prompt}
              busy={opening !== null}
              onDismiss={() => setPrompt(null)}
              onRetry={(entry) => void open(entry)}
              onAnswer={(entry, local) => void answerDirty(entry, local)}
            />
          ) : null}
          {opening && !prompt ? (
            <p className="assistant-hint" role="status">
              Opening the review...
            </p>
          ) : null}
          {detailEntry ? (
            <MrDetail
              entry={detailEntry}
              onBack={() => setDetail(null)}
              actions={
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={opening === detailEntry.key}
                    onClick={() => void open(detailEntry)}
                  >
                    {opening === detailEntry.key ? "Opening..." : "Review"}
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
                  {renderActions?.(detailEntry)}
                  {detailEntry.section === "suggested" ? (
                    <>
                      <button
                        type="button"
                        className="ghost"
                        aria-pressed={detailEntry.feedback === "more_like_this"}
                        onClick={() => feedback(detailEntry, "more_like_this")}
                      >
                        More like this
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        aria-pressed={detailEntry.feedback === "not_interested"}
                        onClick={() => feedback(detailEntry, "not_interested")}
                      >
                        Not interested
                      </button>
                    </>
                  ) : null}
                </>
              }
            />
          ) : !inbox ? (
            <div className="assistant-panel-empty">
              <LoaderCircle className="assistant-spinner" size={24} />
            </div>
          ) : (
            <>
              {problems.length ? (
                <div className="assistant-hint mr-reviews-hosts">
                  {problems.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              ) : null}
              {(["mine", "suggested"] as const).map((section) => (
                <section
                  key={section}
                  className="mr-reviews-section"
                  aria-label={SECTION_TITLE[section]}
                >
                  <h3 className="mr-reviews-section-title">
                    {SECTION_TITLE[section]}
                    <span>{bySection[section].length}</span>
                  </h3>
                  {bySection[section].length ? (
                    <ul className="assistant-task-list">
                      {bySection[section].map((entry) => (
                        <MrReviewRow
                          key={entry.key}
                          entry={entry}
                          selected={entry.key === selected}
                          onSelect={() => setSelected(entry.key)}
                          onOpen={() => void open(entry)}
                        />
                      ))}
                    </ul>
                  ) : (
                    <p className="assistant-hint">
                      {section === "mine"
                        ? inbox.refreshedAt
                          ? "Nothing waits for you."
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
              {!mobile ? (
                <p className="assistant-hint mr-reviews-keys">
                  j/k move · Enter review · i details · o on the forge · x not
                  interested · + more like this · r refresh
                </p>
              ) : null}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
