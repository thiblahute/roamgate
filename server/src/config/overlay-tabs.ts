import { readGuiSettings } from "./gui-settings";

/**
 * Tab ids a connection shows as overlay tabs, from the interface setting the
 * frontend owns (`ui.overlayTabs`, see web/src/overlayTabs.ts). Ranger leaves
 * them out of its lists like every Roamgate view does. A malformed value
 * hides nothing.
 */
export function overlayTabIdsIn(
  ui: Record<string, unknown>,
  connectionId: string,
): Set<string> {
  const value = ui.overlayTabs as
    | { version?: unknown; connections?: unknown }
    | undefined;
  if (!value || value.version !== 1) return new Set();
  const connections = value.connections;
  if (!connections || typeof connections !== "object") return new Set();
  const marks = (connections as Record<string, unknown>)[connectionId];
  if (!marks || typeof marks !== "object" || Array.isArray(marks))
    return new Set();
  return new Set(
    Object.values(marks as Record<string, unknown>).filter(
      (tabId): tabId is string => typeof tabId === "string" && tabId !== "",
    ),
  );
}

export async function overlayTabIds(
  connectionId: string,
): Promise<Set<string>> {
  try {
    return overlayTabIdsIn((await readGuiSettings()).ui, connectionId);
  } catch {
    return new Set();
  }
}
