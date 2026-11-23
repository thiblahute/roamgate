import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { runSync } from "../archive/engine";
import { updateTextRepo } from "../archive/text-repo";
import {
  type GuiArchiveSettings,
  normalizeArchiveSettings,
} from "../archive/settings";
import { callArchiveTool, createArchiveToolHandler } from "./archive-tools";

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
let root: string;
let settings: GuiArchiveSettings;

const runtime = () => ({
  homeDir: root,
  platform: "linux",
  env: {},
  dataDir: join(root, "data"),
});
const handler = () =>
  createArchiveToolHandler({
    settings: async () => settings,
    archiveDir: () => join(root, "archive"),
    runtime,
  });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "roamgate-archive-tools-"));
  settings = normalizeArchiveSettings({ host: "testhost" });
  const dir = join(root, ".claude", "projects", "-Users-t-proj");
  mkdirSync(dir, { recursive: true });
  const lines = [
    "first question about the zebra",
    "an answer",
    "third message",
    "fourth",
  ].map((text, i) =>
    JSON.stringify({
      type: i % 2 ? "assistant" : "user",
      timestamp: `2026-11-14T10:0${i}:00Z`,
      cwd: "/Users/t/proj",
      message: { content: text },
    }),
  );
  writeFileSync(join(dir, `${SESSION}.jsonl`), `${lines.join("\n")}\n`);
  await runSync({
    settings,
    runtime: runtime(),
    archiveDir: join(root, "archive"),
    localOnly: true,
    log: () => {},
  });
  await updateTextRepo({
    archiveDir: join(root, "archive"),
    settings,
    host: "testhost",
    log: () => {},
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("search, session and a bounded read", async () => {
  const search = await callArchiveTool(
    "archive_search",
    { query: "zebra" },
    handler(),
  );
  expect(search.text).toContain("1 match");
  expect(search.text).toContain(SESSION);
  const session = await callArchiveTool(
    "archive_session",
    { id: SESSION.slice(0, 8) },
    handler(),
  );
  expect(session.text).toContain("project -Users-t-proj");
  const read = await callArchiveTool(
    "archive_read",
    { id: SESSION, from_line: 2, limit: 2 },
    handler(),
  );
  expect(read.text).toContain("L2 assistant/text: an answer");
  expect(read.text).toContain("L3 user/text: third message");
  expect(read.text).not.toContain("fourth");
  expect(read.text).toContain("next_line 4");
});

test("hidden projects are never shown", async () => {
  settings = { ...settings, hide: [{ project: "proj" }] };
  expect(
    (await callArchiveTool("archive_search", { query: "zebra" }, handler()))
      .text,
  ).toContain("0 match");
  expect(
    (await callArchiveTool("archive_session", { id: SESSION }, handler())).text,
  ).toContain("No archived session");
  expect(
    (await callArchiveTool("archive_read", { id: SESSION }, handler())).text,
  ).toContain("No archived session");
});

test("invalid parameters are refused", async () => {
  await expect(
    callArchiveTool("archive_search", { query: "zebra", limit: 99 }, handler()),
  ).rejects.toThrow();
  await expect(
    callArchiveTool("archive_read", { id: "x" }, handler()),
  ).rejects.toThrow();
});

test("search finds what was said since the last pass, and regexes", async () => {
  appendFileSync(
    join(root, ".claude", "projects", "-Users-t-proj", `${SESSION}.jsonl`),
    `${JSON.stringify({ type: "user", timestamp: "2026-11-14T11:00:00Z", message: { content: "a late okapi" } })}\n`,
  );
  const live = await callArchiveTool(
    "archive_search",
    { query: "okapi" },
    handler(),
  );
  expect(live.text).toContain("1 matching message(s) in 1 session(s)");
  const regex = await callArchiveTool(
    "archive_search",
    { query: "ze+bra", regex: true },
    handler(),
  );
  expect(regex.text).toContain(SESSION);
});

test("without a text repo there is no archive to search yet", async () => {
  rmSync(join(root, "archive", "text.git"), { recursive: true, force: true });
  await expect(
    callArchiveTool("archive_search", { query: "zebra" }, handler()),
  ).rejects.toThrow("no session archive yet");
});
