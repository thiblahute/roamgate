import { afterEach, describe, expect, test } from "bun:test";
import { parseVoiceMessage } from "./voiceChat";
import {
  forwardWork,
  handOffVoice,
  routeSpeech,
  takeVoiceHandoff,
} from "./voiceRoute";

test("a pane shown again goes on awaiting the answer it awaited", () => {
  handOffVoice({
    connectionId: "local",
    paneId: "w2:p2",
    message: null,
    resume: { sent: "[Voice] No, the other one.", read: ["a1"] },
  });
  // Another pane does not take it.
  expect(takeVoiceHandoff("local", "w2:p3")).toBeNull();
  expect(takeVoiceHandoff("local", "w2:p2")).toEqual({
    message: null,
    resume: { sent: "[Voice] No, the other one.", read: ["a1"] },
  });
  // Taken once.
  expect(takeVoiceHandoff("local", "w2:p2")).toBeNull();
});

describe("the companion's jobs", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  /** What each request posted; every one starts job-1. */
  function recordBodies() {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ job: "job-1" });
    }) as unknown as typeof fetch;
    return bodies;
  }

  test("words said go marked [Voice], as voice chat sends them", async () => {
    const bodies = recordBodies();
    expect(
      await forwardWork("local/w2:p2", "check out his last messages", {
        interruptedAt: null,
      }),
    ).toEqual({ job: "job-1" });
    expect(bodies[0]).toEqual({
      pane: "local/w2:p2",
      words: "[Voice] check out his last messages",
    });
    // The chat shows it as said by voice.
    expect(parseVoiceMessage(String(bodies[0]!.words))).toEqual({
      text: "check out his last messages",
      voice: true,
      interruptedAt: null,
    });
  });

  test("words said over a reading carry the sentence cut off", async () => {
    const bodies = recordBodies();
    await forwardWork("local/w2:p2", "No, the other one.", {
      interruptedAt: "The tests pass.",
    });
    expect(bodies[0]!.words).toBe(
      '[Voice, interrupted you at: "The tests pass."] No, the other one.',
    );
  });

  test("words typed in its text box go as typed", async () => {
    const bodies = recordBodies();
    await forwardWork("local/w2:p2", "Lance les tests du serveur.");
    expect(bodies[0]).toEqual({
      pane: "local/w2:p2",
      words: "Lance les tests du serveur.",
    });
  });

  test("routing takes the sentence cut off, for an errand's voice note", async () => {
    const bodies = recordBodies();
    await routeSpeech("Weather tomorrow?", "local/p1", [], undefined, {
      interruptedAt: "Done.",
    });
    expect(bodies[0]).toMatchObject({
      said: "Weather tomorrow?",
      interrupted_at: "Done.",
    });
    await routeSpeech("Weather tomorrow?", "local/p1", []);
    expect(bodies[1]).not.toHaveProperty("interrupted_at");
    expect(bodies[1]).not.toHaveProperty("typed");
    // Words typed to the companion: an errand gets them as typed.
    await routeSpeech("Weather tomorrow?", "local/p1", [], undefined, "typed");
    expect(bodies[2]).toMatchObject({ typed: true });
    expect(bodies[2]).not.toHaveProperty("interrupted_at");
  });
});
