import { useEffect, useRef, useState } from "react";
import { forgeRefLabel } from "../../../shared/forge";
import {
  MR_LANE_TITLE,
  type MrInboxEntry,
  type MrOverrideField,
  mrWhoseLabel,
} from "../../../shared/mrReviews";
import type { MrOverrideEdit } from "../mrReviews";

/**
 * What one sets by hand on one of one's requests (e): whose move, the next
 * step, what it waits for, labels, a link, stale; each wins over what
 * Roamgate infers. Shown in the request's details.
 */

const WHOSE = ["", "me", "reviewer", "external", "person"] as const;
const WHOSE_LABEL: Record<(typeof WHOSE)[number], string> = {
  "": "As Roamgate says",
  me: "Mine",
  reviewer: "The reviewer's",
  external: "External (CI, another project)",
  person: "Someone's:",
};

function words(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

/** The edit that turns `entry`'s override into the form's values. */
export function overrideEditOf(
  entry: MrInboxEntry,
  values: {
    whose: string;
    person: string;
    next: string;
    dependsOn: string;
    labels: string;
    link: string;
    stale: boolean;
  },
): MrOverrideEdit | null {
  const current = entry.override;
  const set: NonNullable<MrOverrideEdit["set"]> = {};
  const clear: MrOverrideField[] = [];
  const whose =
    values.whose === "person" ? values.person.trim() : values.whose.trim();
  const before = current?.whose ? mrWhoseLabel(current.whose) : "";
  if (whose !== before || (current?.whose && entry.overrideOutdated)) {
    if (whose) set.whose = whose;
    else if (current?.whose) clear.push("whose");
  }
  const next = values.next.trim();
  if (next !== (current?.next ?? "") || (next && entry.overrideOutdated)) {
    if (next) set.next = next;
    else if (current?.next) clear.push("next");
  }
  const depends = words(values.dependsOn);
  const dependsBefore = (current?.dependsOn ?? []).map(
    (key) => refOfKey(key) ?? key,
  );
  if (depends.join(" ") !== dependsBefore.join(" ")) {
    if (depends.length) set.dependsOn = depends;
    else if (current?.dependsOn) clear.push("dependsOn");
  }
  const labels = values.labels
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  if (labels.join(",") !== (current?.labels ?? []).join(",")) {
    if (labels.length) set.labels = labels;
    else if (current?.labels) clear.push("labels");
  }
  const link = values.link.trim();
  if (link !== (current?.link ?? "")) {
    if (link) set.link = link;
    else if (current?.link) clear.push("link");
  }
  if (values.stale !== !!current?.stale) {
    if (values.stale) set.stale = true;
    else clear.push("stale");
  }
  if (!Object.keys(set).length && !clear.length) return null;
  return {
    ...(Object.keys(set).length ? { set } : {}),
    ...(clear.length ? { clear } : {}),
  };
}

/** "gitlab:host/group/project#12" as "group/project!12". */
export function refOfKey(key: string): string | null {
  const match = /^(gitlab|github):[^/]+\/(.+)#(\d+)$/.exec(key);
  if (!match) return null;
  return `${match[2]}${match[1] === "gitlab" ? "!" : "#"}${match[3]}`;
}

export function MrOverrideForm({
  entry,
  known,
  busy,
  error,
  onSave,
  onCancel,
}: {
  entry: MrInboxEntry;
  /** The listed requests, completed in "waits for". */
  known: MrInboxEntry[];
  busy: boolean;
  error: string | null;
  onSave: (edit: MrOverrideEdit | null) => void;
  onCancel: () => void;
}) {
  const current = entry.override;
  const whoseBefore = current?.whose;
  const [whose, setWhose] = useState<string>(
    !whoseBefore
      ? ""
      : typeof whoseBefore === "string"
        ? whoseBefore
        : "person",
  );
  const [person, setPerson] = useState(
    whoseBefore && typeof whoseBefore !== "string" ? whoseBefore.person : "",
  );
  const [next, setNext] = useState(current?.next ?? "");
  const [dependsOn, setDependsOn] = useState(
    (current?.dependsOn ?? []).map((key) => refOfKey(key) ?? key).join(" "),
  );
  const [labels, setLabels] = useState((current?.labels ?? []).join(", "));
  const [link, setLink] = useState(current?.link ?? "");
  const [stale, setStale] = useState(!!current?.stale);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const submit = () =>
    onSave(
      overrideEditOf(entry, {
        whose,
        person,
        next,
        dependsOn,
        labels,
        link,
        stale,
      }),
    );
  const listId = `mr-override-known-${entry.number}`;
  return (
    <form
      className="mr-override-form"
      aria-label="Set by hand"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
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
        <span>Next step</span>
        <input
          ref={first}
          type="text"
          value={next}
          maxLength={200}
          placeholder={entry.next?.from === "override" ? "" : entry.next?.text}
          onChange={(event) => setNext(event.target.value)}
        />
      </label>
      <label>
        <span>Whose move</span>
        <span className="mr-override-whose">
          <select
            value={whose}
            onChange={(event) => setWhose(event.target.value)}
          >
            {WHOSE.map((value) => (
              <option key={value} value={value}>
                {WHOSE_LABEL[value]}
              </option>
            ))}
          </select>
          {whose === "person" ? (
            <input
              type="text"
              aria-label="Whose (user name)"
              value={person}
              maxLength={80}
              placeholder="user name"
              onChange={(event) => setPerson(event.target.value)}
            />
          ) : null}
        </span>
      </label>
      <label>
        <span>Waits for</span>
        <input
          type="text"
          list={listId}
          value={dependsOn}
          placeholder="project!123, URLs (space separated)"
          onChange={(event) => setDependsOn(event.target.value)}
        />
        <datalist id={listId}>
          {known
            .filter((each) => each.key !== entry.key)
            .map((each) => (
              <option key={each.key} value={forgeRefLabel(each)}>
                {each.title}
              </option>
            ))}
        </datalist>
      </label>
      <label>
        <span>Labels</span>
        <input
          type="text"
          value={labels}
          placeholder="comma separated"
          onChange={(event) => setLabels(event.target.value)}
        />
      </label>
      <label>
        <span>Link</span>
        <input
          type="text"
          value={link}
          maxLength={1000}
          placeholder="a URL, or a path (notes, a plan)"
          onChange={(event) => setLink(event.target.value)}
        />
      </label>
      <label className="mr-override-check">
        <input
          type="checkbox"
          checked={stale}
          onChange={(event) => setStale(event.target.checked)}
        />
        <span>Stale (in the Stale lane)</span>
      </label>
      {error ? (
        <p className="assistant-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="assistant-task-buttons">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Saving..." : "Save"}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The detail's lines: lane, next step, what was set by hand. */
export function MrOverrideSummary({
  entry,
  onSelect,
  onClear,
}: {
  entry: MrInboxEntry;
  /** A request it waits for, selected in the list. */
  onSelect?: (key: string) => void;
  onClear?: (field: MrOverrideField | "all") => void;
}) {
  const override = entry.override;
  if (!entry.lane && !override) return null;
  const outdated = entry.overrideOutdated;
  const by = override?.by === "agent" ? "Claude" : "you";
  return (
    <>
      {entry.lane ? (
        <div>
          <dt>Lane</dt>
          <dd>
            {MR_LANE_TITLE[entry.lane]}
            {entry.laneWhy ? <small> · {entry.laneWhy}</small> : null}
          </dd>
        </div>
      ) : null}
      {entry.next ? (
        <div>
          <dt>Next step</dt>
          <dd
            className={
              outdated && entry.next.from === "override" ? "is-outdated" : ""
            }
          >
            {entry.next.text}{" "}
            <small className="mr-reviews-setby">
              {entry.next.from === "override"
                ? `set by ${by}${outdated ? ", changed since" : ""}`
                : "from its status"}
            </small>
          </dd>
        </div>
      ) : null}
      {entry.dependsOn?.length ? (
        <div>
          <dt>Waits for</dt>
          <dd className="mr-reviews-depends">
            {entry.dependsOn.map((key) => (
              <button
                key={key}
                type="button"
                className="ghost"
                title="Select it"
                onClick={() => onSelect?.(key)}
              >
                {refOfKey(key) ?? key}
              </button>
            ))}
          </dd>
        </div>
      ) : null}
      {override ? (
        <div>
          <dt>Set by hand</dt>
          <dd className="mr-override-fields">
            {override.whose ? (
              <span className={outdated ? "is-outdated" : ""}>
                whose move: {mrWhoseLabel(override.whose)}
              </span>
            ) : null}
            {override.labels?.map((label) => (
              <span key={label} className="mr-reviews-chip is-label">
                {label}
              </span>
            ))}
            {override.link ? (
              /^https?:\/\//.test(override.link) ? (
                <a href={override.link} target="_blank" rel="noreferrer">
                  {override.link}
                </a>
              ) : (
                <code>{override.link}</code>
              )
            ) : null}
            {override.stale ? <span>marked stale</span> : null}
            <small>
              by {by}, {new Date(override.at).toLocaleDateString()}
              {outdated ? "; the request moved on since" : ""}
            </small>
            {onClear ? (
              <button
                type="button"
                className="ghost"
                title="Clear what was set by hand (E, :clear)"
                onClick={() => onClear("all")}
              >
                Clear
              </button>
            ) : null}
          </dd>
        </div>
      ) : null}
    </>
  );
}
