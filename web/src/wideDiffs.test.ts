import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const values = new Map<string, string>();
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
    } as Storage,
    configurable: true,
    writable: true,
  });
});
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

const load = () => import("./wideDiffs");

beforeEach(async () => {
  values.clear();
  (await load()).__resetWideDiffsForTests();
});

/** A server holding interface settings, as bridge.ui_settings does. */
function server(initial?: boolean) {
  const sent: boolean[] = [];
  return {
    sent,
    stored: initial as unknown,
    send: async (on: boolean) => {
      sent.push(on);
    },
  };
}

test("diffs are centred until full width is chosen, and the choice stays", async () => {
  const { setWideDiffs, wideDiffs } = await load();
  expect(wideDiffs()).toBe(false);
  setWideDiffs(true);
  expect(wideDiffs()).toBe(true);
  expect(values.get("roamgate:wideDiffs")).toBe("true");
  setWideDiffs(false);
  expect(wideDiffs()).toBe(false);
});

test("a choice goes to the server, and another device's choice applies here", async () => {
  const { adoptWideDiffs, connectWideDiffs, setWideDiffs, wideDiffs } =
    await load();
  const remote = server(false);
  connectWideDiffs(remote.send, remote.stored);
  expect(remote.sent).toEqual([]);
  setWideDiffs(true);
  expect(remote.sent).toEqual([true]);
  adoptWideDiffs(false);
  expect(wideDiffs()).toBe(false);
  // Something else under the key changes nothing.
  adoptWideDiffs("yes");
  expect(wideDiffs()).toBe(false);
});

test("the server's choice wins over this browser's copy", async () => {
  values.set("roamgate:wideDiffs", "false");
  const { connectWideDiffs, wideDiffs } = await load();
  const remote = server(true);
  connectWideDiffs(remote.send, remote.stored);
  expect(remote.sent).toEqual([]);
  expect(wideDiffs()).toBe(true);
});

test("a choice made offline is sent once the server is reached", async () => {
  const { connectWideDiffs, disconnectWideDiffs, setWideDiffs, wideDiffs } =
    await load();
  disconnectWideDiffs();
  setWideDiffs(true);
  const remote = server(false);
  connectWideDiffs(remote.send, remote.stored);
  expect(remote.sent).toEqual([true]);
  expect(wideDiffs()).toBe(true);
  expect(values.has("roamgate:wideDiffs.pending")).toBe(false);
});

test("listeners hear a change, not the same choice again", async () => {
  const { adoptWideDiffs, subscribeWideDiffs } = await load();
  let heard = 0;
  const stop = subscribeWideDiffs(() => heard++);
  try {
    adoptWideDiffs(false);
    expect(heard).toBe(0);
    adoptWideDiffs(true);
    expect(heard).toBe(1);
  } finally {
    stop();
  }
});
