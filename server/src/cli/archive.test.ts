import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createArchiveCommand } from "./archive";
import { runCli } from "./index";
import { createTestCli, type TestCli } from "./test-context";

// Real git, rsync-free local syncs and zstd: slow on a loaded machine.
setDefaultTimeout(60_000);

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const clis: TestCli[] = [];
afterEach(() => {
  for (const cli of clis.splice(0)) cli.cleanup();
});

function machine(archive: Record<string, unknown>) {
  const cli = createTestCli();
  clis.push(cli);
  const data = join(cli.home, ".config", "roamgate");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({ version: 1, archive }),
  );
  return { cli, data };
}

async function run(
  cli: TestCli,
  args: string[],
  options: { gaming?: boolean; ssh?: string } = {},
) {
  cli.output.length = 0;
  cli.errors.length = 0;
  const command = createArchiveCommand({
    gameMode: async () => options.gaming ?? false,
    lowerPriority: () => {},
    ...(options.ssh ? { sshProgram: options.ssh } : {}),
  });
  return runCli(["archive", ...args], cli.context, [command]);
}

const json = (cli: TestCli) => JSON.parse(cli.output.join("\n"));

test("sync writes the text repo; search, status and rebuild-text use it", async () => {
  const { cli } = machine({ host: "desk" });
  const dir = join(cli.home, ".claude", "projects", "-home-t-proj");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${SESSION}.jsonl`),
    `${JSON.stringify({ type: "user", timestamp: "2026-11-14T10:00:00Z", cwd: "/home/t/proj", message: { content: "where is the zebra" } })}\n`,
  );
  expect(await run(cli, ["sync", "--local-only", "--json"])).toBe(0);
  expect(json(cli).text.status).toBe("committed");

  expect(await run(cli, ["search", "zebra", "--json"])).toBe(0);
  const result = json(cli);
  expect([result.source, result.hits[0].session]).toEqual(["text", SESSION]);
  expect(await run(cli, ["search", "zebra"])).toBe(0);
  expect(cli.output.join("\n")).toContain("1 match(es)");
  expect(await run(cli, ["health", "--json"])).toBe(0);
  expect(json(cli).text.files).toBe(1);

  expect(await run(cli, ["status", "--json"])).toBe(0);
  expect(json(cli).text).toMatchObject({ exists: true, files: 1 });

  // GameMode defers the hourly pass and holds a rebuild back.
  expect(
    await run(cli, ["sync", "--local-only", "--json"], { gaming: true }),
  ).toBe(0);
  expect(json(cli).text.status).toBe("deferred");
  expect(await run(cli, ["rebuild-text"], { gaming: true })).toBe(75);
  expect(await run(cli, ["rebuild-text", "--json"])).toBe(0);
  expect(json(cli).text.status).toBe("committed");
});

test("another machine fetches the home's text repo and searches it", async () => {
  const home = machine({ host: "desk" });
  const dir = join(home.cli.home, ".claude", "projects", "-home-t-proj");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${SESSION}.jsonl`),
    `${JSON.stringify({ type: "user", timestamp: "2026-11-14T10:00:00Z", message: { content: "the okapi plan" } })}\n`,
  );
  expect(await run(home.cli, ["sync", "--local-only"])).toBe(0);

  // An ssh stand-in: runs the remote command in the home machine's HOME.
  const other = machine({ host: "mac", remote: "desk" });
  const ssh = join(other.cli.home, "fake-ssh");
  writeFileSync(
    ssh,
    `#!/bin/sh\nfor last; do :; done\ncd '${home.cli.home}' && exec sh -c "$last"\n`,
  );
  chmodSync(ssh, 0o755);
  expect(await run(other.cli, ["fetch-text", "--json"], { ssh })).toBe(0);
  expect(json(other.cli).fetch.updated).toBe(true);
  expect(await run(other.cli, ["search", "okapi", "--json"], { ssh })).toBe(0);
  expect(json(other.cli).hits[0]).toMatchObject({
    session: SESSION,
    host: "desk",
  });
});
