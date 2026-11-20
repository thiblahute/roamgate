import { expect, test } from "bun:test";
import { reviewImageUrl } from "./ReviewNoteBody";

test("a comment's images: pasted ones, and an agent's by their path here", () => {
  expect(
    reviewImageUrl(
      "/home/u/.local/state/roamgate/reviews/images/0123456789abcdef/fedcba9876543210.png",
    ),
  ).toBe(
    "/api/review/image?session=0123456789abcdef&name=fedcba9876543210.png",
  );
  // A screenshot an agent took, named by its absolute path.
  expect(reviewImageUrl("/tmp/shots/login%20page.PNG")).toBe(
    `/api/review/image?path=${encodeURIComponent("/tmp/shots/login page.PNG")}`,
  );
  expect(reviewImageUrl("/var/tmp/a.jpeg")).toBe(
    `/api/review/image?path=${encodeURIComponent("/var/tmp/a.jpeg")}`,
  );
  // Not files here: the web, a forge's upload, a protocol-relative URL,
  // a relative path, anything not an image.
  expect(reviewImageUrl("https://tracker.example/pixel.png")).toBeNull();
  expect(
    reviewImageUrl("/uploads/0123456789abcdef0123456789abcdef/shot.png"),
  ).toBeNull();
  expect(reviewImageUrl("//evil.example/x.png")).toBeNull();
  expect(reviewImageUrl("shots/a.png")).toBeNull();
  expect(reviewImageUrl("/etc/passwd")).toBeNull();
});
