import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "bun:test";
import {
  __resetVoiceOutputForTests,
  holdVoiceContext,
  setVoiceOutputMode,
  voiceContext,
  voiceContextHeld,
  voiceOutputMode,
} from "./voiceOutput";

const globals = globalThis as Record<string, unknown>;
const saved = globals.AudioContext;
let made = 0;
beforeAll(() => {
  globals.AudioContext = class {
    state = "running";
    onstatechange: (() => void) | null = null;
    constructor() {
      made += 1;
    }
    resume = async () => {
      this.state = "running";
    };
    close = async () => {
      this.state = "closed";
    };
  };
});
afterAll(() => {
  globals.AudioContext = saved;
});
// Other files of a serial run leave the call's context held.
beforeEach(() => __resetVoiceOutputForTests());

describe("voice output", () => {
  test("plays with the microphone's audio unless set otherwise", () => {
    expect(voiceOutputMode()).toBe("context");
    setVoiceOutputMode("element");
    expect(voiceOutputMode()).toBe("element");
    setVoiceOutputMode("context");
  });

  test("the call's context outlives a rebuild of the chat, and closes after the call", () => {
    jest.useFakeTimers();
    try {
      const call = new AbortController();
      holdVoiceContext(call.signal, () => {});
      const context = voiceContext();
      expect(voiceContextHeld()).toBe(true);
      // The chat is rebuilt: the old one lets go, the new one takes it.
      call.abort();
      const again = new AbortController();
      holdVoiceContext(again.signal, () => {});
      jest.advanceTimersByTime(10_000);
      expect(voiceContext()).toBe(context);
      expect(context.state).toBe("running");
      again.abort();
      expect(voiceContextHeld()).toBe(false);
      jest.advanceTimersByTime(3000);
      expect(context.state).toBe("closed");
      const before = made;
      voiceContext();
      expect(made).toBe(before + 1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("suspended from outside during a call, it runs again", async () => {
    const call = new AbortController();
    const trace: string[] = [];
    holdVoiceContext(call.signal, (line) => trace.push(line));
    const context = voiceContext() as unknown as {
      state: string;
      onstatechange: () => void;
    };
    context.state = "suspended";
    context.onstatechange();
    await Promise.resolve();
    expect(context.state).toBe("running");
    expect(trace[0]).toContain("suspended from outside");
    call.abort();
  });
});
