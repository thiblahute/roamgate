/**
 * A workspace voice chat went to: its review, if one is pinned there,
 * steps aside (Option+R brings it back) so the agent's chat shows.
 */
let arrival: { connectionId: string; workspaceId: string; at: number } | null =
  null;
const ARRIVAL_MS = 30_000;

export function voiceArrives(connectionId: string, workspaceId: string) {
  arrival = { connectionId, workspaceId, at: Date.now() };
}

/** Whether voice chat just went to this workspace; asked once. */
export function takeVoiceArrival(
  connectionId: string,
  workspaceId: string,
): boolean {
  const taken = arrival;
  if (
    !taken ||
    taken.connectionId !== connectionId ||
    taken.workspaceId !== workspaceId ||
    Date.now() - taken.at > ARRIVAL_MS
  )
    return false;
  arrival = null;
  return true;
}
