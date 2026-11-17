import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const values = new Map<string, string>();
let failWrites = false;
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem(key: string, value: string) {
        if (failWrites) throw new Error("quota");
        values.set(key, value);
      },
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

const load = () => import("./vimKeys");

beforeEach(async () => {
  values.clear();
  (await load()).__resetVimKeysForTests();
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

test("Vim keys are on until turned off, and stay chosen", async () => {
  const { vimKeys, setVimKeys } = await load();
  expect(vimKeys()).toBe(true);
  setVimKeys(false);
  expect(vimKeys()).toBe(false);
  expect(values.get("roamgate:vimKeys")).toBe("false");
  // Storage refusing the choice: it still holds for this page.
  failWrites = true;
  try {
    setVimKeys(true);
    expect(vimKeys()).toBe(true);
  } finally {
    failWrites = false;
  }
  setVimKeys(false);
  expect(vimKeys()).toBe(false);
});

test("the review's old :vim choice is taken over and forgotten", async () => {
  values.set(
    "roamgate:reviewPrefs",
    JSON.stringify({ split: true, vim: false }),
  );
  const { vimKeys } = await load();
  expect(vimKeys()).toBe(false);
  expect(JSON.parse(values.get("roamgate:reviewPrefs") ?? "{}")).toEqual({
    split: true,
  });
});

test("the review's old choice wins over the agent chats' old switch", async () => {
  values.set("roamgate:reviewPrefs", JSON.stringify({ vim: true }));
  values.set("roamgate:agentChatVimKeys", "false");
  const { vimKeys } = await load();
  expect(vimKeys()).toBe(true);
  expect(values.get("roamgate:vimKeys")).toBe("true");
  expect(values.has("roamgate:agentChatVimKeys")).toBe(false);
});

test("the agent chats' old switch is taken when the review had no choice", async () => {
  values.set("roamgate:agentChatVimKeys", "false");
  const { vimKeys } = await load();
  expect(vimKeys()).toBe(false);
  expect(values.has("roamgate:agentChatVimKeys")).toBe(false);
});

test("with no old choice, nothing is kept and Vim keys are on", async () => {
  values.set("roamgate:reviewPrefs", "[1,");
  const { vimKeys } = await load();
  expect(vimKeys()).toBe(true);
  expect(values.has("roamgate:vimKeys")).toBe(false);
});

test("a migrated choice goes to a server that has none", async () => {
  values.set("roamgate:reviewPrefs", JSON.stringify({ vim: false }));
  const { connectVimKeys, vimKeys } = await load();
  const remote = server();
  connectVimKeys(remote.send, remote.stored);
  expect(remote.sent).toEqual([false]);
  expect(vimKeys()).toBe(false);
});

test("the server's choice wins over a migrated one", async () => {
  values.set("roamgate:reviewPrefs", JSON.stringify({ vim: false }));
  const { connectVimKeys, vimKeys } = await load();
  const remote = server(true);
  connectVimKeys(remote.send, remote.stored);
  expect(remote.sent).toEqual([]);
  expect(vimKeys()).toBe(true);
  expect(values.get("roamgate:vimKeys")).toBe("true");
});

test("nothing chosen anywhere sends nothing", async () => {
  const { connectVimKeys, vimKeys } = await load();
  const remote = server();
  connectVimKeys(remote.send, remote.stored);
  expect(remote.sent).toEqual([]);
  expect(vimKeys()).toBe(true);
});

test("a choice goes to the server, and another device's choice applies here", async () => {
  const { adoptVimKeys, connectVimKeys, setVimKeys, vimKeys } = await load();
  const remote = server(true);
  connectVimKeys(remote.send, remote.stored);
  setVimKeys(false);
  expect(remote.sent).toEqual([false]);
  adoptVimKeys(true);
  expect(vimKeys()).toBe(true);
  // Something else under the key changes nothing.
  adoptVimKeys("yes");
  expect(vimKeys()).toBe(true);
});

test("a choice made offline is sent on reconnecting, over the server's", async () => {
  const { connectVimKeys, disconnectVimKeys, setVimKeys, vimKeys } =
    await load();
  const remote = server(true);
  connectVimKeys(remote.send, remote.stored);
  disconnectVimKeys();
  setVimKeys(false);
  expect(remote.sent).toEqual([]);
  connectVimKeys(remote.send, true);
  expect(remote.sent).toEqual([false]);
  expect(vimKeys()).toBe(false);
  // Sent once: the next connection takes the server's again.
  disconnectVimKeys();
  connectVimKeys(remote.send, true);
  expect(remote.sent).toEqual([false]);
  expect(vimKeys()).toBe(true);
});

test("subscribers hear every change, from here or elsewhere", async () => {
  const { adoptVimKeys, setVimKeys, subscribeVimKeys, vimKeys } = await load();
  const seen: boolean[] = [];
  const stop = subscribeVimKeys(() => seen.push(vimKeys()));
  setVimKeys(false);
  adoptVimKeys(true);
  adoptVimKeys(true);
  stop();
  setVimKeys(false);
  expect(seen).toEqual([false, true]);
});
