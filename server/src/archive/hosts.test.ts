import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS } from "./adapters";
import { type Exec, pullAgent, pushAgent, type ResolvedHost } from "./hosts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roamgate-archive-hosts-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function recorder(): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

describe("archive transfers", () => {
  test("a pull compresses every rsync transfer", async () => {
    const { exec, calls } = recorder();
    const host: ResolvedHost = {
      id: "mac",
      self: false,
      ssh: "mac",
      pathStyle: "posix",
      roots: {},
      enabled: true,
    };
    const claude = ADAPTERS.claude!;
    expect(await pullAgent(exec, root, host, claude, "/Users/tester")).toBe(
      true,
    );
    const rsyncs = calls.filter((argv) => argv[0] === "rsync");
    // The tree and the prompt history.
    expect(rsyncs.length).toBe(1 + (claude.extraFiles?.length ?? 0));
    for (const argv of rsyncs) {
      expect(argv).toContain("-z");
      expect(argv).toContain("--inplace");
    }
  });

  test("a push compresses every rsync transfer", async () => {
    const { exec, calls } = recorder();
    const tree = join(root, "projects");
    mkdirSync(tree, { recursive: true });
    const history = join(root, "history.jsonl");
    writeFileSync(history, "{}\n");
    await pushAgent(
      exec,
      { target: "desktop" },
      "mac",
      ADAPTERS.claude!,
      tree,
      [{ path: history, relpath: "@history.jsonl" }],
    );
    expect(calls.length).toBe(2);
    for (const argv of calls) {
      expect(argv[0]).toBe("rsync");
      expect(argv).toContain("-z");
    }
  });
});
