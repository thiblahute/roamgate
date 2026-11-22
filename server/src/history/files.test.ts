import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  companionArea,
  connectionsArea,
  moveHostsArea,
  sessionProfilesArea,
  settingsArea,
  voiceArea,
} from "./files";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function data() {
  const dir = mkdtempSync(join(tmpdir(), "roamgate-files-"));
  dirs.push(dir);
  return dir;
}

test("settings: one file per allowed key, without secrets", async () => {
  const dir = data();
  const settings = join(dir, "settings.json");
  writeFileSync(
    settings,
    JSON.stringify({
      version: 1,
      title_suffix: "desk",
      profiles: {
        list: [{ id: "p", env: { ANTHROPIC_AUTH_TOKEN: "t", HOME: "/h" } }],
      },
      mr_reviews: { order: [] },
      something_new: { x: 1 },
      ui: { note: "glpat-abcdefghijklmnopqr" },
    }),
  );
  const area = settingsArea({ settings });
  const render = await area.render(null);
  expect([...render.files.keys()].sort()).toEqual([
    "settings/profiles.json",
    "settings/title_suffix.json",
    "settings/ui.json",
    "settings/version.json",
  ]);
  expect(render.files.get("settings/profiles.json")).toBe(
    '{\n  "list": [\n    {\n      "env": {\n        "HOME": "/h"\n      },\n      "id": "p"\n    }\n  ]\n}\n',
  );
  expect(render.files.get("settings/ui.json")).toContain("[removed]");
  expect(render.owns).toEqual(["settings/"]);
  expect(area.watch?.()).toEqual([settings]);
  expect(area.describe?.(["settings/ui.json", "settings/profiles.json"])).toBe(
    "ui, profiles",
  );
});

test("the small files areas copy their stores, JSON key-sorted, Markdown as it is", async () => {
  const dir = data();
  const voiceData = join(dir, "share");
  mkdirSync(join(dir, "companion-memories"), { recursive: true });
  mkdirSync(join(dir, "voice-profiles"), { recursive: true });
  mkdirSync(voiceData, { recursive: true });
  writeFileSync(
    join(dir, "connections.json"),
    '{"version":1,"profiles":[{"id":"mac","password":"x"}]}',
  );
  writeFileSync(join(dir, "move-hosts.json"), '{"serving":"desk","hosts":[]}');
  writeFileSync(
    join(dir, "session-profiles.json"),
    '{"version":1,"sessions":{}}',
  );
  writeFileSync(join(dir, "companion-memory.json"), '{"summary":"s"}');
  writeFileSync(
    join(dir, "companion-memories", "home.md"),
    "---\nname: home\n---\nLives here.\n",
  );
  writeFileSync(join(dir, "companion-memories", "notes.txt"), "not a memory");
  writeFileSync(
    join(dir, "taste.json"),
    '{"version":1,"profile":{"top":["a"]},"avoid":["x"],"picks":["y"],"updated":5}',
  );
  writeFileSync(join(dir, "voice.json"), '{"speech_rate":1.1,"helper":"/h"}');
  writeFileSync(join(dir, "voice-profiles", "anna.json"), '{"name":"Anna"}');
  writeFileSync(join(voiceData, "low-gpu.json"), '{"holders":{}}');
  const paths = {
    data: dir,
    connections: join(dir, "connections.json"),
    voiceData,
  };
  const all = new Map<string, string | Uint8Array>();
  for (const area of [
    connectionsArea(paths),
    moveHostsArea(paths),
    sessionProfilesArea(paths),
    companionArea(paths),
    voiceArea(paths),
  ])
    for (const [path, content] of (await area.render(null)).files)
      all.set(path, content);
  expect([...all.keys()].sort()).toEqual([
    "companion/memories/home.md",
    "companion/memory.json",
    "companion/taste.json",
    "connections.json",
    "move-hosts.json",
    "session-profiles.json",
    "voice/low-gpu.json",
    "voice/profiles/anna.json",
    "voice/voice.json",
  ]);
  expect(all.get("connections.json")).toBe(
    '{\n  "profiles": [\n    {\n      "id": "mac"\n    }\n  ],\n  "version": 1\n}\n',
  );
  expect(all.get("companion/memories/home.md")).toBe(
    "---\nname: home\n---\nLives here.\n",
  );
  expect(JSON.parse(all.get("companion/taste.json") as string)).toEqual({
    avoid: ["x"],
    picks: ["y"],
    version: 1,
  });
  const companion = companionArea(paths);
  expect(companion.watch?.()).toContain(
    join(dir, "companion-memories", "home.md"),
  );
  expect((await companion.render(null)).owns).toEqual([
    "companion/memory.json",
    "companion/memories/",
    "companion/taste.json",
  ]);
});

test("a missing store writes nothing; a broken one is an error", async () => {
  const dir = data();
  const area = connectionsArea({ connections: join(dir, "connections.json") });
  expect((await area.render(null)).files.size).toBe(0);
  writeFileSync(join(dir, "connections.json"), "{broken");
  expect(() => area.render(null)).toThrow(/connections\.json/);
});
