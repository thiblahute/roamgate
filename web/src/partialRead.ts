/**
 * After a Roamgate restart a large session's index is made ready in the
 * background, and what needs the whole session (tasks, commands,
 * artifacts, title, stats) is answered from part of it meanwhile, marked
 * `partial`. Such an answer is asked again this soon; what was shown
 * before stays rather than give way to it.
 */
export const PARTIAL_RETRY_MS = 2000;

/** Whether an answer was read from part of the session only. */
export function isPartialRead(result: unknown): boolean {
  return (
    !!result &&
    typeof result === "object" &&
    (result as { partial?: unknown }).partial === true
  );
}
