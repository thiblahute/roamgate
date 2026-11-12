import type { MrReviewsSettings } from "../../../shared/mrReviews";
import type { MrInboxService } from "./inbox";
import { normalizeStoredMrReviews, mrReviewsSettings } from "./settings";

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
      });
      const saved = await deps.saveSettings(mrReviewsSettings(stored));
      // The user's order alone changes nothing the forges are asked.
      if (Object.keys(value).some((name) => name !== "order"))
        void deps.inbox.refresh();
      return saved;
    }
    default:
      if (deps.more) return deps.more(method, params);
      throw new MrReviewsError(`unknown method: ${method}`, "unknown");
  }
}
