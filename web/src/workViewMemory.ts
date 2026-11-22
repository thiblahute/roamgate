import type { WorkItem, WorkState } from "../../shared/work";
import { roamgateSessionStorage } from "./browserStorage";
import type { WorkAddDraft } from "./workOpen";

/**
 * Where the Work board was left, for each workspace it was shown from:
 * hidden (its close button, Esc, Alt+W, a session opened) and shown again,
 * or the page reloaded, it comes back there. The scope, the folded
 * columns, their widths and the view's size are kept elsewhere, for good;
 * this is the page's session.
 */
export type WorkViewPlace = {
  query: string;
  selected: string | null;
  /** The item whose detail shows. */
  detail: string | null;
  /** The new item form. */
  adding: boolean;
  /** The chat's draft the form was started with. */
  draft: WorkAddDraft | null;
  /** An item added, its detail waiting for the board to have it. */
  watching: WorkItem | null;
  focusedColumn: WorkState | null;
  /** Scroll offsets: `${view}:${part}` (view: an item, "add" or "board"). */
  scroll: Record<string, number>;
};

const STORAGE_KEY = "workViewPlace";
/** The workspaces remembered, the latest last. */
const MAX_PLACES = 24;

type Places = Record<string, WorkViewPlace>;

function readPlaces(): Places {
  try {
    const value = JSON.parse(
      roamgateSessionStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Places)
      : {};
  } catch {
    return {};
  }
}

/** Where the board was left in this workspace (its scope key), if it was. */
export function readWorkViewPlace(workspace: string): WorkViewPlace | null {
  return readPlaces()[workspace] ?? null;
}

export function keepWorkViewPlace(workspace: string, place: WorkViewPlace) {
  const places = readPlaces();
  delete places[workspace];
  places[workspace] = place;
  const keys = Object.keys(places);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_PLACES)))
    delete places[key];
  try {
    roamgateSessionStorage.setItem(STORAGE_KEY, JSON.stringify(places));
  } catch {
    // Kept until the view closes only.
  }
}

/** The view a scroll offset belongs to. */
export function workScrollView(place: {
  detail: string | null;
  adding: boolean;
}): string {
  return place.detail ?? (place.adding ? "add" : "board");
}

/**
 * The part of the view a scrolled element is, for its offset: the view's
 * body (down), the columns (sideways), a column's list (down).
 */
export function workScrollPart(
  element: Element,
): { part: string; axis: "top" | "left" } | null {
  if (element.classList.contains("mr-reviews-body"))
    return { part: "body", axis: "top" };
  if (element.classList.contains("mr-reviews-board"))
    return { part: "board", axis: "left" };
  const column = element.parentElement?.getAttribute("data-work-column");
  if (column && element.classList.contains("assistant-task-list"))
    return { part: `column:${column}`, axis: "top" };
  return null;
}

/** The elements of a view whose offsets are kept. */
export function workScrollElements(root: Element): Element[] {
  return [
    ...root.querySelectorAll(
      ".mr-reviews-body, .mr-reviews-board, [data-work-column] > .assistant-task-list",
    ),
  ];
}
