import { expect, test } from "bun:test";
import { MODEL_IMAGE_MAX_EDGE, scaledSize } from "./imageDownscale";

test("a phone photo is drawn to the model's long edge, proportions kept", () => {
  expect(scaledSize(4032, 3024)).toEqual({
    width: MODEL_IMAGE_MAX_EDGE,
    height: 1176,
  });
  expect(scaledSize(3024, 4032)).toEqual({
    width: 1176,
    height: MODEL_IMAGE_MAX_EDGE,
  });
  // A screenshot that fits stays as it is.
  expect(scaledSize(1280, 800)).toBeNull();
  expect(scaledSize(0, 0)).toBeNull();
});
