import { afterEach, describe, expect, test } from "bun:test";
import { parseVoiceMessage } from "./voiceChat";
import {
  errandNoticeText,
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

test("a job's notice says what the session does, never that it looks stuck", () => {
  expect(
    errandNoticeText("roamgate", { seq: 1, kind: "working", minutes: 7 }),
  ).toBe("roamgate is still working (7 min since its last message)");
  expect(
    errandNoticeText("roamgate", {
      seq: 2,
      kind: "waiting",
      what: "git push origin main",
    }),
  ).toBe("roamgate is waiting for your OK: git push origin main");
  expect(
    errandNoticeText("roamgate", { seq: 3, kind: "waiting", what: null }),
  ).toBe("roamgate is waiting for your OK");
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
    // The user's words alone go too: kept with the answer, for a page gone
    // before it comes (voiceWaiting.ts).
    expect(bodies[0]).toEqual({
      pane: "local/w2:p2",
      words: "[Voice] check out his last messages",
      question: "check out his last messages",
    });
    // The chat shows it as said by voice.
    expect(parseVoiceMessage(String(bodies[0]!.words))).toEqual({
      text: "check out his last messages",
      voice: true,
      interruptedAt: null,
      context: null,
    });
  });

  test("words that lean on the call go quoted, with the front's context", async () => {
    const bodies = recordBodies();
    await forwardWork("local/w2:p2", "Uh yeah, ask it again.", {
      interruptedAt: null,
      context: "I had just read your answer on the DNS step.",
    });
    expect(bodies[0]!.words).toBe(
      '[Voice] "Uh yeah, ask it again." (Context: I had just read your answer on the DNS step.)',
    );
  });

  test("routing gives the call lately when there is one", async () => {
    const bodies = recordBodies();
    await routeSpeech(
      "ask it again",
      "local/p1",
      [],
      undefined,
      {},
      '- You said: "Done."',
    );
    expect(bodies[0]).toMatchObject({ recent: '- You said: "Done."' });
    await routeSpeech("ask it again", "local/p1", []);
    expect(bodies[1]).not.toHaveProperty("recent");
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
    await forwardWork(
      "local/w2:p2",
      "Lance les tests du serveur.",
      undefined,
      "roamgate",
    );
    expect(bodies[0]).toEqual({
      pane: "local/w2:p2",
      words: "Lance les tests du serveur.",
      question: "Lance les tests du serveur.",
      label: "roamgate",
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

  test("routing passes on whose voice said it, for the server to label", async () => {
    const bodies = recordBodies();
    const voice = { voices: 3, id: "B", share: 1, mixed: false };
    await routeSpeech("Bonjour à tous.", "local/p1", [], undefined, { voice });
    expect(bodies[0]).toMatchObject({ said: "Bonjour à tous.", voice });
    await routeSpeech("Bonjour.", "local/p1", [], undefined, {});
    expect(bodies[1]).not.toHaveProperty("voice");
  });
});

test("a route without a session is no session", async () => {
  const { parseVoiceSessionId } = await import("./voiceRoute");
  expect(parseVoiceSessionId(undefined)).toBeNull();
  expect(parseVoiceSessionId("local/w2:p2")).toEqual({
    connectionId: "local",
    paneId: "w2:p2",
  });
});

test("the page says which routes it knows, and takes an unknown one for the agent on screen", async () => {
  const { KNOWN_ROUTES, routeSpeech } = await import("./voiceRoute");
  const realFetch = globalThis.fetch;
  const sent: unknown[] = [];
  let answer: unknown = { to: "later-kind", pane: undefined };
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return Response.json(answer);
  }) as unknown as typeof fetch;
  try {
    expect(await routeSpeech("hi", "local/w2:p2", [])).toEqual({
      to: "current",
    });
    expect((sent[0] as { routes: string[] }).routes).toEqual([...KNOWN_ROUTES]);
    answer = { to: "self", reply: "I'm here." };
    expect(await routeSpeech("you there?", "local/w2:p2", [])).toEqual({
      to: "self",
      reply: "I'm here.",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
