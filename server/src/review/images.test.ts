import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewImageFile, saveReviewImage } from "./images";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

test("a pasted image is kept with its review, named by its content", () => {
  const directory = mkdtempSync(join(tmpdir(), "rg-images-"));
  directories.push(directory);
  const path = saveReviewImage(directory, "0123456789abcdef", "image/png", PNG);
  expect(path).toMatch(
    new RegExp(`^${directory}/images/0123456789abcdef/[0-9a-f]{16}\\.png$`),
  );
  expect(readFileSync(path)).toEqual(Buffer.from(PNG));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  // The same image again is the same file.
  expect(saveReviewImage(directory, "0123456789abcdef", "image/png", PNG)).toBe(
    path,
  );

  const name = path.slice(path.lastIndexOf("/") + 1);
  expect(reviewImageFile(directory, "0123456789abcdef", name)).toEqual({
    path,
    type: "image/png",
  });
});

test("only real images, and no way out of the review's folder", () => {
  const directory = mkdtempSync(join(tmpdir(), "rg-images-"));
  directories.push(directory);
  expect(() =>
    saveReviewImage(directory, "0123456789abcdef", "image/svg+xml", PNG),
  ).toThrow("only PNG");
  expect(() =>
    saveReviewImage(
      directory,
      "0123456789abcdef",
      "image/jpeg",
      new Uint8Array([1, 2, 3, 4]),
    ),
  ).toThrow("not a JPG");
  expect(() =>
    saveReviewImage(directory, "../../etc", "image/png", PNG),
  ).toThrow("no such review");
  expect(reviewImageFile(directory, "0123456789abcdef", "../x.png")).toBe(null);
  expect(reviewImageFile(directory, "..", "0123456789abcdef.png")).toBe(null);
});
