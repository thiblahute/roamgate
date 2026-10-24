import { afterEach, expect, spyOn, test } from "bun:test";
import { roamgateLocalStorage } from "./browserStorage";
import {
  readWorkspaceSheetAll,
  saveWorkspaceSheetAll,
} from "./workspaceSheetView";

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

test("the phone's workspace sheet reopens on the list it showed last", () => {
  const values = new Map<string, string>();
  spies.push(
    spyOn(roamgateLocalStorage, "getItem").mockImplementation(
      (key) => values.get(key) ?? null,
    ),
    spyOn(roamgateLocalStorage, "setItem").mockImplementation((key, value) => {
      values.set(key, value);
    }),
  );
  // Recent until the user picks All.
  expect(readWorkspaceSheetAll()).toBe(false);
  saveWorkspaceSheetAll(true);
  expect(readWorkspaceSheetAll()).toBe(true);
  saveWorkspaceSheetAll(false);
  expect(readWorkspaceSheetAll()).toBe(false);
});

test("blocked storage keeps the default and does not throw", () => {
  spies.push(
    spyOn(roamgateLocalStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    }),
    spyOn(roamgateLocalStorage, "setItem").mockImplementation(() => {
      throw new Error("full");
    }),
  );
  expect(readWorkspaceSheetAll()).toBe(false);
  expect(() => saveWorkspaceSheetAll(true)).not.toThrow();
});
