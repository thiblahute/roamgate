import { expect, test } from "bun:test";
import { sessionImage } from "./session-images";

const jsonl = [
  JSON.stringify({ type: "user", uuid: "other", message: { content: "x" } }),
  "{not json",
  JSON.stringify({
    type: "user",
    uuid: "u1",
    message: {
      role: "user",
      content: [
        { type: "text", text: "two" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAA" },
        },
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: "BBB" },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    uuid: "bad",
    message: {
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "text/html", data: "CCC" },
        },
      ],
    },
  }),
].join("\n");

test("finds the n-th inline image of a user record by uuid", () => {
  expect(sessionImage(jsonl, "u1", 0)).toEqual({
    media_type: "image/png",
    data: "AAA",
  });
  expect(sessionImage(jsonl, "u1", 1)).toEqual({
    media_type: "image/jpeg",
    data: "BBB",
  });
});

test("nothing for a missing record, index or a type that is not an image", () => {
  expect(sessionImage(jsonl, "u1", 2)).toBeNull();
  expect(sessionImage(jsonl, "u1", -1)).toBeNull();
  expect(sessionImage(jsonl, "nope", 0)).toBeNull();
  expect(sessionImage(jsonl, "other", 0)).toBeNull();
  expect(sessionImage(jsonl, "bad", 0)).toBeNull();
});

test("malformed base64 is not an image", () => {
  for (const data of ["a", "a=", "aa=", "aaaa=", "<svg>", ""]) {
    const record = JSON.stringify({
      type: "user",
      uuid: "m",
      message: {
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data },
          },
        ],
      },
    });
    expect(sessionImage(record, "m", 0)).toBeNull();
  }
});
