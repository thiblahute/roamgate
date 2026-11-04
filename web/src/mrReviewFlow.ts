import type { MrInboxEntry } from "../../shared/mrReviews";
import type { ReviewSnapshot } from "../../shared/review";
import { mrReviewsCall } from "./mrReviews";
import { rememberReviewSnapshot, requestReviewShown } from "./review";
import { store } from "./store";

/**
 * Opening a request's review from the inbox: the bridge sets up the
 * project's review worktree and workspace and the request's review; the
 * page goes to that workspace and shows the review there. What needs the
 * user (where the clone is, local changes in the worktree) comes back.
 */

export type MrCheckoutState =
  | { state: "done"; head: string; kept?: string; discarded?: boolean }
  | { state: "deferred" }
  | { state: "dirty"; changes: string[] }
  | { state: "missing" }
  | { state: "error"; message: string };

type OpenReply =
  | {
      needClone: {
        host: string;
        project: string;
        connections: { id: string; label: string }[];
      };
    }
  | {
      connectionId: string;
      workspaceId: string;
      sessionId: string;
      snapshot: ReviewSnapshot;
      worktree: string;
      checkout: MrCheckoutState;
      claude?: MrClaudeState;
    };

export type MrClaudeState =
  | { state: "ready" | "starting"; paneId: string; session: string }
  | { state: "busy"; paneId: string; with: string | null }
  | { state: "foreign"; paneId: string }
  | { state: "none"; paneId: string | null }
  | { state: "error"; message: string };

export type MrOpenOutcome =
  | {
      kind: "shown";
      connectionId: string;
      sessionId: string;
      checkout: MrCheckoutState;
      claude?: MrClaudeState;
    }
  | {
      kind: "needClone";
      host: string;
      project: string;
      connections: { id: string; label: string }[];
    };

export async function openMrReview(
  entry: Pick<MrInboxEntry, "key">,
  options: { checkout?: "now" | "later" } = {},
): Promise<MrOpenOutcome> {
  const reply = await mrReviewsCall<OpenReply>("open", {
    key: entry.key,
    ...(options.checkout ? { checkout: options.checkout } : {}),
  });
  if ("needClone" in reply) return { kind: "needClone", ...reply.needClone };
  rememberReviewSnapshot(reply.snapshot);
  await store
    .jumpToConnectionWorkspace(reply.connectionId, reply.workspaceId)
    .catch(() => {});
  requestReviewShown(reply.connectionId, reply.sessionId);
  void import("./mrReviewWorkspaces").then((module) =>
    module.refreshMrReviewWorkspaces(),
  );
  return {
    kind: "shown",
    connectionId: reply.connectionId,
    sessionId: reply.sessionId,
    checkout: reply.checkout,
    ...(reply.claude ? { claude: reply.claude } : {}),
  };
}

/**
 * The request's Claude: `review` asks it to review (the review pane's own
 * flow), `start` starts or resumes it, `switch` waits for a busy one and
 * then switches; `status` only reads.
 */
export function mrClaude(
  key: string,
  action: "status" | "start" | "switch" | "review",
  options: { focus?: string; wait?: boolean } = {},
): Promise<MrClaudeState> {
  return mrReviewsCall<MrClaudeState>("claude", { key, action, ...options });
}

/** Shows the request's Claude pane. */
export async function showMrClaude(connectionId: string, paneId: string) {
  await store.jumpToConnectionPane(connectionId, paneId).catch(() => {});
}

export function checkoutMrReview(
  key: string,
  local: "refuse" | "wip" | "discard",
): Promise<MrCheckoutState> {
  return mrReviewsCall<MrCheckoutState>("checkout", { key, local });
}

export function setMrClone(params: {
  host: string;
  project: string;
  provider: string;
  connectionId: string;
  path: string;
}) {
  return mrReviewsCall("clone", {
    host: params.host,
    project: params.project,
    provider: params.provider,
    connection_id: params.connectionId,
    path: params.path,
  });
}

/**
 * Browsing a review's files with the checkout set to follow on demand:
 * the review worktree goes to the request shown in that workspace. Local
 * changes are never touched: the user is told to choose in Reviews.
 */
export async function checkoutForBrowsing(
  workspaceId: string,
  sessionId?: string,
) {
  const { latestMrInbox, loadMrReviewsSettings } = await import("./mrReviews");
  const entry = latestMrInbox()?.entries.find(
    (each) =>
      each.review?.workspaceId === workspaceId &&
      (!sessionId || each.review.sessionId === sessionId),
  );
  if (!entry) return;
  const settings = await loadMrReviewsSettings().catch(() => null);
  if (settings?.checkout !== "on_demand") return;
  const state = await checkoutMrReview(entry.key, "refuse").catch(() => null);
  if (state?.state === "dirty")
    store.notify({
      kind: "info",
      message: "The review worktree has local changes",
      detail: "Open Reviews (Option+M) to keep or discard them.",
      autoDismissMs: 8000,
    });
}
