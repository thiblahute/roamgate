import type { ReviewSnapshot } from "../../shared/review";

/*
 * Reviews come from the server, pushed or listed: checked before the app
 * draws them, so a malformed one is dropped instead of breaking the page.
 * Only what the review pane reads unguarded is checked.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function isComment(value: unknown) {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.author === "string" &&
    typeof value.body === "string"
  );
}

function isThread(value: unknown) {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    // Kinds are compared where used: one this page does not know is
    // drawn as a comment.
    typeof value.kind === "string" &&
    (value.anchor === undefined || isObject(value.anchor)) &&
    Array.isArray(value.comments) &&
    value.comments.every(isComment)
  );
}

function isTarget(value: unknown) {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "range")
    return typeof value.base === "string" && typeof value.head === "string";
  if (value.kind === "mr") return typeof value.url === "string";
  return true;
}

/** Whether a value is a review the app can draw. */
export function isReviewSnapshot(value: unknown): value is ReviewSnapshot {
  if (!isObject(value) || !isObject(value.session)) return false;
  const session = value.session;
  return (
    typeof session.id === "string" &&
    typeof session.connectionId === "string" &&
    isOptionalString(session.workspaceId) &&
    typeof session.root === "string" &&
    typeof session.title === "string" &&
    typeof session.summary === "string" &&
    isTarget(session.target) &&
    isObject(session.agent) &&
    typeof session.updatedAt === "string" &&
    Array.isArray(value.threads) &&
    value.threads.every(isThread)
  );
}

/** The valid reviews of a list, the others dropped. */
export function validReviewSnapshots(value: unknown): ReviewSnapshot[] {
  return Array.isArray(value) ? value.filter(isReviewSnapshot) : [];
}
