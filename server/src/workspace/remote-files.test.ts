import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBinaryProcessWithTimeout, spawnStreamingProcess } from "./process";
import { IMAGE_MIME_TYPES } from "../../../shared/filePreview";
import { FileDownloadError } from "./file-download";
import {
  downloadRemoteFile,
  resolveRemoteFilePaths,
  readRemoteFile,
  statRemoteFile,
} from "./remote-files";
import { standInHostHome } from "../test-environment";
import { runVectors } from "../../../contract/vectors/vectors";
import * as remoteFiles from "./remote-files";

standInHostHome();

// Execute the exact remote shell command locally, without an SSH server.
test.each([...IMAGE_MIME_TYPES])(
  "remote image reads support %s (%s) within preview byte limits",
  async (extension, mime) => {
    const root = await mkdtemp(join(tmpdir(), "roamgate-image-preview-"));
    try {
      const bytes = Buffer.alloc(600 * 1024, 65);
      const path = `image.${extension.toUpperCase()}`;
      await writeFile(join(root, path), bytes);
      const result = await readRemoteFile({
        host: "example.invalid",
        rootPath: root,
        requestedPath: path,
        shQuote: (value) => "'" + value.replace(/'/g, "'\"'\"'") + "'",
        runProcessWithCodeTimeout: async (argv, timeout) => {
          const result = await runBinaryProcessWithTimeout(
            ["bash", "-c", argv[argv.length - 1]!],
            timeout,
          );
          return { ...result, stdout: result.stdout.toString("utf8") };
        },
      });
      expect(result.truncated).toBe(false);
      expect(result.mime_type).toBe(mime);
      const encoded = result.image_data_url?.split(",")[1] ?? "";
      expect(Buffer.from(encoded, "base64").equals(bytes)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("remote downloads refuse a file over maxBytes before sending it", async () => {
  const root = await mkdtemp(join(tmpdir(), "roamgate-download-max-"));
  try {
    await writeFile(join(root, "small.glb"), Buffer.alloc(1000, 1));
    await writeFile(join(root, "big.glb"), Buffer.alloc(1001, 2));
    let sent = 0;
    const read = (path: string) =>
      downloadRemoteFile({
        host: "example.invalid",
        rootPath: root,
        requestedPath: path,
        shQuote: (value) => "'" + value.replace(/'/g, "'\"'\"'") + "'",
        runProcessWithCodeTimeout: async (argv, timeout) => {
          const result = await runBinaryProcessWithTimeout(
            ["bash", "-c", argv[argv.length - 1]!],
            timeout,
          );
          sent = result.stdout.length;
          return { ...result, stdout: result.stdout.toString("utf8") };
        },
        options: { maxBytes: 1000 },
      });
    const small = await read("small.glb");
    expect(small.size).toBe(1000);
    const body = Buffer.from(await new Response(small.body).arrayBuffer());
    expect(body.equals(Buffer.alloc(1000, 1))).toBe(true);
    const refused = await read("big.glb").catch((error) => error);
    expect(refused).toBeInstanceOf(FileDownloadError);
    expect(refused.status).toBe(413);
    expect(refused.size).toBe(1001);
    expect(sent).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a remote file that changes size while it is sent is never sent short or long", async () => {
  const root = await mkdtemp(join(tmpdir(), "roamgate-download-stream-"));
  try {
    await writeFile(join(root, "app.apk"), Buffer.alloc(1000, 1));
    const shQuote = (value: string) =>
      "'" + value.replace(/'/g, "'\"'\"'") + "'";
    const read = (rewrite: Buffer) =>
      downloadRemoteFile({
        host: "example.invalid",
        rootPath: root,
        requestedPath: "app.apk",
        shQuote,
        runProcessWithCodeTimeout: async (argv, timeout) => {
          const result = await runBinaryProcessWithTimeout(
            ["bash", "-c", argv[argv.length - 1]!],
            timeout,
          );
          return { ...result, stdout: result.stdout.toString("utf8") };
        },
        streamProcess: async (argv) => {
          // Rebuilt between its metadata and its bytes.
          await writeFile(join(root, "app.apk"), rewrite);
          return spawnStreamingProcess(["bash", "-c", argv[argv.length - 1]!]);
        },
      });
    const same = await read(Buffer.alloc(1000, 2));
    expect(same.size).toBe(1000);
    expect(
      Buffer.from(await new Response(same.body).arrayBuffer()).equals(
        Buffer.alloc(1000, 2),
      ),
    ).toBe(true);
    await writeFile(join(root, "app.apk"), Buffer.alloc(1000, 1));
    const changed = await read(Buffer.alloc(2000, 3)).catch((error) => error);
    expect(changed).toBeInstanceOf(Error);
    expect((changed as Error).message).toBe("File changed during download");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote resolution includes directories but rejects relative and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-gui-resolve-"));
  try {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "guide.md"), "guide");
    await symlink(join(root, ".."), join(root, "outside"));
    const result = await resolveRemoteFilePaths({
      host: "example.invalid",
      rootPath: root,
      requestedPaths: [
        "docs/guide.md",
        "docs",
        join(root, "docs"),
        "missing",
        "..",
        "outside",
        join(root, ".."),
      ],
      shQuote: (value) => "'" + value.replace(/'/g, "'\"'\"'") + "'",
      runProcessWithCodeTimeout: async (argv, timeout) => {
        const result = await runBinaryProcessWithTimeout(
          ["bash", "-c", argv[argv.length - 1]!],
          timeout,
        );
        return { ...result, stdout: result.stdout.toString("utf8") };
      },
    });
    expect(result).toEqual([
      "docs/guide.md",
      "docs",
      join(root, "docs"),
      join(root, ".."),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a sibling checkout's page reads and downloads by its path, with macOS's base64", async () => {
  const top = await mkdtemp(join(tmpdir(), "roamgate-sibling-"));
  try {
    const here = join(top, "instalador");
    const sibling = join(top, "planos-3d");
    await mkdir(here, { recursive: true });
    await mkdir(join(sibling, "out"), { recursive: true });
    const page = "<!doctype html><title>casa</title>";
    await writeFile(join(sibling, "out", "casa.html"), page);
    // macOS's base64 takes no file operand (only -i or stdin).
    const shims = join(top, "bin");
    await mkdir(shims);
    const real = Bun.which("base64")!;
    await writeFile(
      join(shims, "base64"),
      `#!/bin/sh\nfor a in "$@"; do case "$a" in -*) ;; *) echo "base64: invalid argument $a" >&2; exit 64 ;; esac; done\nexec ${real} "$@"\n`,
    );
    await chmod(join(shims, "base64"), 0o755);
    const shQuote = (value: string) =>
      "'" + value.replace(/'/g, "'\"'\"'") + "'";
    const run = async (argv: string[], timeout: number) => {
      const result = await runBinaryProcessWithTimeout(
        [
          "env",
          `PATH=${shims}:${process.env.PATH}`,
          "bash",
          "-c",
          argv[argv.length - 1]!,
        ],
        timeout,
      );
      return { ...result, stdout: result.stdout.toString("utf8") };
    };
    // file.read in another workspace: the absolute path, not one under it.
    const file = join(sibling, "out", "casa.html");
    const preview = await readRemoteFile({
      host: "example.invalid",
      rootPath: here,
      requestedPath: file,
      runProcessWithCodeTimeout: run,
      shQuote,
    });
    expect(preview.path).toBe(file);
    expect(preview.text).toBe(page);
    // The rendered page reads it from its own root.
    const download = await downloadRemoteFile({
      host: "example.invalid",
      rootPath: sibling,
      requestedPath: "out/casa.html",
      runProcessWithCodeTimeout: run,
      shQuote,
      options: { maxBytes: 1024 },
    });
    expect(await new Response(download.body).text()).toBe(page);
  } finally {
    await rm(top, { recursive: true, force: true });
  }
});

test("a file's stat on the host compares with what its read gave, and stays in the checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "roamgate-remote-stat-"));
  const run = {
    host: "example.invalid",
    rootPath: root,
    shQuote: (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'",
    runProcessWithCodeTimeout: async (argv: string[], timeout: number) => {
      const result = await runBinaryProcessWithTimeout(
        ["bash", "-c", argv[argv.length - 1]!],
        timeout,
      );
      return { ...result, stdout: result.stdout.toString("utf8") };
    },
  };
  try {
    await writeFile(join(root, "notes.md"), "# Notes\n");
    const read = await readRemoteFile({ ...run, requestedPath: "notes.md" });
    const stat = await statRemoteFile({ ...run, requestedPath: "notes.md" });
    expect(stat).toEqual({
      type: "file",
      size: read.size,
      mtime_ms: read.mtime_ms,
    });
    await writeFile(join(root, "notes.md"), "# Notes, longer now\n");
    const after = await statRemoteFile({ ...run, requestedPath: "notes.md" });
    expect(after.size).not.toBe(read.size);
    await expect(
      statRemoteFile({ ...run, requestedPath: "../outside.md" }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file not on the host is said plainly, not as realpath's error", async () => {
  const root = await mkdtemp(join(tmpdir(), "roamgate-remote-missing-"));
  try {
    const missing = join(root, "..", `gone-${Date.now()}`, "rfcs", "a.md");
    const message = await readRemoteFile({
      host: "example.invalid",
      rootPath: root,
      requestedPath: missing,
      shQuote: (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'",
      runProcessWithCodeTimeout: async (argv: string[], timeout: number) => {
        const result = await runBinaryProcessWithTimeout(
          ["bash", "-c", argv[argv.length - 1]!],
          timeout,
        );
        return { ...result, stdout: result.stdout.toString("utf8") };
      },
    }).catch((error: Error) => error.message);
    expect(message).toBe(
      `${missing} was not found: no such file on this host (or its repository is not checked out at this path).`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The cases are contract/vectors/remote-files.json, the Rust side's too.
runVectors("remote-files", { "remote-files": remoteFiles });
