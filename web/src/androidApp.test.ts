import { expect, test } from "bun:test";
import {
  androidAppKnown,
  androidAppMissedCall,
  androidAppTookCall,
  FORGET_AFTER,
  handoffIntentUrl,
  noteAndroidApp,
} from "./androidApp";

const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";
const DESKTOP =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";

function fakeStore() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

test("the app's launch parameter notes it, and leaves the address bar", () => {
  const store = fakeStore();
  const replaced: string[] = [];
  noteAndroidApp(
    {
      href: "https://roamgate.example/?roamgate_app=12&x=1#chat",
      referrer: "",
      replace: (url) => replaced.push(url),
    },
    store,
    1000,
  );
  expect(replaced).toEqual(["/?x=1#chat"]);
  expect(androidAppKnown(ANDROID, store)).toBe(true);
  // Only on Android: the same storage on a desktop offers no handoff.
  expect(androidAppKnown(DESKTOP, store)).toBe(false);
});

test("the app's referrer notes it too; any other page does not", () => {
  const store = fakeStore();
  noteAndroidApp(
    { href: "https://roamgate.example/", referrer: "https://elsewhere/" },
    store,
  );
  expect(androidAppKnown(ANDROID, store)).toBe(false);
  noteAndroidApp(
    {
      href: "https://roamgate.example/",
      referrer: "android-app://net.ts.roamgate/",
    },
    store,
  );
  expect(androidAppKnown(ANDROID, store)).toBe(true);
});

test("handoffs the app does not take forget it after a few in a row", () => {
  const store = fakeStore();
  noteAndroidApp(
    { href: "https://roamgate.example/?roamgate_app=3", referrer: "" },
    store,
  );
  for (let miss = 1; miss < FORGET_AFTER; miss += 1) {
    expect(androidAppMissedCall(store)).toBe(false);
    expect(androidAppKnown(ANDROID, store)).toBe(true);
  }
  androidAppTookCall(store);
  for (let miss = 1; miss < FORGET_AFTER; miss += 1)
    expect(androidAppMissedCall(store)).toBe(false);
  expect(androidAppMissedCall(store)).toBe(true);
  expect(androidAppKnown(ANDROID, store)).toBe(false);
});

test("a broken store is an app not known", () => {
  const store = fakeStore();
  store.items.set("roamgate.androidApp", "{nope");
  expect(androidAppKnown(ANDROID, store)).toBe(false);
  expect(androidAppKnown(ANDROID, null)).toBe(false);
});

test("the handoff opens only the app, on /call/<id>, never with `token`", () => {
  const url = handoffIntentUrl("https://roamgate.example:8443/x?y", 7, "a_b-c");
  expect(url).toBe(
    "intent://roamgate.example:8443/call/7?handoff=a_b-c#Intent;scheme=https;package=net.ts.roamgate;action=android.intent.action.VIEW;end",
  );
  expect(url).not.toContain("token=");
});
