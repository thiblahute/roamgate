import { describe, expect, test } from "bun:test";
import { VoiceCleaner } from "../voice/voice-cleaner";
import type { VoiceEvent, VoiceHelper } from "../voice/voice-helper";
import { createVoiceSocket } from "./voice-socket";

/** A helper whose session's events the test sends. */
function fakeHelper() {
  let emit: (event: VoiceEvent) => void = () => {};
  const helper = {
    listen(onEvent: (event: VoiceEvent) => void) {
      emit = onEvent;
      return {
        id: 1,
        audio() {},
        release() {},
        finish() {},
        stop() {},
      };
    },
  } as unknown as VoiceHelper;
  return { helper, emit: (event: VoiceEvent) => emit(event) };
}

/** A cleaner that drops "um" and holds what mentions the salt. */
function fakeCleaner() {
  const prompts: string[] = [];
  const cleaner = new VoiceCleaner(() => {
    throw new Error("no process");
  });
  cleaner.warm = () => {};
  cleaner.ask = async (prompt) => {
    prompts.push(prompt);
    const rest = prompt.slice(prompt.lastIndexOf("Rest: ") + 6);
    return {
      for_agent: !rest.includes("salt"),
      text: rest.replaceAll("um ", ""),
    };
  };
  return { cleaner, prompts };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("voice socket", () => {
  test("without a context, events pass as they are", () => {
    const { helper, emit } = fakeHelper();
    const { cleaner } = fakeCleaner();
    const socket = createVoiceSocket(helper, () => cleaner);
    const sent: string[] = [];
    const ws = { send: (message: string) => sent.push(message) };
    socket.message(ws, JSON.stringify({ op: "listen" }));
    emit({ event: "final", session: 1, text: "Do um it.", speech_ms: 900 });
    expect(sent.map((s) => JSON.parse(s))).toEqual([
      { event: "listening", session: 1 },
      { event: "final", session: 1, text: "Do um it.", speech_ms: 900 },
    ]);
  });

  test("with a context, the final text is cleaned, in order", async () => {
    const { helper, emit } = fakeHelper();
    const { cleaner, prompts } = fakeCleaner();
    const socket = createVoiceSocket(helper, () => cleaner);
    const sent: Record<string, unknown>[] = [];
    const ws = { send: (message: string) => sent.push(JSON.parse(message)) };
    socket.message(
      ws,
      JSON.stringify({ op: "listen", context: "Agent: Ready?" }),
    );
    emit({ event: "speech_end", session: 1 });
    emit({ event: "final", session: 1, text: "Do um it.", speech_ms: 900 });
    emit({
      event: "final",
      session: 1,
      text: "Pass the salt.",
      speech_ms: 800,
    });
    await settle();
    expect(sent.slice(1)).toEqual([
      { event: "speech_end", session: 1 },
      {
        event: "final",
        session: 1,
        text: "Do it.",
        raw: "Do um it.",
        for_agent: true,
        speech_ms: 900,
      },
      {
        event: "final",
        session: 1,
        text: "Pass the salt.",
        raw: "Pass the salt.",
        for_agent: false,
        speech_ms: 800,
      },
    ]);
    expect(prompts[0]).toContain("Agent: Ready?");
  });
});
