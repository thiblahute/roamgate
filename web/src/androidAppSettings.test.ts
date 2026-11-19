import { expect, test } from "bun:test";
import { appSettingsOpener } from "./androidAppSettings";

test("the app's bridge gives a way to its settings", () => {
  const calls: unknown[] = [];
  const bridge = {
    openSettings(this: unknown) {
      calls.push(this);
    },
  };
  const open = appSettingsOpener({ RoamgateApp: bridge });
  expect(open).not.toBeNull();
  open?.();
  expect(calls).toEqual([bridge]);
});

test("a browser, or a bridge without openSettings, offers nothing", () => {
  expect(appSettingsOpener({})).toBeNull();
  expect(appSettingsOpener({ RoamgateApp: null })).toBeNull();
  expect(appSettingsOpener({ RoamgateApp: { handOff() {} } })).toBeNull();
  expect(appSettingsOpener({ RoamgateApp: { openSettings: "no" } })).toBeNull();
  expect(appSettingsOpener(undefined)).toBeNull();
});
