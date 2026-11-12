import { forgeRefKey } from "../../../shared/forge";
import {
  mrActivityMarker,
  type MrReviewsSettings,
} from "../../../shared/mrReviews";
import { parseRequestRef } from "./agent-search";
import type { MrInboxService } from "./inbox";
import {
  MAX_HIDDEN,
  MAX_PINNED,
  mrReviewsSettings,
  normalizeStoredMrReviews,
} from "./settings";

/**
 * `bridge.mr_reviews.*`: the reviews inbox for every browser. Reads and
 * the user's own marks (seen, feedback, settings); nothing here writes to
 * a forge.
 */

export class MrReviewsError extends Error {
  constructor(
    message: string,
    readonly code = "invalid",
  ) {
    super(message);
  }
}

export type MrReviewsRpcDeps = {
  inbox: MrInboxService;
  settings: () => Promise<MrReviewsSettings>;
  /** Saves new settings (settings.json `mr_reviews`), returns them. */
  saveSettings: (settings: MrReviewsSettings) => Promise<MrReviewsSettings>;
  /** The rest of the methods (open, checkout, Claude), when set up. */
  more?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};

export function isMrReviewsMethod(method: string): boolean {
  return method.startsWith("bridge.mr_reviews.");
}

function key(params: Record<string, unknown>): string {
  const value = params.key;
  if (typeof value !== "string" || !value || value.length > 600)
    throw new MrReviewsError("key is required");
  return value;
}

/** Pins and hides read the settings, change them, save: one at a time. */
let editing: Promise<unknown> = Promise.resolve();
function editSettings<T>(change: () => Promise<T>): Promise<T> {
  const next = editing.then(change, change);
  editing = next.catch(() => {});
  return next;
}

export async function handleMrReviewsRpc(
  deps: MrReviewsRpcDeps,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case "bridge.mr_reviews.inbox":
      return deps.inbox.get({
        fresh: params.fresh === true,
        viewer: params.viewer !== false,
      });
    case "bridge.mr_reviews.seen":
      return { ok: deps.inbox.markSeen(key(params)) };
    case "bridge.mr_reviews.feedback": {
      const verdict = params.verdict;
      if (
        verdict !== null &&
        verdict !== "not_interested" &&
        verdict !== "more_like_this"
      )
        throw new MrReviewsError(
          "verdict must be not_interested, more_like_this or null",
        );
      return { ok: deps.inbox.feedback(key(params), verdict) };
    }
    case "bridge.mr_reviews.pin": {
      // A URL on one of the user's hosts, or "project!12" / "!12" as the
      // reviews agent reads them.
      const text = params.text;
      if (typeof text !== "string" || !text.trim() || text.length > 600)
        throw new MrReviewsError("a merge or pull request URL is required");
      const ref = parseRequestRef(
        text.trim(),
        deps.inbox.items(),
        await deps.inbox.hosts(),
      );
      if (!ref)
        throw new MrReviewsError(
          /^https?:\/\//i.test(text.trim())
            ? "That host is not one of your forge hosts (see the settings), or it is not a merge or pull request URL."
            : "Not a merge or pull request: paste its URL.",
        );
      if ("ambiguous" in ref)
        throw new MrReviewsError(
          "That number fits several requests: paste the URL.",
        );
      const key = forgeRefKey(ref);
      await editSettings(async () => {
        const current = await deps.settings();
        if (current.pinned.some((each) => forgeRefKey(each) === key)) return;
        if (current.pinned.length >= MAX_PINNED)
          throw new MrReviewsError(
            `At most ${MAX_PINNED} requests can be pinned: remove one first.`,
          );
        await deps.saveSettings({
          ...current,
          pinned: [ref, ...current.pinned],
          hidden: current.hidden.filter((each) => each.key !== key),
        });
      });
      await deps.inbox.readPin(ref);
      return { ok: true, key };
    }
    case "bridge.mr_reviews.unpin": {
      const target = key(params);
      await editSettings(async () => {
        const current = await deps.settings();
        await deps.saveSettings({
          ...current,
          pinned: current.pinned.filter((each) => forgeRefKey(each) !== target),
        });
      });
      deps.inbox.changed();
      return { ok: true };
    }
    case "bridge.mr_reviews.hide": {
      // Out of the view: a pinned request is unpinned, any other one stays
      // out until something happens on it.
      const target = key(params);
      const action = await editSettings(async () => {
        const current = await deps.settings();
        if (current.pinned.some((each) => forgeRefKey(each) === target)) {
          await deps.saveSettings({
            ...current,
            pinned: current.pinned.filter(
              (each) => forgeRefKey(each) !== target,
            ),
          });
          return "unpinned" as const;
        }
        const item = deps.inbox.item(target);
        if (!item) throw new MrReviewsError("no such request", "not_found");
        await deps.saveSettings({
          ...current,
          hidden: [
            ...current.hidden.filter((each) => each.key !== target),
            { key: target, marker: mrActivityMarker(item) },
          ].slice(-MAX_HIDDEN),
        });
        return "hidden" as const;
      });
      deps.inbox.changed();
      return { ok: true, action };
    }
    case "bridge.mr_reviews.unhide": {
      const target = key(params);
      await editSettings(async () => {
        const current = await deps.settings();
        await deps.saveSettings({
          ...current,
          hidden: current.hidden.filter((each) => each.key !== target),
        });
      });
      deps.inbox.changed();
      return { ok: true };
    }
    case "bridge.mr_reviews.settings.get":
      return deps.settings();
    case "bridge.mr_reviews.settings.update": {
      const current = await deps.settings();
      const raw = params.settings;
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new MrReviewsError("settings are required");
      const value = raw as Record<string, unknown>;
      // The browser speaks the settings' own names; settings.json the
      // stored ones: normalized through the stored form.
      const stored = normalizeStoredMrReviews({
        hosts: value.hosts ?? current.hosts,
        followed: value.followed ?? current.followed,
        checkout: value.checkout ?? current.checkout,
        retention_days: value.retentionDays ?? current.retentionDays,
        curation: value.curation ?? current.curation,
        suggest_days: value.suggestDays ?? current.suggestDays,
        hints: value.hints ?? current.hints,
        tree_groups: value.treeGroups ?? current.treeGroups,
        clones: Object.fromEntries(
          Object.entries(
            (value.clones as MrReviewsSettings["clones"] | undefined) ??
              current.clones,
          ).map(([project, clone]) => [
            project,
            { connection_id: clone?.connectionId, path: clone?.path },
          ]),
        ),
        order: value.order ?? current.order,
        pinned: value.pinned ?? current.pinned,
        hidden: value.hidden ?? current.hidden,
      });
      const saved = await deps.saveSettings(mrReviewsSettings(stored));
      // The user's order alone changes nothing the forges are asked.
      if (
        Object.keys(value).some(
          (name) => name !== "order" && name !== "pinned" && name !== "hidden",
        )
      )
        void deps.inbox.refresh();
      return saved;
    }
    default:
      if (deps.more) return deps.more(method, params);
      throw new MrReviewsError(`unknown method: ${method}`, "unknown");
  }
}
