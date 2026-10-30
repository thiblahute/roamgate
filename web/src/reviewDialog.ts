/**
 * The review overlay's role. A pinned review stays mounted while hidden: it
 * is a dialog only while shown, else the page would count it as an open
 * dialog for good (a newer build waits for dialogs to close before it
 * reloads the page).
 */
export function reviewDialogRole(hidden: boolean): "dialog" | undefined {
  return hidden ? undefined : "dialog";
}
