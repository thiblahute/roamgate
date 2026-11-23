import { afterEach, expect, test } from "bun:test";
import {
  applyRemoteGuiSettings,
  type GuiSettings,
  type GuiSettingsRemote,
  normalizeGuiSettings,
  onGuiSettingsChanged,
  peekGuiSettings,
  readGuiSettings,
  setGuiSettingsRemote,
  updateGuiSettings,
} from "./gui-settings";

/** A writer like the Rust core's: compare-and-set on a revision. */
function fakeWriter(start = 100) {
  const state = {
    revision: start,
    settings: normalizeGuiSettings({}) as unknown,
    gets: 0,
    updates: 0,
  };
  const remote: GuiSettingsRemote = {
    get: async () => {
      state.gets += 1;
      return { revision: state.revision, settings: state.settings };
    },
    update: async (base, settings) => {
      state.updates += 1;
      if (base !== state.revision)
        throw Object.assign(new Error("settings changed"), { code: "stale" });
      state.revision += 1;
      state.settings = normalizeGuiSettings(settings);
      return { revision: state.revision, settings: state.settings };
    },
  };
  /** A change the writer makes itself (one of its own handlers). */
  const own = (change: (current: GuiSettings) => GuiSettings) => {
    state.revision += 1;
    state.settings = normalizeGuiSettings(
      change(state.settings as GuiSettings),
    );
    return { revision: state.revision, settings: state.settings };
  };
  return { state, remote, own };
}

afterEach(() => setGuiSettingsRemote(null));

test("reads and writes go through the remote writer against its revision", async () => {
  const writer = fakeWriter();
  setGuiSettingsRemote(writer.remote);
  expect((await readGuiSettings()).auto_rename_agent_tabs).toBe(true);
  expect(writer.state.gets).toBe(1);
  const next = await updateGuiSettings((current) => ({
    ...current,
    auto_rename_agent_tabs: false,
  }));
  expect(next.auto_rename_agent_tabs).toBe(false);
  expect(writer.state.revision).toBe(101);
  expect(peekGuiSettings()?.auto_rename_agent_tabs).toBe(false);
  // Kept: no second read.
  await readGuiSettings();
  expect(writer.state.gets).toBe(1);
});

test("a stale write is made again on what the writer has now, losing nothing", async () => {
  const writer = fakeWriter();
  setGuiSettingsRemote(writer.remote);
  await readGuiSettings();
  // The writer moves on behind the cache's back (its change not told yet).
  writer.own((current) => ({ ...current, title_suffix: "desk" }));
  let runs = 0;
  const next = await updateGuiSettings((current) => {
    runs += 1;
    return { ...current, claude_start_mode: "conversation" };
  });
  expect(runs).toBe(2);
  expect(next.title_suffix).toBe("desk");
  expect(next.claude_start_mode).toBe("conversation");
  expect((writer.state.settings as GuiSettings).title_suffix).toBe("desk");
});

test("concurrent updates from both sides keep every change", async () => {
  const writer = fakeWriter();
  setGuiSettingsRemote(writer.remote);
  const keys = Array.from({ length: 8 }, (_, at) => `k${at}`);
  await Promise.all(
    keys.map(async (key, at) => {
      if (at % 2) {
        const told = writer.own((current) => ({
          ...current,
          ui: { ...current.ui, [key]: at },
        }));
        applyRemoteGuiSettings(told.revision, told.settings, "core");
        return;
      }
      await updateGuiSettings((current) => ({
        ...current,
        ui: { ...current.ui, [key]: at },
      }));
    }),
  );
  const ui = (writer.state.settings as GuiSettings).ui;
  expect(Object.keys(ui).sort()).toEqual(keys);
});

test("the writer's own changes reach the listeners; older and front ones do not", async () => {
  const writer = fakeWriter();
  setGuiSettingsRemote(writer.remote);
  await readGuiSettings();
  const heard: (boolean | undefined)[][] = [];
  const stop = onGuiSettingsChanged((previous, next) =>
    heard.push([previous?.auto_rename_agent_tabs, next.auto_rename_agent_tabs]),
  );
  try {
    const told = writer.own((current) => ({
      ...current,
      auto_rename_agent_tabs: false,
    }));
    expect(applyRemoteGuiSettings(told.revision, told.settings, "core")).toBe(
      true,
    );
    expect(applyRemoteGuiSettings(told.revision, told.settings, "core")).toBe(
      false,
    );
    expect(applyRemoteGuiSettings(told.revision - 1, {}, "core")).toBe(false);
    await updateGuiSettings((current) => ({ ...current, title_suffix: "x" }));
    expect(heard).toEqual([[true, false]]);
    expect(peekGuiSettings()?.title_suffix).toBe("x");
  } finally {
    stop();
  }
});

test("without a remote writer, a told change is ignored", () => {
  expect(applyRemoteGuiSettings(1, {}, "core")).toBe(false);
});
