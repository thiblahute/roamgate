import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  PLACE_KEY,
  PLACES_KEPT,
  readReviewPlace,
  writeReviewPlace,
} from "./reviewPlace";

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("a place comes back whole: view, commit, line on both sides, offset", () => {
  const place = {
    commit: "abc123",
    subject: "Fix it",
    index: 1,
    count: 3,
    path: "src/a.ts",
    old: 11,
    new: 12,
    offset: 240,
  };
  writeReviewPlace("s1", place);
  expect(readReviewPlace("s1")).toEqual(place);
  // All changes, no line yet.
  writeReviewPlace("s2", { commit: null });
  expect(readReviewPlace("s2")).toEqual({ commit: null });
  expect(readReviewPlace("s3")).toBeNull();
});

test("writing a place again replaces it and makes it the latest", () => {
  writeReviewPlace("s1", { commit: "a" });
  writeReviewPlace("s2", { commit: "b" });
  writeReviewPlace("s1", { commit: "c" });
  expect(Object.keys(JSON.parse(values.get(`roamgate:${PLACE_KEY}`)!))).toEqual(
    ["s2", "s1"],
  );
  expect(readReviewPlace("s1")).toEqual({ commit: "c" });
});

test(`only the ${PLACES_KEPT} reviews last moved in keep their place`, () => {
  for (let i = 0; i <= PLACES_KEPT; i++)
    writeReviewPlace(`s${i}`, { commit: null, path: `f${i}` });
  const kept = Object.keys(JSON.parse(values.get(`roamgate:${PLACE_KEY}`)!));
  expect(kept).toHaveLength(PLACES_KEPT);
  expect(readReviewPlace("s0")).toBeNull();
  expect(readReviewPlace("s1")?.path).toBe("f1");
  expect(readReviewPlace(`s${PLACES_KEPT}`)?.path).toBe(`f${PLACES_KEPT}`);
});

test("damaged storage reads as no place, and is written anew", () => {
  for (const damaged of ["{oops", "null", "7"]) {
    values.set(`roamgate:${PLACE_KEY}`, damaged);
    expect(readReviewPlace("s1")).toBeNull();
  }
  values.set(
    `roamgate:${PLACE_KEY}`,
    JSON.stringify({ s1: "not a place", s2: null }),
  );
  expect(readReviewPlace("s1")).toBeNull();
  expect(readReviewPlace("s2")).toBeNull();
  values.set(`roamgate:${PLACE_KEY}`, "{oops");
  writeReviewPlace("s1", { commit: null });
  expect(readReviewPlace("s1")).toEqual({ commit: null });
});

test("a storage that throws loses the place, not the review", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    },
  });
  expect(readReviewPlace("s1")).toBeNull();
  expect(() => writeReviewPlace("s1", { commit: null })).not.toThrow();
});
