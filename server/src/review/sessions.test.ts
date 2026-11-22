import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewService, type ReviewService } from "./service";
import { openReviewStorage } from "./storage";

const directories: string[] = [];
const services: ReviewService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("listing many reviews looks through each one's checkout alone", async () => {
  // 2,500 checkouts with a rendered file and a branch each: a scan of every
  // review for each one (25 million checks) took about half a second;
  // through the reviews of its checkout, a few milliseconds.
  const dir = mkdtempSync(join(tmpdir(), "roamgate-sessions-"));
  directories.push(dir);
  const seed = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  const rendered = seed.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "rendered", path: "plan.md" },
  }).session;
  const code = seed.open({
    connectionId: "local",
    root: "/repo",
    target: { kind: "range", base: "main", head: "topic" },
  }).session;
  const thread = await seed.addThread({
    sessionId: rendered.id,
    anchor: { path: "plan.md", line: 3, side: "new", text: "line 3" },
    text: "On the plan",
  });
  seed.close();
  const storage = openReviewStorage(dir);
  const checkouts = 2_500;
  const id = (n: number, kind: number) =>
    (n * 2 + kind + 1).toString(16).padStart(16, "0");
  for (let n = 0; n < checkouts; n++) {
    const root = `/repo/${n}`;
    storage.saveSession({ ...rendered, id: id(n, 0), root });
    storage.saveSession({ ...code, id: id(n, 1), root });
    storage.saveThread({
      ...thread,
      id: `thread-${n}`,
      sessionId: id(n, 0),
    });
  }
  storage.close();
  const service = createReviewService({
    storage: openReviewStorage(dir),
    publish: () => {},
    loadDiff: async () => ({ files: [], truncated: false }),
  });
  services.push(service);
  service.list();
  const started = performance.now();
  const listed = service.list();
  const took = performance.now() - started;
  expect(listed).toHaveLength(checkouts * 2 + 2);
  for (const { session, shared } of listed) {
    const expected =
      session.target.kind === "range"
        ? [
            session.id === code.id
              ? thread.id
              : `thread-${session.root.slice(6)}`,
          ]
        : undefined;
    expect(shared?.map((each) => each.id)).toEqual(expected);
  }
  expect(took).toBeLessThan(150);
  // A review gone is gone from its checkout's too.
  service.remove({ sessionId: rendered.id });
  expect(service.get({ sessionId: code.id }).shared).toBeUndefined();
});
