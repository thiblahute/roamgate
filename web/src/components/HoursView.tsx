import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BLOCK_STATUS_LABELS,
  type Block,
  canPreview,
  changeLine,
  clockOf,
  clockMinutes,
  DAY_STATUS_LABELS,
  failureText,
  previewWorkedMinutes,
  REOPENED_LABELS,
  reopenedTitle,
  splitPoints,
  UNIT_MINUTES,
  workedMinutes,
  type Day,
  type DaySummary,
  type Evidence,
  type Explanation,
  formatMinutes,
  type Gap,
  hoursWindow,
  isoAt,
  openQuestions,
  placeIn,
  type Preview,
  recentRange,
  SOURCE_LABELS,
  type SubmitResult,
  shortDate,
  submitHint,
  targetColor,
} from "../hoursModel";
import type { TimelineWorkspace } from "../activityTimelineModel";
import { workspaceColor } from "../activityTimelineModel";
import {
  type TaskType,
  type Target,
  TimeReportError,
  timeReport,
} from "../timeReportApi";
import "./HoursView.css";

/** How long between two polls of a day the provider is still refreshing. */
const POLL_MS = [2_000, 4_000, 8_000, 15_000];

type Targets = { targets: Target[]; task_types: TaskType[] };

type Submit =
  | { step: "previewing" }
  | { step: "preview"; preview: Preview }
  | { step: "confirm"; preview: Preview; checked: boolean }
  | { step: "submitting"; preview: Preview }
  | { step: "result"; result: SubmitResult; error: string | null }
  | { step: "error"; message: string };

/**
 * The Hours view: a day of the provider's blocks over its cleaned
 * timeline, questions answered in place, gaps to claim, and the one way
 * anything reaches the tracker: Preview, an explicit confirmation, Submit.
 */
export function HoursView({
  date,
  onDate,
  workspaces,
  onEditMapping,
}: {
  date: string;
  onDate: (date: string) => void;
  /** The timeline's workspaces, to open a subject's mapping from a block. */
  workspaces: TimelineWorkspace[];
  onEditMapping?: (workspace: TimelineWorkspace) => void;
}) {
  const [day, setDay] = useState<Day | null>(null);
  const [summaries, setSummaries] = useState<DaySummary[]>([]);
  const [targets, setTargets] = useState<Targets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [submit, setSubmit] = useState<Submit | null>(null);
  const request = useRef(0);
  const poll = useRef<number | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      if (poll.current !== null) window.clearTimeout(poll.current);
    },
    [],
  );

  const loadSummaries = useCallback(() => {
    const range = recentRange(date > today() ? date : today());
    timeReport<{ days: DaySummary[] }>("days", range).then(
      (reply) => alive.current && setSummaries([...reply.days].reverse()),
      () => undefined,
    );
  }, [date]);

  const load = useCallback(
    async (attempt = 0) => {
      const id = ++request.current;
      if (poll.current !== null) window.clearTimeout(poll.current);
      try {
        const next = await timeReport<Day>("day", { date });
        if (!alive.current || id !== request.current) return;
        setDay(next);
        setError(null);
        setRefreshing(!!next.refreshing);
        // The provider finishes in the background: ask again while open.
        if (next.refreshing)
          poll.current = window.setTimeout(
            () => void load(attempt + 1),
            POLL_MS[Math.min(attempt, POLL_MS.length - 1)],
          );
        else loadSummaries();
      } catch (failure) {
        if (!alive.current || id !== request.current) return;
        setError((failure as Error).message);
        setRefreshing(false);
      } finally {
        if (alive.current && id === request.current) setLoading(false);
      }
    },
    [date, loadSummaries],
  );

  useEffect(() => {
    setLoading(true);
    setDay(null);
    setSubmit(null);
    void load();
  }, [load]);
  useEffect(() => {
    timeReport<Targets>("targets").then(
      (reply) =>
        alive.current &&
        setTargets({
          targets: reply.targets.filter((entry) => entry.active !== false),
          task_types: reply.task_types.filter(
            (entry) => entry.active !== false,
          ),
        }),
      () => undefined,
    );
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const reply = await timeReport<Day | { accepted: true }>("refresh", {
        date,
      });
      if (!alive.current) return;
      if ("blocks" in reply && !reply.refreshing) {
        setDay(reply);
        setRefreshing(false);
        loadSummaries();
      } else void load();
    } catch (failure) {
      if (!alive.current) return;
      setError((failure as Error).message);
      setRefreshing(false);
    }
  };

  /** Runs a block operation, then reads the day again: ids may change. */
  const operate = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    let failed: string | null = null;
    try {
      await run();
    } catch (failure) {
      failed = failureText(failure as TimeReportError);
    } finally {
      if (alive.current) {
        setRefreshing(true);
        await load();
        // Reading the day again does not hide why the operation failed.
        if (failed) setError(failed);
        setBusy(null);
      }
    }
  };

  const startPreview = async () => {
    setSubmit({ step: "previewing" });
    try {
      const preview = await timeReport<Preview>("submit-preview", { date });
      if (alive.current) setSubmit({ step: "preview", preview });
    } catch (failure) {
      if (alive.current)
        setSubmit({
          step: "error",
          message: failureText(failure as TimeReportError),
        });
    }
  };

  // Only reachable from the confirmation step, with its box ticked.
  const confirmSubmit = async (preview: Preview) => {
    setSubmit({ step: "submitting", preview });
    try {
      const result = await timeReport<SubmitResult>("submit", {
        date,
        confirm_token: preview.confirm_token,
        confirmed: true,
      });
      if (alive.current) setSubmit({ step: "result", result, error: null });
    } catch (failure) {
      if (!alive.current) return;
      const partial =
        failure instanceof TimeReportError
          ? (failure.partial as SubmitResult | null)
          : null;
      setSubmit(
        partial?.results
          ? {
              step: "result",
              result: partial,
              error: (failure as Error).message,
            }
          : { step: "error", message: (failure as Error).message },
      );
    }
    if (alive.current) void load();
  };

  const questions = day ? openQuestions(day) : [];
  const questionMinutes = questions.reduce((sum, b) => sum + b.minutes, 0);
  const tracked = day?.tracked_minutes ?? 0;
  const expected = day?.expected_minutes ?? null;
  const subjectWorkspace = (block: Block) =>
    block.subject
      ? (workspaces.find((entry) => entry.subject?.label === block.subject) ??
        null)
      : null;

  return (
    <div className="hours">
      <DayList summaries={summaries} date={date} onDate={onDate} />
      <div className="hours-day">
        <div className="hours-summary">
          <span className="hours-tracked">{formatMinutes(tracked)}</span>
          {expected ? (
            <span className="hours-muted">
              of {formatMinutes(expected)} expected
            </span>
          ) : null}
          {expected ? (
            <span
              className="hours-meter"
              role="img"
              aria-label={`${formatMinutes(tracked)} of ${formatMinutes(expected)}`}
            >
              <i
                style={{
                  width: `${Math.min(100, (Math.max(0, tracked - questionMinutes) / expected) * 100)}%`,
                }}
              />
              <i
                className="is-question"
                style={{
                  left: `${Math.min(100, (Math.max(0, tracked - questionMinutes) / expected) * 100)}%`,
                  width: `${Math.min(100, (questionMinutes / expected) * 100)}%`,
                }}
              />
            </span>
          ) : null}
          {questions.length ? (
            <span className="hours-chip is-yellow">
              {questions.length} question{questions.length > 1 ? "s" : ""} ·{" "}
              {formatMinutes(questionMinutes)}
            </span>
          ) : null}
          {day?.deferred ? (
            <span
              className="hours-chip is-red"
              title={day.deferred_reason ?? "The model could not run"}
            >
              Model deferred
            </span>
          ) : null}
          <button
            type="button"
            className="hours-btn hours-refresh"
            disabled={refreshing || loading}
            onClick={() => void refresh()}
            title="Ask the provider to look at the day again (up to a minute)"
          >
            <RefreshCw
              size={13}
              aria-hidden="true"
              className={refreshing ? "is-spinning" : undefined}
            />
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
        {day?.deferred && !refreshing ? (
          <p className="hours-deferred" role="status">
            The model did not run
            {day.deferred_reason ? `: ${day.deferred_reason}` : ""}. What it
            could not place stays a question; Refresh tries again.
          </p>
        ) : null}
        {refreshing ? (
          <p className="hours-muted hours-note" role="status">
            The provider is looking at the day again. What you see stays usable;
            it updates when done.
          </p>
        ) : null}
        {error ? (
          <p className="hours-error" role="alert">
            {error}
          </p>
        ) : null}
        {loading && !day ? <p className="hours-muted">Loading...</p> : null}
        {day ? (
          <>
            <Strip day={day} />
            {questions.length ? (
              <section className="hours-section" aria-label="Questions">
                <h3>
                  Questions{" "}
                  <span className="hours-muted">
                    answer in place; the rest of the day stays editable
                  </span>
                </h3>
                {questions.map((block) => (
                  <QuestionCard
                    key={block.id}
                    block={block}
                    busy={busy === block.id}
                    onAnswer={(optionId, remember) =>
                      void operate(block.id, () =>
                        timeReport("block-answer", {
                          date,
                          block: block.id,
                          body: { option_id: optionId, remember },
                        }),
                      )
                    }
                  />
                ))}
              </section>
            ) : null}
            <section className="hours-section" aria-label="Blocks">
              <h3>
                Blocks{" "}
                <span className="hours-muted">
                  {
                    day.blocks.filter((block) => block.status === "proposed")
                      .length
                  }{" "}
                  proposed,{" "}
                  {
                    day.blocks.filter((block) => block.status === "accepted")
                      .length
                  }{" "}
                  accepted
                </span>
                {day.blocks.some((block) => block.status === "proposed") ? (
                  <button
                    type="button"
                    className="hours-btn is-small hours-push"
                    disabled={busy !== null}
                    onClick={() =>
                      void operate("all", async () => {
                        for (const block of day.blocks)
                          if (block.status === "proposed")
                            await timeReport("block-accept", {
                              date,
                              block: block.id,
                            });
                      })
                    }
                  >
                    Accept all
                  </button>
                ) : null}
              </h3>
              {day.blocks.filter((block) => block.status !== "needs_input")
                .length === 0 ? (
                <p className="hours-muted">No blocks for this day.</p>
              ) : null}
              <div className="hours-blocks">
                {day.blocks
                  .filter((block) => block.status !== "needs_input")
                  .map((block) => (
                    <BlockCard
                      key={block.id}
                      date={date}
                      block={block}
                      targets={targets}
                      busy={busy === block.id || busy === "all"}
                      operate={(run) => void operate(block.id, run)}
                      mappingWorkspace={subjectWorkspace(block)}
                      onEditMapping={onEditMapping}
                    />
                  ))}
              </div>
            </section>
            {day.gaps.length ? (
              <section className="hours-section" aria-label="Gaps">
                <h3>
                  Gaps <span className="hours-muted">unexplained time</span>
                </h3>
                <div className="hours-gaps">
                  {day.gaps.map((gap) => (
                    <GapRow
                      key={gap.start}
                      gap={gap}
                      targets={targets}
                      busy={busy === `gap-${gap.start}`}
                      onClaim={(body) =>
                        void operate(`gap-${gap.start}`, () =>
                          timeReport("block-create", { date, body }),
                        )
                      }
                    />
                  ))}
                </div>
              </section>
            ) : null}
            <div className="hours-submitbar">
              <span className="hours-muted">{submitHint(day)}</span>
              <button
                type="button"
                className="hours-btn is-primary"
                disabled={!canPreview(day) || busy !== null || submit !== null}
                onClick={() => void startPreview()}
              >
                Preview submit
              </button>
            </div>
          </>
        ) : null}
      </div>
      {submit ? (
        <SubmitDialog
          date={date}
          day={day}
          state={submit}
          setState={setSubmit}
          onSubmit={(preview) => void confirmSubmit(preview)}
          onClose={() => setSubmit(null)}
        />
      ) : null}
    </div>
  );
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const DAY_TONE: Record<DaySummary["status"], string> = {
  empty: "",
  needs_input: "is-yellow",
  proposed: "is-blue",
  accepted: "is-blue",
  submitted: "is-green",
};

function DayList({
  summaries,
  date,
  onDate,
}: {
  summaries: DaySummary[];
  date: string;
  onDate: (date: string) => void;
}) {
  if (summaries.length === 0) return <div className="hours-days" />;
  return (
    <nav className="hours-days" aria-label="Days">
      {summaries.map((summary) => (
        <button
          type="button"
          key={summary.date}
          className={`hours-daybtn${summary.date === date ? " is-on" : ""}`}
          aria-current={summary.date === date ? "date" : undefined}
          onClick={() => onDate(summary.date)}
        >
          <b>{shortDate(summary.date)}</b>
          <span className="hours-daytime">
            {summary.tracked_minutes
              ? formatMinutes(summary.tracked_minutes)
              : "-"}
            {summary.expected_minutes
              ? ` / ${formatMinutes(summary.expected_minutes)}`
              : ""}
          </span>
          <span className={`hours-chip ${DAY_TONE[summary.status]}`}>
            {summary.status === "needs_input" && summary.open_questions
              ? `${summary.open_questions} question${summary.open_questions > 1 ? "s" : ""}`
              : DAY_STATUS_LABELS[summary.status]}
          </span>
        </button>
      ))}
    </nav>
  );
}

function Strip({ day }: { day: Day }) {
  const window = hoursWindow(day);
  const ticks: number[] = [];
  const step = window.end - window.start > 8 * 60 ? 120 : 60;
  // The edges carry no label: it would hang out of the strip.
  for (let tick = window.start + step; tick < window.end; tick += step)
    ticks.push(tick);
  const at = (minute: number) =>
    `${((minute - window.start) / (window.end - window.start)) * 100}%`;
  return (
    <div className="hours-strip" aria-hidden="true">
      <div className="hours-axis">
        {ticks.map((tick) => (
          <span key={tick} style={{ left: at(tick) }}>
            {`${String(Math.floor(tick / 60)).padStart(2, "0")}:00`}
          </span>
        ))}
      </div>
      <div className="hours-lane">
        <span className="hours-lane-label">Activity</span>
        {(day.timeline ?? [])
          .filter((segment) => segment.kind !== "idle")
          .map((segment) => {
            const place = placeIn(segment, window);
            if (!place) return null;
            const key =
              segment.subject ??
              segment.workspace_id ??
              segment.label ??
              segment.kind;
            return (
              <span
                key={`${segment.start}-${segment.kind}-${key}`}
                className={`hours-seg is-${segment.kind}`}
                title={`${clockOf(segment.start)} to ${clockOf(segment.end)} · ${segment.label ?? segment.subject ?? segment.kind}${segment.note ? ` (${segment.note})` : ""}`}
                style={{
                  left: `${place.left}%`,
                  width: `${place.width}%`,
                  background: workspaceColor(key),
                }}
              />
            );
          })}
      </div>
      <div className="hours-lane is-blocks">
        <span className="hours-lane-label">Blocks</span>
        {day.blocks.map((block) => {
          const place = placeIn(block, window);
          if (!place) return null;
          return (
            <span
              key={block.id}
              className={`hours-blk is-${block.status}`}
              title={`${clockOf(block.start)} to ${clockOf(block.end)} · ${block.target?.label ?? BLOCK_STATUS_LABELS[block.status]}`}
              style={{
                left: `${place.left}%`,
                width: `${place.width}%`,
                ...(block.status === "needs_input"
                  ? {}
                  : { background: targetColor(block.target) }),
              }}
            >
              {block.status === "needs_input"
                ? "?"
                : (block.target?.label ?? "")}
            </span>
          );
        })}
        {day.gaps.map((gap) => {
          const place = placeIn(gap, window);
          return place ? (
            <span
              key={`gap-${gap.start}`}
              className="hours-seg is-gap"
              style={{ left: `${place.left}%`, width: `${place.width}%` }}
            />
          ) : null;
        })}
      </div>
    </div>
  );
}

function QuestionCard({
  block,
  busy,
  onAnswer,
}: {
  block: Block;
  busy: boolean;
  onAnswer: (optionId: string, remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(true);
  const options = block.question?.options ?? [];
  return (
    <div className="hours-question">
      <div className="hours-question-head">
        <strong>{block.question?.prompt ?? "Where does this time go?"}</strong>
        <span className="hours-muted">
          {clockOf(block.start)} to {clockOf(block.end)} ·{" "}
          {formatMinutes(block.minutes)}
        </span>
      </div>
      {block.evidence?.length ? (
        <div className="hours-evidence">
          {block.evidence.map((entry, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: evidence has no id
            <EvidenceItem key={index} entry={entry} />
          ))}
        </div>
      ) : null}
      <div className="hours-options">
        {options.map((option) => (
          <button
            type="button"
            key={option.id}
            disabled={busy}
            className={`hours-option${option.label.startsWith("Suggested") ? " is-suggested" : ""}${option.kind === "skip" ? " is-skip" : ""}`}
            onClick={() => onAnswer(option.id, remember)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <label className="hours-remember">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        Remember (always use it). Every answer is recorded either way.
      </label>
    </div>
  );
}

function EvidenceItem({ entry }: { entry: Evidence }) {
  const text = `${entry.title}${entry.minutes ? ` ${formatMinutes(entry.minutes)}` : ""}`;
  return entry.url ? (
    <a href={entry.url} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    <span className={entry.kind === "note" ? "is-note" : undefined}>
      {text}
    </span>
  );
}

function TargetSelect({
  targets,
  value,
  onChange,
  label,
}: {
  targets: Targets | null;
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <label className="hours-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="" disabled>
          Choose a project
        </option>
        {(targets?.targets ?? []).map((target) => (
          <option key={target.id} value={target.id}>
            {target.group ? `${target.group}: ${target.label}` : target.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TaskTypeSelect({
  targets,
  value,
  onChange,
}: {
  targets: Targets | null;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="hours-field">
      <span>Task type</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">None</option>
        {(targets?.task_types ?? []).map((type) => (
          <option key={type.id} value={type.id}>
            {type.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function BlockCard({
  date,
  block,
  targets,
  busy,
  operate,
  mappingWorkspace,
  onEditMapping,
}: {
  date: string;
  block: Block;
  targets: Targets | null;
  busy: boolean;
  operate: (run: () => Promise<unknown>) => void;
  mappingWorkspace: TimelineWorkspace | null;
  onEditMapping?: (workspace: TimelineWorkspace) => void;
}) {
  const [panel, setPanel] = useState<
    "edit" | "split" | "explain" | "delete" | null
  >(null);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);
  const submitted = block.status === "submitted";
  const toggle = (next: typeof panel) =>
    setPanel((current) => (current === next ? null : next));
  const explain = () => {
    toggle("explain");
    if (explanation || panel === "explain") return;
    timeReport<Explanation>("block-explain", { date, block: block.id }).then(
      setExplanation,
      (failure) => setExplainError((failure as Error).message),
    );
  };
  const split = block.evidence?.find(
    (entry) => entry.kind === "note" && /split between/.test(entry.title),
  );
  return (
    <article
      className={`hours-block is-${block.status}`}
      aria-label={`${clockOf(block.start)} to ${clockOf(block.end)}`}
    >
      <span
        className="hours-block-bar"
        style={{ background: targetColor(block.target) }}
      />
      <div className="hours-block-main">
        <div className="hours-block-top">
          <span className="hours-time">
            {clockOf(block.start)} to {clockOf(block.end)}
          </span>
          <span className="hours-muted">{formatMinutes(block.minutes)}</span>
          {workedMinutes(block) !== null ? (
            <span
              className="hours-worked"
              title={`Worked ${formatMinutes(workedMinutes(block)!)}; the report counts whole ${UNIT_MINUTES}-minute units`}
            >
              worked {formatMinutes(workedMinutes(block)!)}
            </span>
          ) : null}
          <span
            className={`hours-chip ${block.status === "accepted" ? "is-green" : block.status === "proposed" ? "is-blue" : ""}`}
          >
            {BLOCK_STATUS_LABELS[block.status]}
          </span>
          <span className="hours-chip">{SOURCE_LABELS[block.source]}</span>
          {block.reopened ? (
            <span
              className="hours-chip is-yellow"
              title={reopenedTitle(block.reopened)}
            >
              {REOPENED_LABELS[block.reopened.reason] ??
                "Proposed again: accept again"}
            </span>
          ) : null}
          {typeof block.confidence === "number" ? (
            <span className="hours-confidence" title="How sure the provider is">
              <i>
                <b style={{ width: `${block.confidence * 100}%` }} />
              </i>
              {Math.round(block.confidence * 100)}%
            </span>
          ) : null}
        </div>
        <div className="hours-block-target">
          <strong>{block.target?.label ?? "Not logged"}</strong>
          {block.task_type ? (
            <span className="hours-muted"> · {block.task_type}</span>
          ) : null}
          {block.subject ? (
            <span className="hours-muted"> · {block.subject}</span>
          ) : null}
        </div>
        {block.description ? (
          <div className="hours-block-desc">{block.description}</div>
        ) : null}
        {block.evidence?.length ? (
          <div className="hours-evidence">
            {block.evidence
              .filter((entry) => entry !== split)
              .map((entry, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: evidence has no id
                <EvidenceItem key={index} entry={entry} />
              ))}
          </div>
        ) : null}
        {split ? (
          <div className="hours-splitnote">
            <b>Split</b>: {split.title}.
            {mappingWorkspace && onEditMapping ? (
              <>
                {" "}
                <button
                  type="button"
                  className="hours-link"
                  onClick={() => onEditMapping(mappingWorkspace)}
                >
                  Change the mapping
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {panel === "edit" ? (
          <EditForm
            block={block}
            targets={targets}
            busy={busy}
            onCancel={() => setPanel(null)}
            onSave={(body) => {
              setPanel(null);
              operate(() =>
                timeReport("block-update", { date, block: block.id, body }),
              );
            }}
          />
        ) : null}
        {panel === "split" ? (
          <SplitForm
            block={block}
            onCancel={() => setPanel(null)}
            onSplit={(at) => {
              setPanel(null);
              operate(() =>
                timeReport("block-split", { date, block: block.id, at }),
              );
            }}
          />
        ) : null}
        {panel === "delete" ? (
          <div className="hours-inline">
            <span>
              Remove this block from the proposal? A recompute does not bring it
              back.
            </span>
            <button
              type="button"
              className="hours-btn is-small"
              onClick={() => setPanel(null)}
            >
              Keep
            </button>
            <button
              type="button"
              className="hours-btn is-small is-danger"
              onClick={() => {
                setPanel(null);
                operate(() =>
                  timeReport("block-delete", { date, block: block.id }),
                );
              }}
            >
              Delete
            </button>
          </div>
        ) : null}
        {panel === "explain" ? (
          <div className="hours-explain">
            {explanation ? (
              <>
                <h4>Why {block.target?.label ?? "this"}?</h4>
                {explanation.reasoning ? <p>{explanation.reasoning}</p> : null}
                {explanation.inputs?.length ? (
                  <ul>
                    {explanation.inputs.map((input) => (
                      <li key={input}>{input}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="hours-muted">
                  {explanation.decided_by
                    ? `Decided by ${explanation.decided_by}`
                    : null}
                  {explanation.decided_at
                    ? ` at ${clockOf(explanation.decided_at)}`
                    : null}
                </div>
              </>
            ) : explainError ? (
              <span className="hours-error">{explainError}</span>
            ) : (
              <span className="hours-muted">Asking...</span>
            )}
          </div>
        ) : null}
      </div>
      <div className="hours-block-actions">
        {block.status === "proposed" ? (
          <button
            type="button"
            className="hours-btn is-small is-primary"
            disabled={busy}
            onClick={() =>
              operate(() =>
                timeReport("block-accept", { date, block: block.id }),
              )
            }
          >
            Accept
          </button>
        ) : null}
        <button
          type="button"
          className="hours-btn is-small"
          disabled={busy || submitted}
          aria-pressed={panel === "edit"}
          onClick={() => toggle("edit")}
        >
          Edit
        </button>
        <button
          type="button"
          className="hours-btn is-small"
          disabled={busy || submitted || splitPoints(block).length === 0}
          title={
            splitPoints(block).length === 0
              ? `Halves are whole ${UNIT_MINUTES}-minute units: a ${UNIT_MINUTES}-minute block cannot be split`
              : undefined
          }
          aria-pressed={panel === "split"}
          onClick={() => toggle("split")}
        >
          Split
        </button>
        <button
          type="button"
          className="hours-btn is-small"
          aria-pressed={panel === "explain"}
          onClick={explain}
        >
          Explain
        </button>
        <button
          type="button"
          className="hours-btn is-small is-danger"
          disabled={busy || submitted}
          onClick={() => toggle("delete")}
        >
          Delete
        </button>
      </div>
    </article>
  );
}

function EditForm({
  block,
  targets,
  busy,
  onCancel,
  onSave,
}: {
  block: Block;
  targets: Targets | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [target, setTarget] = useState(block.target?.id ?? "");
  const [taskType, setTaskType] = useState(block.task_type ?? "");
  const [description, setDescription] = useState(block.description ?? "");
  const [start, setStart] = useState(clockOf(block.start));
  const [end, setEnd] = useState(clockOf(block.end));
  const save = () => {
    const body: Record<string, unknown> = {};
    if (target && target !== block.target?.id) body.target = target;
    if ((taskType || null) !== (block.task_type ?? null))
      body.task_type = taskType || null;
    if ((description || null) !== (block.description ?? null))
      body.description = description || null;
    if (start !== clockOf(block.start)) body.start = isoAt(block.start, start);
    if (end !== clockOf(block.end)) body.end = isoAt(block.end, end);
    onSave(body);
  };
  return (
    <div className="hours-form">
      <TargetSelect
        label="Project"
        targets={targets}
        value={target}
        onChange={setTarget}
      />
      <TaskTypeSelect
        targets={targets}
        value={taskType}
        onChange={setTaskType}
      />
      <label className="hours-field is-time">
        <span>Start</span>
        <input
          type="time"
          value={start}
          onChange={(event) => setStart(event.target.value)}
        />
      </label>
      <label className="hours-field is-time">
        <span>End</span>
        <input
          type="time"
          value={end}
          onChange={(event) => setEnd(event.target.value)}
        />
      </label>
      <label className="hours-field is-wide">
        <span>Description</span>
        <input
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <div className="hours-form-actions">
        <span className="hours-muted">
          Changing the times makes it a block of your own.
        </span>
        <button type="button" className="hours-btn is-small" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="hours-btn is-small is-primary"
          disabled={busy || !start || !end || start >= end}
          onClick={save}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function SplitForm({
  block,
  onCancel,
  onSplit,
}: {
  block: Block;
  onCancel: () => void;
  onSplit: (at: string) => void;
}) {
  // Halves are whole units: only those points are offered.
  const points = splitPoints(block);
  const [at, setAt] = useState(
    () => points[Math.floor((points.length - 1) / 2)] ?? "",
  );
  const startClock = clockOf(block.start);
  const endClock = clockOf(block.end);
  return (
    <div className="hours-inline">
      <label className="hours-field is-time">
        <span>Split at</span>
        <select value={at} onChange={(event) => setAt(event.target.value)}>
          {points.map((point) => (
            <option key={point} value={point}>
              {point}
            </option>
          ))}
        </select>
      </label>
      <span className="hours-muted">
        {at
          ? `${formatMinutes(clockMinutes(startClock, at))} + ${formatMinutes(clockMinutes(at, endClock))}`
          : ""}{" "}
        (halves are whole {UNIT_MINUTES}-minute units)
      </span>
      <button type="button" className="hours-btn is-small" onClick={onCancel}>
        Cancel
      </button>
      <button
        type="button"
        className="hours-btn is-small is-primary"
        disabled={!at}
        onClick={() => {
          const iso = isoAt(block.start, at);
          if (iso) onSplit(iso);
        }}
      >
        Split
      </button>
    </div>
  );
}

function GapRow({
  gap,
  targets,
  busy,
  onClaim,
}: {
  gap: Gap;
  targets: Targets | null;
  busy: boolean;
  onClaim: (body: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [taskType, setTaskType] = useState("");
  const [description, setDescription] = useState(gap.hint ?? "");
  const minutes = (Date.parse(gap.end) - Date.parse(gap.start)) / 60_000 || 0;
  return (
    <div className="hours-gap">
      <div className="hours-gap-head">
        <span className="hours-time">
          {clockOf(gap.start)} to {clockOf(gap.end)}
        </span>
        <span className="hours-muted">{formatMinutes(minutes)}</span>
        <span className="hours-gap-hint">{gap.hint ?? "Nothing recorded"}</span>
        <button
          type="button"
          className="hours-btn is-small"
          aria-expanded={open}
          disabled={busy}
          onClick={() => setOpen((value) => !value)}
        >
          Claim...
        </button>
      </div>
      {open ? (
        <div className="hours-form">
          <TargetSelect
            label="Project"
            targets={targets}
            value={target}
            onChange={setTarget}
          />
          <TaskTypeSelect
            targets={targets}
            value={taskType}
            onChange={setTaskType}
          />
          <label className="hours-field is-wide">
            <span>Description</span>
            <input
              type="text"
              value={description}
              placeholder="For example: was reading, offline"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <div className="hours-form-actions">
            <button
              type="button"
              className="hours-btn is-small"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="hours-btn is-small is-primary"
              disabled={!target || busy}
              onClick={() => {
                setOpen(false);
                onClaim({
                  start: gap.start,
                  end: gap.end,
                  target,
                  task_type: taskType || null,
                  description: description || null,
                });
              }}
            >
              Claim
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SubmitDialog({
  date,
  day,
  state,
  setState,
  onSubmit,
  onClose,
}: {
  date: string;
  day: Day | null;
  state: Submit;
  setState: (state: Submit) => void;
  onSubmit: (preview: Preview) => void;
  onClose: () => void;
}) {
  const preview =
    state.step === "preview" ||
    state.step === "confirm" ||
    state.step === "submitting"
      ? state.preview
      : null;
  const count = preview?.changes.length ?? 0;
  return (
    <div
      className="hours-submit-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && state.step !== "submitting")
          onClose();
      }}
    >
      <div
        className="hours-submit"
        role="dialog"
        aria-modal="true"
        aria-label="Submit hours"
      >
        {state.step === "previewing" ? (
          <p className="hours-muted">Preparing the preview...</p>
        ) : null}
        {state.step === "error" ? (
          <>
            <h3>Could not preview or submit</h3>
            <p className="hours-error" role="alert">
              {state.message}
            </p>
            <div className="hours-submit-actions">
              <button type="button" className="hours-btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : null}
        {preview ? (
          <>
            <h3>
              {state.step === "preview"
                ? "Preview: what would be written"
                : "Submit?"}
            </h3>
            <p className="hours-muted">
              {shortDate(date)} · {count} change{count === 1 ? "" : "s"} ·{" "}
              {formatMinutes(preview.total_minutes)} reported · nothing written
              yet
            </p>
            {(() => {
              const worked = previewWorkedMinutes(preview.changes, day);
              return worked !== null && worked !== preview.total_minutes ? (
                <p className="hours-muted hours-worked-total">
                  Worked {formatMinutes(worked)}, reported{" "}
                  {formatMinutes(preview.total_minutes)}: each block is rounded
                  up to whole {UNIT_MINUTES}-minute units.
                </p>
              ) : null;
            })()}
            <ul className="hours-changes">
              {preview.changes.map((change, index) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: changes have no id
                  key={index}
                >
                  <span
                    className={`hours-chip ${change.action === "delete" ? "is-red" : change.action === "update" ? "is-yellow" : "is-green"}`}
                  >
                    {change.action}
                  </span>{" "}
                  {changeLine(change)}
                </li>
              ))}
            </ul>
            {preview.warnings?.length ? (
              <div className="hours-warn">
                {preview.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ) : null}
            <p className="hours-muted">
              This preview expires at {clockOf(preview.expires_at)}.
            </p>
            {state.step === "confirm" || state.step === "submitting" ? (
              <div className="hours-confirm">
                <p>
                  {count === 1
                    ? "This change will be written"
                    : `These ${count} changes will be written`}{" "}
                  to the tracker under your account. This cannot be undone from
                  here.
                </p>
                <label className="hours-remember">
                  <input
                    type="checkbox"
                    checked={state.step === "confirm" && state.checked}
                    disabled={state.step === "submitting"}
                    onChange={(event) =>
                      state.step === "confirm" &&
                      setState({ ...state, checked: event.target.checked })
                    }
                  />
                  I checked these entries
                </label>
              </div>
            ) : null}
            <div className="hours-submit-actions">
              {state.step === "preview" ? (
                <>
                  <button type="button" className="hours-btn" onClick={onClose}>
                    Close
                  </button>
                  <button
                    type="button"
                    className="hours-btn is-primary"
                    disabled={count === 0}
                    onClick={() =>
                      setState({ step: "confirm", preview, checked: false })
                    }
                  >
                    Continue to submit...
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="hours-btn"
                    disabled={state.step === "submitting"}
                    onClick={() => setState({ step: "preview", preview })}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="hours-btn is-primary"
                    disabled={!(state.step === "confirm" && state.checked)}
                    onClick={() => onSubmit(preview)}
                  >
                    {state.step === "submitting"
                      ? "Submitting..."
                      : `Submit ${count} change${count === 1 ? "" : "s"}`}
                  </button>
                </>
              )}
            </div>
          </>
        ) : null}
        {state.step === "result" ? (
          <>
            <h3>{state.error ? "Submitted, partly" : "Submitted"}</h3>
            {state.error ? (
              <p className="hours-error" role="alert">
                {state.error}. What was written stays; preview again to send the
                rest.
              </p>
            ) : null}
            <ul className="hours-changes">
              {state.result.results.map((entry, index) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: results have no id
                  key={index}
                >
                  <span
                    className={`hours-chip ${entry.ok ? "is-green" : "is-red"}`}
                  >
                    {entry.ok ? "written" : "failed"}
                  </span>{" "}
                  {entry.block_id ?? ""}
                  {entry.error ? ` · ${entry.error}` : ""}
                </li>
              ))}
            </ul>
            <div className="hours-submit-actions">
              <button
                type="button"
                className="hours-btn is-primary"
                onClick={onClose}
              >
                Close
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
