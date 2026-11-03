import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { bridge } from "../api";
import {
  type AgentLane,
  addDays,
  type AxisWindow,
  axisWindow,
  colorFor,
  formatClock,
  formatDate,
  formatDuration,
  type GroupBy,
  jumpTarget,
  place,
  REFRESH_MS,
  SOURCE_LABELS,
  STATE_LABELS,
  type SubjectGroup,
  storedGroupBy,
  storeGroupBy,
  subjectGroups,
  type Timeline,
  type TimelineDay,
  type TimelineReply,
  type TimelineWorkspace,
  workspaceColor,
  type WorkspaceRow,
  workspaceRows,
} from "../activityTimelineModel";
import { store } from "../store";
import { CloseButton } from "./CloseButton";
import { focusDialogElement } from "./dialogFocus";
import {
  loadProjectMappings,
  ProjectMappingEditor,
  type ProjectMappings,
} from "./ProjectMapping";
import { allocationLabel, mappingFor } from "../timeReportApi";
import "./ActivityTimeline.css";

type Tip = { x: number; y: number; title: string; lines: string[] };

/** The workspace (or its subject) whose project is being corrected. */
type Editing = {
  workspace: TimelineWorkspace;
  scope: "workspace" | "subject";
};

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "off" }
  | { state: "ready"; timeline: Timeline };

function spanLines(
  span: { start: string; end: string | null; open?: boolean },
  now: number,
): string {
  const start = Date.parse(span.start);
  const end = span.end === null ? now : Date.parse(span.end);
  const until = span.open || span.end === null ? "now" : formatClock(end);
  return `${formatClock(start)} to ${until} · ${formatDuration(end - start)}`;
}

/** The day's attention, idle time, agent states and totals, per workspace. */
export function ActivityTimeline({ onClose }: { onClose: () => void }) {
  // null: today, as the bridge's day start defines it.
  const [date, setDate] = useState<string | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tip, setTip] = useState<Tip | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [groupBy, setGroupBy] = useState<GroupBy>(() =>
    storedGroupBy(typeof localStorage === "undefined" ? null : localStorage),
  );
  const chooseGroupBy = (value: GroupBy) => {
    setGroupBy(value);
    storeGroupBy(
      typeof localStorage === "undefined" ? null : localStorage,
      value,
    );
  };
  const dialogRef = useRef<HTMLDivElement>(null);
  const [projects, setProjects] = useState<ProjectMappings | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const reloadProjects = useCallback(() => {
    loadProjectMappings().then(setProjects, () => setProjects(null));
  }, []);
  useEffect(reloadProjects, [reloadProjects]);
  const request = useRef(0);
  const showsToday = date === null || date === today;

  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const reply: TimelineReply = await bridge.call(
        "bridge.activity.timeline",
        date === null ? {} : { from: date, to: date },
      );
      if (id !== request.current) return;
      setNow(Date.now());
      if (!reply.recording) {
        setLoad({ state: "off" });
        return;
      }
      if (date === null) setToday(reply.days[0]?.date ?? null);
      setLoad({ state: "ready", timeline: reply });
    } catch (error) {
      if (id !== request.current) return;
      setLoad({ state: "error", message: (error as Error).message });
    }
  }, [date]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Today keeps up with what happens.
  useEffect(() => {
    if (!showsToday) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, showsToday]);

  useEffect(() => focusDialogElement(dialogRef.current), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (editing) setEditing(null);
      else if (tip) setTip(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, tip, editing]);

  const shown = load.state === "ready" ? (load.timeline.days[0] ?? null) : null;
  const current = date ?? today;
  const go = (offset: number) => {
    if (!current) return;
    const next = addDays(current, offset);
    setTip(null);
    setLoad({ state: "loading" });
    setDate(today && next >= today ? null : next);
  };

  const showTip: ShowTip = (point, title, lines) => {
    setTip({ x: point.clientX, y: point.clientY, title, lines });
  };

  const jump = (workspace: TimelineWorkspace) => {
    const state = store.get();
    const target = jumpTarget(
      workspace,
      state.activeConnectionId,
      state.workspaces,
    );
    if (!target) return;
    onClose();
    void store.jumpToConnectionWorkspace(workspace.connection_id, target);
  };

  return (
    <div
      className="modal-backdrop activity-timeline-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal activity-timeline"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Activity timeline"
        onPointerDown={(event) => {
          if (!(event.target as HTMLElement).closest(".activity-band"))
            setTip(null);
        }}
      >
        <div className="modal-head">
          <div>
            <h2>Activity timeline</h2>
            <p>{current ? formatDate(current) : "Today"}</p>
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <div className="activity-timeline-nav">
          <button
            type="button"
            className="activity-timeline-nav-button"
            aria-label="Previous day"
            title="Previous day"
            disabled={!current}
            onClick={() => go(-1)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="activity-timeline-nav-button"
            aria-label="Next day"
            title="Next day"
            disabled={showsToday}
            onClick={() => go(1)}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="activity-timeline-today"
            disabled={showsToday}
            onClick={() => {
              setTip(null);
              setLoad({ state: "loading" });
              setDate(null);
            }}
          >
            Today
          </button>
          <fieldset className="activity-timeline-group" aria-label="Group by">
            {(["workspace", "subject"] as const).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="activity-group-by"
                  value={value}
                  checked={groupBy === value}
                  onChange={() => chooseGroupBy(value)}
                />
                <span>{value === "workspace" ? "Workspaces" : "Subjects"}</span>
              </label>
            ))}
          </fieldset>
          {shown ? <DaySummary day={shown} /> : null}
        </div>
        <div className="activity-timeline-body">
          {load.state === "loading" ? (
            <p className="activity-timeline-note">Loading...</p>
          ) : load.state === "error" ? (
            <p className="activity-timeline-note is-error" role="alert">
              {load.message}
            </p>
          ) : load.state === "off" ? (
            <p className="activity-timeline-note">
              Activity recording is off. Set <code>activity.enabled</code> in
              settings.json and restart Roamgate to record.
            </p>
          ) : shown ? (
            <DayView
              timeline={load.timeline}
              day={shown}
              now={now}
              showTip={showTip}
              onJump={jump}
              groupBy={groupBy}
              projects={projects}
              onEditProject={setEditing}
            />
          ) : null}
        </div>
        {editing && projects ? (
          <ProjectMappingEditor
            workspace={editing.workspace}
            initialScope={editing.scope}
            projects={projects}
            current={mappingFor(projects.mappings, editing.workspace)}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              reloadProjects();
            }}
          />
        ) : null}
        {tip ? (
          <div
            className="activity-timeline-tip"
            role="tooltip"
            style={tipPosition(tip)}
          >
            <strong>{tip.title}</strong>
            {tip.lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function tipPosition(tip: Tip): CSSProperties {
  const right = tip.x > window.innerWidth / 2;
  const below = tip.y < window.innerHeight / 2;
  return {
    left: right ? undefined : tip.x + 12,
    right: right ? window.innerWidth - tip.x + 12 : undefined,
    top: below ? tip.y + 14 : undefined,
    bottom: below ? undefined : window.innerHeight - tip.y + 14,
  };
}

function DaySummary({ day }: { day: TimelineDay }) {
  const { totals } = day;
  return (
    <p className="activity-timeline-summary">
      <span>
        Attended <strong>{formatDuration(totals.attended_ms)}</strong>
      </span>
      {totals.idle_ms ? (
        <span>Idle {formatDuration(totals.idle_ms)}</span>
      ) : null}
      {totals.unrecorded_ms ? (
        <span>Not recorded {formatDuration(totals.unrecorded_ms)}</span>
      ) : null}
    </p>
  );
}

type ShowTip = (
  point: { clientX: number; clientY: number },
  title: string,
  lines: string[],
) => void;

function Band({
  span,
  axis,
  now,
  className,
  style,
  title,
  lines,
  showTip,
}: {
  span: { start: string; end: string | null };
  axis: AxisWindow;
  now: number;
  className: string;
  style?: CSSProperties;
  title: string;
  lines: string[];
  showTip: ShowTip;
}) {
  const at = place(span, axis, now);
  if (!at) return null;
  return (
    <div
      className={`activity-band ${className}`}
      style={{ ...style, left: `${at.left}%`, width: `${at.width}%` }}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") showTip(event, title, lines);
      }}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse") showTip(event, title, lines);
      }}
      onClick={(event) => showTip(event, title, lines)}
    />
  );
}

function Lane({
  label,
  className,
  children,
}: {
  label: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`activity-lane ${className ?? ""}`}>
      <div className="activity-lane-label">{label}</div>
      <div className="activity-lane-track">{children}</div>
    </div>
  );
}

function DayView({
  timeline,
  day,
  now,
  showTip,
  onJump,
  groupBy,
  projects,
  onEditProject,
}: {
  timeline: Timeline;
  day: TimelineDay;
  now: number;
  showTip: ShowTip;
  onJump: (workspace: TimelineWorkspace) => void;
  groupBy: GroupBy;
  projects: ProjectMappings | null;
  onEditProject: (editing: Editing) => void;
}) {
  const axis = axisWindow(day, now);
  const left = (ms: number) =>
    `${((ms - axis.start) / (axis.end - axis.start)) * 100}%`;
  const names = new Map(timeline.workspaces.map((entry) => [entry.id, entry]));
  const name = (id: string | null) =>
    (id && names.get(id)?.name) || "Unknown workspace";
  const rows = workspaceRows(day, timeline.workspaces);
  const groups =
    groupBy === "subject" ? subjectGroups(day, timeline.workspaces) : null;
  const color = (id: string) => colorFor(id, names.get(id), groupBy);
  const nowShown = now > axis.start && now < axis.end;
  const renderRow = (row: WorkspaceRow) => (
    <div className="activity-workspace" key={row.id}>
      <Lane
        label={
          <>
            <button
              type="button"
              className="activity-workspace-name"
              disabled={!row.workspace}
              title={
                row.workspace
                  ? `Go to ${row.name}${row.workspace.path ? ` (${row.workspace.path})` : ""}`
                  : row.name
              }
              onClick={() => row.workspace && onJump(row.workspace)}
            >
              <span
                className="activity-dot"
                style={{ background: color(row.id) }}
              />
              <span>{row.name}</span>
            </button>
            {groupBy === "workspace" && row.workspace?.subject ? (
              <span
                className="activity-subject-chip"
                title={subjectLine(row.workspace)[0]}
              >
                {row.workspace.subject.label}
              </span>
            ) : null}
          </>
        }
        className="activity-workspace-head"
      >
        {grid}
        {row.attention.map((segment) => (
          <Band
            key={`ws-${segment.start}`}
            span={segment}
            axis={axis}
            now={now}
            className={`is-attention is-thin${segment.source === "herdr" ? " is-herdr" : ""}`}
            style={{ "--band": color(row.id) } as CSSProperties}
            title={row.name}
            lines={[spanLines(segment, now), SOURCE_LABELS[segment.source]]}
            showTip={showTip}
          />
        ))}
      </Lane>
      {row.lanes.map((lane) => (
        <AgentRow
          key={`${lane.connection_id}-${lane.pane_id}-${lane.agent}`}
          lane={lane}
          workspaceName={row.name}
          axis={axis}
          now={now}
          grid={grid}
          showTip={showTip}
        />
      ))}
    </div>
  );
  const grid = (
    <div className="activity-grid" aria-hidden="true">
      {axis.ticks.map((tick) => (
        <span key={tick} style={{ left: left(tick) }} />
      ))}
      {nowShown ? (
        <span className="activity-now" style={{ left: left(now) }} />
      ) : null}
    </div>
  );
  const gaps = day.gaps.map((gap) => (
    <Band
      key={`gap-${gap.connection_id}-${gap.start}`}
      span={gap}
      axis={axis}
      now={now}
      className={gap.connection_id ? "is-disconnected" : "is-unrecorded"}
      title={gap.connection_id ? "Disconnected" : "Not recorded"}
      lines={[
        spanLines(gap, now),
        gap.connection_id
          ? `Connection ${gap.connection_id}`
          : "Roamgate was not running",
      ]}
      showTip={showTip}
    />
  ));

  return (
    <>
      {!timeline.recorder_running ? (
        <p className="activity-timeline-note is-warning">
          The recorder is not running: nothing is recorded since its last stamp.
        </p>
      ) : null}
      <div className="activity-chart">
        <div className="activity-lane activity-axis">
          <div className="activity-lane-label" />
          <div className="activity-lane-track">
            {axis.ticks.map((tick) => {
              const at = (tick - axis.start) / (axis.end - axis.start);
              // Labels at the edges stay inside the track.
              const shift = at > 0.94 ? "-100%" : at < 0.06 ? "0" : "-50%";
              return (
                <span
                  key={tick}
                  style={{
                    left: left(tick),
                    transform: `translateX(${shift})`,
                  }}
                >
                  {formatClock(tick)}
                </span>
              );
            })}
          </div>
        </div>
        <Lane label={<strong>You</strong>} className="activity-you">
          {grid}
          {day.idle.map((span) => (
            <Band
              key={`idle-${span.client_id}-${span.start}`}
              span={span}
              axis={axis}
              now={now}
              className="is-idle"
              title="Idle"
              lines={[
                spanLines(span, now),
                span.client_kind === "phone" ? "Phone" : "Browser",
              ]}
              showTip={showTip}
            />
          ))}
          {day.attention.map((segment) => (
            <Band
              key={`you-${segment.start}`}
              span={segment}
              axis={axis}
              now={now}
              className={`is-attention${segment.source === "herdr" ? " is-herdr" : ""}`}
              style={
                {
                  "--band": color(segment.workspace_id),
                } as CSSProperties
              }
              title={name(segment.workspace_id)}
              lines={[
                spanLines(segment, now),
                SOURCE_LABELS[segment.source],
                ...subjectLine(names.get(segment.workspace_id)),
              ]}
              showTip={showTip}
            />
          ))}
          {gaps}
        </Lane>
        {groups
          ? groups.map((group) => (
              <SubjectSection
                key={group.id ?? "none"}
                group={group}
                axis={axis}
                now={now}
                grid={grid}
                showTip={showTip}
                renderRow={renderRow}
              />
            ))
          : rows.map(renderRow)}
      </div>
      <Legend />
      <TotalsTable
        day={day}
        rows={rows}
        groups={groups}
        color={color}
        onJump={onJump}
        projects={projects}
        onEditProject={onEditProject}
      />
    </>
  );
}

function AgentRow({
  lane,
  workspaceName,
  axis,
  now,
  grid,
  showTip,
}: {
  lane: AgentLane;
  workspaceName: string;
  axis: AxisWindow;
  now: number;
  grid: ReactNode;
  showTip: ShowTip;
}) {
  return (
    <Lane
      label={<span className="activity-agent-name">{lane.agent}</span>}
      className="activity-agent"
    >
      {grid}
      {lane.spans.map((span) => (
        <Band
          key={span.start}
          span={span}
          axis={axis}
          now={now}
          className={`is-agent is-${span.state}`}
          title={`${lane.agent} · ${STATE_LABELS[span.state]}`}
          lines={[
            spanLines(span, now),
            lane.task ? `${workspaceName}: ${lane.task}` : workspaceName,
          ]}
          showTip={showTip}
        />
      ))}
    </Lane>
  );
}

function Legend() {
  return (
    <ul className="activity-legend" aria-label="Legend">
      <li>
        <span className="activity-swatch is-attention" /> Browser or phone
      </li>
      <li>
        <span className="activity-swatch is-attention is-herdr" /> Herdr TUI
      </li>
      <li>
        <span className="activity-swatch is-idle" /> Idle
      </li>
      <li>
        <span className="activity-swatch is-disconnected" /> Disconnected
      </li>
      <li>
        <span className="activity-swatch is-working" /> Working
      </li>
      <li>
        <span className="activity-swatch is-blocked" /> Blocked
      </li>
    </ul>
  );
}

function TotalsTable({
  day,
  rows,
  groups,
  color,
  onJump,
  projects,
  onEditProject,
}: {
  day: TimelineDay;
  rows: WorkspaceRow[];
  groups: SubjectGroup[] | null;
  color: (workspaceId: string) => string;
  onJump: (workspace: TimelineWorkspace) => void;
  projects: ProjectMappings | null;
  onEditProject: (editing: Editing) => void;
}) {
  if (rows.length === 0)
    return <p className="activity-timeline-note">Nothing recorded that day.</p>;
  const cell = (ms: number | undefined) => (ms ? formatDuration(ms) : "-");
  const totalsRow = (row: WorkspaceRow, nested: boolean) => (
    <tr key={row.id} className={nested ? "is-nested" : undefined}>
      <th scope="row">
        <button
          type="button"
          className="activity-workspace-name"
          disabled={!row.workspace}
          onClick={() => row.workspace && onJump(row.workspace)}
        >
          <span
            className="activity-dot"
            style={{ background: color(row.id) }}
          />
          <span>{row.name}</span>
        </button>
        {projects && row.workspace ? (
          <span className="activity-project-inline">
            <ProjectButton
              projects={projects}
              workspace={row.workspace}
              scope="workspace"
              onEdit={onEditProject}
            />
          </span>
        ) : null}
      </th>
      <td>{cell(row.totals?.attended_ms)}</td>
      <td>{cell(row.totals?.herdr_ms)}</td>
      <td>{cell(row.totals?.working_ms)}</td>
      <td>{cell(row.totals?.blocked_ms)}</td>
      {projects ? (
        <td className="activity-project-cell">
          {row.workspace ? (
            <ProjectButton
              projects={projects}
              workspace={row.workspace}
              scope="workspace"
              onEdit={onEditProject}
            />
          ) : null}
        </td>
      ) : null}
    </tr>
  );
  return (
    <table className="activity-totals">
      <thead>
        <tr>
          <th scope="col">{groups ? "Subject" : "Workspace"}</th>
          <th scope="col">Attended</th>
          <th scope="col" title="Of the attended time, from Herdr's TUI">
            Herdr
          </th>
          <th scope="col">Working</th>
          <th scope="col">Blocked</th>
          {projects ? (
            <th scope="col" className="activity-project-cell">
              Project
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {groups
          ? groups.flatMap((group) => [
              <tr
                key={`s-${group.id ?? "none"}`}
                className="activity-subject-total"
              >
                <th scope="row">
                  <span className="activity-workspace-name">
                    <span
                      className="activity-dot"
                      style={{
                        background: group.id
                          ? workspaceColor(group.id)
                          : "transparent",
                      }}
                    />
                    <span>{group.label}</span>
                  </span>
                  {projects && group.subject && group.rows[0]?.workspace ? (
                    <span className="activity-project-inline">
                      <ProjectButton
                        projects={projects}
                        workspace={group.rows[0].workspace}
                        scope="subject"
                        onEdit={onEditProject}
                      />
                    </span>
                  ) : null}
                </th>
                <td>{cell(group.totals.attended_ms)}</td>
                <td>{cell(group.totals.herdr_ms)}</td>
                <td>{cell(group.totals.working_ms)}</td>
                <td>{cell(group.totals.blocked_ms)}</td>
                {projects ? (
                  <td className="activity-project-cell">
                    {group.subject && group.rows[0]?.workspace ? (
                      <ProjectButton
                        projects={projects}
                        workspace={group.rows[0].workspace}
                        scope="subject"
                        onEdit={onEditProject}
                      />
                    ) : null}
                  </td>
                ) : null}
              </tr>,
              ...group.rows.map((row) => totalsRow(row, true)),
            ])
          : rows.map((row) => totalsRow(row, false))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Total</th>
          <td>{formatDuration(day.totals.attended_ms)}</td>
          <td>
            {cell(
              day.totals.workspaces.reduce(
                (sum, entry) => sum + entry.herdr_ms,
                0,
              ),
            )}
          </td>
          <td colSpan={2} />
          {projects ? <td className="activity-project-cell" /> : null}
        </tr>
      </tfoot>
    </table>
  );
}

/** A tooltip line naming a workspace's subject. */
function subjectLine(workspace: TimelineWorkspace | undefined): string[] {
  const subject = workspace?.subject;
  if (!subject) return [];
  const chain = subject.groups.map((group) => group.label).join(" / ");
  return [`Subject: ${chain || subject.label}`];
}

/** A subject's header lane (all its attention), then its workspaces. */
function SubjectSection({
  group,
  axis,
  now,
  grid,
  showTip,
  renderRow,
}: {
  group: SubjectGroup;
  axis: AxisWindow;
  now: number;
  grid: ReactNode;
  showTip: ShowTip;
  renderRow: (row: WorkspaceRow) => ReactNode;
}) {
  const chain = group.subject?.groups.map((entry) => entry.label) ?? [];
  const title =
    group.subject?.source === "explicit"
      ? `Group ${chain.join(" / ")} of the Workspaces tree`
      : group.subject
        ? `Folder ${group.subject.path ?? chain.join("/")}`
        : "Workspaces in no group nor subject folder";
  return (
    <section
      className={`activity-subject${group.id ? "" : " is-none"}`}
      aria-label={`Subject ${group.label}`}
    >
      <Lane
        label={
          <span className="activity-subject-name" title={title}>
            {group.id ? (
              <span
                className="activity-dot"
                style={{ background: workspaceColor(group.id) }}
              />
            ) : null}
            <span>{group.label}</span>
            <span className="activity-subject-total-time">
              {formatDuration(group.totals.attended_ms)}
            </span>
          </span>
        }
        className="activity-subject-head"
      >
        {grid}
        {group.id
          ? group.attention.map((segment) => (
              <Band
                key={`subject-${segment.start}`}
                span={segment}
                axis={axis}
                now={now}
                className={`is-attention${segment.source === "herdr" ? " is-herdr" : ""}`}
                style={{ "--band": workspaceColor(group.id!) } as CSSProperties}
                title={group.label}
                lines={[spanLines(segment, now), SOURCE_LABELS[segment.source]]}
                showTip={showTip}
              />
            ))
          : null}
      </Lane>
      {group.rows.map(renderRow)}
    </section>
  );
}

/** The project a workspace (or its subject) goes to; opens the correction. */
function ProjectButton({
  projects,
  workspace,
  scope,
  onEdit,
}: {
  projects: ProjectMappings;
  workspace: TimelineWorkspace;
  scope: "workspace" | "subject";
  onEdit: (editing: Editing) => void;
}) {
  const mapping =
    scope === "subject"
      ? (projects.mappings.find(
          (entry) =>
            entry.scope === "subject" &&
            entry.subject_label === workspace.subject?.label,
        ) ?? null)
      : mappingFor(projects.mappings, workspace);
  const inherited = scope === "workspace" && mapping?.scope === "subject";
  const label = mapping
    ? allocationLabel(mapping.allocations)
    : scope === "subject"
      ? "Set for subject"
      : "Set";
  return (
    <button
      type="button"
      className={`activity-project${mapping ? "" : " is-unset"}${inherited ? " is-inherited" : ""}`}
      title={
        inherited
          ? `From ${workspace.subject?.label}: ${label}. Click to correct.`
          : mapping
            ? `${label}. Click to correct.`
            : "Tell where this time goes"
      }
      onClick={() => onEdit({ workspace, scope })}
    >
      {label}
    </button>
  );
}
