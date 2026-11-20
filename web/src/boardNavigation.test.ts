import { expect, test } from "bun:test";
import { nextColumn, nextRow } from "./boardNavigation";

const columns = [["a1", "a2", "a3"], [], ["c1"], ["d1", "d2"]];
const ordered = columns.flat();

test("j / k walk the rows as drawn, and stay in the column on a wide pane", () => {
  expect(nextRow(null, [], null, 1)).toBeNull();
  // Nothing selected: a count from the start, or from the end.
  expect(nextRow(null, ordered, null, 1)).toBe("a1");
  expect(nextRow(null, ordered, null, 3)).toBe("a3");
  expect(nextRow(null, ordered, null, -1)).toBe("d2");
  // Through every row when the pane is one list.
  expect(nextRow(null, ordered, "a3", 1)).toBe("c1");
  expect(nextRow(null, ordered, "a1", -1)).toBe("a1");
  expect(nextRow(null, ordered, "d2", 5)).toBe("d2");
  // In its column on the board; a row in no column walks the list.
  expect(nextRow(columns, ordered, "a3", 1)).toBe("a3");
  expect(nextRow(columns, ordered, "a1", 2)).toBe("a3");
  expect(nextRow(columns, ordered, "d1", 1)).toBe("d2");
  expect(nextRow(columns, ordered, "zz", 1)).toBe("a1");
});

test("h / l go to the column beside at the same height, skipping empty ones", () => {
  expect(nextColumn([], null, 1)).toBeNull();
  expect(nextColumn(columns, null, 1)).toBe("a1");
  expect(nextColumn(columns, null, -1)).toBe("d1");
  expect(nextColumn(columns, "a2", 1)).toBe("c1");
  expect(nextColumn(columns, "a3", 1)).toBe("c1");
  expect(nextColumn(columns, "c1", 1)).toBe("d1");
  expect(nextColumn(columns, "d2", -1)).toBe("c1");
  expect(nextColumn(columns, "c1", -1)).toBe("a1");
  // Past the last column: nothing to go to.
  expect(nextColumn(columns, "d1", 1)).toBeNull();
  expect(nextColumn(columns, "a1", -1)).toBeNull();
});
