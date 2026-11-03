import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTimeReportSettings } from "../config/gui-settings";
import { ProviderError, runProvider } from "./provider";

const dir = mkdtempSync(join(tmpdir(), "roamgate-provider-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A provider that does what its first argument says, and logs its call. */
const script = join(dir, "provider.sh");
const log = join(dir, "calls.log");
writeFileSync(
  script,
  `#!/bin/sh
input=$(cat)
printf '%s|%s|%s|%s\\n' "$*" "$input" "$PWD" "$(ls -A | wc -l | tr -d ' ')" >> ${JSON.stringify(log)}
case "$2" in
  health) printf '{"ok":true,"provider":"Fake"}\\n' ;;
  slow) sleep 5 ;;
  invalid) printf '{"error":"end before start","code":"invalid"}\\n' >&2; exit 2 ;;
  upstream) printf '{"results":[{"block_id":"b1","ok":true}]}\\n'; printf '{"error":"Olmo is down","code":"upstream"}\\n' >&2; exit 6 ;;
  bare) echo "boom" >&2; exit 3 ;;
  silent) ;;
  echo) printf '%s\\n' "$input" ;;
esac
`,
  { mode: 0o755 },
);
/** The error a run fails with. */
async function failure(run: Promise<unknown>): Promise<ProviderError> {
  try {
    await run;
  } catch (error) {
    return error as ProviderError;
  }
  throw new Error("the run did not fail");
}

const settings = (timeout = 60) => ({
  command: ["/bin/sh", script, "provider"],
  timeout_seconds: timeout,
});

test("the operation follows the command; the body goes on stdin; an empty directory", async () => {
  expect(await runProvider(settings(), ["health"], undefined)).toEqual({
    ok: true,
    provider: "Fake",
  });
  expect(
    await runProvider(settings(), ["echo", "2026-11-03"], { date: "x" }),
  ).toEqual({ date: "x" });
  const [first, second] = readFileSync(log, "utf8").trim().split("\n");
  const [args, input, cwd, entries] = first!.split("|");
  expect(args).toBe("provider health");
  expect(input).toBe("");
  expect(entries).toBe("0");
  // The directory is gone after the run.
  expect(existsSync(cwd!)).toBe(false);
  expect(second!.split("|").slice(0, 2)).toEqual([
    "provider echo 2026-11-03",
    '{"date":"x"}',
  ]);
});

test("a hung provider is killed at the timeout", async () => {
  const started = Date.now();
  const error = await failure(runProvider(settings(0.3), ["slow"], undefined));
  expect(error).toBeInstanceOf(ProviderError);
  expect(error.code).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(3_000);
});

test("errors carry the provider's message and code, and submit's partial result", async () => {
  const invalid = await failure(runProvider(settings(), ["invalid"], {}));
  expect([invalid.message, invalid.code, invalid.exitCode]).toEqual([
    "end before start",
    "invalid",
    2,
  ]);
  const upstream = await failure(runProvider(settings(), ["upstream"], {}));
  expect(upstream.code).toBe("upstream");
  expect(upstream.partial).toEqual({ results: [{ block_id: "b1", ok: true }] });
  const bare = await failure(runProvider(settings(), ["bare"], {}));
  expect([bare.message, bare.code]).toEqual(["boom", "not_found"]);
  const silent = await failure(runProvider(settings(), ["silent"], {}));
  expect(silent.message).toBe("The provider printed no JSON.");
});

test("a missing command says so", async () => {
  const error = await failure(
    runProvider(
      { command: [join(dir, "nope")], timeout_seconds: 5 },
      ["health"],
      undefined,
    ),
  );
  expect(error).toBeInstanceOf(ProviderError);
  expect(error.message).toContain("not found");
});

test("only a runnable command is a provider setting", () => {
  expect(normalizeTimeReportSettings(undefined)).toBeNull();
  expect(normalizeTimeReportSettings({ command: [] })).toBeNull();
  expect(normalizeTimeReportSettings({ command: "olmo" })).toBeNull();
  expect(normalizeTimeReportSettings({ command: ["a", 3] })).toBeNull();
  expect(
    normalizeTimeReportSettings({ command: ["olmo", "provider"] }),
  ).toEqual({ command: ["olmo", "provider"], timeout_seconds: 60 });
  expect(
    normalizeTimeReportSettings({ command: ["o"], timeout_seconds: 1 })
      ?.timeout_seconds,
  ).toBe(60);
});
