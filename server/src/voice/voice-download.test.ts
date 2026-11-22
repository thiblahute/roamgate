import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChecksumError,
  type DownloadTarget,
  downloadFile,
  partPath,
} from "./voice-download";
import { serveModels } from "./voice-setup-testing";

const server = serveModels();
afterAll(() => server.stop());

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "roamgate-voice-download-"));
  server.requests.length = 0;
  server.ignoreRange = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The fixture's Parakeet encoder, to `dir`. */
function target(): DownloadTarget & { body: Uint8Array } {
  const entry = server.packages.find((p) => p.id === "parakeet-tdt-0.6b-v3")!;
  const file = entry.files.find((f) => f.path === "encoder-model.int8.onnx")!;
  const body = server.bodies.get(new URL(file.url).pathname)!;
  return { ...file, path: join(dir, "sub", file.path), body };
}

describe("downloadFile", () => {
  test("downloads into .part, checks it and puts it in place", async () => {
    const file = target();
    const progress: number[] = [];
    expect(
      await downloadFile(file, { onProgress: (done) => progress.push(done) }),
    ).toBe("downloaded");
    expect(readFileSync(file.path).equals(Buffer.from(file.body))).toBe(true);
    expect(existsSync(partPath(file.path))).toBe(false);
    expect(progress.at(-1)).toBe(file.size);
    expect(server.requests).toEqual([
      { path: new URL(file.url).pathname, range: null },
    ]);
  });

  test("resumes a .part with a Range request", async () => {
    const file = target();
    mkdirSync(join(dir, "sub"));
    writeFileSync(partPath(file.path), file.body.slice(0, 100));
    const progress: number[] = [];
    await downloadFile(file, { onProgress: (done) => progress.push(done) });
    expect(server.requests.map((request) => request.range)).toEqual([
      "bytes=100-",
    ]);
    expect(progress[0]).toBe(100);
    expect(readFileSync(file.path).equals(Buffer.from(file.body))).toBe(true);
  });

  test("a server ignoring Range sends it whole, written over the .part", async () => {
    const file = target();
    server.ignoreRange = true;
    mkdirSync(join(dir, "sub"));
    writeFileSync(partPath(file.path), file.body.slice(0, 100));
    await downloadFile(file);
    expect(readFileSync(file.path).equals(Buffer.from(file.body))).toBe(true);
  });

  test("a connection lost halfway is resumed where it stopped", async () => {
    const file = target();
    server.cutOnce.add(new URL(file.url).pathname);
    await downloadFile(file, { retryDelayMs: 0, fetch: server.fetch });
    const [first, second] = server.requests;
    expect(first?.range).toBeNull();
    expect(second?.range).toMatch(/^bytes=[1-9]\d*-$/);
    expect(readFileSync(file.path).equals(Buffer.from(file.body))).toBe(true);
  });

  test("a wrong checksum fails, nothing left behind", async () => {
    const file = { ...target(), sha256: "0".repeat(64) };
    await expect(
      downloadFile(file, { retryDelayMs: 0 }),
    ).rejects.toBeInstanceOf(ChecksumError);
    expect(existsSync(file.path)).toBe(false);
    expect(existsSync(partPath(file.path))).toBe(false);
    expect(server.requests).toHaveLength(1);
  });

  test("a complete .part is checked without asking the server", async () => {
    const file = target();
    mkdirSync(join(dir, "sub"));
    writeFileSync(partPath(file.path), file.body);
    await downloadFile(file);
    expect(server.requests).toHaveLength(0);
    expect(existsSync(file.path)).toBe(true);
  });

  test("a file in place is kept; verify downloads a corrupted one again", async () => {
    const file = target();
    mkdirSync(join(dir, "sub"));
    const corrupted = new Uint8Array(file.body);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    writeFileSync(file.path, corrupted);
    expect(await downloadFile(file)).toBe("present");
    expect(server.requests).toHaveLength(0);
    expect(await downloadFile(file, { verify: true })).toBe("downloaded");
    expect(readFileSync(file.path).equals(Buffer.from(file.body))).toBe(true);
  });

  test("a missing file fails after its attempts", async () => {
    const file = { ...target(), url: `${server.url}/nothing` };
    await expect(
      downloadFile(file, { retryDelayMs: 0, attempts: 2 }),
    ).rejects.toThrow("HTTP 404");
    expect(server.requests).toHaveLength(2);
  });

  test("an abort stops it, the .part kept for later", async () => {
    const file = target();
    const abort = new AbortController();
    server.cutOnce.add(new URL(file.url).pathname);
    const done = downloadFile(file, {
      fetch: server.fetch,
      signal: abort.signal,
      retryDelayMs: 60_000,
      onProgress: (bytes) => {
        if (bytes > 0) abort.abort(new Error("stop"));
      },
    });
    await expect(done).rejects.toThrow();
    expect(existsSync(file.path)).toBe(false);
    expect(existsSync(partPath(file.path))).toBe(true);
  });
});
