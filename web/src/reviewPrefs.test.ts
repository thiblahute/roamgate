import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  PREFS_KEY,
  readReviewPrefs,
  reviewSplitDefault,
  SPLIT_MIN_WIDTH,
  writeReviewPrefs,
} from "./reviewPrefs";

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

test("no preferences stored read as none", () => {
  expect(readReviewPrefs()).toEqual({});
});

test("a write keeps the other preferences", () => {
  writeReviewPrefs({ split: true });
  writeReviewPrefs({ filesHidden: true });
  expect(readReviewPrefs()).toEqual({
    split: true,
    filesHidden: true,
  });
  expect(JSON.parse(values.get(`roamgate:${PREFS_KEY}`)!)).toEqual({
    split: true,
    filesHidden: true,
  });
  writeReviewPrefs({ split: false });
  expect(readReviewPrefs().split).toBe(false);
});

test("damaged preferences read as none, and are written anew", () => {
  for (const damaged of ["{not json", "null", "42", '"text"']) {
    values.set(`roamgate:${PREFS_KEY}`, damaged);
    expect(readReviewPrefs()).toEqual({});
  }
  values.set(`roamgate:${PREFS_KEY}`, "null");
  writeReviewPrefs({ filesHidden: true });
  expect(readReviewPrefs()).toEqual({ filesHidden: true });
});

test("a storage that throws loses the write, not the review", () => {
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
  expect(readReviewPrefs()).toEqual({});
  expect(() => writeReviewPrefs({ split: true })).not.toThrow();
});

test("side by side as chosen, else from a wide enough window", () => {
  expect(reviewSplitDefault({ split: true }, 400)).toBe(true);
  expect(reviewSplitDefault({ split: false }, 4000)).toBe(false);
  expect(reviewSplitDefault({}, SPLIT_MIN_WIDTH)).toBe(true);
  expect(reviewSplitDefault({}, SPLIT_MIN_WIDTH - 1)).toBe(false);
  // No window (a server render): unified.
  expect(reviewSplitDefault({}, undefined)).toBe(false);
});
