/*
 * Saving what is written in a review. The editor closes as you save, before
 * the server answers: a save that fails hands the text back to be kept (as
 * an unsent draft), so it is never lost, and says so.
 */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs a save. When it fails, `keep` puts the text somewhere it can be
 * found again; the answer is then why it failed, else null.
 */
export async function saveOrKeep(
  save: () => Promise<unknown>,
  keep: () => void,
): Promise<string | null> {
  try {
    await save();
    return null;
  } catch (error) {
    keep();
    return errorText(error) || "unknown error";
  }
}

/** What the status says of a save that failed: the text was kept. */
export function notSavedStatus(error: string): string {
  return `Not saved: ${error}. Your text is kept: reopen it to go on.`;
}

/** What the status says of a handoff, as it went. */
export function handoffStatus(
  agentName: string,
  error: string | null,
  open: number,
  newOverall: boolean,
): string {
  if (error) return `Not sent to ${agentName}: ${error}`;
  const discussions = `${open} open discussion${open === 1 ? "" : "s"}`;
  return `Sent to ${agentName}: ${discussions}${newOverall ? " and your overall comment" : ""}.`;
}
