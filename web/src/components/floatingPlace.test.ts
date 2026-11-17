import { expect, test } from "bun:test";
import { floatingPlace } from "./floatingPlace";

const phone = { width: 412, height: 915 };
const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

test("a menu opens under its button, its right edge on the button's", () => {
  expect(
    floatingPlace(box(300, 100, 30, 26), { width: 240, height: 90 }, phone),
  ).toEqual({ left: 90, top: 130, maxHeight: 777 });
});

test("a menu whose button is near the left edge moves right to stay on the screen", () => {
  const place = floatingPlace(
    box(10, 100, 30, 26),
    { width: 240, height: 90 },
    phone,
  );
  expect(place.left).toBe(8);
  expect(place.left + 240).toBeLessThanOrEqual(phone.width - 8);
});

test("opened from the left edge (start), a menu near the right edge moves left", () => {
  const place = floatingPlace(
    box(380, 100, 30, 26),
    { width: 240, height: 90 },
    phone,
    "start",
  );
  expect(place.left).toBe(412 - 8 - 240);
});

test("a menu wider than the screen is narrowed to it, 8 px from each edge", () => {
  const place = floatingPlace(
    box(200, 100, 30, 26),
    { width: 600, height: 90 },
    phone,
  );
  expect(place).toMatchObject({ left: 8, width: 396 });
});

test("with no room under its button, a menu opens over it", () => {
  const place = floatingPlace(
    box(300, 850, 30, 26),
    { width: 240, height: 200 },
    phone,
  );
  expect(place.top).toBe(850 - 4 - 200);
  expect(place.maxHeight).toBe(850 - 4 - 8);
});

test("too tall for either side, it takes the larger one and scrolls", () => {
  const place = floatingPlace(
    box(300, 300, 30, 26),
    { width: 240, height: 2000 },
    phone,
  );
  expect(place.top).toBe(330);
  expect(place.maxHeight).toBe(915 - 326 - 4 - 8);
});
