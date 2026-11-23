import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "./engine";
import { type ArchiveRuntime } from "./hosts";
import { searchArchive } from "./search";
import { type GuiArchiveSettings, normalizeArchiveSettings } from "./settings";
import {
  git,
  headCommit,
  readHeadFile,
  readTextState,
  rebuildTextRepo,
  STATE_PATH,
  textRepoPath,
  textRepoStatus,
  updateTextRepo,
} from "./text-repo";

// Real git, fsync and zstd per step: slow on a loaded machine.
setDefaultTimeout(60_000);

let root: string;
let runtime: ArchiveRuntime;
let archiveDir: string;

const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";
const PROJECT = "-Users-tester-devel-proj";

function record(
  type: "user" | "assistant",
  content: unknown,
  ts = "2026-11-14T10:00:00.000Z",
): string {
  return `${JSON.stringify({
    type,
    timestamp: ts,
    cwd: "/Users/tester/devel/proj",
    message: { role: type, content },
  })}\n`;
}

function claudeFile(session = SESSION, project = PROJECT): string {
  const dir = join(root, ".claude", "projects", project);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${session}.jsonl`);
}

function settings(
  overrides: Partial<GuiArchiveSettings> = {},
): GuiArchiveSettings {
  return { ...normalizeArchiveSettings({ host: "testhost" }), ...overrides };
}

async function sync(s = settings()) {
  await runSync({
    settings: s,
    runtime,
    archiveDir,
    localOnly: true,
    log: () => {},
  });
}

async function pass(s = settings()) {
  return updateTextRepo({
    archiveDir,
    settings: s,
    host: "testhost",
    log: () => {},
  });
}

const repo = () => textRepoPath(archiveDir);

/** HEAD's files and blob ids, the state file left out. */
function tree(dir = repo()): string[] {
  return git(dir, ["ls-tree", "-r", "HEAD"])
    .stdout.toString()
    .trim()
    .split("\n")
    .filter((line) => !line.endsWith(STATE_PATH));
}

function file(path: string): string {
  return readHeadFile(repo(), path)?.toString("utf8") ?? "";
}

const query = (terms: string, extra: object = {}) => ({
  terms: terms.split(" "),
  limit: 20,
  ...extra,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roamgate-text-"));
  runtime = {
    homeDir: root,
    platform: "linux",
    env: {},
    dataDir: join(root, ".config", "roamgate"),
  };
  archiveDir = join(root, ".config", "roamgate", "archive");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the text repo", () => {
  test("renders raw/ incrementally, one commit per pass", async () => {
    const main = claudeFile();
    writeFileSync(
      main,
      record("user", "first flamingo question") +
        record("assistant", [
          { type: "text", text: "looking" },
          { type: "tool_use", name: "Bash", input: { command: "ls /tmp" } },
        ]) +
        record("user", [{ type: "tool_result", content: "tool walrus out" }]),
    );
    const sub = join(claudeFile().replace(/\.jsonl$/, ""), "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-1.jsonl"), record("user", "subagent task"));
    writeFileSync(
      join(root, ".claude", "history.jsonl"),
      `${JSON.stringify({ display: "a typed prompt", timestamp: Date.parse("2026-11-14T09:00:00Z"), project: "/Users/tester/devel/proj" })}\n`,
    );
    await sync();
    const first = await pass();
    expect(first.status).toBe("committed");
    expect(first.files).toBe(3);
    const path = `testhost/claude/${PROJECT}/2026/11/14/${SESSION}.md`;
    expect(tree().map((line) => line.split("\t")[1])).toEqual([
      `testhost/@history/claude/history.md`,
      `testhost/claude/${PROJECT}/2026/11/14/${SESSION}.agent-1.md`,
      path,
    ]);
    expect(file(path)).toBe(
      [
        `# testhost/claude/${PROJECT}/${SESSION}.jsonl cwd=/Users/tester/devel/proj`,
        "2026-11-14T10:00:00 user text: first flamingo question",
        "2026-11-14T10:00:00 assistant text: looking",
        "2026-11-14T10:00:00 assistant tool_use Bash: ls /tmp",
        "",
      ].join("\n"),
    );
    expect((await pass()).status).toBe("unchanged");

    // Grows, with a partial last line held back until it is complete.
    appendFileSync(
      main,
      record("user", "second narwhal", "2026-11-15T08:00:00Z") +
        '{"type":"user","timestamp":"2026-11-15T08:00:01Z","message":{"content":"half pel',
    );
    await sync();
    const second = await pass();
    expect([second.status, second.files, second.lines]).toEqual([
      "committed",
      1,
      1,
    ]);
    expect(file(path).trim().split("\n").at(-1)).toBe(
      "2026-11-15T08:00:00 user text: second narwhal",
    );
    appendFileSync(main, 'ican"}}\n');
    await sync();
    await pass();
    expect(file(path).trim().split("\n").at(-1)).toBe(
      "2026-11-15T08:00:01 user text: half pelican",
    );
    expect(
      git(repo(), ["rev-list", "--count", "HEAD"]).stdout.toString().trim(),
    ).toBe("3");
    const log = git(repo(), ["log", "-1", "--format=%cn <%ce>"]);
    expect(log.stdout.toString().trim()).toBe("Roamgate <roamgate@testhost>");

    // A rebuild yields the same files, and a second one the same again.
    const incremental = tree();
    await rebuildTextRepo({
      archiveDir,
      settings: settings(),
      host: "testhost",
      log: () => {},
    });
    expect(tree()).toEqual(incremental);
    await rebuildTextRepo({
      archiveDir,
      settings: settings(),
      host: "testhost",
      log: () => {},
    });
    expect(tree()).toEqual(incremental);
    expect(
      git(repo(), ["rev-list", "--count", "HEAD"]).stdout.toString().trim(),
    ).toBe("1");
    const status = textRepoStatus(archiveDir, settings());
    expect([status.exists, status.files, status.last_repack !== null]).toEqual([
      true,
      3,
      true,
    ]);
  });

  test("a shrunk transcript is rendered again from its new copy", async () => {
    const main = claudeFile();
    writeFileSync(main, record("user", "old flamingo") + record("user", "x"));
    await sync();
    await pass();
    writeFileSync(main, record("user", "new axolotl", "2026-11-16T00:00:00Z"));
    await sync();
    await pass();
    const paths = tree().map((line) => line.split("\t")[1]);
    expect(paths).toEqual([
      `testhost/claude/${PROJECT}/2026/11/16/${SESSION}.md`,
    ]);
    expect(file(paths[0] as string)).toContain("new axolotl");
    expect(file(paths[0] as string)).not.toContain("flamingo");
  });

  test("name collisions: the first raw path keeps the name, in any order", async () => {
    // Two Codex rollouts of the same session id, started the same day.
    const id = "019e460d-9751-78d0-8c76-e6d9c9f466b4";
    const rollout = (day: string, text: string) => {
      const dir = join(root, ".codex", "sessions", "2026", "05", day);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `rollout-2026-05-${day}T11-42-36-${id}.jsonl`),
        [
          {
            timestamp: "2026-05-20T09:42:36Z",
            type: "session_meta",
            payload: { id, cwd: "/tmp/work" },
          },
          {
            timestamp: "2026-05-20T09:42:37Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text }],
            },
          },
        ]
          .map((line) => `${JSON.stringify(line)}\n`)
          .join(""),
      );
    };
    rollout("21", "later capybara");
    await sync();
    await pass();
    rollout("20", "earlier capybara");
    await sync();
    await pass();
    const incremental = tree();
    const names = incremental.map((line) => line.split("\t")[1]);
    expect(names).toHaveLength(2);
    expect(names).toContain(`testhost/codex/-tmp-work/2026/05/20/${id}.md`);
    expect(file(`testhost/codex/-tmp-work/2026/05/20/${id}.md`)).toContain(
      "earlier capybara",
    );
    await rebuildTextRepo({
      archiveDir,
      settings: settings(),
      host: "testhost",
      log: () => {},
    });
    expect(tree()).toEqual(incremental);
  });

  test("a transcript with no text yet is kept, then named by its first line", async () => {
    const main = claudeFile();
    writeFileSync(
      main,
      record("user", [{ type: "tool_result", content: "only output" }]),
    );
    await sync();
    await pass();
    expect(tree()).toEqual([]);
    expect(
      readTextState(repo())?.files[
        `testhost/claude/${PROJECT}/${SESSION}.jsonl`
      ]?.path,
    ).toBe("");
    appendFileSync(main, record("user", "now a gecko", "2026-11-15T00:00:00Z"));
    await sync();
    const report = await pass();
    expect([report.files, report.lines]).toEqual([1, 1]);
    // Dated by its first record, though that one had no text.
    const path = `testhost/claude/${PROJECT}/2026/11/14/${SESSION}.md`;
    expect(file(path).split("\n").slice(1, 2)).toEqual([
      "2026-11-15T00:00:00 user text: now a gecko",
    ]);
  });

  test("a pass is deferred while busy", async () => {
    writeFileSync(claudeFile(), record("user", "hello"));
    await sync();
    const report = await updateTextRepo({
      archiveDir,
      settings: settings(),
      host: "testhost",
      log: () => {},
      busy: async () => true,
    });
    expect(report.status).toBe("deferred");
    expect(headCommit(repo())).toBeNull();
  });
});

describe("search", () => {
  beforeEach(async () => {
    writeFileSync(
      claudeFile(),
      record("user", "the flamingo and the walrus", "2026-11-01T10:00:00Z") +
        record("assistant", "a flamingo answer", "2026-11-02T10:00:00Z") +
        record(
          "assistant",
          [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "grep flamingo" },
            },
          ],
          "2026-11-02T10:00:01Z",
        ) +
        record(
          "user",
          [{ type: "tool_result", content: "only in tool output: quokka" }],
          "2026-11-02T10:00:02Z",
        ),
    );
    writeFileSync(
      claudeFile(OTHER, "-Users-tester-devel-other"),
      record("user", "one flamingo elsewhere", "2026-11-10T10:00:00Z"),
    );
    writeFileSync(
      join(root, ".claude", "history.jsonl"),
      `${JSON.stringify({ display: "flamingo prompt", timestamp: Date.parse("2026-11-03T09:00:00Z"), project: "/p" })}\n`,
    );
    await sync();
    await pass();
  });

  test("ranks sessions by matching messages, then recency", async () => {
    const result = await searchArchive(
      archiveDir,
      query("flamingo"),
      settings(),
    );
    expect(result.source).toBe("text");
    expect(result.hits.map((hit) => [hit.session, hit.matches])).toEqual([
      [SESSION, 3],
      [OTHER, 1],
    ]);
    expect(result.total).toBe(4);
    const top = result.hits[0];
    expect(top?.snippets).toHaveLength(3);
    expect(top?.snippet).toContain("[flamingo]");
    expect(top?.project).toBe(PROJECT);
    expect(top?.kind).toBe("tool_use");
    const recent = await searchArchive(
      archiveDir,
      query("flamingo", { recent: true }),
      settings(),
    );
    expect(recent.hits[0]?.session).toBe(OTHER);
  });

  test("filters: words, phrases, operators, role, kind, time, project, hide", async () => {
    const sessions = async (
      terms: string,
      extra: object = {},
      s = settings(),
    ) =>
      (await searchArchive(archiveDir, query(terms, extra), s)).hits.map(
        (hit) => hit.session,
      );
    expect(await sessions("walrus flamingo")).toEqual([SESSION]);
    expect(await sessions('"the walrus"')).toEqual([SESSION]);
    expect(await sessions('"walrus the"')).toEqual([]);
    expect(await sessions("flamingo NOT walrus")).toHaveLength(2);
    expect(await sessions("walrus OR elsewhere")).toHaveLength(2);
    // One user message each: the latest first.
    expect(await sessions("flamingo", { role: "user" })).toEqual([
      OTHER,
      SESSION,
    ]);
    expect(await sessions("flamingo", { kind: "tool_use" })).toEqual([SESSION]);
    expect(await sessions("flamingo", { since: "2026-11-05" })).toEqual([
      OTHER,
    ]);
    expect(await sessions("flamingo", { until: "2026-11-05" })).toEqual([
      SESSION,
    ]);
    expect(await sessions("flamingo", { project: "other" })).toEqual([OTHER]);
    expect(await sessions("flamingo", { host: "nothere" })).toEqual([]);
    expect(await sessions("flamingo", { agent: "claude" })).toHaveLength(2);
    expect(
      await sessions(
        "flamingo",
        {},
        settings({ hide: [{ project: "other" }] }),
      ),
    ).toEqual([SESSION]);
    expect(await sessions("quokka")).toEqual([]);
    expect(await sessions("fl[a-z]+go\\s+eLsE", { regex: true })).toEqual([
      OTHER,
    ]);
  });

  test("prompt history is searched on request", async () => {
    const result = await searchArchive(
      archiveDir,
      query("flamingo", { history: true }),
      settings(),
    );
    expect(result.history).toEqual([
      {
        host: "testhost",
        ts: "2026-11-03T09:00:00",
        project: "/p",
        snippet: "[flamingo] prompt",
      },
    ]);
    expect(result.hits.every((hit) => hit.session !== "history")).toBe(true);
  });

  test("sessions grown since the last commit are found", async () => {
    appendFileSync(
      claudeFile(),
      record("user", "a fresh pangolin", "2026-11-20T10:00:00Z"),
    );
    writeFileSync(
      claudeFile("77777777-2222-3333-4444-555555555555"),
      record("user", "a new pangolin session", "2026-11-21T10:00:00Z"),
    );
    const without = await searchArchive(
      archiveDir,
      query("pangolin"),
      settings(),
    );
    expect(without.hits).toEqual([]);
    const live = await searchArchive(
      archiveDir,
      query("pangolin"),
      settings(),
      {
        runtime,
      },
    );
    expect(live.hits.map((hit) => hit.session).sort()).toEqual([
      SESSION,
      "77777777-2222-3333-4444-555555555555",
    ]);
    const grown = live.hits.find((hit) => hit.session === SESSION);
    // The repo's file has a header and 3 lines: the new one is line 5.
    expect(grown?.doc).toBe(5);
    // Cached until the next commit, and gone once committed.
    expect(
      (
        await searchArchive(archiveDir, query("pangolin"), settings(), {
          runtime,
        })
      ).hits,
    ).toHaveLength(2);
    await sync();
    await pass();
    const after = await searchArchive(
      archiveDir,
      query("pangolin"),
      settings(),
      {
        runtime,
      },
    );
    expect(after.hits.map((hit) => hit.matches)).toEqual([1, 1]);
  });

  test("tool output is searched in raw/ on request", async () => {
    const result = await searchArchive(
      archiveDir,
      query("quokka", { toolOutput: true }),
      settings(),
    );
    expect(result.source).toBe("raw");
    expect(result.warning).toContain("slow");
    expect(result.hits.map((hit) => [hit.session, hit.kind, hit.doc])).toEqual([
      [SESSION, "tool_result", 4],
    ]);
  });

  test("the state lists every rendered file", () => {
    const state = readTextState(repo());
    expect(Object.keys(state?.files ?? {}).sort()).toEqual([
      "testhost/claude/-Users-tester-devel-other/99999999-2222-3333-4444-555555555555.jsonl",
      `testhost/claude/${PROJECT}/${SESSION}.jsonl`,
      "testhost/claude/@history.jsonl",
    ]);
  });
});
