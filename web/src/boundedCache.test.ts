import { expect, test } from "bun:test";
import { BoundedCache } from "./boundedCache";

test("past its size the least recently used entry goes first", () => {
  const cache = new BoundedCache<string, number>({ max: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  // Reading a makes b the oldest.
  expect(cache.get("a")).toBe(1);
  cache.set("c", 3);
  expect(cache.size).toBe(2);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe(1);
  expect(cache.get("c")).toBe(3);
  // Writing a key again does not grow it.
  cache.set("c", 4);
  expect(cache.size).toBe(2);
  expect(cache.get("c")).toBe(4);
});

test("expired entries miss and are dropped by the next write", () => {
  let now = 0;
  const cache = new BoundedCache<string, number>({
    max: 10,
    ttlMs: 1000,
    now: () => now,
  });
  cache.set("a", 1);
  cache.set("b", 2);
  now = 999;
  expect(cache.get("a")).toBe(1);
  now = 1000;
  cache.set("c", 3);
  // Both a and b expired: the write dropped them without reading them.
  expect(cache.size).toBe(1);
  expect(cache.get("c")).toBe(3);
  now = 2500;
  expect(cache.get("c")).toBeUndefined();
  expect(cache.size).toBe(0);
});

test("clear and delete forget entries", () => {
  const cache = new BoundedCache<string, number>({ max: 3 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.delete("a");
  expect(cache.get("a")).toBeUndefined();
  cache.clear();
  expect(cache.size).toBe(0);
});
