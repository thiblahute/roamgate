import { ChevronLeft, RefreshCw } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MR_DISPOSITIONS,
  type MrDisposition,
  type MrEffort,
  type MrEffortSummary,
} from "../../../shared/mrReviews";
import { mrReviewsCall, onMrReviewsChange } from "../mrReviews";
import { EMPTY_KEY_STATE, feedKey } from "../reviewNavigation";
import { useWorkspaceTree } from "../workspaceTreeStore";
import "./MrEffortView.css";

/**
 * Upstreaming efforts in Reviews: a card per effort at the top of Mine
 * (progress by disposition), and the effort's view: Progress (bar, counts,
 * burndown, breakdown by directory), Ledger (every commit, selectable,
 * dispositions set in bulk with Undo) and Feeders.
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
}: {
  commits: LedgerCommit[];
  selected: ReadonlySet<string>;
  cursor: number;
  onCursor: (index: number) => void;
  onToggle: (key: string) => void;
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
              <span className="mr-ledger-note" title={commit.note}>
                {commit.note ?? ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type Tab = "progress" | "ledger" | "feeders";

/** One effort, maximized in the panel. */
export function MrEffortView({
  id,
  onBack,
  onLeader,
  say,
}: {
  id: string;
  onBack: () => void;
  onLeader: () => void;
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
  const [history, setHistory] = useState<Record<string, unknown>[] | null>(
    null,
  );
  const keyState = useRef(EMPTY_KEY_STATE);
  const rootRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const commandRef = useRef<HTMLInputElement>(null);

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
    else if (name === "plan")
      void setDisposition("planned", argument ? { reason: argument } : {});
    else if (name === "unsort") void setDisposition("unsorted");
    else if (name === "refresh")
      void mrReviewsCall("effort.refresh", { id }).then(load);
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
    if (target.closest("input, textarea, select")) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (history) setHistory(null);
      else if (selected.size) setSelected(new Set());
      else onBack();
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
    if (fed.key === "P") setTab("progress");
    else if (fed.key === "L") setTab("ledger");
    else if (fed.key === "F") setTab("feeders");
    else if (fed.key === "c") onLeader();
    else if (tab !== "ledger") handled = false;
    else if (fed.key === "j" || fed.key === "ArrowDown") move(cursor + count);
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
    else if (fed.key === ":") setCommand("");
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
      ).then((answer) => setHistory(answer.versions));
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

  let body: ReactNode;
  if (error) body = <p className="assistant-error">{error}</p>;
  else if (!detail || !summary)
    body = <p className="assistant-hint">Reading the effort...</p>;
  else if (tab === "progress")
    body = (
      <div className="mr-effort-progress">
        <EffortBar summary={summary} />
        <p>{countsText(summary)}</p>
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
            {dirs.slice(0, 30).map(([dir, counts]) => (
              <tr key={dir}>
                <td>{dir}</td>
                {MR_DISPOSITIONS.map((each) => (
                  <td key={each}>{counts[each] ?? ""}</td>
                ))}
              </tr>
            ))}
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
          NAME · :unsort · u undo · Enter its history
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
        />
        {history ? (
          <section className="mr-effort-history" aria-label="Its versions">
            <h4>Its versions, oldest first</h4>
            <ol>
              {history.map((version, index) => (
                <li key={index}>
                  <code>{String(version.sha).slice(0, 10)}</code>{" "}
                  {String(version.subject)}{" "}
                  <small>
                    {String(version.where)} ·{" "}
                    {String(version.seenAt).slice(0, 16).replace("T", " ")}
                  </small>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </>
    );
  else
    body = detail.feeders.length ? (
      <ul className="mr-effort-feeders" aria-label="Feeders">
        {detail.feeders.map((feeder) => (
          <li key={feeder.ref}>
            <code>{feeder.ref.replace(/^refs\/(heads|remotes)\//, "")}</code>:{" "}
            {feeder.notReady} not on the source yet, {feeder.drift} behind it
          </li>
        ))}
      </ul>
    ) : (
      <p className="assistant-hint">
        No feeder: say which branches land into the source with effort_set.
      </p>
    );

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      className="mr-effort-view"
      aria-label={`Effort ${detail?.effort.name ?? ""}`}
      onKeyDown={onKey}
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
        <button type="button" className="ghost" onClick={onLeader} title="c">
          Leader session
        </button>
      </div>
      <nav className="assistant-primary-nav" aria-label="Effort views">
        {(["progress", "ledger", "feeders"] as const).map((each) => (
          <button
            key={each}
            type="button"
            className="ghost"
            aria-pressed={tab === each}
            title={`${each[0]!.toUpperCase()}`}
            onClick={() => setTab(each)}
          >
            {each[0]!.toUpperCase() + each.slice(1)}
          </button>
        ))}
      </nav>
      {body}
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
    </section>
  );
}

/** Declaring an effort on a group headed upstream, its overlaps shown first. */
export function MrEffortDeclare({
  groups,
  onDone,
  onCancel,
}: {
  /** The groups headed upstream, by id. */
  groups: string[];
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const tree = useWorkspaceTree();
  const named = groups.flatMap((id) => {
    const node = tree.nodes.find((each) => each.id === id);
    return node?.kind === "group" ? [{ id, label: node.label }] : [];
  });
  const [group, setGroup] = useState(named[0]?.id ?? "");
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
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
        Mark a group of the Workspaces tree as Headed upstream first (its menu),
        with the source's clone among its workspaces.
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
        <span>Group</span>
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
