import { describe, expect, test } from "bun:test";
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
import { runBinaryProcessWithTimeout } from "./process";
import { IMAGE_MIME_TYPES } from "../../../shared/filePreview";
import { PREVIEW_IMAGE_MAX_BYTES, PREVIEW_MAX_BYTES } from "./file-constants";
import { FileDownloadError } from "./file-download";
import {
  downloadRemoteFile,
  parseRemoteFileDelete,
  parseRemoteFileDownload,
  parseRemoteFileList,
  parseRemoteFilePreview,
  parseRemoteFileResolutions,
  parseRemoteFileUpload,
  resolveRemoteFilePaths,
  parseRemoteFileStat,
  readRemoteFile,
  statRemoteFile,
} from "./remote-files";

function b64(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

describe("remote file protocol parsers", () => {
  test("parses remote directory listings", () => {
    const result = parseRemoteFileList(
      [
        `ROOT\t${b64("/repo")}`,
        `ENTRY\tfile\t12\t2\t${b64("b.txt")}`,
        `ENTRY\tdirectory\t0\t1\t${b64("src")}`,
        "TRUNCATED",
      ].join("\n"),
      "packages/app",
    );

    expect(result).toEqual({
      root: "/repo",
      path: "packages/app",
      truncated: true,
      entries: [
        {
          name: "src",
          path: "packages/app/src",
          type: "directory",
          size: 0,
          mtime_ms: 1000,
          hidden: false,
        },
        {
          name: "b.txt",
          path: "packages/app/b.txt",
          type: "file",
          size: 12,
          mtime_ms: 2000,
          hidden: false,
        },
      ],
    });
  });

  test("parses text and image previews", () => {
    const text = parseRemoteFilePreview(
      `META\t${b64("/repo")}\t5\t9\t${b64("README.md")}\n${b64("hello")}`,
      "README.md",
    );
    expect(text).toMatchObject({
      root: "/repo",
      path: "README.md",
      text: "hello",
      binary: false,
      size: 5,
      mtime_ms: 9000,
      truncated: false,
    });

    const image = parseRemoteFilePreview(
      `META\t${b64("/repo")}\t3\t1\t${b64("image.png")}\n${b64("png")}`,
      "image.png",
    );
    expect(image).toMatchObject({
      path: "image.png",
      binary: true,
      mime_type: "image/png",
      image_data_url: "data:image/png;base64,cG5n",
    });
  });

  test("never labels a short image payload as complete", () => {
    const bytes = Buffer.alloc(PREVIEW_MAX_BYTES + 1);
    const image = parseRemoteFilePreview(
      `META\t${b64("/repo")}\t${600 * 1024}\t1\t${b64("image.apng")}\n${bytes.toString("base64")}`,
      "image.apng",
    );
    expect(image.truncated).toBe(true);
    expect(image.image_data_url).toBeUndefined();
    expect(image.size).toBe(600 * 1024);
  });

  test("parses directory previews without content", () => {
    const directory = parseRemoteFilePreview(
      `META\t${b64("/repo")}\t0\t9\t${b64("packages/app")}\tdirectory`,
      "packages/app",
    );
    expect(directory).toMatchObject({
      root: "/repo",
      path: "packages/app",
      type: "directory",
      size: 0,
      mtime_ms: 9000,
      text: null,
      binary: false,
      truncated: false,
    });
  });

  test("parses resolved remote files", () => {
    expect(
      parseRemoteFileResolutions(
        [`FILE\t${b64("a/b/c.png")}`, `FILE\t${b64("/tmp/image.png")}`].join(
          "\n",
        ),
      ),
    ).toEqual(["a/b/c.png", "/tmp/image.png"]);
  });

  test("parses download, upload, and delete responses", () => {
    expect(
      parseRemoteFileDownload(
        `META\t4\t${b64("dir/a.txt")}\t${b64("a.txt")}\t${b64("text/plain")}\n${b64("data")}`,
        "dir/a.txt",
      ),
    ).toMatchObject({
      filename: "a.txt",
      path: "dir/a.txt",
      size: 4,
      contentType: "text/plain",
    });
    expect(parseRemoteFileUpload(`META\t${b64("dir/a.txt")}\t4\t1`)).toEqual({
      path: "dir/a.txt",
      size: 4,
      overwritten: true,
    });
    expect(parseRemoteFileDelete(`META\t${b64("dir")}\tdirectory`)).toEqual({
      path: "dir",
      type: "directory",
    });
  });

  test("rejects malformed remote protocol responses", () => {
    expect(() => parseRemoteFilePreview("oops", "x")).toThrow("oops");
    expect(() => parseRemoteFileDownload("oops", "x")).toThrow("oops");
    expect(() => parseRemoteFileUpload("oops")).toThrow("oops");
    expect(() => parseRemoteFileDelete("oops")).toThrow("oops");
  });
});

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

test("remote image previews reject oversized files", () => {
  const oversized = parseRemoteFilePreview(
    `META\t${b64("/repo")}\t${PREVIEW_IMAGE_MAX_BYTES + 1}\t1\t${b64("large.apng")}\n${Buffer.alloc(PREVIEW_MAX_BYTES + 1).toString("base64")}`,
    "large.apng",
  );
  expect(oversized.truncated).toBe(true);
  expect(oversized.image_data_url).toBeUndefined();
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

test("parses a remote stat, and refuses anything else", () => {
  expect(parseRemoteFileStat("STAT\t12\t1700000000\tfile\n")).toEqual({
    type: "file",
    size: 12,
    mtime_ms: 1_700_000_000_000,
  });
  expect(parseRemoteFileStat("motd\nSTAT\t4096\t5\tdirectory\n")).toEqual({
    type: "directory",
    size: 0,
    mtime_ms: 5000,
  });
  expect(() => parseRemoteFileStat("nope")).toThrow("nope");
});
