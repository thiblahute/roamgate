import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { sshReadCommandArgv } from "../bridge/ssh-command";
import { assertInsideRoot, relativePreviewPath } from "./file-paths";
import type { RunProcessWithCodeTimeout } from "./file-types";
import { PREVIEW_TIMEOUT_MS } from "./file-constants";
import { HTML_PREVIEW_FILES_SH, fillTemplate } from "../assets";

export class HtmlPreviewError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type PreviewResource = { path: string; bytes: Buffer };

// The extra byte detects growth after stat without reading the entire file.
export async function readHtmlPreviewFile({
  rootPath,
  path,
  limit,
  host,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  rootPath: string;
  path: string;
  limit: number;
  host?: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}): Promise<PreviewResource> {
  if (host) {
    const command = fillTemplate(HTML_PREVIEW_FILES_SH, {
      root: shQuote(rootPath),
      path: shQuote(path),
      limit,
      limit_after: limit + 1,
    });
    const result = await runProcessWithCodeTimeout(
      sshReadCommandArgv(host, `bash -lc ${shQuote(command)}`),
      PREVIEW_TIMEOUT_MS,
    );
    if (result.code === 15)
      throw new HtmlPreviewError("Preview file is too large", 413);
    if (result.code !== 0)
      throw new HtmlPreviewError("Unable to read HTML preview file");
    const separator = result.stdout.indexOf("\n");
    if (separator < 0)
      throw new HtmlPreviewError("Invalid HTML preview response");
    const bytes = Buffer.from(result.stdout.slice(separator + 1), "base64");
    if (bytes.length > limit)
      throw new HtmlPreviewError("Preview file is too large", 413);
    return {
      path: Buffer.from(result.stdout.slice(0, separator), "base64").toString(
        "utf8",
      ),
      bytes,
    };
  }

  const rootReal = await realpath(rootPath);
  const targetReal = await realpath(
    isAbsolute(path) ? path : resolve(rootReal, path),
  );
  assertInsideRoot(rootReal, targetReal);
  const file = await open(
    targetReal,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (!info.isFile())
      throw new HtmlPreviewError("HTML preview requires a regular file");
    if (info.size > limit)
      throw new HtmlPreviewError("Preview file is too large", 413);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit)
      throw new HtmlPreviewError("Preview file is too large", 413);
    return {
      path: relativePreviewPath(rootReal, targetReal),
      bytes: Buffer.from(buffer.subarray(0, length)),
    };
  } finally {
    await file.close();
  }
}
