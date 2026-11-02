import { describe, expect, test } from "bun:test";
import {
  rememberCallForReload,
  setVoiceCallPhase,
  takeCallAfterReload,
  voiceCallReloadState,
} from "./voiceCallReload";

function memory() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const pane = { connectionId: "local", paneId: "w2:p2" };

describe("a voice call over a reload", () => {
  test("the reloaded page goes on with the call, once", () => {
    const storage = memory();
    setVoiceCallPhase(pane, "safe");
    expect(voiceCallReloadState()).toBe("safe");
    rememberCallForReload(storage, 1000);
    expect(takeCallAfterReload(storage, 5000)).toEqual(pane);
    expect(takeCallAfterReload(storage, 5000)).toBeNull();
    setVoiceCallPhase(pane, null);
    expect(voiceCallReloadState()).toBe("none");
  });

  test("a reload long ago starts no call", () => {
    const storage = memory();
    setVoiceCallPhase(pane, "safe");
    rememberCallForReload(storage, 1000);
    expect(takeCallAfterReload(storage, 1000 + 61_000)).toBeNull();
    setVoiceCallPhase(pane, null);
  });

  test("another pane's chat ending leaves the call alone", () => {
    setVoiceCallPhase(pane, "busy");
    setVoiceCallPhase({ connectionId: "local", paneId: "w3:p1" }, null);
    expect(voiceCallReloadState()).toBe("busy");
    setVoiceCallPhase(pane, null);
  });
});
