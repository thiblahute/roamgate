import { expect, test } from "bun:test";
import { imageUploadPending, imageUploadToken } from "./ReviewCommentEditor";

test("a text waits while one of its images uploads", () => {
  expect(imageUploadPending(`Look:\n${imageUploadToken(3)}\nthere`)).toBe(true);
  expect(imageUploadPending("Look:\n![shot](/review/image/a.png)")).toBe(false);
  expect(imageUploadPending("![Adding image soon]()")).toBe(false);
});
