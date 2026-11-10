import { parseOverlayShown, withOverlayShown } from "./overlayTabs";

/**
 * Whether the workspace inspector (Files, Changes, Commits, History) was
 * left shown, per browser, connection and workspace: showing it in one
 * workspace shows it there only, and switching back brings it back as it
 * was. Its view, dock and Zen are the checkout's (readInspectorPreferences).
 * Kept in localStorage, in the overlay's shape (parseOverlayShown).
 */
export const INSPECTOR_SHOWN_STORAGE_KEY = "inspectorShown.v1";

type ShownStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function readShown(storage: Pick<Storage, "getItem">) {
  try {
    const raw = storage.getItem(INSPECTOR_SHOWN_STORAGE_KEY);
    return raw ? parseOverlayShown(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** Whether this browser last left the workspace's inspector shown. */
export function inspectorWasShown(
  storage: Pick<Storage, "getItem">,
  connectionId: string,
  workspaceId: string,
): boolean {
  return readShown(storage)[connectionId]?.includes(workspaceId) ?? false;
}

export function rememberInspectorShown(
  storage: ShownStorage,
  connectionId: string,
  workspaceId: string,
  shown: boolean,
): void {
  const spaces = readShown(storage);
  if ((spaces[connectionId]?.includes(workspaceId) ?? false) === shown) return;
  try {
    const next = withOverlayShown(spaces, connectionId, workspaceId, shown);
    if (Object.keys(next).length === 0)
      storage.removeItem(INSPECTOR_SHOWN_STORAGE_KEY);
    else
      storage.setItem(
        INSPECTOR_SHOWN_STORAGE_KEY,
        JSON.stringify({ version: 1, connections: next }),
      );
  } catch {
    // The inspector still works; switching back just finds it hidden.
  }
}
