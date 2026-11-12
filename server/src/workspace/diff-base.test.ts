import { describe, expect, test } from "bun:test";
import {
  chooseDefaultBase,
  type DefaultBaseFacts,
  defaultBaseCandidates,
  parseFactsOutput,
  resolveDefaultBase,
  selectDiffBase,
} from "./diff-base";

const refs = (...names: string[]) => names.map((name) => ({ name }));

/** Automatic's base from refs alone (no git facts: the two agree). */
const automatic = (
  list: { name: string; symbolic?: string }[],
  configured: string,
) => chooseDefaultBase(defaultBaseCandidates(list, configured));

describe("Inspector comparison base selection", () => {
  test("supports local main and master without a remote", () => {
    for (const branch of ["main", "master"]) {
      expect(
        automatic(refs(`refs/heads/${branch}`, "refs/heads/feature"), ""),
      ).toBe(`refs/heads/${branch}`);
    }
  });

  test("prefers the recorded custom remote default and its local branch", () => {
    const branches = [
      ...refs(
        "refs/heads/main",
        "refs/heads/release/stable",
        "refs/remotes/origin/release/stable",
      ),
      {
        name: "refs/remotes/origin/HEAD",
        symbolic: "refs/remotes/origin/release/stable",
      },
    ];
    // Both forms of the recorded default; the same commit, the remote one.
    expect(defaultBaseCandidates(branches, "main")).toEqual({
      local: "refs/heads/release/stable",
      remote: "refs/remotes/origin/release/stable",
    });
    expect(automatic(branches, "main")).toBe(
      "refs/remotes/origin/release/stable",
    );
    expect(automatic(branches.slice(2), "")).toBe(
      "refs/remotes/origin/release/stable",
    );
  });

  test("supports other remotes, configured local defaults, and origin fallbacks", () => {
    expect(
      automatic(
        [
          ...refs("refs/remotes/upstream/trunk"),
          {
            name: "refs/remotes/upstream/HEAD",
            symbolic: "refs/remotes/upstream/trunk",
          },
        ],
        "",
      ),
    ).toBe("refs/remotes/upstream/trunk");
    expect(
      automatic(refs("refs/heads/trunk", "refs/heads/main"), "trunk"),
    ).toBe("refs/heads/trunk");
    expect(automatic(refs("refs/remotes/origin/master"), "")).toBe(
      "refs/remotes/origin/master",
    );
  });

  test("explicit selection wins and rejects revisions, options, and missing branches", () => {
    const branches = refs(
      "refs/heads/main",
      "refs/heads/custom",
      "refs/remotes/upstream/custom",
    );
    for (const name of ["custom", "refs/heads/custom"]) {
      expect(selectDiffBase(branches, "refs/heads/main", name).base).toBe(
        "refs/heads/custom",
      );
    }
    expect(selectDiffBase(branches, undefined, "upstream/custom").base).toBe(
      "refs/remotes/upstream/custom",
    );
    // Automatic: the resolved base, when it is one of the branches.
    expect(selectDiffBase(branches, "refs/heads/main").base).toBe(
      "refs/heads/main",
    );
    for (const invalid of [
      "missing",
      "HEAD~1",
      "--help",
      "main; touch /tmp/nope",
      {},
      null,
    ]) {
      expect(() => selectDiffBase(branches, undefined, invalid)).toThrow(
        "Comparison branch was not found",
      );
    }
  });

  test("does not mistake current feature or stale metadata for a default", () => {
    expect(
      automatic(
        [
          ...refs("refs/heads/feature"),
          {
            name: "refs/remotes/origin/HEAD",
            symbolic: "refs/remotes/origin/missing",
          },
        ],
        "missing",
      ),
    ).toBeUndefined();
  });
});

describe("Automatic's base: the newer of the local default branch and its remote (D12)", () => {
  const both = {
    local: "refs/heads/main",
    remote: "refs/remotes/origin/main",
  };
  const facts = (over: Partial<DefaultBaseFacts>): DefaultBaseFacts => ({
    onLocal: false,
    remoteInLocal: false,
    localInRemote: false,
    localForkTime: 0,
    remoteForkTime: 0,
    localForkInRemoteFork: false,
    remoteForkInLocalFork: false,
    ...over,
  });

  test("a stale local main (behind origin/main): origin/main", () => {
    expect(chooseDefaultBase(both, facts({ localInRemote: true }))).toBe(
      both.remote,
    );
  });

  test("a local main ahead of origin/main: the local one, unless it is checked out", () => {
    expect(chooseDefaultBase(both, facts({ remoteInLocal: true }))).toBe(
      both.local,
    );
    // On main itself, main..HEAD would be empty: its unpushed work shows.
    expect(
      chooseDefaultBase(both, facts({ remoteInLocal: true, onLocal: true })),
    ).toBe(both.remote);
  });

  test("diverged: the one whose merge-base with HEAD is newest", () => {
    expect(
      chooseDefaultBase(both, facts({ localForkInRemoteFork: true })),
    ).toBe(both.remote);
    expect(
      chooseDefaultBase(both, facts({ remoteForkInLocalFork: true })),
    ).toBe(both.local);
    // Unrelated forks: by commit time.
    expect(
      chooseDefaultBase(both, facts({ localForkTime: 20, remoteForkTime: 10 })),
    ).toBe(both.local);
    expect(
      chooseDefaultBase(both, facts({ localForkTime: 10, remoteForkTime: 20 })),
    ).toBe(both.remote);
  });

  test("the facts are read from the last lines, after what a login profile printed", () => {
    expect(parseFactsOutput("welcome\n0\n1\n0\n5\n6\n0\n1\n")).toEqual({
      onLocal: false,
      remoteInLocal: true,
      localInRemote: false,
      localForkTime: 5,
      remoteForkTime: 6,
      localForkInRemoteFork: false,
      remoteForkInLocalFork: true,
    });
    expect(parseFactsOutput("1\n0\n")).toBeUndefined();
  });

  test("over SSH: two read-only scripts on the host, never a fetch; one when local and remote are the same commit", async () => {
    const commands: string[][] = [];
    const answers = [
      [
        "refs/heads/main\t\taaa",
        "refs/remotes/origin/HEAD\trefs/remotes/origin/main\t",
        "refs/remotes/origin/main\t\tbbb",
        "\n--diff-base-config--\n",
      ].join("\n"),
      // A stale local main: in origin/main.
      "0\n0\n1\n100\n200\n1\n0\n",
    ];
    const resolved = await resolveDefaultBase({
      root: "/remote/repo's root",
      host: "example.test",
      shQuote: (value) => `'${value.replaceAll("'", "'\\''")}'`,
      runProcessWithCodeTimeout: async (argv) => {
        commands.push(argv);
        return { code: 0, stderr: "", stdout: answers.shift() ?? "" };
      },
    });
    expect(resolved).toEqual({
      base: "refs/remotes/origin/main",
      alternate: "refs/heads/main",
      branches: ["refs/heads/main", "refs/remotes/origin/main"],
    });
    expect(commands).toHaveLength(2);
    for (const argv of commands) {
      expect(argv[0]).toBe("ssh");
      expect(argv.join(" ")).not.toContain("fetch");
    }
    expect(commands[1]?.join(" ")).toContain("merge-base --is-ancestor");

    const same: string[][] = [];
    const sameCommit = await resolveDefaultBase({
      root: "/repo",
      host: "example.test",
      shQuote: (value) => `'${value}'`,
      runProcessWithCodeTimeout: async (argv) => {
        same.push(argv);
        return {
          code: 0,
          stderr: "",
          stdout:
            "refs/heads/main\t\taaa\nrefs/remotes/origin/main\t\taaa\n\n--diff-base-config--\n",
        };
      },
    });
    expect(sameCommit.base).toBe("refs/remotes/origin/main");
    expect(same).toHaveLength(1);
  });
});
