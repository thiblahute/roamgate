import { roamgateLocalStorage } from "./browserStorage";

/**
 * Which list the phone's workspace sheet shows, All (the tree) or Recent,
 * remembered for this browser: the sheet opens again on the last one.
 */
const KEY = "workspaceSheetView.v1";

/** True when the sheet last showed every workspace (the tree). */
export function readWorkspaceSheetAll(): boolean {
  try {
    return roamgateLocalStorage.getItem(KEY) === "all";
  } catch {
    return false;
  }
}

export function saveWorkspaceSheetAll(all: boolean) {
  try {
    roamgateLocalStorage.setItem(KEY, all ? "all" : "recent");
  } catch {
    // Storage full or blocked: the choice lasts for this page only.
  }
}
