/*
 * Where the Files preview has been, as a browser's Back and Forward keep
 * it: the files a link opened in the viewer and the pages a page's frame
 * went to, each with the scroll it was left at. Pure; the preview keeps
 * one history per tab.
 */

export type PreviewPlace = {
  /** The file's path or the site's URL, as the preview's tab has it. */
  path: string;
  fragment?: string;
  /** In a page's frame: the page shown, as its script says it. */
  frameUrl?: string;
  /** How far down it was read, in CSS pixels. */
  scroll: number;
};

export type PreviewHistory = {
  places: readonly PreviewPlace[];
  at: number;
};

/** The history of a tab opened at `path`. */
export function startHistory(path: string): PreviewHistory {
  return { places: [{ path, scroll: 0 }], at: 0 };
}

export function samePlace(
  a: Pick<PreviewPlace, "path" | "fragment" | "frameUrl">,
  b: Pick<PreviewPlace, "path" | "fragment" | "frameUrl">,
): boolean {
  return (
    a.path === b.path &&
    (a.fragment ?? "") === (b.fragment ?? "") &&
    (a.frameUrl ?? "") === (b.frameUrl ?? "")
  );
}

/** The place shown now. */
export function currentPlace(history: PreviewHistory): PreviewPlace {
  return history.places[history.at]!;
}

/**
 * Gone to `place` from the one shown: it follows it, what was ahead is
 * dropped. Going where one already is changes nothing.
 */
export function pushPlace(
  history: PreviewHistory,
  place: Omit<PreviewPlace, "scroll">,
): PreviewHistory {
  if (samePlace(currentPlace(history), place)) return history;
  const places = [
    ...history.places.slice(0, history.at + 1),
    { ...place, scroll: 0 },
  ];
  return { places, at: places.length - 1 };
}

/** The place shown now was scrolled to `scroll`. */
export function keepScroll(
  history: PreviewHistory,
  scroll: number,
): PreviewHistory {
  const place = currentPlace(history);
  if (place.scroll === scroll) return history;
  const places = history.places.slice();
  places[history.at] = { ...place, scroll };
  return { ...history, places };
}

/** The frame's page is now `frameUrl`, without going anywhere new. */
export function settleFrame(
  history: PreviewHistory,
  frameUrl: string,
): PreviewHistory {
  const place = currentPlace(history);
  if (place.frameUrl === frameUrl) return history;
  const places = history.places.slice();
  places[history.at] = { ...place, frameUrl };
  return { ...history, places };
}

export function canStep(history: PreviewHistory, step: -1 | 1): boolean {
  const to = history.at + step;
  return to >= 0 && to < history.places.length;
}

/** Back (-1) or Forward (1): the history moved, and the place to show. */
export function stepHistory(
  history: PreviewHistory,
  step: -1 | 1,
): { history: PreviewHistory; place: PreviewPlace } | null {
  if (!canStep(history, step)) return null;
  const at = history.at + step;
  return { history: { ...history, at }, place: history.places[at]! };
}

/** Back or Forward's keys: Alt+Left / Alt+Right, Cmd+[ / Cmd+] on a Mac. */
export function historyKeyStep(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): -1 | 1 | 0 {
  if (event.shiftKey || event.ctrlKey) return 0;
  if (event.altKey && !event.metaKey) {
    if (event.key === "ArrowLeft") return -1;
    if (event.key === "ArrowRight") return 1;
  }
  if (event.metaKey && !event.altKey) {
    if (event.key === "[") return -1;
    if (event.key === "]") return 1;
  }
  return 0;
}
