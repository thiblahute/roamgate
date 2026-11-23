import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { passThroughToCore, type RunCore } from "./cli";
import type { Families } from "./protocol";

const families: Families = {
  update: { rpc: [], http: [], files: [], shadow: [], cli: ["update"] },
  test: {
    test: true,
    rpc: [],
    http: [],
    files: [],
    shadow: [],
    cli: ["secret"],
  },
};

function setup(table: unknown, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "rg-pass-"));
  const runtime = join(home, ".config", "roamgate", "runtime");
  mkdirSync(runtime, { recursive: true });
  if (table !== undefined)
    writeFileSync(join(runtime, "owners.json"), JSON.stringify(table));
  const core = join(home, "core");
  writeFileSync(core, "");
  const out: string[] = [];
  const err: string[] = [];
  const runs: { argv: string[]; env: Record<string, string | undefined> }[] =
    [];
  const runCore: RunCore = async (argv, childEnv, output) => {
    runs.push({ argv, env: childEnv });
    output.out("from the core");
    output.err("on its stderr");
    return 3;
  };
  const context = {
    version: "1.2.3",
    runtime: {
      platform: "linux",
      homeDir: home,
      execPath: "/opt/roamgate/roamgate",
      argv: ["/opt/roamgate/roamgate", "update"],
      env: { PATH: "/bin", ...env },
    },
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
  };
  return { home, core, out, err, runs, runCore, context };
}

describe("CLI pass-through", () => {
  test("a Bun family, no table or no family runs in Bun", async () => {
    for (const table of [
      undefined,
      { version: 1, owners: {} },
      { version: 1, owners: { update: "bun" } },
    ]) {
      const run = setup(table);
      expect(
        await passThroughToCore("update", [], run.context, {
          families,
          runCore: run.runCore,
        }),
      ).toBeNull();
      expect(run.runs).toEqual([]);
    }
    const run = setup({ version: 1, owners: { test: "rust" } });
    expect(
      await passThroughToCore("secret", [], run.context, {
        families,
        runCore: run.runCore,
      }),
    ).toBeNull();
    expect(
      await passThroughToCore("doctor", [], run.context, {
        families,
        runCore: run.runCore,
      }),
    ).toBeNull();
  });

  test("a Rust family runs in the table's core with the CLI's facts", async () => {
    const run = setup(undefined);
    writeFileSync(
      join(run.home, ".config", "roamgate", "runtime", "owners.json"),
      JSON.stringify({
        version: 1,
        owners: { update: "rust" },
        core: run.core,
      }),
    );
    const code = await passThroughToCore(
      "update",
      ["--check", "--json"],
      run.context,
      { families, runCore: run.runCore },
    );
    expect(code).toBe(3);
    expect(run.runs[0]!.argv).toEqual([
      run.core,
      "update",
      "--check",
      "--json",
    ]);
    expect(run.runs[0]!.env).toMatchObject({
      PATH: "/bin",
      ROAMGATE_CLI_EXEC: "/opt/roamgate/roamgate",
      ROAMGATE_CLI_VERSION: "1.2.3",
      ROAMGATE_CLI_STANDALONE: "1",
    });
    expect(run.out).toEqual(["from the core"]);
    expect(run.err).toEqual(["on its stderr"]);
  });

  test("ROAMGATE_CORE_BIN wins, and a missing core leaves it to Bun", async () => {
    const run = setup({ version: 1, owners: { update: "rust" } });
    expect(
      await passThroughToCore("update", [], run.context, {
        families,
        runCore: run.runCore,
      }),
    ).toBeNull();
    expect(run.err[0]).toContain("no core binary was found");
    const withBin = setup(
      { version: 1, owners: { update: "rust" }, core: "/nowhere" },
      {},
    );
    withBin.context.runtime.env = {
      ...withBin.context.runtime.env,
      ROAMGATE_CORE_BIN: withBin.core,
    } as never;
    expect(
      await passThroughToCore("update", [], withBin.context, {
        families,
        runCore: withBin.runCore,
      }),
    ).toBe(3);
    expect(withBin.runs[0]!.argv[0]).toBe(withBin.core);
    expect(withBin.runs[0]!.env.ROAMGATE_CORE_BIN).toBeUndefined();
  });
});
