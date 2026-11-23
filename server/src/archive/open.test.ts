import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "./engine";
import { type ArchiveRuntime } from "./hosts";
import { openArchived } from "./open";
import { archiveSearchQuery, createArchiveRpc } from "./rpc";
import { normalizeArchiveSettings } from "./settings";
import { updateTextRepo } from "./text-repo";

setDefaultTimeout(60_000);

const SESSION = "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee";
const KEY = `testhost/claude/-Users-t-proj/${SESSION}.jsonl`;
let root: string;
let runtime: ArchiveRuntime;
let archiveDir: string;
const settings = normalizeArchiveSettings({ host: "testhost" });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "roamgate-open-"));
  runtime = {
    homeDir: root,
    platform: "linux",
    env: {},
    dataDir: join(root, "data"),
  };
  archiveDir = join(root, "archive");
  const dir = join(root, ".claude", "projects", "-Users-t-proj");
  mkdirSync(dir, { recursive: true });
  const records = [
    { type: "ai-title", aiTitle: "Zoo planning" },
    ...Array.from({ length: 30 }, (_, i) => ({
      type: i % 2 ? "assistant" : "user",
      timestamp: `2026-11-14T10:${String(i).padStart(2, "0")}:00Z`,
      message: {
        content:
          i === 20
            ? [
                { type: "text", text: "now the lemur" },
                { type: "tool_use", name: "Bash", input: { command: "ls" } },
              ]
            : i === 21
              ? [{ type: "tool_result", content: "lemur.txt in the output" }]
              : `message ${i}`,
      },
    })),
  ];
  writeFileSync(
    join(dir, `${SESSION}.jsonl`),
    records.map((r) => `${JSON.stringify(r)}\n`).join(""),
  );
  await runSync({
    settings,
    runtime,
    archiveDir,
    localOnly: true,
    log: () => {},
  });
  await updateTextRepo({
    archiveDir,
    settings,
    host: "testhost",
    log: () => {},
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("opening a hit", () => {
  test("a text repo line opens its record, with context, from raw/", async () => {
    const rpc = createArchiveRpc({
      settings: async () => settings,
      archiveDir: () => archiveDir,
      runtime: () => runtime,
    });
    const found = await rpc.search({ query: "lemur" });
    const hit = found.hits[0];
    expect(hit?.key).toBe(KEY);
    const opened = await rpc.open({ key: hit?.key, line: hit?.doc });
    // The title record is line 1: message 20 is record 22.
    expect(opened?.hit).toBe(22);
    expect(opened?.title).toBe("Zoo planning");
    const marked = opened?.records.find((record) => record.hit);
    expect(marked?.messages.map((m) => m.kind)).toEqual(["text", "tool_use"]);
    expect(opened?.records.length).toBe(1 + 12 + 9);
    expect([opened?.before, opened?.after]).toEqual([true, false]);
    // Tool output is shown when opened, though the repo leaves it out.
    expect(
      opened?.records.some((record) =>
        record.messages.some((m) => m.text.includes("lemur.txt")),
      ),
    ).toBe(true);
  });

  test("a raw/ hit opens by record line; hidden and bad keys open nothing", async () => {
    const raw = await openArchived(archiveDir, settings, {
      key: KEY,
      line: 23,
      raw: true,
    });
    expect(raw?.records.find((record) => record.hit)?.messages[0]?.kind).toBe(
      "tool_result",
    );
    expect(
      await openArchived(
        archiveDir,
        { ...settings, hide: [{ project: "proj" }] },
        { key: KEY, line: 2 },
      ),
    ).toBeNull();
    expect(
      await openArchived(archiveDir, settings, {
        key: "testhost/claude/../../etc/passwd",
        line: 1,
      }),
    ).toBeNull();
  });

  test("search parameters are checked", () => {
    expect(() => archiveSearchQuery({})).toThrow();
    expect(() => archiveSearchQuery({ query: "x".repeat(400) })).toThrow();
    expect(
      archiveSearchQuery({ query: "a b", tool_output: true, limit: 999 }),
    ).toMatchObject({ terms: ["a", "b"], toolOutput: true, limit: 200 });
  });
});
