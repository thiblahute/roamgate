import { createHash, type Hash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Downloads a model file into place: into `<path>.part` first, resumed with
 * a Range request where an earlier download stopped, its SHA-256 checked
 * before it is renamed to `path`. A file already at `path` with the right
 * size is kept (verified with `verify`).
 */

export type DownloadTarget = {
  url: string;
  /** Where it goes. */
  path: string;
  size: number;
  sha256: string;
};

export type DownloadOptions = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Bytes of the file now on disk, called as they arrive. */
  onProgress?: (done: number) => void;
  /** Hash a file already in place, rather than trusting its size. */
  verify?: boolean;
  /** Attempts on network errors, each resuming where the last stopped. */
  attempts?: number;
  /** Wait before an attempt, in ms (tests make it 0). */
  retryDelayMs?: number;
};

export class ChecksumError extends Error {}

export function partPath(path: string): string {
  return `${path}.part`;
}

async function hashFile(path: string, hash: Hash, signal?: AbortSignal) {
  for await (const chunk of createReadStream(path, { signal }))
    hash.update(chunk as Buffer);
}

async function sha256Of(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  await hashFile(path, hash, signal);
  return hash.digest("hex");
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** Whether `path` holds the file, by size, or by checksum with `verify`. */
export async function inPlace(
  target: DownloadTarget,
  verify = false,
  signal?: AbortSignal,
): Promise<boolean> {
  if (sizeOf(target.path) !== target.size) return false;
  return !verify || (await sha256Of(target.path, signal)) === target.sha256;
}

/** One attempt: what the .part has, and the rest from the server. */
async function attempt(
  target: DownloadTarget,
  options: DownloadOptions,
): Promise<void> {
  const part = partPath(target.path);
  let have = sizeOf(part) ?? 0;
  if (have > target.size) {
    await rm(part, { force: true });
    have = 0;
  }
  let hash = createHash("sha256");
  if (have > 0) await hashFile(part, hash, options.signal);
  options.onProgress?.(have);
  if (have < target.size) {
    const response = await (options.fetch ?? fetch)(target.url, {
      redirect: "follow",
      signal: options.signal,
      headers: have > 0 ? { Range: `bytes=${have}-` } : {},
    });
    if (response.status === 416) {
      // The server has no more than the .part: start again from nothing.
      await rm(part, { force: true });
      throw new RetryNow("the download's range was refused");
    }
    if (!response.ok || !response.body)
      throw new Error(`${target.url}: HTTP ${response.status}`);
    if (have > 0 && response.status !== 206) {
      // The whole file came back: what the .part had is written over.
      have = 0;
      hash = createHash("sha256");
      options.onProgress?.(0);
    }
    const file = await open(part, have > 0 ? "a" : "w");
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (have + chunk.length > target.size)
          throw new ChecksumError(
            `${target.url} is larger than the ${target.size} bytes expected`,
          );
        await file.write(chunk);
        hash.update(chunk);
        have += chunk.length;
        options.onProgress?.(have);
      }
    } finally {
      await file.close();
    }
  }
  if (have !== target.size)
    throw new Error(`${target.url} stopped at ${have} of ${target.size} bytes`);
  const digest = hash.digest("hex");
  if (digest !== target.sha256) {
    await rm(part, { force: true });
    throw new ChecksumError(
      `${target.url}: checksum ${digest} is not the expected ${target.sha256}`,
    );
  }
  await rename(part, target.path);
}

/** A failure worth trying again at once (the .part was dropped). */
class RetryNow extends Error {}

export async function downloadFile(
  target: DownloadTarget,
  options: DownloadOptions = {},
): Promise<"downloaded" | "present"> {
  if (await inPlace(target, options.verify, options.signal)) {
    options.onProgress?.(target.size);
    return "present";
  }
  mkdirSync(dirname(target.path), { recursive: true });
  // A file in place of the wrong size or checksum is downloaded again.
  if (existsSync(target.path)) await rm(target.path, { force: true });
  const attempts = options.attempts ?? 4;
  let lastError: unknown;
  for (let tried = 0; tried < attempts; tried += 1) {
    if (options.signal?.aborted) throw options.signal.reason;
    try {
      await attempt(target, options);
      return "downloaded";
    } catch (error) {
      if (error instanceof ChecksumError) {
        await rm(partPath(target.path), { force: true });
        throw error;
      }
      if (options.signal?.aborted) throw error;
      lastError = error;
      if (!(error instanceof RetryNow) && tried + 1 < attempts)
        await Bun.sleep((options.retryDelayMs ?? 2000) * (tried + 1));
    }
  }
  throw lastError;
}
