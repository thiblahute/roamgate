import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

const LEVEL = 10;

export type FrameResult = { bytes: number; sha256: string; zstBytes: number };

/**
 * Compress source bytes [start, end) as one zstd frame appended to `dest`
 * (frames concatenate into one valid stream), with a content checksum, then
 * decompress the new frame and compare length and SHA-256 with the input.
 * On any failure `dest` is cut back to its old length. Returns the sizes.
 */
export async function appendFrame(
  source: string,
  start: number,
  end: number,
  dest: string,
): Promise<FrameResult> {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  let before = 0;
  try {
    before = statSync(dest).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return appendFrameAt(source, start, end, dest, before);
}

/** As appendFrame, with `dest` first cut to `keep` bytes (crash recovery). */
export async function appendFrameAt(
  source: string,
  start: number,
  end: number,
  dest: string,
  keep: number,
): Promise<FrameResult> {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const fd = openSync(dest, "a+", 0o600);
  try {
    ftruncateSync(fd, keep);
  } finally {
    closeSync(fd);
  }
  const input = createHash("sha256");
  let digest: string | undefined;
  const inputHex = () => (digest ??= input.digest("hex"));
  let bytes = 0;
  try {
    if (end > start) {
      const compress = zlib.createZstdCompress({
        params: {
          [zlib.constants.ZSTD_c_compressionLevel]: LEVEL,
          [zlib.constants.ZSTD_c_checksumFlag]: 1,
        },
      });
      await pipeline(
        createReadStream(source, {
          start,
          end: end - 1,
          highWaterMark: 1 << 20,
        }),
        async function* (chunks) {
          for await (const chunk of chunks as AsyncIterable<Buffer>) {
            input.update(chunk);
            bytes += chunk.length;
            yield chunk;
          }
        },
        compress,
        createWriteStream(dest, { flags: "a", mode: 0o600 }),
      );
    }
    const after = statSync(dest).size;
    const syncFd = openSync(dest, "r");
    try {
      fsyncSync(syncFd);
    } finally {
      closeSync(syncFd);
    }
    if (end > start) {
      const output = createHash("sha256");
      let verified = 0;
      await pipeline(
        createReadStream(dest, { start: keep, end: after - 1 }),
        zlib.createZstdDecompress(),
        async (chunks: AsyncIterable<Buffer>) => {
          for await (const chunk of chunks) {
            output.update(chunk);
            verified += chunk.length;
          }
        },
      );
      if (verified !== bytes || output.digest("hex") !== inputHex())
        throw new Error(`verification mismatch for ${dest}`);
    }
    return { bytes, sha256: inputHex(), zstBytes: after - keep };
  } catch (error) {
    const cut = openSync(dest, "a+");
    try {
      ftruncateSync(cut, keep);
    } finally {
      closeSync(cut);
    }
    throw error;
  }
}

/** The decompressed bytes of an archived file, streamed. */
export function readArchived(path: string): AsyncIterable<Buffer> {
  const decompress = zlib.createZstdDecompress();
  const file = createReadStream(path, { highWaterMark: 1 << 20 });
  file.on("error", (error) => decompress.destroy(error));
  return file.pipe(decompress) as unknown as AsyncIterable<Buffer>;
}

/** Decompress the whole archived file to compare with a size and SHA-256. */
export async function archivedDigest(
  path: string,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of readArchived(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}
