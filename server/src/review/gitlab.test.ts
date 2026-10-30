import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDraftNote,
  findBranchMergeRequest,
  gitlabHostFor,
  type GlabContext,
  isSecurityProject,
  mergeRequestSource,
  onGitlabHost,
  parseCheckout,
  parseMergeRequestUrl,
  pickMergeRequest,
  readCheckout,
  readCheckoutScript,
  readMergeRequest,
  readMergeRequestDiff,
  readMergeRequestThreads,
  type ReviewCheckout,
  remoteProject,
  replyToDiscussion,
} from "./gitlab";
import { ReviewGoneError } from "../workspace/review-patch";

function fakeGlab(responses: Record<string, unknown>) {
  const calls: string[][] = [];
  const context: GlabContext = {
    root: "/repo",
    shQuote: (value) => `'${value}'`,
    runProcessWithCodeTimeout: async (argv) => {
      calls.push(argv);
      const path = argv.find((arg) => arg.startsWith("projects/"))!;
      const key = Object.keys(responses).find((pattern) =>
        path.includes(pattern),
      );
      if (!key) return { code: 1, stdout: "", stderr: `404 ${path}` };
      const value = responses[key];
      return {
        code: 0,
        stdout: typeof value === "string" ? value : JSON.stringify(value),
        stderr: "",
      };
    },
  };
  return { context, calls };
}

const url = "https://gitlab.example/gst/gstreamer/-/merge_requests/42";
const mrJson = {
  web_url: url,
  title: "cuda: fix",
  state: "opened",
  diff_refs: {
    base_sha: "b".repeat(40),
    start_sha: "s".repeat(40),
    head_sha: "h".repeat(40),
  },
};

test("merge request URLs and the security guard", () => {
  expect(parseMergeRequestUrl(`${url}/diffs#note_1`)).toEqual({
    host: "gitlab.example",
    project: "gst/gstreamer",
    iid: 42,
  });
  expect(
    parseMergeRequestUrl("https://gitlab.example/x/merge_requests/1"),
  ).toBeNull();
  expect(isSecurityProject("gstreamer/security")).toBe(true);
  expect(isSecurityProject("gst/gstreamer")).toBe(false);
});

test("threads: discussions without system notes, and every draft note", async () => {
  const { context, calls } = fakeGlab({
    "merge_requests/42/discussions": [
      {
        id: "abc1",
        notes: [
          {
            id: 1,
            body: "Why?",
            author: { username: "reviewer" },
            created_at: "2026-10-01",
            resolvable: true,
            resolved: false,
            position: {
              new_path: "a.c",
              new_line: 5,
              old_line: 4,
              head_sha: "x",
            },
          },
          { id: 2, system: true, body: "changed the description" },
        ],
      },
      { id: "def2", notes: [{ id: 3, system: true, body: "merged" }] },
    ],
    // Two pages back to back, as `glab api --paginate` prints them.
    "merge_requests/42/draft_notes": `[{"id":7,"note":"Leak","position":{"new_path":"a.c","new_line":9}}][{"id":8,"note":"Overall","position":null}]`,
    "merge_requests/42": mrJson,
  });
  const mr = await readMergeRequest(context, url);
  const threads = await readMergeRequestThreads(context, mr, "s1");
  expect(threads.map((t) => [t.id, t.kind, t.anchor])).toEqual([
    [
      "gl:abc1",
      "merge-request",
      { path: "a.c", line: 5, side: "new", contextOld: 4 },
    ],
    ["gldraft:7", "draft", { path: "a.c", line: 9, side: "new" }],
    ["gldraft:8", "draft", {}],
  ]);
  expect(threads[0]!.comments).toHaveLength(1);
  expect(threads[0]!.comments[0]!.author).toBe("@reviewer");
  expect(calls.every((argv) => argv.includes("--paginate"))).toBe(true);
});

test("a draft on an unchanged line carries both line numbers", async () => {
  const { context, calls } = fakeGlab({
    "merge_requests/42/draft_notes": { id: 9, note: "n", position: null },
    "merge_requests/42": mrJson,
  });
  const mr = await readMergeRequest(context, url);
  await createDraftNote(
    context,
    mr,
    { path: "a.c", line: 10, side: "new", contextOld: 8 },
    "Context comment",
  );
  const argv = calls.at(-1)!;
  expect(argv.slice(0, 7)).toEqual([
    "glab",
    "api",
    "--hostname",
    "gitlab.example",
    "--method",
    "POST",
    "projects/gst%2Fgstreamer/merge_requests/42/draft_notes",
  ]);
  const fields = argv.slice(7).filter((_, i) => i % 2 === 1);
  expect(fields).toContain("note=Context comment");
  expect(fields).toContain("position[new_line]=10");
  expect(fields).toContain("position[old_line]=8");
  expect(fields).toContain(`position[head_sha]=${"h".repeat(40)}`);
});

test("replies refuse odd discussion ids; the API diff is rebuilt", async () => {
  const { context } = fakeGlab({
    "merge_requests/42/diffs": [
      {
        old_path: "a.c",
        new_path: "a.c",
        diff: "@@ -1 +1 @@\n-x\n+y\n",
      },
      { old_path: "big.bin", new_path: "big.bin", too_large: true },
    ],
    "merge_requests/42": mrJson,
  });
  const mr = await readMergeRequest(context, url);
  await expect(
    replyToDiscussion(context, mr, "abc; rm -rf", "hi"),
  ).rejects.toThrow("invalid discussion id");
  const diff = await readMergeRequestDiff(context, mr);
  expect(diff.files.map((f) => [f.path, f.binary ?? false])).toEqual([
    ["a.c", false],
    ["big.bin", true],
  ]);
  expect(diff.headSha).toBe("h".repeat(40));
});

test("remote URLs: ssh, scp-like and https give a host and project", () => {
  expect(
    remoteProject("git@ssh.gitlab.freedesktop.org:thiblahute/gstreamer.git"),
  ).toEqual({
    host: "ssh.gitlab.freedesktop.org",
    project: "thiblahute/gstreamer",
  });
  expect(
    remoteProject("ssh://git@Gitlab.Example:2222/gst/sub/gstreamer.git/"),
  ).toEqual({
    host: "gitlab.example",
    project: "gst/sub/gstreamer",
  });
  expect(remoteProject("https://gitlab.example/gst/gstreamer")).toEqual({
    host: "gitlab.example",
    project: "gst/gstreamer",
  });
  expect(remoteProject("/srv/git/gstreamer.git")).toBeNull();
  expect(remoteProject("C:/src/gstreamer")).toBeNull();
  expect(remoteProject("host:~user/repo")).toBeNull();
  expect(onGitlabHost("ssh.gitlab.example", "gitlab.example")).toBe(true);
  expect(onGitlabHost("gitlab.example", "gitlab.example")).toBe(true);
  expect(onGitlabHost("github.com", "gitlab.example")).toBe(false);
});

const forkCheckout = (over: Partial<ReviewCheckout> = {}): ReviewCheckout => ({
  branch: "fix",
  head: "a1",
  defaultBranch: "main",
  remoteHeads: {},
  upstream: null,
  pushRemote: null,
  remotes: {
    origin: "https://gitlab.example/gst/gstreamer.git",
    fork: "git@ssh.gitlab.example:me/gstreamer.git",
  },
  gitlabHost: "gitlab.example",
  gitlabLogins: [],
  ...over,
});

test("the source is the upstream, else the branch on its push remote or origin", () => {
  expect(
    mergeRequestSource(
      forkCheckout({
        upstream: { remote: "fork", branch: "fix-v2" },
        pushRemote: "origin",
      }),
    ),
  ).toEqual({ remote: "fork", branch: "fix-v2" });
  expect(mergeRequestSource(forkCheckout({ pushRemote: "fork" }))).toEqual({
    remote: "fork",
    branch: "fix",
    byName: true,
  });
  expect(mergeRequestSource(forkCheckout())).toEqual({
    remote: "origin",
    branch: "fix",
    byName: true,
  });
  // Detached, or a default branch: no merge request to look for.
  expect(mergeRequestSource(forkCheckout({ branch: null }))).toBeNull();
  expect(mergeRequestSource(forkCheckout({ branch: "master" }))).toBeNull();
  expect(
    mergeRequestSource(
      forkCheckout({ branch: "devel", defaultBranch: "devel" }),
    ),
  ).toBeNull();
  // git checkout -b myfix origin/main: main is where it started, the merge
  // request is the branch's own name.
  expect(
    mergeRequestSource(
      forkCheckout({
        branch: "myfix",
        upstream: { remote: "origin", branch: "main" },
      }),
    ),
  ).toEqual({ remote: "origin", branch: "myfix", byName: true });
  expect(
    mergeRequestSource(
      forkCheckout({
        branch: "myfix",
        upstream: { remote: "fork", branch: "devel" },
        remoteHeads: { fork: "devel" },
        pushRemote: "fork",
      }),
    ),
  ).toEqual({ remote: "fork", branch: "myfix", byName: true });
  expect(
    mergeRequestSource(
      forkCheckout({
        branch: "myfix",
        upstream: { remote: "origin", branch: "devel" },
        remoteHeads: { fork: "devel" },
      }),
    ),
  ).toEqual({ remote: "origin", branch: "devel" });
});

test("the checkout script's answer is parsed", () => {
  const checkout = parseCheckout(
    [
      "branch fix",
      "head a1",
      "default origin/main",
      "remote fork",
      "merge refs/heads/fix-v2",
      "pushremote ",
      "pushdefault fork",
      "rhead refs/remotes/fork/HEAD refs/remotes/fork/devel",
      "rhead refs/remotes/origin/HEAD refs/remotes/origin/main",
      "glab https://gitlab.example/",
      "url origin https://gitlab.example/gst/gstreamer.git",
      "url fork git@ssh.gitlab.example:me/gstreamer.git",
      "login gitlab.example",
      "login Gitlab.Other",
    ].join("\n"),
  );
  expect(checkout).toEqual(
    forkCheckout({
      remoteHeads: { fork: "devel", origin: "main" },
      upstream: { remote: "fork", branch: "fix-v2" },
      pushRemote: "fork",
      gitlabLogins: ["gitlab.example", "gitlab.other"],
    }),
  );
  // A branch tracking another local branch has no remote source.
  expect(
    parseCheckout("branch fix\nremote .\nmerge refs/heads/main\nglab \n"),
  ).toMatchObject({ upstream: null, gitlabHost: null });
});

test("only an open merge request from the source project is picked", () => {
  const list = [
    {
      iid: 1,
      state: "opened",
      source_project_id: 9,
      web_url: "u1",
      title: "a",
    },
    {
      iid: 2,
      state: "merged",
      source_project_id: 7,
      web_url: "u2",
      title: "b",
    },
    {
      iid: 3,
      state: "opened",
      source_project_id: 7,
      web_url: "u3",
      title: "c",
    },
  ];
  expect(pickMergeRequest(list, 7)).toEqual({
    url: "u3",
    title: "c",
    number: 3,
    state: "opened",
  });
  expect(pickMergeRequest(list.slice(0, 2), 7)).toBeNull();
  expect(pickMergeRequest(null, 7)).toBeNull();
});

test("a branch's merge request: the open ones of its name, from its project", async () => {
  const calls: string[][] = [];
  const context: GlabContext = {
    root: "/repo",
    shQuote: (value) => `'${value}'`,
    runProcessWithCodeTimeout: async (argv) => {
      calls.push(argv);
      const path = argv.at(-1)!;
      const body = path.startsWith("projects/")
        ? { id: 7 }
        : [
            { iid: 3, state: "opened", source_project_id: 9, web_url: "x" },
            {
              iid: 10046,
              state: "opened",
              source_project_id: 7,
              web_url:
                "https://gitlab.example/gst/gstreamer/-/merge_requests/10046",
              title: "Fix",
            },
          ];
      return { code: 0, stdout: JSON.stringify(body), stderr: "" };
    },
  };
  const ids = new Map<string, number>();
  const checkout = forkCheckout({
    upstream: { remote: "fork", branch: "fix-v2" },
  });
  expect(await findBranchMergeRequest(context, checkout, ids)).toEqual({
    url: "https://gitlab.example/gst/gstreamer/-/merge_requests/10046",
    title: "Fix",
    number: 10046,
    state: "opened",
    branch: "fix",
  });
  expect(calls.map((argv) => argv.at(-1))).toEqual([
    "projects/me%2Fgstreamer",
    "merge_requests?scope=all&state=opened&source_branch=fix-v2&per_page=100&page=1",
  ]);
  for (const argv of calls) {
    expect(argv.slice(0, 6)).toEqual([
      "glab",
      "api",
      "--hostname",
      "gitlab.example",
      "--method",
      "GET",
    ]);
  }
  // The project's id is remembered: one call next time.
  await findBranchMergeRequest(context, checkout, ids);
  expect(calls).toHaveLength(3);
  // Another host than glab's, or no branch: GitLab is not asked.
  expect(
    await findBranchMergeRequest(
      context,
      forkCheckout({ gitlabHost: "gitlab.other" }),
      ids,
    ),
  ).toBeNull();
  expect(
    await findBranchMergeRequest(context, forkCheckout({ branch: null }), ids),
  ).toBeNull();
  expect(calls).toHaveLength(3);
});

test("a remote on another host glab is logged in to is asked there", async () => {
  expect(
    gitlabHostFor("ssh.gitlab.other", {
      gitlabHost: "gitlab.example",
      gitlabLogins: ["gitlab.other"],
    }),
  ).toBe("gitlab.other");
  expect(
    gitlabHostFor("ssh.gitlab.example", {
      gitlabHost: "gitlab.example",
      gitlabLogins: [],
    }),
  ).toBe("gitlab.example");
  expect(
    gitlabHostFor("github.com", { gitlabHost: null, gitlabLogins: [] }),
  ).toBeNull();

  const calls: string[][] = [];
  const tokens: (string | undefined)[] = [];
  const context: GlabContext = {
    root: "/repo",
    shQuote: (value) => `'${value}'`,
    runProcessWithCodeTimeout: async (argv, _timeout, options) => {
      calls.push(argv);
      tokens.push(options?.env?.GITLAB_TOKEN);
      const body = argv.at(-1)!.startsWith("projects/")
        ? { id: 7 }
        : [
            {
              iid: 4,
              state: "opened",
              source_project_id: 7,
              web_url: "https://gitlab.other/gst/gstreamer/-/merge_requests/4",
              title: "Fix",
            },
          ];
      return { code: 0, stdout: JSON.stringify(body), stderr: "" };
    },
  };
  const checkout = forkCheckout({
    remotes: { origin: "git@ssh.gitlab.other:me/gstreamer.git" },
    gitlabHost: "gitlab.com",
    gitlabLogins: ["gitlab.other"],
  });
  // A token in the environment is for glab's default host: not sent there.
  const saved = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = "default-host-token";
  try {
    expect(
      (await findBranchMergeRequest(context, checkout, new Map()))?.number,
    ).toBe(4);
  } finally {
    if (saved === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = saved;
  }
  expect(calls.map((argv) => argv[3])).toEqual([
    "gitlab.other",
    "gitlab.other",
  ]);
  expect(tokens).toEqual([undefined, undefined]);
});

test("the merge request list is read a page at a time, up to a few", async () => {
  const paths: string[] = [];
  const other = (iid: number) => ({
    iid,
    state: "opened",
    source_project_id: 9,
    web_url: `u${iid}`,
  });
  let pages: unknown[][] = [];
  const context: GlabContext = {
    root: "/repo",
    shQuote: (value) => `'${value}'`,
    runProcessWithCodeTimeout: async (argv) => {
      const path = argv.at(-1)!;
      paths.push(path);
      expect(argv).not.toContain("--paginate");
      const page = Number(/&page=(\d+)$/.exec(path)?.[1]);
      const body = path.startsWith("projects/") ? { id: 7 } : pages[page - 1];
      return { code: 0, stdout: JSON.stringify(body ?? []), stderr: "" };
    },
  };
  const full = Array.from({ length: 100 }, (_, i) => other(i));
  pages = [
    full,
    [...full.slice(1), { ...other(500), source_project_id: 7 }],
    full,
  ];
  const ids = new Map([["gitlab.example\ngst/gstreamer", 7]]);
  expect(
    (await findBranchMergeRequest(context, forkCheckout(), ids))?.number,
  ).toBe(500);
  expect(paths.map((path) => path.replace(/^.*&page=/, ""))).toEqual([
    "1",
    "2",
  ]);
  // A short page is the last; and five pages at most.
  paths.length = 0;
  // (The user's own are asked after, the same way: counted apart.)
  const projectPages = () =>
    paths.filter((path) => path.includes("scope=all")).length;
  pages = [full, full.slice(0, 3), full];
  expect(await findBranchMergeRequest(context, forkCheckout(), ids)).toBeNull();
  expect(projectPages()).toBe(2);
  paths.length = 0;
  pages = Array.from({ length: 8 }, () => full);
  expect(await findBranchMergeRequest(context, forkCheckout(), ids)).toBeNull();
  expect(projectPages()).toBe(5);
});

test("the checkout script applies insteadOf and never prints a token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-checkout-"));
  try {
    const bin = join(dir, "bin");
    const repo = join(dir, "repo");
    mkdirSync(bin);
    // A stand-in glab: a default host, a token of its own for gitlab.other
    // only, and GITLAB_TOKEN or a hostless token for any other host.
    writeFileSync(
      join(bin, "glab"),
      [
        "#!/bin/sh",
        'if [ "$3" = host ]; then echo https://gitlab.example; exit 0; fi',
        'if [ "$5" = gitlab.other ]; then echo s3cr3t-token; exit 0; fi',
        'echo "${GITLAB_TOKEN:-hostless-token}"',
      ].join("\n"),
    );
    chmodSync(join(bin, "glab"), 0o755);
    const git = (...argv: string[]) => {
      const result = Bun.spawnSync(["git", "-C", repo, ...argv]);
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    mkdirSync(repo);
    git("init", "-q", "-b", "myfix");
    git("config", "url.git@ssh.gitlab.other:.insteadOf", "other:");
    git("remote", "add", "fork", "other:me/gstreamer.git");
    git("remote", "add", "origin", "https://GitLab.Example/gst/gstreamer.git");
    git("remote", "add", "hub", "git@github.com:me/gstreamer.git");
    git("config", "branch.myfix.remote", "fork");
    git("config", "branch.myfix.merge", "refs/heads/myfix");
    const read = () => {
      const result = Bun.spawnSync(
        ["sh", "-c", readCheckoutScript(repo, (value) => `'${value}'`)],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            GITLAB_TOKEN: "env-token",
          },
        },
      );
      const stdout = result.stdout.toString();
      expect(result.exitCode).toBe(0);
      expect(stdout).not.toMatch(/s3cr3t|env-token|hostless/);
      return parseCheckout(stdout);
    };
    // Only the source remote is read.
    expect(read()).toMatchObject({
      branch: "myfix",
      upstream: { remote: "fork", branch: "myfix" },
      remotes: { fork: "git@ssh.gitlab.other:me/gstreamer.git" },
      gitlabHost: "gitlab.example",
      gitlabLogins: ["gitlab.other"],
    });
    // GITLAB_TOKEN or a hostless token is no login to github.com.
    git("config", "branch.myfix.remote", "hub");
    expect(read()).toMatchObject({
      remotes: { hub: "git@github.com:me/gstreamer.git" },
      gitlabLogins: [],
    });
    // Without an upstream: the push remote, else origin.
    git("config", "--unset", "branch.myfix.remote");
    expect(read()).toMatchObject({
      upstream: null,
      remotes: { origin: "https://GitLab.Example/gst/gstreamer.git" },
      gitlabLogins: [],
    });
    git("config", "remote.pushDefault", "fork");
    expect(read()).toMatchObject({
      pushRemote: "fork",
      remotes: { fork: "git@ssh.gitlab.other:me/gstreamer.git" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a branch started from origin/main finds the user's merge request from a fork", async () => {
  const asked: string[] = [];
  const context: GlabContext = {
    root: "/repo",
    shQuote: (value) => `'${value}'`,
    runProcessWithCodeTimeout: async (argv) => {
      const path = argv.at(-1)!;
      asked.push(path);
      const body = path.startsWith("projects/")
        ? { id: 1357 }
        : path.includes("scope=created_by_me")
          ? [
              // Someone else's project into another one: not this.
              {
                iid: 4,
                state: "opened",
                source_project_id: 5,
                project_id: 6,
                web_url: "y",
              },
              {
                iid: 12855,
                state: "opened",
                source_project_id: 1372,
                project_id: 1357,
                web_url:
                  "https://gitlab.example/gst/gstreamer/-/merge_requests/12855",
                title: "appsink",
              },
            ]
          : [];
      return { code: 0, stdout: JSON.stringify(body), stderr: "" };
    },
  };
  const checkout = forkCheckout({
    branch: "appsink-fix",
    upstream: { remote: "origin", branch: "main" },
  });
  expect(
    (await findBranchMergeRequest(context, checkout, new Map()))?.number,
  ).toBe(12855);
  expect(asked).toEqual([
    "projects/gst%2Fgstreamer",
    "merge_requests?scope=all&state=opened&source_branch=appsink-fix&per_page=100&page=1",
    "merge_requests?scope=created_by_me&state=opened&source_branch=appsink-fix&per_page=100&page=1",
  ]);
  // A tracked branch is never looked up by name among the user's own.
  asked.length = 0;
  await findBranchMergeRequest(
    context,
    forkCheckout({ upstream: { remote: "fork", branch: "fix-v2" } }),
    new Map(),
  );
  expect(asked.some((path) => path.includes("created_by_me"))).toBe(false);
});

test("a merge request's removed checkout reads from GitLab, from home", async () => {
  const root = mkdtempSync(join(tmpdir(), "roamgate-glab-"));
  rmSync(root, { recursive: true, force: true });
  const cwds: (string | undefined)[] = [];
  const commands: string[] = [];
  const reply = async (
    argv: string[],
    _timeout: number,
    options?: { cwd?: string },
  ) => {
    cwds.push(options?.cwd);
    commands.push(argv.at(-1)!);
    return { code: 0, stdout: JSON.stringify(mrJson), stderr: "" };
  };
  const local: GlabContext = {
    root,
    shQuote: (value) => `'${value}'`,
    runProcessWithCodeTimeout: reply,
  };
  expect((await readMergeRequest(local, url)).headSha).toBe("h".repeat(40));
  // Bun's spawn fails with ENOENT for a missing cwd, as for a missing glab.
  expect(cwds).toEqual([homedir()]);
  // Over SSH the shell goes home when the checkout is not there.
  await readMergeRequest({ ...local, host: "builder" }, url);
  expect(commands.at(-1)).toContain(`{ cd '${root}' 2>/dev/null || cd; } && `);
});

test("a missing glab is still told as such", async () => {
  const root = mkdtempSync(join(tmpdir(), "roamgate-glab-"));
  try {
    const context: GlabContext = {
      root,
      shQuote: (value) => `'${value}'`,
      runProcessWithCodeTimeout: async (_argv, _timeout, options) => {
        expect(options?.cwd).toBe(root);
        throw Object.assign(new Error("spawn glab ENOENT"), {
          code: "ENOENT",
        });
      },
    };
    await expect(readMergeRequest(context, url)).rejects.toThrow(
      "glab is not installed on this host",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a removed checkout is told as such when finding its merge request", async () => {
  const context: GlabContext = {
    root: "/var/home/me/upstreaming/validate-comparison-type",
    host: "builder",
    shQuote: (value) => `'${value}'`,
    runProcessWithCodeTimeout: async () => ({
      code: 2,
      stdout: "",
      stderr: "ROAMGATE-REVIEW-NO-CHECKOUT\n",
    }),
  };
  const error = await readCheckout(context).catch((failure) => failure);
  expect(error).toBeInstanceOf(ReviewGoneError);
  expect(error.message).toBe(
    "This checkout no longer exists: /var/home/me/upstreaming/validate-comparison-type",
  );
});
