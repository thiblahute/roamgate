import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AreaRender, HistoryArea } from "./area";
import { HistoryRepo, ownedBy } from "./repo";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-history-"));
  dirs.push(dir);
  return new HistoryRepo({ dir: join(dir, "history"), host: "desk" });
}

/** An area whose render is whatever the test sets. */
function area(name: string, render: () => AreaRender): HistoryArea {
  return { name, render };
}

async function git(history: HistoryRepo, ...args: string[]) {
  const result = await history.run(args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

test("a new repo has FORMAT and README.md, committed by Roamgate", async () => {
  const history = repo();
  await history.ensure();
  expect(readFileSync(join(history.dir, "FORMAT"), "utf8")).toBe("1\n");
  expect(existsSync(join(history.dir, "README.md"))).toBe(true);
  expect(await git(history, "log", "--format=%an <%ae>|%cn|%B")).toBe(
    "Roamgate <roamgate@desk>|Roamgate|Start the Roamgate history\n\nRoamgate-Host: desk",
  );
  // Again: nothing new.
  await history.ensure();
  expect(await git(history, "rev-list", "--count", "HEAD")).toBe("1");
});

test("a newer layout is refused", async () => {
  const history = repo();
  await history.ensure();
  writeFileSync(join(history.dir, "FORMAT"), "2\n");
  await expect(history.ensure()).rejects.toThrow(/format 2/);
});

test("a pass writes what changed, removes what is gone, and commits once", async () => {
  const history = repo();
  let files = new Map<string, string>([
    ["notes/a.json", "{}\n"],
    ["notes/b.json", "[]\n"],
  ]);
  const notes = area("notes", () => ({ files, owns: ["notes/"] }));
  notes.describe = (changed) => `${changed.length} notes`;
  let result = await history.pass({ areas: [{ area: notes, ids: null }] });
  expect(result).toMatchObject({ commits: 1, blocked: [], errors: [] });
  expect(await git(history, "log", "-1", "--format=%s%n%b")).toBe(
    "notes: 2 notes\n- notes/a.json\n- notes/b.json\n\nRoamgate-Host: desk",
  );
  // The same files: no commit.
  result = await history.pass({ areas: [{ area: notes, ids: null }] });
  expect(result.commits).toBe(0);
  files = new Map([["notes/a.json", '{"x":1}\n']]);
  result = await history.pass({ areas: [{ area: notes, ids: null }] });
  expect(result.commits).toBe(1);
  expect(existsSync(join(history.dir, "notes", "b.json"))).toBe(false);
  expect(await git(history, "show", "--name-status", "--format=", "HEAD")).toBe(
    "M\tnotes/a.json\nD\tnotes/b.json",
  );
  const status = await history.status();
  expect(status).toMatchObject({
    exists: true,
    commits: 3,
    files: { notes: 1, FORMAT: 1, "README.md": 1 },
    lastPass: { commits: 1 },
  });
  expect(status.lastCommit?.author).toBe("Roamgate");
  expect(status.sizeBytes).toBeGreaterThan(0);
});

test("a render owns only its paths; `*` stands for any directory", async () => {
  const history = repo();
  const all = area("r", () => ({
    files: new Map([
      ["r/2025/s1/a.md", "a\n"],
      ["r/2026/s2/b.md", "b\n"],
      ["r/images/x.png", "png"],
    ]),
    owns: ["r/"],
  }));
  await history.pass({ areas: [{ area: all, ids: null }] });
  const one = area("r", () => ({ files: new Map(), owns: ["r/*/s1/"] }));
  await history.pass({ areas: [{ area: one, ids: new Set(["s1"]) }] });
  expect(await git(history, "ls-files", "r")).toBe(
    "r/2026/s2/b.md\nr/images/x.png",
  );
  expect(ownedBy("r/*/s1/", "r/2025/s1/a.md")).toBe(true);
  expect(ownedBy("r/*/s1/", "r/2025/s10/a.md")).toBe(false);
  expect(ownedBy("a.json", "a.json")).toBe(true);
  expect(ownedBy("a.json", "a.jsonx")).toBe(false);
});

test("a secret keeps its file out of the commit, named in the status", async () => {
  const history = repo();
  const notes = area("notes", () => ({
    files: new Map([
      ["notes/clean.md", "nothing here\n"],
      ["notes/leak.md", "line one\nmy token glpat-abcdefghijklmnopqrst\n"],
    ]),
    owns: ["notes/"],
  }));
  const result = await history.pass({ areas: [{ area: notes, ids: null }] });
  expect(result.commits).toBe(1);
  expect(result.blocked).toEqual([
    { file: "notes/leak.md", line: 2, kind: "glpat-... token" },
  ]);
  expect(await git(history, "ls-files", "notes")).toBe("notes/clean.md");
  expect(await git(history, "log", "--all", "-p")).not.toContain("glpat-");
  expect((await history.status()).blocked).toHaveLength(1);
  // Still there next time, still out.
  const again = await history.pass({ areas: [{ area: notes, ids: null }] });
  expect(again).toMatchObject({ commits: 0 });
  expect(again.blocked).toHaveLength(1);
});

test("Work changes are one commit each, by their author, at their time", async () => {
  const history = repo();
  const path = "work/items/i1.md";
  const result = await history.pass({
    areas: [],
    work: [
      {
        path,
        content: "one\n",
        author: { name: "me", email: "me@desk" },
        date: "2026-11-20T10:00:00.000Z",
        subject: "work i1: state open",
      },
      {
        path,
        content: "two\n",
        author: { name: "Claude (desktop/w1:p1)", email: "agent@desk" },
        date: "2026-11-21T11:30:00.000Z",
        subject: "work i1: state doing",
        body: "By Claude at desktop/w1:p1.",
      },
      // Nothing changed: no commit.
      {
        path,
        content: "two\n",
        author: { name: "me", email: "me@desk" },
        date: "2026-11-21T12:00:00.000Z",
        subject: "work i1: updated",
      },
      {
        path,
        content: null,
        author: { name: "me", email: "me@desk" },
        date: "2026-11-22T09:00:00.000Z",
        subject: "work i1: removed",
      },
    ],
  });
  expect(result).toMatchObject({ commits: 3, errors: [] });
  expect(
    await git(history, "log", "--format=%an|%ae|%aI|%cn|%s", "--", path),
  ).toBe(
    [
      "me|me@desk|2026-11-22T09:00:00Z|Roamgate|work i1: removed",
      "Claude (desktop/w1:p1)|agent@desk|2026-11-21T11:30:00Z|Roamgate|work i1: state doing",
      "me|me@desk|2026-11-20T10:00:00Z|Roamgate|work i1: state open",
    ].join("\n"),
  );
  expect(await git(history, "log", "-1", "--skip=1", "--format=%b")).toBe(
    "By Claude at desktop/w1:p1.\n\nRoamgate-Host: desk",
  );
});

test("one pass at a time, across processes", async () => {
  const history = repo();
  await history.ensure();
  const lock = join(history.dir, ".git", "roamgate-pass.lock");
  mkdirSync(lock);
  const notes = area("notes", () => ({
    files: new Map([["n.json", "1\n"]]),
    owns: ["n.json"],
  }));
  expect(
    await history.pass({ areas: [{ area: notes, ids: null }] }),
  ).toMatchObject({
    locked: true,
    commits: 0,
  });
  rmSync(lock, { recursive: true });
  expect(
    (await history.pass({ areas: [{ area: notes, ids: null }] })).commits,
  ).toBe(1);
});

test("an area that fails is reported; the others are committed", async () => {
  const history = repo();
  const broken = area("broken", () => {
    throw new Error("cannot read");
  });
  const fine = area("fine", () => ({
    files: new Map([["fine.json", "1\n"]]),
    owns: ["fine.json"],
  }));
  const result = await history.pass({
    areas: [
      { area: broken, ids: null },
      { area: fine, ids: null },
    ],
  });
  expect(result.commits).toBe(1);
  expect(result.errors).toMatchObject([
    { area: "broken", message: "cannot read" },
  ]);
  expect((await history.status()).errors).toHaveLength(1);
});

test("the user's git config does not sign, hook or author", async () => {
  const history = repo();
  const home = mkdtempSync(join(tmpdir(), "roamgate-history-home-"));
  dirs.push(home);
  writeFileSync(
    join(home, ".gitconfig"),
    "[user]\n\tname = Someone\n\temail = someone@example.org\n[commit]\n\tgpgsign = true\n",
  );
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    await history.ensure();
    expect(await git(history, "log", "-1", "--format=%an|%cn")).toBe(
      "Roamgate|Roamgate",
    );
  } finally {
    process.env.HOME = saved;
  }
});
