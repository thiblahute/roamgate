import { describe, expect, test } from "bun:test";
import { type ErrandEntry, VoiceErrands } from "./voice-errands";

const timing = { poll: 5, settled: 20, stalled: 40, limit: 2000 };
const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("VoiceErrands", () => {
  test("sends the errand and gives back the answer once it settles", async () => {
    let entries: ErrandEntry[] = [
      { id: "old", role: "assistant", kind: "message", text: "Earlier." },
    ];
    const prompted: string[] = [];
    const errands = new VoiceErrands(
      {
        read: async () => entries,
        prompt: async (connectionId, paneId, text) => {
          prompted.push(`${connectionId} ${paneId} ${text}`);
          entries = [
            ...entries,
            { id: "q", role: "user", kind: "message", text },
            { id: "t", role: "assistant", kind: "tool_call", text: "search" },
          ];
          setTimeout(() => {
            entries = [
              ...entries,
              { id: "a", role: "assistant", kind: "message", text: "2 to 1." },
            ];
          }, 30);
        },
      },
      timing,
    );
    const job = await errands.start("local/wF:p5", "[Voice] The score?");
    expect(prompted).toEqual(["local wF:p5 [Voice] The score?"]);
    expect(errands.state(job)).toEqual({
      done: false,
      answer: null,
      stalled: false,
    });
    await until(() => errands.state(job)!.done);
    expect(errands.state(job)).toEqual({
      done: true,
      answer: "2 to 1.",
      stalled: false,
    });
  });

  test("a session stuck on a step is told as stalled", async () => {
    let entries: ErrandEntry[] = [];
    const errands = new VoiceErrands(
      {
        read: async () => entries,
        prompt: async () => {
          entries = [
            { id: "q", role: "user", kind: "message", text: "Send it" },
            { id: "t", role: "assistant", kind: "tool_call", text: "send" },
          ];
        },
      },
      timing,
    );
    const job = await errands.start("local/wF:p5", "Send it");
    await until(() => errands.state(job)!.stalled);
    expect(errands.state(job)!.stalled).toBe(true);
    expect(errands.state(job)!.done).toBe(false);
  });
});
