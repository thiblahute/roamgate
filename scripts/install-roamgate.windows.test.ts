import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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

const powershell = () =>
  join(
    process.env.SystemRoot!,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );

/** A Bun executable answering `--version` with `roamgate <version>`, and
 * `wait` by staying up until killed (10 minutes at most). */
function compileFixture(root: string, version: string, outfile: string) {
  const source = join(root, `fixture-${version}.ts`);
  writeFileSync(
    source,
    `if (process.argv[2] === "--version") console.log("roamgate ${version}"); else if (process.argv[2] === "wait") setTimeout(() => {}, 600_000); else process.exit(2);`,
  );
  expect(
    Bun.spawnSync([
      process.execPath,
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      source,
      "--outfile",
      outfile,
    ]).exitCode,
  ).toBe(0);
}

test.skipIf(process.platform !== "win32")(
  "the PowerShell installer verifies, installs beside a running roamgate and keeps the previous one",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "roamgate installer "));
    let host: ReturnType<typeof Bun.serve> | undefined;
    let running: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const arch = Bun.spawnSync([
        powershell(),
        "-NoProfile",
        "-Command",
        "[Runtime.InteropServices.RuntimeInformation]::OSArchitecture",
      ])
        .stdout.toString()
        .trim();
      const platform = `windows-${arch === "Arm64" ? "arm64" : "x64"}`;
      const packageDir = `roamgate-${platform}`;
      const assets = join(root, "assets");
      const installDir = join(root, "install dir");
      const binaries = join(root, "binaries");
      mkdirSync(assets);
      mkdirSync(binaries);
      for (const version of ["1.0.0", "2.0.0"]) {
        compileFixture(root, version, join(binaries, `${version}.exe`));
      }

      /** Packages `version` as the release archive `name`, as xtask does:
       * a zip holding the package directory. */
      const release = (
        name: string,
        version: string,
        options: { pi?: boolean; versionFile?: string; checksum?: string } = {},
      ) => {
        const stage = join(root, `stage-${name}`);
        rmSync(stage, { recursive: true, force: true });
        mkdirSync(join(stage, packageDir), { recursive: true });
        copyFileSync(
          join(binaries, `${version}.exe`),
          join(stage, packageDir, "roamgate.exe"),
        );
        if (options.pi !== false) {
          copyFileSync(
            join(binaries, `${version}.exe`),
            join(stage, packageDir, "roamgate-pi.exe"),
          );
        }
        writeFileSync(
          join(stage, packageDir, "VERSION"),
          options.versionFile ?? `roamgate ${version} ${platform}\n`,
        );
        writeFileSync(
          join(stage, packageDir, "THIRD_PARTY_LICENSES.md"),
          "#\n",
        );
        const archive = join(assets, name);
        rmSync(archive, { force: true });
        expect(
          Bun.spawnSync([
            "tar.exe",
            "-a",
            "-C",
            stage,
            "-cf",
            archive,
            packageDir,
          ]).exitCode,
        ).toBe(0);
        const digest = createHash("sha256")
          .update(readFileSync(archive))
          .digest("hex");
        writeFileSync(
          `${archive}.sha256`,
          `${options.checksum ?? digest}  ${name}\n`,
        );
      };

      let unavailable = false;
      host = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (unavailable) return new Response("unavailable", { status: 503 });
          const name = new URL(request.url).pathname.slice(1);
          const file = join(assets, name);
          return !name.includes("/") && existsSync(file)
            ? new Response(Bun.file(file))
            : new Response("missing", { status: 404 });
        },
      });
      // Spawned, not spawnSync: the mirror answers from this process.
      const install = async (
        environment: Record<string, string | undefined> = {},
      ) => {
        const child = Bun.spawn(
          [
            powershell(),
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            join(import.meta.dir, "install-roamgate.ps1"),
          ],
          {
            env: {
              ...process.env,
              // Windows itself only: no Git Bash tools, no Bun; and Windows
              // PowerShell's own modules, not those of the pwsh that runs
              // the job.
              PATH: `${join(process.env.SystemRoot!, "System32")};${join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0")}`,
              PSModulePath: undefined,
              ROAMGATE_RELEASE_BASE_URL: `http://127.0.0.1:${host!.port}`,
              ROAMGATE_INSTALL_DIR: installDir,
              ROAMGATE_VERSION: undefined,
              ...environment,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      };
      const installed = (name: string) =>
        Bun.spawnSync([join(installDir, name), "--version"])
          .stdout.toString()
          .trim();
      const names = () => readdirSync(installDir).sort();

      // A fresh install of the latest release.
      release(`roamgate-${platform}.zip`, "1.0.0");
      let ran = await install();
      expect(ran.exitCode, ran.stderr).toBe(0);
      expect(ran.stdout).toContain(
        `Installed roamgate 1.0.0 to ${join(installDir, "roamgate.exe")}`,
      );
      expect(names()).toEqual(["roamgate-pi.exe", "roamgate.exe"]);

      // Over a running roamgate.exe: renamed away, not overwritten.
      running = Bun.spawn([join(installDir, "roamgate.exe"), "wait"]);
      release(`roamgate-${platform}.zip`, "2.0.0");
      ran = await install();
      expect(ran.exitCode, ran.stderr).toBe(0);
      expect(names()).toEqual([
        "roamgate-pi.exe",
        "roamgate-pi.exe.previous",
        "roamgate.exe",
        "roamgate.exe.previous",
      ]);
      expect(installed("roamgate.exe")).toBe("roamgate 2.0.0");
      expect(installed("roamgate-pi.exe")).toBe("roamgate 2.0.0");
      expect(installed("roamgate.exe.previous")).toBe("roamgate 1.0.0");

      // A pinned version, from its own archive name. While the old
      // roamgate.exe.previous still runs, it cannot make way: refused,
      // nothing moved.
      release(`roamgate-v1.0.0-${platform}.zip`, "1.0.0");
      ran = await install({ ROAMGATE_VERSION: "1.0.0" });
      expect(ran.exitCode).not.toBe(0);
      expect(ran.stderr).toContain("is in use");
      expect(installed("roamgate.exe")).toBe("roamgate 2.0.0");
      running.kill();
      await running.exited;
      ran = await install({ ROAMGATE_VERSION: "1.0.0" });
      expect(ran.exitCode, ran.stderr).toBe(0);
      expect(installed("roamgate.exe")).toBe("roamgate 1.0.0");

      // Every refusal leaves the installation as it was.
      const before = names().map((name) => [
        name,
        readFileSync(join(installDir, name)).length,
      ]);
      const refusals: [string, () => void, Record<string, string>, string][] = [
        [
          "checksum",
          () =>
            release(`roamgate-${platform}.zip`, "2.0.0", {
              checksum: "0".repeat(64),
            }),
          {},
          "package checksum mismatch",
        ],
        [
          "VERSION",
          () =>
            release(`roamgate-${platform}.zip`, "2.0.0", {
              versionFile: `roamgate 2.0.0 linux-x64\n`,
            }),
          {},
          `package platform is linux-x64, expected ${platform}`,
        ],
        [
          "binary",
          () =>
            release(`roamgate-${platform}.zip`, "2.0.0", {
              versionFile: `roamgate 3.0.0 ${platform}\n`,
            }),
          {},
          "binary version does not match package VERSION",
        ],
        [
          "pinned",
          () => release(`roamgate-v2.0.0-${platform}.zip`, "1.0.0"),
          { ROAMGATE_VERSION: "2.0.0" },
          "package version is 1.0.0, expected 2.0.0",
        ],
        [
          "insecure mirror",
          () => {},
          { ROAMGATE_RELEASE_BASE_URL: "http://example.com/releases" },
          "release base URL must use HTTPS unless the mirror is loopback",
        ],
        [
          "credentials",
          () => {},
          { ROAMGATE_RELEASE_BASE_URL: "https://u:p@example.com/releases" },
          "release base URL must not contain credentials",
        ],
        [
          "bad version",
          () => {},
          { ROAMGATE_VERSION: "1.0.0;rm" },
          "invalid ROAMGATE_VERSION",
        ],
      ];
      for (const [what, prepare, environment, message] of refusals) {
        prepare();
        ran = await install(environment);
        expect(ran.exitCode, what).not.toBe(0);
        expect(ran.stderr, what).toContain(message);
        expect(
          names().map((name) => [
            name,
            readFileSync(join(installDir, name)).length,
          ]),
          what,
        ).toEqual(before);
      }
      unavailable = true;
      ran = await install();
      expect(ran.exitCode).not.toBe(0);
      expect(installed("roamgate.exe")).toBe("roamgate 1.0.0");
    } finally {
      running?.kill();
      await running?.exited;
      host?.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  // An installer run takes 25 s on windows-11-arm.
  900_000,
);
