import { useEffect, useRef, useState } from "react";
import type { TimelineWorkspace } from "../activityTimelineModel";
import {
  type Mapping,
  type MappingSet,
  type TaskType,
  type Target,
  TimeReportError,
  timeReport,
} from "../timeReportApi";
import { focusDialogElement } from "./dialogFocus";

/** What the timeline knows of the provider's projects and mappings. */
export type ProjectMappings = {
  provider: string;
  targets: Target[];
  taskTypes: TaskType[];
  mappings: Mapping[];
};

/** Loads them, or null when no provider can record mappings. */
export async function loadProjectMappings(): Promise<ProjectMappings | null> {
  try {
    const health = await timeReport<{
      ok: boolean;
      provider: string;
      capabilities?: string[];
    }>("health");
    if (!health.ok || !health.capabilities?.includes("mapping")) return null;
    const [targets, mappings] = await Promise.all([
      timeReport<{ targets: Target[]; task_types: TaskType[] }>("targets"),
      timeReport<{ mappings: Mapping[] }>("mappings"),
    ]);
    return {
      provider: health.provider,
      targets: targets.targets.filter((target) => target.active !== false),
      taskTypes: targets.task_types.filter((type) => type.active !== false),
      mappings: mappings.mappings,
    };
  } catch (error) {
    if (error instanceof TimeReportError) return null;
    throw error;
  }
}

const SKIP = "__skip__";

/** One share as edited: a target id (or SKIP), a task type, a percent. */
type Share = { target: string; taskType: string; percent: number };

/**
 * Corrects where a workspace's time goes: recorded by the provider as an
 * answer (it learns from it), and kept as a standing mapping when
 * remembered. Roamgate keeps nothing of it.
 */
export function ProjectMappingEditor({
  workspace,
  projects,
  current,
  initialScope,
  onClose,
  onSaved,
}: {
  initialScope?: "workspace" | "subject";
  workspace: TimelineWorkspace;
  projects: ProjectMappings;
  /** The mapping in effect for the workspace, if any. */
  current: Mapping | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const subject = workspace.subject ?? null;
  const [scope, setScope] = useState<"workspace" | "subject">(
    subject && (initialScope ?? current?.scope) === "subject"
      ? "subject"
      : "workspace",
  );
  const [shares, setShares] = useState<Share[]>(() =>
    current?.allocations.length
      ? current.allocations.map((entry) => ({
          target: entry.target?.id ?? SKIP,
          taskType: entry.task_type ?? "",
          percent: entry.percent,
        }))
      : [{ target: "", taskType: "", percent: 100 }],
  );
  const total = shares.reduce((sum, share) => sum + share.percent, 0);
  const complete =
    total === 100 &&
    shares.every(
      (share) =>
        share.target !== "" &&
        Number.isInteger(share.percent) &&
        share.percent > 0,
    );
  const update = (index: number, patch: Partial<Share>) =>
    setShares((list) =>
      list.map((share, at) => (at === index ? { ...share, ...patch } : share)),
    );
  const addShare = () =>
    setShares((list) => {
      // The new share takes half of the largest one.
      const largest = list.reduce(
        (best, share, at) => (share.percent > list[best]!.percent ? at : best),
        0,
      );
      const half = Math.floor(list[largest]!.percent / 2);
      if (half < 1) return list;
      return [
        ...list.map((share, at) =>
          at === largest ? { ...share, percent: share.percent - half } : share,
        ),
        { target: "", taskType: "", percent: half },
      ];
    });
  const removeShare = (index: number) =>
    setShares((list) => {
      if (list.length < 2) return list;
      const removed = list[index]!.percent;
      const rest = list.filter((_, at) => at !== index);
      // Its percent goes back to the first share.
      return rest.map((share, at) =>
        at === 0 ? { ...share, percent: share.percent + removed } : share,
      );
    });
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => focusDialogElement(ref.current), []);
  const groups = new Map<string, Target[]>();
  for (const entry of projects.targets) {
    const key = entry.group ?? "";
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const standing =
    current &&
    (scope === "subject"
      ? current.scope === "subject" && current.subject_label === subject?.label
      : current.scope === "workspace" && current.workspace_id === workspace.id)
      ? current
      : null;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onSaved();
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  };

  const save = () =>
    run(() => {
      const body: MappingSet = {
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        allocations: shares.map((share) => ({
          target:
            share.target === SKIP
              ? null
              : (projects.targets.find((entry) => entry.id === share.target) ??
                null),
          task_type: share.target === SKIP ? null : share.taskType || null,
          percent: share.percent,
        })),
        remember,
      };
      if (scope === "subject" && subject) body.subject = subject;
      return timeReport("mapping-set", { body });
    });

  const forget = () =>
    run(() =>
      timeReport("mapping-delete", {
        body:
          scope === "subject" && subject
            ? { subject: subject.label }
            : { workspace_id: workspace.id },
      }),
    );

  return (
    <div
      className="project-mapping-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="project-mapping"
        role="dialog"
        aria-modal="true"
        aria-label={`Project for ${workspace.name}`}
        tabIndex={-1}
      >
        <h3>
          Where does{" "}
          {scope === "subject" && subject ? subject.label : workspace.name} go?
        </h3>
        {subject ? (
          <fieldset className="project-mapping-scope">
            <legend>For</legend>
            <label>
              <input
                type="radio"
                name="project-mapping-scope"
                checked={scope === "workspace"}
                onChange={() => setScope("workspace")}
              />
              This workspace
            </label>
            <label>
              <input
                type="radio"
                name="project-mapping-scope"
                checked={scope === "subject"}
                onChange={() => setScope("subject")}
              />
              Every workspace in {subject.label}
            </label>
          </fieldset>
        ) : null}
        <div className="project-mapping-shares">
          {shares.map((share, index) => (
            <fieldset
              // biome-ignore lint/suspicious/noArrayIndexKey: shares have no identity but their place
              key={index}
              className="project-mapping-share"
              aria-label={`Share ${index + 1}`}
            >
              <label className="project-mapping-field">
                <span>
                  {shares.length > 1
                    ? `Project ${index + 1}`
                    : `Project in ${projects.provider}`}
                </span>
                <select
                  value={share.target}
                  onChange={(event) =>
                    update(index, { target: event.target.value })
                  }
                >
                  <option value="" disabled>
                    Choose a project
                  </option>
                  {[...groups].map(([group, entries]) =>
                    group ? (
                      <optgroup key={group} label={group}>
                        {entries.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.label}
                          </option>
                        ))}
                      </optgroup>
                    ) : (
                      entries.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label}
                        </option>
                      ))
                    ),
                  )}
                  <option value={SKIP}>Do not log</option>
                </select>
              </label>
              <div className="project-mapping-share-row">
                <label className="project-mapping-field">
                  <span>Task type</span>
                  <select
                    value={share.taskType}
                    disabled={share.target === SKIP}
                    onChange={(event) =>
                      update(index, { taskType: event.target.value })
                    }
                  >
                    <option value="">None</option>
                    {projects.taskTypes.map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </label>
                {shares.length > 1 ? (
                  <>
                    <label className="project-mapping-field project-mapping-percent">
                      <span>Share</span>
                      <span className="project-mapping-percent-input">
                        <input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={99}
                          step={1}
                          value={share.percent}
                          onChange={(event) =>
                            update(index, {
                              percent: Math.round(Number(event.target.value)),
                            })
                          }
                        />
                        %
                      </span>
                    </label>
                    <button
                      type="button"
                      className="project-mapping-remove"
                      aria-label={`Remove share ${index + 1}`}
                      title="Remove this share"
                      onClick={() => removeShare(index)}
                    >
                      ×
                    </button>
                  </>
                ) : null}
              </div>
            </fieldset>
          ))}
          <div className="project-mapping-split">
            <button type="button" onClick={addShare}>
              Split between projects
            </button>
            {shares.length > 1 ? (
              <span
                className={total === 100 ? "is-ok" : "is-off"}
                role="status"
              >
                {total === 100
                  ? "100%: each block is cut in this order"
                  : `Shares add up to ${total}%, not 100%`}
              </span>
            ) : null}
          </div>
        </div>
        <label className="project-mapping-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span>
            Remember: always use this. Unticked, it is only an example the model
            learns from.
          </span>
        </label>
        {error ? (
          <p className="project-mapping-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="project-mapping-actions">
          {standing ? (
            <button
              type="button"
              className="project-mapping-forget"
              disabled={busy}
              onClick={() => void forget()}
            >
              Forget mapping
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="is-primary"
            disabled={busy || !complete}
            onClick={() => void save()}
          >
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
