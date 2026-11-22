import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHistoryCommand } from "./history";
import { createTestCli, type TestCli } from "./test-context";

const clis: TestCli[] = [];
afterEach(() => {
  for (const cli of clis.splice(0)) cli.cleanup();
});

function seeded() {
  const cli = createTestCli();
  clis.push(cli);
  const data = join(cli.home, ".config", "roamgate");
  mkdirSync(join(data, "work"), { recursive: true });
  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({ version: 1, title_suffix: "desk", api_token: "x" }),
  );
  writeFileSync(
    join(data, "work", "work.json"),
    JSON.stringify({
      version: 1,
      projects: [],
      items: [
        {
          id: "1111222233334444",
          project: "p",
          title: "T",
          state: "open",
          tags: [],
          links: [],
          createdAt: "2026-11-20T08:00:00.000Z",
          updatedAt: "2026-11-20T08:00:00.000Z",
          by: "user",
        },
      ],
    }),
  );
  return { cli, data };
}

test("history commit writes the areas, status shows the repo", async () => {
  const { cli, data } = seeded();
  const command = createHistoryCommand({ host: "desk" });
  expect(await command.run(["commit"], cli.context)).toBe(0);
  expect(cli.errors).toEqual([]);
  expect(cli.output.join("\n")).toContain(
    "Committed in ~/.config/roamgate/history (1 commit)",
  );
  expect(
    existsSync(join(data, "history", "work", "items", "1111222233334444.md")),
  ).toBe(true);
  expect(
    existsSync(join(data, "history", "settings", "title_suffix.json")),
  ).toBe(true);
  cli.output.length = 0;
  expect(await command.run(["commit"], cli.context)).toBe(0);
  expect(cli.output).toEqual([
    "Nothing changed in ~/.config/roamgate/history.",
  ]);
  cli.output.length = 0;
  expect(await command.run(["status"], cli.context)).toBe(0);
  const text = cli.output.join("\n");
  expect(text).toContain("Local history: on");
  expect(text).toContain("Location: ~/.config/roamgate/history (default)");
  expect(text).toMatch(
    /Last commit: .* settings: title_suffix, version; work: 1 item/,
  );
  expect(text).toMatch(/Files: .*settings 2.*work 1/);
  cli.output.length = 0;
  expect(await command.run(["status", "--json"], cli.context)).toBe(0);
  expect(JSON.parse(cli.output.join("\n"))).toMatchObject({
    enabled: true,
    exists: true,
    commits: 2,
    files: { settings: 2, work: 1 },
  });
});

test("history off: status says so, commit refuses", async () => {
  const { cli } = seeded();
  cli.context.runtime.env = { ROAMGATE_HISTORY: "off" };
  const command = createHistoryCommand({ host: "desk" });
  expect(await command.run(["commit"], cli.context)).toBe(1);
  expect(cli.errors[0]).toContain("Local history is off");
  expect(await command.run(["status"], cli.context)).toBe(0);
  expect(cli.output).toEqual([
    "Local history: off",
    "Location: ~/.config/roamgate/history (default)",
    "No repository there yet.",
  ]);
});

test("unknown actions and arguments are usage errors", async () => {
  const { cli } = seeded();
  const command = createHistoryCommand();
  expect(await command.run(["restore"], cli.context)).toBe(2);
  expect(await command.run(["status", "--all"], cli.context)).toBe(2);
  expect(await command.run([], cli.context)).toBe(0);
  expect(cli.output[0]).toContain("roamgate history status");
});
