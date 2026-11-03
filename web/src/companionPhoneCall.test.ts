import { afterEach, expect, test } from "bun:test";
import {
  __resetCompanionCallForTests,
  endCompanionCall,
  startCompanionCall,
} from "./companionCall";
import { showCompanionCallOnPhone } from "./companionPhoneCall";

afterEach(() => __resetCompanionCallForTests());

function view(phone: boolean, shown = false) {
  const seen = { phone, shown, shows: 0, hides: 0 };
  const stop = showCompanionCallOnPhone({
    phone: () => seen.phone,
    shown: () => seen.shown,
    show: () => {
      seen.shown = true;
      seen.shows += 1;
    },
    hide: () => {
      seen.shown = false;
      seen.hides += 1;
    },
  });
  return { seen, stop };
}

test("on a phone a call shows the whole conversation, its end takes it away", () => {
  const { seen } = view(true);
  startCompanionCall();
  expect(seen).toMatchObject({ shown: true, shows: 1 });
  // Started again during the call: nothing more.
  startCompanionCall();
  expect(seen.shows).toBe(1);
  endCompanionCall();
  expect(seen).toMatchObject({ shown: false, hides: 1 });
  // The next call shows it again.
  startCompanionCall();
  expect(seen.shows).toBe(2);
});

test("on a desktop the call stays in the top bar", () => {
  const { seen } = view(false);
  startCompanionCall();
  endCompanionCall();
  expect(seen).toMatchObject({ shown: false, shows: 0, hides: 0 });
});

test("a conversation open before the call stays after it", () => {
  const { seen } = view(true, true);
  startCompanionCall();
  endCompanionCall();
  expect(seen).toMatchObject({ shown: true, shows: 0, hides: 0 });
});

test("closed by hand during the call: its end does not touch it", () => {
  const { seen } = view(true);
  startCompanionCall();
  seen.shown = false;
  endCompanionCall();
  expect(seen.hides).toBe(0);
});

test("stops watching", () => {
  const { seen, stop } = view(true);
  stop();
  startCompanionCall();
  expect(seen.shows).toBe(0);
});
