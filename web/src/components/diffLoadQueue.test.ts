import { expect, test } from "bun:test";
import { createDiffLoadQueue } from "./diffLoadQueue";

test("bounds requests, prioritizes selections, and drops obsolete queued files", async () => {
  const queue = createDiffLoadQueue();
  const started: string[] = [];
  const release: Array<() => void> = [];
  let wanted = true;
  const request = (name: string, priority = false) =>
    queue.request(
      () => {
        started.push(name);
        return new Promise<{ diff: string }>((resolve) => {
          release.push(() => resolve({ diff: "patch" }));
        });
      },
      () => name !== "obsolete" || wanted,
      priority,
      name,
    );
  const first = request("first");
  const second = request("second");
  const obsolete = request("obsolete").catch((error: Error) => error.message);
  const nearby = request("nearby");
  wanted = false;
  const selected = request("selected");
  queue.prioritize("selected");
  expect(started).toEqual(["first", "second"]);
  expect(await obsolete).toBe("diff request retired");
  release.shift()!();
  await first;
  // Resolving a request pumps the next task after its promise reaction.
  await Promise.resolve();
  expect(started).toEqual(["first", "second", "selected"]);
  release.shift()!();
  await second;
  await Promise.resolve();
  expect(started).toEqual(["first", "second", "selected", "nearby"]);
  for (const resolve of release) resolve();
  await Promise.all([selected, nearby]);

  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 60 }, () =>
      queue.request(
        async () => {
          active += 1;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active -= 1;
          return { diff: "small" };
        },
        () => true,
      ),
    ),
  );
  expect(peak).toBeLessThanOrEqual(8);
});

test("files asked together go in batches of at most 16, two batches at once, whatever the per-file pace", async () => {
  const queue = createDiffLoadQueue();
  const runs: string[][] = [];
  const release: Array<() => void> = [];
  const batch = (name: string) => ({
    key: "review",
    item: name,
    run: (items: unknown[]) => {
      runs.push(items as string[]);
      return new Promise<Array<{ diff: string } | Error>>((resolve) => {
        release.push(() =>
          resolve(
            items.map((item) =>
              item === "bad" ? new Error("refused") : { diff: String(item) },
            ),
          ),
        );
      });
    },
  });
  // A slow single request first drops the per-file pace to one at a time.
  await queue.request(
    () =>
      new Promise<{ diff: string }>((resolve) =>
        setTimeout(() => resolve({ diff: "x".repeat(200_000) }), 0),
      ),
    () => true,
  );
  const names = ["bad", ...Array.from({ length: 39 }, (_, i) => `f${i}`)];
  const results = names.map((name) =>
    queue
      .requestBatched(batch(name), () => name !== "f38")
      .then(
        (file) => file.diff,
        (error: Error) => error.message,
      ),
  );
  const other = queue.requestBatched(
    { ...batch("other"), key: "another review" },
    () => true,
  );
  await Promise.resolve();
  // Two batches at once, the 16 first files and the next 16.
  expect(runs.map((each) => each.length)).toEqual([16, 16]);
  expect(runs[0]![0]).toBe("bad");
  release.shift()!();
  release.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The rest of this review's files (one retired), then the other review's.
  expect(runs.map((each) => each.length)).toEqual([16, 16, 7, 1]);
  expect(runs[3]).toEqual(["other"]);
  for (const resolve of release) resolve();
  await other;
  const answered = await Promise.all(results);
  expect(answered[0]).toBe("refused");
  expect(answered[1]).toBe("f0");
  expect(answered[39]).toBe("diff request retired");
});
