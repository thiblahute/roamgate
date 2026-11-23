import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import {
  MR_EFFORT_COLUMN_TITLE,
  MR_EFFORT_COLUMNS,
  type MrEffortColumn,
  mrEffortColumn,
} from "../mrEffortBoard";
import type {
  MrInboxEntry,
  MrPlan,
  MrWorkspaceLink,
} from "../../../shared/mrReviews";
import {
  type EffortPoint,
  EffortThreadsAt,
  effortItemProps,
} from "./EffortThreads";
import { type MrExtraChip, MrReviewRow } from "./MrReviewsPanel";

/**
 * An effort's Board: one card per planned request in the columns of the
 * inbox's lanes. A plan without a part is Planned, one with a part and no
 * request Not proposed yet (its branch's row when the inbox has one), one
 * whose request is open in that request's lane, drawn with the inbox's
 * own card; merged ones are Done, folded until asked.
 */

export type BoardCard = {
  plan: MrPlan;
  /** Its request, or its part's branch row; none before either. */
  entry?: MrInboxEntry;
  column: MrEffortColumn;
};

export type BoardColumn = { column: MrEffortColumn; cards: BoardCard[] };

/** A card as one comments on it: by its plan's id. */
export function cardPoint(plan: MrPlan): EffortPoint {
  return {
    tab: "board",
    item: { kind: "card", key: plan.id, label: plan.name },
  };
}

/**
 * The Board's columns, left to right, the empty ones left out. `entries`:
 * the inbox's live entries (fresher than the ones effort.get gave).
 */
export function boardColumns(input: {
  plans: readonly MrPlan[];
  linked: Readonly<Record<string, MrInboxEntry>>;
  entries: readonly MrInboxEntry[];
  /** Whether every commit of a plan is upstream. */
  upstream: (plan: MrPlan) => boolean;
}): BoardColumn[] {
  const live = new Map(input.entries.map((entry) => [entry.key, entry]));
  const cards = input.plans.map((plan): BoardCard => {
    const given = input.linked[plan.id];
    const entry = given ? (live.get(given.key) ?? given) : undefined;
    return {
      plan,
      ...(entry ? { entry } : {}),
      column: mrEffortColumn(plan, entry, input.upstream(plan)),
    };
  });
  return MR_EFFORT_COLUMNS.flatMap((column) => {
    const inIt = cards.filter((card) => card.column === column);
    return inIt.length ? [{ column, cards: inIt }] : [];
  });
}

/** What a card says of its plan: after what, how many commits, its part. */
export function planChips(
  plan: MrPlan,
  names: ReadonlyMap<string, string>,
  withState: boolean,
): MrExtraChip[] {
  const chips: MrExtraChip[] = [];
  if (withState)
    chips.push(
      plan.state === "accepted"
        ? { label: "accepted", tone: "good" }
        : {
            label: "proposed",
            tone: "wait",
            title: "Proposed: accept it in Plans (R), or :accept NAME",
          },
    );
  chips.push({
    label: `${plan.commits.length} commit${plan.commits.length === 1 ? "" : "s"}`,
    tone: "tree",
  });
  if (plan.dependsOn.length)
    chips.push({
      label: `after ${plan.dependsOn.map((each) => names.get(each) ?? each).join(", ")}`,
      tone: "wait",
    });
  if (plan.part?.ported)
    chips.push({
      label: "ported",
      tone: "tree",
      title: "Its branch is a port of the plan: its content its own",
    });
  if (plan.part?.conflict)
    chips.push({
      label: "conflict",
      tone: "bad",
      title: `Stopped ${plan.part.conflict.folding ? "folding fixups " : ""}at ${plan.part.conflict.sha.slice(0, 10)} ${plan.part.conflict.subject} (${plan.part.conflict.files.join(", ") || "empty"}): resolve it in ${plan.part.path}`,
    });
  return chips;
}

/** The next step of a plan with no request yet. */
function planNext(plan: MrPlan): string {
  if (!plan.part)
    return plan.state === "accepted"
      ? "Make its part (Plans, :part NAME)"
      : "Accept it, then make its part";
  if (plan.part.conflict) return `Resolve the conflict in ${plan.part.path}`;
  return `Open its request from ${plan.part.branch}`;
}

/** A plan with no request (nor branch row) yet: a card like the inbox's. */
function PlanCard({
  plan,
  chips,
  selected,
  onSelect,
  onOpen,
  pointed,
}: {
  plan: MrPlan;
  chips: MrExtraChip[];
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  pointed: EffortPoint | null;
}) {
  return (
    <li
      className="mr-reviews-item"
      {...effortItemProps(cardPoint(plan), pointed)}
    >
      <button
        type="button"
        className={`assistant-task-row mr-reviews-row${selected ? " is-selected" : ""}`}
        aria-current={selected ? "true" : undefined}
        data-mr-plan={plan.id}
        onFocus={onSelect}
        onClick={onOpen}
      >
        <div className="mr-reviews-dense-head">
          <strong>
            <span className="mr-reviews-number">plan</span> {plan.name}
          </strong>
          <span className="mr-reviews-dense-chips" aria-label="Where it stands">
            {chips.map((chip) => (
              <span
                key={chip.label}
                className={`mr-reviews-chip is-${chip.tone}`}
                title={chip.title}
              >
                {chip.label}
              </span>
            ))}
          </span>
        </div>
        <span className="mr-reviews-next">
          <span className="mr-reviews-next-text">{planNext(plan)}</span>
          <small className="mr-reviews-dense-meta">
            {plan.part ? plan.part.branch : "no part yet"}
            {plan.by === "agent" ? " · by Claude" : ""}
          </small>
        </span>
      </button>
    </li>
  );
}

export function MrEffortBoard({
  columns,
  names,
  wide,
  folded,
  onToggleColumn,
  pointed,
  onPoint,
  onOpen,
  links,
  onGoWorkspace,
  onStartHome,
  editor,
}: {
  columns: BoardColumn[];
  /** Plan names by id, for "after X". */
  names: ReadonlyMap<string, string>;
  /** Columns side by side; else one list under the columns' titles. */
  wide: boolean;
  folded: ReadonlySet<MrEffortColumn>;
  onToggleColumn: (column: MrEffortColumn) => void;
  pointed: EffortPoint | null;
  onPoint: (card: BoardCard) => void;
  /** Enter, a click: its review in its home, its part's workspace... */
  onOpen: (card: BoardCard) => void;
  links?: Readonly<Record<string, MrWorkspaceLink[]>>;
  onGoWorkspace?: (entry: MrInboxEntry, link: MrWorkspaceLink) => void;
  onStartHome?: (entry: MrInboxEntry) => void;
  /** What one sets by hand on the selected card's request (e). */
  editor?: ReactNode;
}) {
  if (!columns.length)
    return (
      <p className="assistant-hint">
        No planned request yet. The leader session proposes them (gl), or select
        commits in the Ledger and :plan NAME.
      </p>
    );
  const at = pointed?.item?.kind === "card" ? pointed.item.key : null;
  return (
    <>
      {editor}
      <div
        className={`mr-effort-board ${wide ? "mr-reviews-board is-wide" : "mr-reviews-sections"}`}
        aria-label="Board"
      >
        {columns.map(({ column, cards }) => {
          const isFolded = folded.has(column);
          return (
            <div
              key={column}
              className={`mr-reviews-lane is-${column}${isFolded ? " is-folded" : ""}`}
              role="group"
              aria-label={MR_EFFORT_COLUMN_TITLE[column]}
              data-effort-column={column}
            >
              <button
                type="button"
                className="mr-reviews-lane-title"
                aria-expanded={!isFolded}
                title={`${isFolded ? "Expand" : "Fold"} ${MR_EFFORT_COLUMN_TITLE[column]} (za)`}
                onClick={() => onToggleColumn(column)}
              >
                {isFolded ? (
                  <ChevronRight size={13} />
                ) : (
                  <ChevronDown size={13} />
                )}
                {MR_EFFORT_COLUMN_TITLE[column]}
                <span>{cards.length}</span>
              </button>
              {isFolded ? null : (
                <ul className="assistant-task-list">
                  {cards.map((card) => {
                    const { plan, entry } = card;
                    const selected = at === plan.id;
                    const point = cardPoint(plan);
                    // A card's threads under it (an empty item hides).
                    const threads = (
                      <li
                        key={`threads:${plan.id}`}
                        className="mr-effort-card-threads"
                      >
                        <EffortThreadsAt point={point} />
                      </li>
                    );
                    if (!entry)
                      return [
                        <PlanCard
                          key={plan.id}
                          plan={plan}
                          chips={planChips(plan, names, true)}
                          selected={selected}
                          onSelect={() => onPoint(card)}
                          onOpen={() => {
                            onPoint(card);
                            onOpen(card);
                          }}
                          pointed={pointed}
                        />,
                        threads,
                      ];
                    const extra: MrExtraChip[] = [
                      ...(entry.title === plan.name
                        ? []
                        : [
                            {
                              label: `plan ${plan.name}`,
                              tone: "tree" as const,
                            },
                          ]),
                      ...planChips(plan, names, false),
                    ];
                    return [
                      <MrReviewRow
                        key={plan.id}
                        entry={entry}
                        selected={selected}
                        onSelect={() => onPoint(card)}
                        onOpen={() => {
                          onPoint(card);
                          onOpen(card);
                        }}
                        extra={extra}
                        itemProps={{
                          ...effortItemProps(point, pointed),
                          "data-mr-plan": plan.id,
                        }}
                        {...(links?.[entry.key]
                          ? { links: links[entry.key]! }
                          : {})}
                        {...(onGoWorkspace
                          ? {
                              onGoWorkspace: (link: MrWorkspaceLink) =>
                                onGoWorkspace(entry, link),
                            }
                          : {})}
                        {...(onStartHome && !entry.branch
                          ? { onStartHome: () => onStartHome(entry) }
                          : {})}
                      />,
                      threads,
                    ];
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** The cards the keys walk, column by column (folded columns left out). */
export function walkable(
  columns: BoardColumn[],
  folded: ReadonlySet<MrEffortColumn>,
): BoardColumn[] {
  return columns.filter(
    (each) => !folded.has(each.column) && each.cards.length,
  );
}

/**
 * j / k / h / l on the Board: the card `step` away in its column (or, in
 * one list, through every column), or the column `side` away, at the same
 * height. Null: nowhere to go.
 */
export function boardStep(
  columns: BoardColumn[],
  current: string | null,
  move: { step?: number; side?: number },
  wide: boolean,
): BoardCard | null {
  if (!columns.length) return null;
  const col = columns.findIndex((each) =>
    each.cards.some((card) => card.plan.id === current),
  );
  if (col < 0) return columns[0]!.cards[0] ?? null;
  const row = columns[col]!.cards.findIndex((card) => card.plan.id === current);
  if (move.side) {
    const next = Math.max(0, Math.min(columns.length - 1, col + move.side));
    const cards = columns[next]!.cards;
    return cards[Math.min(row, cards.length - 1)] ?? null;
  }
  const step = move.step ?? 0;
  if (wide) {
    const cards = columns[col]!.cards;
    return cards[Math.max(0, Math.min(cards.length - 1, row + step))] ?? null;
  }
  const all = columns.flatMap((each) => each.cards);
  const at = all.findIndex((card) => card.plan.id === current);
  return all[Math.max(0, Math.min(all.length - 1, at + step))] ?? null;
}

/** Whether a point is a card of the Board, and which plan. */
export function pointedPlan(point: EffortPoint | null): string | null {
  return point && point.tab === "board" && point.item?.kind === "card"
    ? point.item.key
    : null;
}
