import { afterEach, expect, jest, test } from "bun:test";
import { roamgateLocalStorage } from "./browserStorage";
import {
  keepPreviewTabPlace,
  parsePreviewTabPlace,
  PREVIEW_PLACES_KEPT,
  PREVIEW_PLACES_WRITE_MS,
  readPreviewTabPlace,
  resetPreviewTabPlacesForTests,
  type PreviewTabPlace,
} from "./previewPlaces";

const backing = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() {
      return backing.size;
    },
    key: (index: number) => [...backing.keys()][index] ?? null,
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => backing.set(key, String(value)),
    removeItem: (key: string) => backing.delete(key),
    clear: () => backing.clear(),
  },
});

const place = (scroll: number): PreviewTabPlace => ({
  history: { places: [{ path: "a.md", scroll }], at: 0 },
  cursor: "b:3",
  flipped: ["t1"],
  mode: "rendered",
  threadsOpen: false,
});

afterEach(() => {
  resetPreviewTabPlacesForTests();
  jest.useRealTimers();
});

test("a tab's place is read back as kept, per checkout", () => {
  keepPreviewTabPlace("c1", "a.md", place(120));
  expect(readPreviewTabPlace("c1", "a.md")).toEqual(place(120));
  expect(readPreviewTabPlace("c2", "a.md")).toBeNull();
});

test("written to localStorage a little after the last change, read back on a new page", () => {
  jest.useFakeTimers();
  keepPreviewTabPlace("c3", "a.md", place(10));
  keepPreviewTabPlace("c3", "a.md", place(20));
  jest.advanceTimersByTime(PREVIEW_PLACES_WRITE_MS - 1);
  resetPreviewTabPlacesForTests();
  expect(readPreviewTabPlace("c3", "a.md")).toBeNull();
  keepPreviewTabPlace("c3", "a.md", place(30));
  jest.advanceTimersByTime(PREVIEW_PLACES_WRITE_MS);
  resetPreviewTabPlacesForTests();
  expect(readPreviewTabPlace("c3", "a.md")?.history.places[0]?.scroll).toBe(30);
});

test("only the tabs left last are kept", () => {
  for (let index = 0; index <= PREVIEW_PLACES_KEPT; index++)
    keepPreviewTabPlace("c4", `f${index}.md`, place(index));
  expect(readPreviewTabPlace("c4", "f0.md")).toBeNull();
  expect(
    readPreviewTabPlace("c4", `f${PREVIEW_PLACES_KEPT}.md`),
  ).not.toBeNull();
});

test("what is not a place is not read back", () => {
  expect(parsePreviewTabPlace(null)).toBeNull();
  expect(parsePreviewTabPlace({ history: { places: [], at: 0 } })).toBeNull();
  expect(
    parsePreviewTabPlace({ history: { places: [{ path: "a" }], at: 0 } }),
  ).toBeNull();
  expect(
    parsePreviewTabPlace({
      history: { places: [{ path: "a", scroll: 1 }], at: 3 },
    }),
  ).toBeNull();
  roamgateLocalStorage.setItem("roamgate.previewPlaces.v1:c5", "not json");
  expect(readPreviewTabPlace("c5", "a.md")).toBeNull();
});

test("a frame URL kept by an older build is dropped, not shown doubled", () => {
  const kept = parsePreviewTabPlace({
    history: {
      places: [
        {
          path: "cancun/index.html",
          scroll: 40,
          frameUrl: "cancun/index.html",
        },
        { path: "cancun/index.html", scroll: 0, framePage: "day.html" },
      ],
      at: 0,
    },
    cursor: null,
    flipped: [],
    mode: "rendered",
    threadsOpen: false,
  });
  expect(kept?.history.places).toEqual([
    { path: "cancun/index.html", scroll: 40 },
    { path: "cancun/index.html", scroll: 0, framePage: "day.html" },
  ]);
});
