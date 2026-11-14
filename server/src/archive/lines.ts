import { createReadStream } from "node:fs";

/** One complete line and its length in bytes, newline included. */
export type CompleteLine = { line: Buffer; length: number };

/**
 * Complete lines of a byte stream. A final line with no newline is left
 * out: the writer may still be appending to it. Memory is the longest line.
 */
export async function* completeLines(
  chunks: AsyncIterable<Buffer | Uint8Array>,
): AsyncGenerator<CompleteLine> {
  let pending: Buffer[] = [];
  let pendingLength = 0;
  for await (const raw of chunks) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let from = 0;
    for (;;) {
      const newline = chunk.indexOf(10, from);
      if (newline === -1) {
        if (from < chunk.length) {
          pending.push(chunk.subarray(from));
          pendingLength += chunk.length - from;
        }
        break;
      }
      const tail = chunk.subarray(from, newline);
      const length = pendingLength + tail.length + 1;
      const line =
        pending.length === 0 ? tail : Buffer.concat([...pending, tail]);
      pending = [];
      pendingLength = 0;
      yield { line, length };
      from = newline + 1;
    }
  }
}

/** Bytes [start, end) of a file, in chunks of 1 MiB. */
export function fileRange(
  path: string,
  start: number,
  end: number,
): AsyncIterable<Buffer> {
  return createReadStream(path, {
    start,
    end: end - 1,
    highWaterMark: 1 << 20,
  }) as AsyncIterable<Buffer>;
}
