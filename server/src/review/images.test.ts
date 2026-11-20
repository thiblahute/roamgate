import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localImageFile,
  pruneReviewImages,
  reviewImageFile,
  saveReviewImage,
} from "./images";

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

test("pruning removes the images of gone reviews only", () => {
  const directory = mkdtempSync(join(tmpdir(), "rg-images-"));
  directories.push(directory);
  const live = "0123456789abcdef";
  const gone = "fedcba9876543210";
  const kept = saveReviewImage(directory, live, "image/png", PNG);
  const removed = saveReviewImage(directory, gone, "image/png", PNG);
  // A folder not named as a review id is never touched.
  const notes = join(directory, "images", "notes");
  mkdirSync(notes);
  writeFileSync(join(notes, "keep.txt"), "mine\n");

  expect(pruneReviewImages(directory, new Set([live]))).toEqual([gone]);
  expect(existsSync(kept)).toBe(true);
  expect(existsSync(removed)).toBe(false);
  expect(existsSync(join(directory, "images", gone))).toBe(false);
  expect(readFileSync(join(notes, "keep.txt"), "utf8")).toBe("mine\n");
  // Nothing left to remove, and no images folder at all, is fine.
  expect(pruneReviewImages(directory, new Set([live]))).toEqual([]);
  expect(pruneReviewImages(join(directory, "none"), new Set())).toEqual([]);
});

test("an agent's image by its path: only image files, by their bytes", async () => {
  const folder = mkdtempSync(join(tmpdir(), "review-local-image-"));
  try {
    const shot = join(folder, "shot.png");
    writeFileSync(shot, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]));
    const named = join(folder, "secret.png");
    writeFileSync(named, "not an image");
    const webp = join(folder, "a.webp");
    writeFileSync(webp, Buffer.from("RIFF\0\0\0\0WEBPVP8 "));
    const wav = join(folder, "b.webp");
    writeFileSync(wav, Buffer.from("RIFF\0\0\0\0WAVEfmt "));
    expect(await localImageFile(shot)).toEqual({
      path: shot,
      type: "image/png",
    });
    expect(await localImageFile(webp)).toEqual({
      path: webp,
      type: "image/webp",
    });
    expect(await localImageFile(named)).toBeNull();
    expect(await localImageFile(wav)).toBeNull();
    expect(await localImageFile(join(folder, "gone.png"))).toBeNull();
    expect(await localImageFile("shot.png")).toBeNull();
    expect(await localImageFile(folder)).toBeNull();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
