import { expect, test } from "bun:test";
import { RpcError } from "./api";
import {
  isSentImage,
  isSentImageGone,
  sentImageBlob,
  sentImageUrl,
} from "./sentImages";

test("an inline image becomes a blob of its type and bytes", async () => {
  const blob = sentImageBlob({ media_type: "image/png", data: "AAEC/w==" });
  expect(blob.type).toBe("image/png");
  expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0, 1, 2, 255]);
});

test("only an image reply is taken", () => {
  expect(isSentImage({ media_type: "image/jpeg", data: "" })).toBe(true);
  expect(isSentImage({ media_type: "text/html", data: "" })).toBe(false);
  expect(isSentImage(null)).toBe(false);
});

test("an image loads once per key, and again after a failure", async () => {
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { media_type: "image/png", data: "AA==" };
  };
  const first = await sentImageUrl("test:a", load);
  expect(await sentImageUrl("test:a", load)).toBe(first);
  expect(loads).toBe(1);
  await expect(
    sentImageUrl("test:b", async () => {
      throw new Error("gone");
    }),
  ).rejects.toThrow("gone");
  await Promise.resolve();
  await sentImageUrl("test:b", load);
  expect(loads).toBe(2);
});

test("only the bridge saying an image is not there, or a non-image, is final", async () => {
  expect(
    isSentImageGone(new RpcError("not in the session", "image_gone")),
  ).toBe(true);
  expect(isSentImageGone(new Error("timeout: agent_history.image"))).toBe(
    false,
  );
  expect(isSentImageGone(new RpcError("Agent session is unavailable"))).toBe(
    false,
  );
  const failure = await sentImageUrl("test:c", async () => ({
    media_type: "text/html",
    data: "",
  })).catch((error: unknown) => error);
  expect(isSentImageGone(failure)).toBe(true);
});
