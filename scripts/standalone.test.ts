import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import serverPackage from "../server/package.json";
import rootPackage from "../package.json";

async function run(argv: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(argv, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("standalone OAuth keeps the SDK undici override aligned with the server", () => {
  expect(rootPackage.overrides.undici).toBe(serverPackage.dependencies.undici);
});

test("standalone Ranger emits Kimi device codes and saves OAuth credentials in either store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "roamgate-oauth-"));
  const entry = join(dir, "oauth.ts");
  const binary = join(
    dir,
    process.platform === "win32" ? "oauth.exe" : "oauth",
  );
  try {
    await Bun.write(
      entry,
      `
import { join } from "node:path";
import { createPiDriver } from ${JSON.stringify(fileURLToPath(new URL("../server/src/assistant/pi-driver.ts", import.meta.url)))};
const directory = join(process.cwd(), "ranger");
const driver = createPiDriver(directory);
const events = [];
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push(String(url));
  if (String(url) === "https://kimi.test/api/oauth/device_authorization") {
    return Response.json({ device_code: "synthetic-device", user_code: "TEST-CODE",
      verification_uri: "https://kimi.test/device", verification_uri_complete: "https://kimi.test/device?code=TEST-CODE",
      interval: 0.001, expires_in: 60 });
  }
  if (String(url) === "https://kimi.test/api/oauth/token" &&
      new URLSearchParams(options.body).get("device_code") === "synthetic-device") {
    return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600 });
  }
  throw new Error("Unexpected OAuth request: " + url);
};
try {
  for (const source of ["assistant", "pi"]) {
    await driver.login("kimi-coding", "oauth", {
      credential_source: source, signal: new AbortController().signal,
      prompt: async () => { throw new Error("Device login must not prompt"); },
      notify: event => events.push({ source, ...event }),
    });
    const catalog = await driver.catalog(source);
    if (!catalog.providers.find(provider => provider.id === "kimi-coding")?.configured) {
      throw new Error("OAuth credential is not configured in " + source);
    }
  }
  const credentials = await Promise.all([directory, process.env.PI_CODING_AGENT_DIR].map(async path =>
    (await Bun.file(join(path, "auth.json")).json())["kimi-coding"]));
  console.log(JSON.stringify({ standalone: Bun.isStandaloneExecutable, events, requests, credentials }));
} finally { await driver.dispose(); }
`,
    );
    const build = await run(
      [
        process.execPath,
        "build",
        "--compile",
        "--minify",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        entry,
        "--outfile",
        binary,
      ],
      dir,
    );
    expect(build.code, build.stderr).toBe(0);
    await rm(entry);
    const execution = await run([binary], dir, {
      ...process.env,
      PI_CODING_AGENT_DIR: join(dir, "pi"),
      PI_OFFLINE: "1",
      KIMI_CODE_OAUTH_HOST: "https://kimi.test",
    });
    expect(execution.code, execution.stderr).toBe(0);
    const result = JSON.parse(execution.stdout.trim().split("\n").at(-1)!);
    expect(result.standalone).toBe(true);
    expect(result.events).toEqual(
      ["assistant", "pi"].map((source) => ({
        source,
        type: "device_code",
        userCode: "TEST-CODE",
        verificationUri: "https://kimi.test/device?code=TEST-CODE",
        intervalSeconds: 0.001,
        expiresInSeconds: 60,
      })),
    );
    expect(result.requests).toEqual([
      "https://kimi.test/api/oauth/device_authorization",
      "https://kimi.test/api/oauth/token",
      "https://kimi.test/api/oauth/device_authorization",
      "https://kimi.test/api/oauth/token",
    ]);
    for (const credential of result.credentials) {
      expect(credential).toMatchObject({
        type: "oauth",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 45_000);
