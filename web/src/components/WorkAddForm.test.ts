import { expect, test } from "bun:test";
import { workAddPayload, workImageMarkdown } from "./WorkAddForm";

test("an image taken into the form is named by its token; the add call carries the ones the text kept, as base64", async () => {
  const shot = new File([new Uint8Array([1, 2, 3])], "image.png", {
    type: "image/png",
  });
  const named = new File([new Uint8Array([4])], "a [photo].jpg", {
    type: "image/jpeg",
  });
  const first = { token: "work-image:1", file: shot };
  const second = { token: "work-image:2", file: named };
  expect(workImageMarkdown(first)).toBe("![screenshot](<work-image:1>)");
  expect(workImageMarkdown(second)).toBe("![a photo.jpg](<work-image:2>)");
  // The second image was deleted from the text: not sent.
  const payload = await workAddPayload(
    "  See ![screenshot](<work-image:1>) here  ",
    [first, second],
  );
  expect(payload).toEqual({
    text: "See ![screenshot](<work-image:1>) here",
    images: [{ token: "work-image:1", type: "image/png", data: "AQID" }],
  });
  // No words: nothing but the title goes.
  expect(await workAddPayload("   ", [first])).toEqual({});
});
