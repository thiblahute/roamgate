import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeProject, mapCwd } from "./adapters";
import { rebuildArchiveDb, runIngest, runSync } from "./engine";
import { archiveHealth } from "./health";
import { type ArchiveRuntime, type Exec, resolveHosts } from "./hosts";
import { acquireHostLock } from "./lock";
import { makeSnippet, searchArchive } from "./search";
import {
  catFile,
  catLines,
  localFileSource,
  lookupSession,
  resumeSession,
} from "./session";
import { type GuiArchiveSettings, normalizeArchiveSettings } from "./settings";
import { openArchiveDb } from "./store";
import { updateTextRepo } from "./text-repo";
import { archivedDigest } from "./zstd";

let root: string;
let runtime: ArchiveRuntime;
let archiveDir: string;

const SESSION = "11111111-2222-3333-4444-555555555555";

function record(type: string, text: string, extra: object = {}): string {
  return `${JSON.stringify({
    type,
    timestamp: "2026-11-14T10:00:00.000Z",
    uuid: `u-${text.length}-${Math.random()}`,
    cwd: "/Users/tester/devel/proj",
    message: { role: type, content: text },
    ...extra,
  })}\n`;
}

function claudeDir(): string {
  return join(root, ".claude", "projects", "-Users-tester-devel-proj");
}

function settings(
  overrides: Partial<GuiArchiveSettings> = {},
): GuiArchiveSettings {
  return { ...normalizeArchiveSettings({ host: "testhost" }), ...overrides };
}

async function sync(s = settings()) {
  const logs: string[] = [];
  const report = await runSync({
    settings: s,
    runtime,
    archiveDir,
    localOnly: true,
    log: (m) => logs.push(m),
  });
  return report.hosts[0]?.agents ?? {};
}

function withDb<T>(fn: (db: ReturnType<typeof openArchiveDb>["db"]) => T): T {
  const { db } = openArchiveDb(archiveDir);
  try {
    return fn(db);
  } finally {
    db.close(false);
  }
}

const query = (terms: string, extra: object = {}) => ({
  terms: terms.split(" "),
  limit: 50,
  ...extra,
});

/** Search as the CLI does after a sync: the text pass, then the text repo. */
async function found(terms: string, extra: object = {}, s = settings()) {
  await updateTextRepo({
    archiveDir,
    settings: s,
    host: "testhost",
    log: () => {},
  });
  return searchArchive(archiveDir, query(terms, extra), s);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roamgate-archive-"));
  runtime = {
    homeDir: root,
    platform: "linux",
    env: {},
    dataDir: join(root, ".config", "roamgate"),
  };
  archiveDir = join(root, ".config", "roamgate", "archive");
  mkdirSync(join(claudeDir(), SESSION, "subagents"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("claude lifecycle", () => {
  test("archives, indexes, grows, handles partial lines and shrinks", async () => {
    const main = join(claudeDir(), `${SESSION}.jsonl`);
    const sub = join(claudeDir(), SESSION, "subagents", "agent-1.jsonl");
    writeFileSync(
      main,
      record("user", "first flamingo question") +
        record("assistant", "an answer"),
    );
    writeFileSync(sub, record("user", "subagent walrus task"));
    let stats = (await sync()).claude;
    expect([stats?.new, stats?.error]).toEqual([2, 0]);
    expect((await found("flamingo")).total).toBe(1);
    const walrus = (await found("walrus")).hits[0];
    expect(walrus?.subagent).toBe(true);
    expect(walrus?.session).toBe(SESSION);
    stats = (await sync()).claude;
    expect([stats?.same, stats?.new, stats?.grown]).toEqual([2, 0, 0]);

    appendFileSync(main, record("user", "second narwhal question"));
    stats = (await sync()).claude;
    expect([stats?.grown, stats?.docs]).toEqual([1, 1]);
    expect((await found("narwhal")).total).toBe(1);
    expect((await found("flamingo")).total).toBe(1);

    appendFileSync(main, '{"type":"user","message":{"content":"half pelican');
    await sync();
    expect((await found("pelican")).total).toBe(0);
    appendFileSync(main, ' done"}}\n');
    await sync();
    expect((await found("pelican")).total).toBe(1);

    // cat is byte-identical, also with the partial line archived once
    withDb((db) => {
      const lookup = lookupSession(db, SESSION.slice(0, 8));
      expect(lookup.files.every((f) => f.complete)).toBe(true);
    });
    const lookup = withDb((db) => lookupSession(db, SESSION));
    const chunks: Buffer[] = [];
    for await (const chunk of catFile(archiveDir, lookup)) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(readFileSync(main))).toBe(true);

    // shrink keeps the old copy
    writeFileSync(main, record("user", "rewritten axolotl"));
    stats = (await sync()).claude;
    expect(stats?.shrunk).toBe(1);
    const dir = join(
      archiveDir,
      "raw",
      "testhost",
      "claude",
      "-Users-tester-devel-proj",
    );
    expect(
      readdirSync(dir).filter((n) => n.includes(".jsonl.zst.")),
    ).toHaveLength(1);
    expect((await found("flamingo")).total).toBe(0);
    expect((await found("axolotl")).total).toBe(1);
    expect(existsSync(main) && existsSync(sub)).toBe(true);
  });

  test("appended frames are one valid zstd stream with a checksum", async () => {
    const main = join(claudeDir(), `${SESSION}.jsonl`);
    writeFileSync(main, record("user", "alpha".repeat(1000)));
    await sync();
    appendFileSync(main, record("user", "beta".repeat(1000)));
    await sync();
    const digest = await archivedDigest(
      join(
        archiveDir,
        "raw",
        "testhost",
        "claude",
        "-Users-tester-devel-proj",
        `${SESSION}.jsonl.zst`,
      ),
    );
    expect(digest.bytes).toBe(readFileSync(main).length);
  });

  test("a crash after compressing is repaired on the next run", async () => {
    const main = join(claudeDir(), `${SESSION}.jsonl`);
    writeFileSync(main, record("user", "one gazelle"));
    await sync();
    const zst = join(
      archiveDir,
      "raw",
      "testhost",
      "claude",
      "-Users-tester-devel-proj",
      `${SESSION}.jsonl.zst`,
    );
    appendFileSync(zst, Buffer.from("garbage from an interrupted append"));
    appendFileSync(main, record("user", "two ibex"));
    await sync();
    expect((await found("ibex")).total).toBe(1);
    const digest = await archivedDigest(zst);
    expect(digest.bytes).toBe(readFileSync(main).length);
  });

  test("index rules, hide and exclude", async () => {
    const other = join(root, ".claude", "projects", "-Users-tester-secret");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(claudeDir(), `${SESSION}.jsonl`),
      record("user", "visible okapi"),
    );
    writeFileSync(
      join(other, "aaaaaaaa-2222-3333-4444-555555555555.jsonl"),
      record("user", "hidden okapi"),
    );
    await sync(settings({ hide: [{ project: "secret" }] }));
    expect((await found("okapi")).total).toBe(2);
    expect(
      (await found("okapi", {}, settings({ hide: [{ project: "secret" }] })))
        .total,
    ).toBe(1);
    rmSync(archiveDir, { recursive: true });
    const stats = await sync(settings({ exclude: [{ project: "secret" }] }));
    expect(stats.claude?.excluded).toBe(1);
    expect((await found("okapi")).total).toBe(1);
  });

  test("the none level archives a session but keeps it out of search", async () => {
    writeFileSync(
      join(claudeDir(), `${SESSION}.jsonl`),
      record("user", "marmot colony"),
    );
    const none = settings({ index: { default: "none", rules: [] } });
    await sync(none);
    expect((await found("marmot", {}, none)).total).toBe(0);
    withDb((db) => expect(lookupSession(db, SESSION).found).toBe(true));
  });

  test("rebuild-db restores the bookkeeping; the text repo carries on", async () => {
    writeFileSync(
      join(claudeDir(), `${SESSION}.jsonl`),
      record("user", "first lemur") + record("assistant", "reply ocelot"),
    );
    await sync();
    const before = (await found("ocelot")).total;
    const rebuilt = await rebuildArchiveDb(archiveDir, settings(), () => {});
    rebuilt.close(false);
    withDb((db) =>
      expect(lookupSession(db, SESSION).files[0]?.complete).toBe(true),
    );
    expect(
      (
        await updateTextRepo({
          archiveDir,
          settings: settings(),
          host: "testhost",
          log: () => {},
        })
      ).status,
    ).toBe("unchanged");
    expect((await found("ocelot")).total).toBe(before);
    const stats = (await sync()).claude;
    expect(stats?.error).toBe(0);
  });

  test("history prompts are searched", async () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "history.jsonl"),
      `${JSON.stringify({ display: "remember the tapir", timestamp: 1_760_000_000_000, project: "/x" })}\n`,
    );
    await sync();
    expect((await found("tapir", { history: true })).history).toHaveLength(1);
  });
});

describe("other agents", () => {
  test("codex and pi sessions are archived, indexed and round-trip", async () => {
    const codexId = "019e460d-9751-78d0-8c76-e6d9c9f466b4";
    const codexFile = join(
      root,
      ".codex",
      "sessions",
      "2026",
      "05",
      "20",
      `rollout-2026-05-20T11-42-36-${codexId}.jsonl`,
    );
    mkdirSync(join(codexFile, ".."), { recursive: true });
    const lines = [
      {
        timestamp: "2026-05-20T09:42:36Z",
        type: "session_meta",
        payload: { id: codexId, cwd: "/tmp/work" },
      },
      {
        timestamp: "2026-05-20T09:42:37Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "find the capybara" }],
        },
      },
      {
        timestamp: "2026-05-20T09:42:38Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          arguments: '{"cmd":"ls"}',
          call_id: "c",
        },
      },
      {
        timestamp: "2026-05-20T09:42:39Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c",
          output: "found capybara.txt",
        },
      },
      {
        timestamp: "2026-05-20T09:42:40Z",
        type: "event_msg",
        payload: { type: "token_count" },
      },
    ];
    writeFileSync(
      codexFile,
      lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
    );
    const piId = "019f6105-eecf-7d83-b4bf-37244d32b16a";
    const piFile = join(
      root,
      ".pi",
      "agent",
      "sessions",
      "--tmp-work--",
      `2026-07-14T14-26-46-608Z_${piId}.jsonl`,
    );
    mkdirSync(join(piFile, ".."), { recursive: true });
    const piLines = [
      {
        type: "session",
        id: piId,
        cwd: "/tmp/work",
        timestamp: "2026-07-14T14:26:46Z",
      },
      {
        type: "message",
        id: "a",
        timestamp: "2026-07-14T14:27:00Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello quokka" }],
        },
      },
      {
        type: "message",
        id: "b",
        timestamp: "2026-07-14T14:27:01Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "hi" },
            { type: "toolCall", name: "bash", arguments: { command: "ls" } },
          ],
        },
      },
    ];
    writeFileSync(
      piFile,
      piLines.map((l) => `${JSON.stringify(l)}\n`).join(""),
    );
    const stats = await sync();
    expect(stats.codex?.docs).toBe(3);
    expect(stats.pi?.docs).toBe(3);
    // The text has the prompt; the tool output only the raw/ search reads.
    expect((await found("capybara", { agent: "codex" })).total).toBe(1);
    expect(
      (await found("capybara", { agent: "codex", toolOutput: true })).total,
    ).toBe(2);
    expect((await found("quokka")).hits[0]?.agent).toBe("pi");
    withDb((db) => {
      const codex = lookupSession(db, codexId.slice(0, 8));
      expect(codex.session).toBe(codexId);
      expect(codex.restorable).toBe(false);
      expect(codex.cwd).toBe("/tmp/work");
      expect(lookupSession(db, piId).resume).toBe(`pi --session ${piId}`);
    });
    const lookup = withDb((db) => lookupSession(db, codexId));
    const chunks: Buffer[] = [];
    for await (const chunk of catFile(archiveDir, lookup)) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(readFileSync(codexFile))).toBe(true);
  });
});

describe("resume", () => {
  test("restores only what is missing, maps the project and appends a note", async () => {
    const main = join(claudeDir(), `${SESSION}.jsonl`);
    writeFileSync(
      main,
      record("user", "question") + record("assistant", "answer"),
    );
    await sync();
    const lookup = withDb((db) => lookupSession(db, SESSION));
    // Pretend another machine: a different home, an empty claude dir.
    const other = mkdtempSync(join(tmpdir(), "roamgate-archive-other-"));
    try {
      const otherRuntime: ArchiveRuntime = { ...runtime, homeDir: other };
      const self = resolveHosts(settings(), otherRuntime)[0];
      if (!self) throw new Error("no self");
      const result = await resumeSession(lookup, {
        runtime: otherRuntime,
        self,
        source: localFileSource(archiveDir),
      });
      expect(result.restored.map((r) => r.status)).toEqual(["restored"]);
      const mapped = join(
        other,
        ".claude",
        "projects",
        mapClaudeProject("-Users-tester-devel-proj", other),
        `${SESSION}.jsonl`,
      );
      expect(existsSync(mapped)).toBe(true);
      const text = readFileSync(mapped, "utf8");
      expect(text.startsWith(readFileSync(main, "utf8"))).toBe(true);
      const note = JSON.parse(text.trim().split("\n").pop() as string);
      expect(note.type).toBe("user");
      expect(note.message.content).toContain("restored from another computer");
      expect(note.cwd).toBe(mapCwd("/Users/tester/devel/proj", other));
      expect(result.command).toBe(`claude --resume ${SESSION}`);
      // A second resume never overwrites.
      const again = await resumeSession(lookup, {
        runtime: otherRuntime,
        self,
        source: localFileSource(archiveDir),
      });
      expect(again.restored.map((r) => r.status)).toEqual(["exists"]);
      expect(readFileSync(mapped, "utf8")).toBe(text);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("codex sessions are not restored", async () => {
    const id = "019e460d-9751-78d0-8c76-e6d9c9f466b4";
    const file = join(
      root,
      ".codex",
      "sessions",
      "2026",
      "05",
      "20",
      `rollout-x-${id}.jsonl`,
    );
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session_meta", payload: { id, cwd: "/a" } })}\n`,
    );
    await sync();
    const lookup = withDb((db) => lookupSession(db, id));
    const self = resolveHosts(settings(), runtime)[0];
    if (!self) throw new Error("no self");
    const result = await resumeSession(lookup, {
      runtime,
      self,
      source: localFileSource(archiveDir),
    });
    expect(result.restored).toEqual([]);
    expect(result.command).toBeNull();
  });
});

describe("hosts and health", () => {
  test("a pull from an unreachable host is recorded, not fatal", async () => {
    const exec: Exec = async () => ({
      code: 255,
      stdout: "",
      stderr: "ssh: connect timed out",
    });
    const report = await runSync({
      settings: settings({ hosts: { mac: { ssh: "mac" } } }),
      runtime,
      archiveDir,
      exec,
      log: () => {},
    });
    expect(report.hosts.find((h) => h.host === "mac")?.status).toBe(
      "unreachable",
    );
    withDb((db) => {
      const health = archiveHealth(
        db,
        archiveDir,
        settings({ hosts: { mac: { ssh: "mac" } } }),
        runtime,
        0,
      );
      expect(health.warnings.some((w) => w.includes("mac"))).toBe(true);
      expect(
        health.hosts.find((h) => h.host === "mac")?.last_attempt,
      ).not.toBeNull();
    });
  });

  test("an ingested mirror is archived under its host, duplicates stay separate", async () => {
    const mirror = join(
      archiveDir,
      "mirror",
      "mac",
      "claude",
      "tree",
      "-Users-tester-devel-proj",
    );
    mkdirSync(mirror, { recursive: true });
    writeFileSync(
      join(mirror, `${SESSION}.jsonl`),
      record("user", "mirrored kudu"),
    );
    writeFileSync(
      join(claudeDir(), `${SESSION}.jsonl`),
      record("user", "local kudu"),
    );
    await sync();
    await runIngest({
      settings: settings(),
      runtime,
      archiveDir,
      host: "mac",
      log: () => {},
    });
    withDb((db) => {
      const lookup = lookupSession(db, SESSION);
      expect(lookup.copies.map((c) => c.host).sort()).toEqual([
        "mac",
        "testhost",
      ]);
    });
    expect((await found("kudu")).total).toBe(2);
    expect(
      await runIngest({
        settings: settings(),
        runtime,
        archiveDir,
        host: "bad host!",
        log: () => {},
      }).catch((e) => e.message),
    ).toContain("invalid host");
  });

  test("host locks are exclusive", () => {
    mkdirSync(archiveDir, { recursive: true });
    const release = acquireHostLock(archiveDir, "mac");
    expect(release).not.toBeNull();
    expect(acquireHostLock(archiveDir, "mac")).toBeNull();
    release?.();
    expect(acquireHostLock(archiveDir, "mac")).not.toBeNull();
  });

  test("health is stale without a sync and fresh after one", async () => {
    writeFileSync(
      join(claudeDir(), `${SESSION}.jsonl`),
      record("user", "x y z"),
    );
    await sync();
    withDb((db) => {
      const fresh = archiveHealth(db, archiveDir, settings(), runtime, 0);
      expect(fresh.hosts[0]?.stale).toBe(false);
      const later = archiveHealth(
        db,
        archiveDir,
        settings(),
        runtime,
        0,
        new Date(Date.now() + 100 * 3_600_000),
      );
      expect(later.hosts[0]?.stale).toBe(true);
      expect(later.ok).toBe(false);
    });
  });
});

describe("helpers", () => {
  test("snippets mark matches", () => {
    expect(makeSnippet("The Quick brown fox", ["quick", "FOX"], 50)).toBe(
      "The [Quick] brown [fox]",
    );
    const long = `${"a".repeat(300)} needle ${"b".repeat(300)}`;
    const snippet = makeSnippet(long, ["needle"], 20);
    expect(snippet.startsWith("... ") && snippet.endsWith(" ...")).toBe(true);
  });

  test("project mapping across homes", () => {
    expect(
      mapClaudeProject("-Users-thiblahute-devel-x", "/var/home/thiblahute"),
    ).toBe("-var-home-thiblahute-devel-x");
    expect(
      mapClaudeProject("-var-home-thiblahute-devel-x", "/Users/thiblahute"),
    ).toBe("-Users-thiblahute-devel-x");
    expect(mapCwd("/Users/a/b", "/var/home/a")).toBe("/var/home/a/b");
  });

  test("catLines is bounded", async () => {
    const lookup = (async function* () {
      yield Buffer.from("a\nb\nc\nd\n");
    })();
    const slice = await catLines(lookup, 2, 2, 100);
    expect(slice.lines).toEqual(["b", "c"]);
    expect(slice.next).toBe(4);
  });
});
