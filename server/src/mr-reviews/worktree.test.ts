import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MrItem } from "../../../shared/mrReviews";
import { DEFAULT_MR_REVIEWS_SETTINGS } from "../../../shared/mrReviews";
import {
  clonesScript,
  createCloneFinder,
  matchClones,
  type MrConnection,
  parseClones,
} from "./clones";
import { createMrOpener } from "./open";
import { openMrStore } from "./store";
import {
  checkoutScript,
  ensureWorktreeScript,
  fetchScript,
  parseCheckout,
  parseFetch,
  reviewWorktreePath,
} from "./worktree";

let dir = "";
const sh = (script: string, cwd = dir) => {
  const run = Bun.spawnSync(["sh", "-c", script], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.org",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.org",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return {
    code: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
};
let heads: Record<number, string> = {};

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mr-wt-")));
  // The "forge": a bare repository with merge request refs.
  const setup = sh(`
    set -e
    git init -q -b main forge-src && cd forge-src
    git config user.email t@example.org && git config user.name T
    echo base > a.txt && git add a.txt && git commit -qm base
    git checkout -qb mr1 && echo one > b.txt && git add b.txt && git commit -qm one
    git checkout -q main && git checkout -qb mr2 && echo two > c.txt && git add c.txt && git commit -qm two
    git checkout -q main
    cd .. && git clone -q --bare forge-src forge.git
    cd forge.git
    git update-ref refs/merge-requests/1/head $(git rev-parse mr1)
    git update-ref refs/merge-requests/2/head $(git rev-parse mr2)
    git branch -D mr1 mr2 >/dev/null
    cd .. && git clone -q --no-local forge.git clone
    git -C clone remote rename origin upstream
    git -C clone remote set-url upstream https://gitlab.example.org/group/app.git
    git -C clone config "url.$PWD/forge.git.insteadOf" https://gitlab.example.org/group/app.git
    git -C clone remote add mine git@gitlab.example.org:me/app.git
  `);
  if (setup.code) throw new Error(setup.stderr);
  heads = {
    1: sh(
      "git -C forge.git rev-parse refs/merge-requests/1/head",
    ).stdout.trim(),
    2: sh(
      "git -C forge.git rev-parse refs/merge-requests/2/head",
    ).stdout.trim(),
  };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("review worktree scripts", () => {
  test("worktree, prefetch, detached checkout, local changes", () => {
    const clone = join(dir, "clone");
    const wt = reviewWorktreePath(clone);
    expect(wt).toBe(`${clone}.worktrees/review`);
    expect(
      sh(ensureWorktreeScript(clone, wt, "upstream/main")).stdout.trim(),
    ).toBe("CREATED");
    expect(
      sh(ensureWorktreeScript(clone, wt, "upstream/main")).stdout.trim(),
    ).toBe("EXISTS");
    const fetched = parseFetch(
      sh(
        fetchScript(clone, "upstream", "gitlab", [
          { number: 1, headSha: heads[1]! },
          { number: 2, headSha: heads[2]! },
          { number: 9, headSha: "f".repeat(40) },
        ]),
      ).stdout,
    );
    expect(fetched.fetched.sort()).toEqual([1, 2]);
    expect(fetched.missing).toEqual([9]);
    // Prefetched: the next time is no fetch at all.
    expect(
      parseFetch(
        sh(
          fetchScript(clone, "upstream", "gitlab", [
            { number: 1, headSha: heads[1]! },
          ]),
        ).stdout,
      ).have,
    ).toEqual([1]);
    let result = parseCheckout(
      sh(checkoutScript(wt, heads[1]!, "refuse", "1")),
    );
    expect(result).toEqual({ state: "done", head: heads[1] });
    expect(sh(`git -C ${wt} symbolic-ref -q HEAD`).code).not.toBe(0);
    // Local changes: refused, kept on a branch, or dropped on request.
    writeFileSync(join(wt, "b.txt"), "edited\n");
    writeFileSync(join(wt, "new.txt"), "untracked\n");
    expect(
      parseCheckout(sh(checkoutScript(wt, heads[2]!, "refuse", "1"))),
    ).toEqual({
      state: "dirty",
    });
    expect(readFileSync(join(wt, "b.txt"), "utf8")).toBe("edited\n");
    result = parseCheckout(sh(checkoutScript(wt, heads[2]!, "wip", "1")));
    expect(result).toMatchObject({
      state: "done",
      head: heads[2],
      kept: "review/1",
    });
    expect(sh(`git -C ${clone} show review/1:b.txt`).stdout).toBe("edited\n");
    expect(sh(`git -C ${clone} show review/1:new.txt`).stdout).toBe(
      "untracked\n",
    );
    expect(existsSync(join(wt, "new.txt"))).toBe(false);
    // A second WIP of the same request gets another branch.
    writeFileSync(join(wt, "c.txt"), "again\n");
    result = parseCheckout(sh(checkoutScript(wt, heads[1]!, "wip", "1")));
    expect(result.state).toBe("done");
    expect((result as { kept: string }).kept).toMatch(
      /^review\/1-\d{8}-\d{6}$/,
    );
    writeFileSync(join(wt, "a.txt"), "drop me\n");
    result = parseCheckout(sh(checkoutScript(wt, heads[2]!, "discard", "1")));
    expect(result).toMatchObject({ state: "done", discarded: true });
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("base\n");
    // A head that is not there says so.
    expect(
      parseCheckout(sh(checkoutScript(wt, "e".repeat(40), "refuse", "1"))),
    ).toEqual({
      state: "missing",
    });
  });

  test("clones: the main checkout and the remote that is the project", () => {
    const clone = join(dir, "clone");
    const scanned = parseClones(
      sh(clonesScript([clone, `${clone}.worktrees/review`, "/nonexistent"]))
        .stdout,
    );
    expect(scanned.map((repo) => repo.path)).toEqual([clone]);
    const ref = {
      host: "gitlab.example.org",
      project: "group/app",
      provider: "gitlab" as const,
    };
    const again = parseClones(sh(clonesScript([clone])).stdout);
    expect(matchClones("local", again, ref)).toEqual([
      { connectionId: "local", path: clone, remote: "upstream" },
    ]);
    expect(
      matchClones("local", again, { ...ref, project: "group/other" }),
    ).toEqual([]);
  });
});

describe("opening a request", () => {
  test("worktree, workspace, review, checkout; asks for a clone when none", async () => {
    const clone = join(dir, "clone");
    const herdrCalls: [string, unknown][] = [];
    const connection: MrConnection = {
      id: "local",
      label: "Local",
      run: async (script) => sh(script),
      dirs: async () => [clone],
      herdr: async (method, params) => {
        herdrCalls.push([method, params]);
        if (method === "workspace.list") return { workspaces: [] };
        if (method === "workspace.create")
          return { workspace: { workspace_id: "w9" } };
        return {};
      },
    };
    const item = (number: number, project = "group/app"): MrItem => ({
      provider: "gitlab",
      host: "gitlab.example.org",
      project,
      number,
      key: `gitlab:gitlab.example.org/${project}#${number}`,
      url: `https://gitlab.example.org/${project}/-/merge_requests/${number}`,
      title: `MR ${number}`,
      author: "a",
      draft: false,
      state: "open",
      updatedAt: "2026-11-04T00:00:00Z",
      headSha: heads[number] ?? "f".repeat(40),
      sourceBranch: "x",
      targetBranch: "main",
      pipeline: null,
      notes: 0,
      reasons: ["review_requested"],
    });
    const items = [item(1), item(2), item(3, "group/elsewhere")];
    const storeDir = mkdtempSync(join(tmpdir(), "mr-open-"));
    const store = openMrStore(join(storeDir, "state.json"));
    const opened: unknown[] = [];
    const fresh = createMrOpener({
      inbox: {
        item: (key: string) => items.find((each) => each.key === key),
        markSeen: () => true,
      } as any,
      store,
      settings: async () => DEFAULT_MR_REVIEWS_SETTINGS,
      saveClone: async () => {},
      connections: () => [connection],
      clones: createCloneFinder(),
      openReview: (params) => {
        opened.push(params);
        return { session: { id: `s-${opened.length}` } } as any;
      },
    });
    const result = await fresh.open(items[1]!.key);
    if ("needClone" in result) throw new Error("no clone");
    expect(result.workspaceId).toBe("w9");
    expect(result.worktree).toBe(`${clone}.worktrees/review`);
    expect(result.checkout).toMatchObject({ state: "done", head: heads[2] });
    expect(
      herdrCalls.find(([method]) => method === "workspace.create")?.[1],
    ).toEqual({
      cwd: `${clone}.worktrees/review`,
      label: "Reviews · app",
      focus: false,
    });
    expect(opened.at(-1)).toMatchObject({
      connectionId: "local",
      workspaceId: "w9",
      root: `${clone}.worktrees/review`,
      url: items[1]!.url,
    });
    expect(store.get().reviews[items[1]!.key]).toMatchObject({
      sessionId: "s-1",
    });
    // Another project without a clone: the user is asked.
    const other = await fresh.open(items[2]!.key);
    expect("needClone" in other && other.needClone.project).toBe(
      "group/elsewhere",
    );
    rmSync(storeDir, { recursive: true, force: true });
  });
});
