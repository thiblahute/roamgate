import { describe, expect, test } from "bun:test";
import { anchoredMenuPosition, reloadApplicationPage } from "./ConfigMenu";

describe("application menu actions", () => {
  test("reloads the current page", () => {
    let reloadCount = 0;

    reloadApplicationPage({
      reload() {
        reloadCount += 1;
      },
    });

    expect(reloadCount).toBe(1);
  });
});

describe("the menu opened from another button", () => {
  const viewport = { width: 1000, height: 800 };
  test("opens under it, its right edge on the button's", () => {
    expect(
      anchoredMenuPosition(
        { top: 0, bottom: 26, left: 900, right: 928 },
        { width: 380 },
        viewport,
      ),
    ).toEqual({ left: 548, top: 32, maxHeight: 760 });
  });
  test("stays inside the viewport", () => {
    expect(
      anchoredMenuPosition(
        { top: 0, bottom: 26, left: 10, right: 38 },
        { width: 380 },
        viewport,
      ).left,
    ).toBe(8);
    expect(
      anchoredMenuPosition(
        { top: 0, bottom: 26, left: 990, right: 1010 },
        { width: 380 },
        viewport,
      ).left,
    ).toBe(612);
    expect(
      anchoredMenuPosition(
        { top: 0, bottom: 26, left: 0, right: 300 },
        { width: 380 },
        { width: 300, height: 800 },
      ),
    ).toMatchObject({ left: 8 });
  });
  test("places in the page's zoomed pixels", () => {
    expect(
      anchoredMenuPosition(
        { top: 0, bottom: 30, left: 900, right: 928 },
        { width: 380 },
        viewport,
        1.25,
      ),
    ).toEqual({ left: 438.4, top: 28.8, maxHeight: 604.8 });
  });
});
