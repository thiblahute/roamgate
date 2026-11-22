import { expect, test } from "bun:test";
import {
  takeWorkImage,
  workAddPayload,
  workImageMarkdown,
} from "./WorkAddForm";

test("an image taken into the form is named by its token; the add call carries the ones the text kept, as base64", async () => {
  const shot = new File([new Uint8Array([1, 2, 3])], "image.png", {
    type: "image/png",
  });
  const named = new File([new Uint8Array([4])], "a [photo].jpg", {
    type: "image/jpeg",
  });
  const first = await takeWorkImage(shot, "work-image:1");
  const second = await takeWorkImage(named, "work-image:2");
  expect(workImageMarkdown(first)).toBe("![screenshot](<work-image:1>)");
  expect(workImageMarkdown(second)).toBe("![a photo.jpg](<work-image:2>)");
  // The second image was deleted from the text: not sent.
  const payload = workAddPayload("  See ![screenshot](<work-image:1>) here  ", [
    first,
    second,
  ]);
  expect(payload).toEqual({
    text: "See ![screenshot](<work-image:1>) here",
    images: [{ token: "work-image:1", type: "image/png", data: "AQID" }],
  });
  // No words: nothing but the title goes.
  expect(workAddPayload("   ", [first])).toEqual({});
});

test("an image is read when taken: a file the page can no longer read fails then, saying so, not at Add", async () => {
  const shot = new File([new Uint8Array([1])], "18303.png", {
    type: "image/png",
  });
  // Chrome on Android: the picker's file is unreadable a while later.
  let reads = 0;
  Object.defineProperty(shot, "arrayBuffer", {
    value: () => {
      reads++;
      return Promise.reject(
        new DOMException(
          "The requested file could not be read",
          "NotReadableError",
        ),
      );
    },
  });
  await expect(takeWorkImage(shot, "work-image:1")).rejects.toThrow(
    "the image could not be read (The requested file could not be read)",
  );
  expect(reads).toBe(1);
  // Not an image, too large: refused before reading.
  await expect(
    takeWorkImage(new File(["x"], "a.txt", { type: "text/plain" }), "t"),
  ).rejects.toThrow("not an image");
  const big = new File([new Uint8Array(1)], "big.png", { type: "image/png" });
  Object.defineProperty(big, "size", { value: 11 * 1024 * 1024 });
  await expect(takeWorkImage(big, "t")).rejects.toThrow(
    "an image is at most 10 MiB",
  );
});
