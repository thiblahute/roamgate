import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewActivity } from "../../shared/review";
import type { LocalReviewBranch } from "./localReviews";
import { reviewCall } from "./review";
import { shallowEqual, type State, useStoreSelector } from "./store";

/** A review whose branch to read: its id, connection and checkout. */
export type ActivityReview = {
  id: string;
  connectionId: string;
  root: string;
};

/** The connections Roamgate does not reach now, and every connection's name. */
type ConnectionLine = { offline: string; names: string };

function selectConnections(state: State): ConnectionLine {
  const connections = state.connections ?? [];
  return {
    offline: connections
      .filter((each) => each.state !== "ready")
      .map((each) => each.id)
      .join("\n"),
    names: connections
      .map((each) => `${each.id}\t${each.label || each.id}`)
      .join("\n"),
  };
}

/** The reviews of one checkout on one connection: one review.activity call. */
export function activityGroups(
  reviews: readonly ActivityReview[],
): { connectionId: string; root: string; ids: string[] }[] {
  const groups = new Map<
    string,
    { connectionId: string; root: string; ids: string[] }
  >();
  for (const review of reviews) {
    const key = `${review.connectionId}\n${review.root}`;
    const group = groups.get(key) ?? {
      connectionId: review.connectionId,
      root: review.root,
      ids: [],
    };
    group.ids.push(review.id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * The branches of these reviews, read checkout by checkout: each answer
 * shows as it comes (a slow checkout holds back no other), the reviews of
 * a connection not reached now are said offline without asking, and asked
 * once it is back. Each review is read once while the caller shows it.
 */
export function useReviewActivity(
  reviews: readonly ActivityReview[],
): ReadonlyMap<string, LocalReviewBranch> {
  const connections = useStoreSelector(selectConnections, shallowEqual);
  const offline = useMemo(
    () => new Set(connections.offline ? connections.offline.split("\n") : []),
    [connections.offline],
  );
  const names = useMemo(
    () =>
      new Map(
        (connections.names ? connections.names.split("\n") : []).map(
          (line) => line.split("\t") as [string, string],
        ),
      ),
    [connections.names],
  );
  const [read, setRead] = useState<ReadonlyMap<string, LocalReviewBranch>>(
    () => new Map(),
  );
  /** The reviews asked for (answered or not), for this mount. */
  const asked = useRef(new Set<string>());
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const groups = useMemo(() => activityGroups(reviews), [reviews]);
  useEffect(() => {
    for (const group of groups) {
      if (offline.has(group.connectionId)) continue;
      const ids = group.ids.filter((id) => !asked.current.has(id));
      if (!ids.length) continue;
      for (const id of ids) asked.current.add(id);
      const keep = (answer: (id: string) => LocalReviewBranch) => {
        if (!live.current) return;
        setRead((current) => {
          const next = new Map(current);
          for (const id of ids) next.set(id, answer(id));
          return next;
        });
      };
      void reviewCall<{ activity: ReviewActivity[] }>(
        group.connectionId,
        "review.activity",
        { session_ids: ids },
        undefined,
        { lane: "background" },
      ).then(
        ({ activity }) => {
          const byId = new Map(activity.map((each) => [each.sessionId, each]));
          // A review it says nothing of (not a range) stands as it is.
          keep((id) => ({
            state: "read",
            activity: byId.get(id) ?? { sessionId: id, newCommits: false },
          }));
        },
        () => {
          // Asked again on the next show.
          for (const id of ids) asked.current.delete(id);
          keep(() => ({ state: "failed" }));
        },
      );
    }
  }, [groups, offline]);
  return useMemo(() => {
    const branches = new Map<string, LocalReviewBranch>();
    for (const review of reviews) {
      const known = read.get(review.id);
      const reached = !offline.has(review.connectionId);
      if (known && (known.state !== "failed" || reached))
        branches.set(review.id, known);
      else if (!reached)
        branches.set(review.id, {
          state: "offline",
          connection: names.get(review.connectionId) ?? review.connectionId,
        });
      else branches.set(review.id, { state: "reading" });
    }
    return branches;
  }, [reviews, read, offline, names]);
}
