import { describe, expect, test } from "bun:test";
import { terminalPathText } from "./terminal-path-text";
import { runVectors } from "../../../contract/vectors/vectors";
import * as terminalPathTextModule from "./terminal-path-text";

describe("terminal path text", () => {
  test.skipIf(process.platform === "win32")(
    "POSIX shell receives each supported path as one unchanged argument",
    () => {
      for (const [path, platform] of [
        ["/tmp/John,Doe/img.png", "linux"],
        ["/tmp/John Doe/img.png", "linux"],
        ["/tmp/O'B$n/img.png", "linux"],
        ["C:\\Users\\John,Doe\\img.png", "win32"],
        ["C:\\Users\\John Doe\\img.png", "win32"],
        ["C:\\Users\\O'Brien\\img.png", "win32"],
      ] as const) {
        const result = Bun.spawnSync([
          "sh",
          "-c",
          `printf '%s\\n' ${terminalPathText(path, platform)}`,
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toBe(
          `${platform === "win32" ? path.replaceAll("\\", "/") : path}\n`,
        );
      }
    },
  );

  test.skipIf(process.platform !== "win32")(
    "PowerShell receives comma and quoted paths as one unchanged argument",
    () => {
      const paths = [
        "C:\\Users\\John,Doe\\img.png",
        "C:\\Users\\John Doe\\img.png",
        "C:\\Users\\O'Brien\\img.png",
        "C:\\Users\\O'B$n\\img.png",
        "C:\\Users\\O'B`n\\img.png",
      ];
      const script = paths
        .map(
          (path) =>
            `ConvertTo-Json -Compress -InputObject @(Write-Output ${terminalPathText(path, "win32")})`,
        )
        .join("\n");
      const result = Bun.spawnSync([
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ]);
      expect(result.exitCode).toBe(0);
      expect(
        result.stdout
          .toString()
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line)),
      ).toEqual(paths.map((path) => [path.replaceAll("\\", "/")]));
    },
    30_000,
  );
});

// The cases are contract/vectors/terminal-path-text.json, the Rust side's too.
runVectors("terminal-path-text", {
  "terminal-path-text": terminalPathTextModule,
});
