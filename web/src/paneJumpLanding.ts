import { useCallback, useEffect, useRef } from "react";

/**
 * Find keeps the current pane or workspace listed for context, but going to
 * it does nothing, so its selection lands on the first entry a jump can
 * reach. Only the landing skips it: once the user moves the selection, with
 * keys or the pointer, it stays where they put it, the current entry
 * included, while the list changes under it (statuses, the agents of other
 * servers, what needs the user moving to the top).
 */
export function usePaneJumpLanding(
  searching: boolean,
  entries: readonly { current?: boolean }[],
  indexRef: { readonly current: number },
  select: (index: number) => void,
) {
  const landingRef = useRef(true);
  useEffect(() => {
    if (!searching) {
      landingRef.current = true;
      return;
    }
    if (!landingRef.current || !entries[indexRef.current]?.current) return;
    const target = entries.findIndex((entry) => !entry.current);
    if (target >= 0) select(target);
  }, [searching, entries, indexRef, select]);
  /** A new search put the selection back at the top: it lands again. */
  const land = useCallback(() => {
    landingRef.current = true;
  }, []);
  /** The user moved the selection. */
  const moved = useCallback(() => {
    landingRef.current = false;
  }, []);
  return { land, moved };
}
