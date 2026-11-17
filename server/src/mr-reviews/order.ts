import { forgeRefKey } from "../../../shared/forge";
import { workspaceRefKey } from "../../../shared/workspaceTree";
import type {
  MrHiddenEntry,
  MrInboxEntry,
  MrReviewsSettings,
} from "../../../shared/mrReviews";
import {
  applyMrOrderOp,
  flattenMrSections,
  MAX_ORDER,
  MR_SECTION_ORDER,
  type MrOrderOp,
  type MrOrderSections,
  orderMrEntries,
  rebaseMrOrder,
  storedMrOrder,
} from "../../../shared/mrReviewsOrder";
import type { MrInboxService } from "./inbox";

/**
 * The user's order of the reviews inbox, as the server keeps it: one
 * document (settings.json `mr_reviews.order`) with a version that every
 * change bumps (the pins and removals too). A change is an operation on the
 * latest order, so the user's drag and the agent's reorder never overwrite
 * each other; a whole list saved by a page that has since fallen behind is
 * rebased onto it. Every saved change is pushed to every page.
 */

/** Who changed it, and what to say about it (the agent's changes only). */
export type MrChangeMeta = {
  by: "user" | "agent";
  summary?: string;
  /** Offer to take this change back (Undo). */
  undoable?: boolean;
};

export type MrOrderView = {
  version: number;
  sections: Record<(typeof MR_SECTION_ORDER)[number], MrInboxEntry[]>;
  hidden: MrHiddenEntry[];
};

export type MrOrderResult = {
  changed: boolean;
  version: number;
  moved: string[];
  unknown: string[];
  elsewhere: string[];
  view: MrOrderView;
};

/** Pins, removals and order changes read the settings, change them, save: one at a time. */
let editing: Promise<unknown> = Promise.resolve();
export function editSettings<T>(change: () => Promise<T>): Promise<T> {
  const next = editing.then(change, change);
  editing = next.catch(() => {});
  return next;
}

/** Versions kept, to rebase a stale list and to undo. */
const HISTORY = 40;

/** Lists Undo restores element by element (by their key). */
const UNDO_LISTS = [
  "pinned",
  "hidden",
  "views",
  "unsent",
  "upstreamGroups",
  "upstreamSkip",
  "upstreamWorkspaces",
  "efforts",
] as const;
const UNDO_LIST_KEY: {
  [field in (typeof UNDO_LISTS)[number]]: (
    value: MrReviewsSettings[field][number],
  ) => string;
} = {
  pinned: (ref) => forgeRefKey(ref),
  hidden: (entry) => entry.key,
  views: (view) => view.name.toLowerCase(),
  unsent: (entry) => entry.key,
  upstreamGroups: (id) => id,
  upstreamSkip: (ref) => workspaceRefKey(ref),
  upstreamWorkspaces: (ref) => workspaceRefKey(ref),
  efforts: (effort) => effort.id,
};
/** Records Undo restores key by key. */
const UNDO_RECORDS = ["overrides"] as const;

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A record after undoing the change from `before` to `after`: each key it
 * changed goes back, unless it changed again since.
 */
export function undoRecord<T>(
  before: Record<string, T>,
  after: Record<string, T>,
  current: Record<string, T>,
): Record<string, T> {
  const out = { ...current };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (sameJson(before[key], after[key])) continue;
    if (!sameJson(current[key], after[key])) continue;
    if (before[key] === undefined) delete out[key];
    else out[key] = before[key];
  }
  return out;
}

/** A keyed list after undoing a change, as undoRecord; restored ones first. */
export function undoList<T>(
  before: T[],
  after: T[],
  current: T[],
  keyOf: (value: T) => string,
): T[] {
  const index = (list: T[]) => new Map(list.map((each) => [keyOf(each), each]));
  const was = index(before);
  const now = index(after);
  const out = [...current];
  const restored: T[] = [];
  for (const [key, value] of now)
    if (!was.has(key)) {
      const at = out.findIndex((each) => keyOf(each) === key);
      if (at >= 0 && sameJson(out[at], value)) out.splice(at, 1);
    }
  for (const [key, value] of was) {
    const at = out.findIndex((each) => keyOf(each) === key);
    if (!now.has(key)) {
      if (at < 0) restored.push(value);
    } else if (
      at >= 0 &&
      !sameJson(value, now.get(key)) &&
      sameJson(out[at], now.get(key))
    )
      // Changed in place by that change, and not since.
      out[at] = value;
  }
  return [...restored, ...out];
}

export type MrOrderDeps = {
  inbox: MrInboxService;
  /** The settings in effect. */
  settings: () => Promise<MrReviewsSettings>;
  /** Saves them (bumping the version when the order moved), returns them. */
  save: (
    settings: MrReviewsSettings,
    meta?: MrChangeMeta,
  ) => Promise<MrReviewsSettings>;
};

export function createMrOrder(deps: MrOrderDeps) {
  /**
   * Per version: the whole settings as saved (Undo takes back any field a
   * change touched), and the list as it was shown.
   */
  const stored = new Map<number, MrReviewsSettings>();
  const shown = new Map<number, string[]>();

  function view(settings: MrReviewsSettings): MrOrderView {
    const { entries, hidden } = deps.inbox.snapshot(settings);
    const sections: MrOrderView["sections"] = {
      pinned: [],
      mine: [],
      authored: [],
      suggested: [],
    };
    for (const name of MR_SECTION_ORDER)
      sections[name] = orderMrEntries(
        entries.filter((entry) => entry.section === name),
        settings.order,
      );
    return { version: settings.orderVersion ?? 0, sections, hidden };
  }

  function keysOf(shown: MrOrderView): MrOrderSections {
    return {
      pinned: shown.sections.pinned.map((entry) => entry.key),
      mine: shown.sections.mine.map((entry) => entry.key),
      authored: shown.sections.authored.map((entry) => entry.key),
      suggested: shown.sections.suggested.map((entry) => entry.key),
    };
  }

  const shownList = (settings: MrReviewsSettings) =>
    flattenMrSections(keysOf(view(settings)));

  function note(settings: MrReviewsSettings) {
    const version = settings.orderVersion ?? 0;
    stored.set(version, structuredClone(settings));
    shown.set(version, shownList(settings));
    for (const old of [...stored.keys()])
      if (old <= version - HISTORY) {
        stored.delete(old);
        shown.delete(old);
      }
  }

  /** The order in effect is known to history, whatever made it. */
  function seed(settings: MrReviewsSettings) {
    if (!stored.has(settings.orderVersion ?? 0)) note(settings);
  }

  return {
    /** Remembers what a save produced (the version it got). */
    remember: note,
    /** Remembers the settings a save starts from, unless known. */
    seed,

    /** The inbox as the user sees it: sections in their order. */
    async view(): Promise<MrOrderView> {
      return view(await deps.settings());
    },

    /** An operation on the latest order, applied and saved. */
    apply(
      operation: MrOrderOp,
      meta: MrChangeMeta & { describe?: (moved: string[]) => string },
    ): Promise<MrOrderResult> {
      return editSettings(async () => {
        const current = await deps.settings();
        seed(current);
        const before = view(current);
        const outcome = applyMrOrderOp(keysOf(before), operation);
        if (!outcome.moved.length)
          return {
            changed: false,
            version: before.version,
            moved: [],
            unknown: outcome.unknown,
            elsewhere: outcome.elsewhere,
            view: before,
          };
        const saved = await deps.save(
          {
            ...current,
            order: storedMrOrder(
              flattenMrSections(outcome.sections),
              current.order,
            ),
          },
          {
            by: meta.by,
            ...(meta.describe ? { summary: meta.describe(outcome.moved) } : {}),
            ...(meta.undoable ? { undoable: true } : {}),
          },
        );
        return {
          changed: true,
          version: saved.orderVersion ?? 0,
          moved: outcome.moved,
          unknown: outcome.unknown,
          elsewhere: outcome.elsewhere,
          view: view(saved),
        };
      });
    },

    /**
     * A whole list from a page that last saw `base` (a version), put on
     * the settings in effect: what it moved is applied on their order.
     * Without that version's order (an old one, or after a restart) the
     * list is taken as it is, the keys it lacks kept after it.
     */
    rebased(
      current: MrReviewsSettings,
      list: string[],
      baseVersion?: number,
    ): string[] {
      seed(current);
      const base =
        baseVersion !== undefined && baseVersion !== (current.orderVersion ?? 0)
          ? shown.get(baseVersion)
          : undefined;
      return base
        ? storedMrOrder(
            rebaseMrOrder(base, list, shownList(current)),
            current.order,
          )
        : list.slice(0, MAX_ORDER);
    },

    /**
     * Takes back the change that made `version`: each field it touched goes
     * back to what it was, unless something changed it since (for the
     * order: what that change moved, undone on the latest order; for keyed
     * fields such as overrides, key by key).
     */
    undo(version: number): Promise<MrReviewsSettings> {
      return editSettings(async () => {
        const current = await deps.settings();
        seed(current);
        const after = shown.get(version);
        const before = shown.get(version - 1);
        const settingsBefore = stored.get(version - 1);
        const settingsAfter = stored.get(version);
        if (!after || !before || !settingsBefore || !settingsAfter)
          throw new Error("That change can no longer be undone.");
        const same = (a: unknown, b: unknown) =>
          JSON.stringify(a) === JSON.stringify(b);
        const next: MrReviewsSettings = { ...current };
        if (!same(settingsBefore.order, settingsAfter.order))
          next.order =
            (current.orderVersion ?? 0) === version
              ? settingsBefore.order
              : storedMrOrder(
                  rebaseMrOrder(after, before, shownList(current)),
                  current.order,
                );
        for (const field of UNDO_LISTS) {
          const keyOf = UNDO_LIST_KEY[field];
          (next as Record<string, unknown>)[field] = undoList(
            settingsBefore[field] as unknown[],
            settingsAfter[field] as unknown[],
            current[field] as unknown[],
            keyOf as (value: unknown) => string,
          );
        }
        for (const field of UNDO_RECORDS)
          (next as Record<string, unknown>)[field] = undoRecord(
            settingsBefore[field] as Record<string, unknown>,
            settingsAfter[field] as Record<string, unknown>,
            current[field] as Record<string, unknown>,
          );
        return deps.save(next, { by: "user" });
      });
    },
  };
}

export type MrOrder = ReturnType<typeof createMrOrder>;
