import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AssistantTask } from "../../shared/assistant";
import type { ForgeStatus } from "../../shared/forge";
import {
  __resetVoiceEventsForTests,
  noteVoiceEvent,
  onVoiceEvent,
  recentVoiceEvents,
} from "./voiceEvents";
import {
  createFrontVoice,
  earlyReplySaid,
  eventForFront,
  frontContext,
  notForMeSpoken,
  SKIPPED_KEPT,
  SKIPPED_MAX_AGE_MS,
  spokenSentences,
  withoutRecovered,
  withNotForAgent,
  withSkipped,
} from "./voiceFront";
import { KNOWN_ROUTES, routeSpeech, streamedRoute } from "./voiceRoute";

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe("the front's words said first", () => {
  test("its own words are said early; a session's work only on a call", () => {
    for (const to of ["self", "web", "tool", "ranger", "reviews"]) {
      expect(earlyReplySaid(to, false)).toBe(true);
      expect(earlyReplySaid(to, true)).toBe(true);
    }
    for (const to of ["current", "send"]) {
      expect(earlyReplySaid(to, true)).toBe(true);
      // Elsewhere, the turn's opening, said with its acks.
      expect(earlyReplySaid(to, false)).toBe(false);
    }
    for (const to of ["errand", "nobody", "read", "mode", "open"])
      expect(earlyReplySaid(to, true)).toBe(false);
  });

  test("a streamed route gives its early words, then the route", async () => {
    const encoder = new TextEncoder();
    const parts = [
      '{"early": {"to": "self", "reply": "Oui, je',
      ' t\'entends."}}\n{"to": "self", ',
      '"reply": "Oui, je t\'entends."}\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    });
    const early: unknown[] = [];
    expect(await streamedRoute(body, (said) => early.push(said))).toEqual({
      to: "self",
      reply: "Oui, je t'entends.",
    });
    expect(early).toEqual([{ to: "self", reply: "Oui, je t'entends." }]);
  });
});

/** A voice whose playing ends on `finish()` or an abort. */
function fakeSpeech() {
  const played: string[] = [];
  const signals: AbortSignal[] = [];
  let finish = () => {};
  const claimed: AbortController[] = [];
  const voice = createFrontVoice(
    {
      fetchAudio: async (text, language) => `${language}:${text}`,
      playAudio: (audio, signal) => {
        played.push(audio);
        signals.push(signal);
        return new Promise<void>((resolve) => {
          finish = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },
    (owner) => claimed.push(owner),
  );
  return { voice, played, signals, claimed, finish: () => finish() };
}

describe("createFrontVoice", () => {
  test("says the sentences given, and hears which ones were heard whole", async () => {
    const speech = fakeSpeech();
    const signal = new AbortController().signal;
    const heard: number[] = [];
    const sentences = ["Phase deux : la", "réponse de Nicolas.", "Puis slomo."];
    const said = speech.voice.say(sentences.join(" "), signal, {
      sentences,
      onHeard: (index) => heard.push(index),
    });
    await flush();
    // As given, not split again (a colon would end a sentence).
    expect(speech.played).toEqual(["fr:Phase deux : la"]);
    speech.finish();
    await flush();
    expect(heard).toEqual([0]);
    expect(speech.played).toEqual([
      "fr:Phase deux : la",
      "fr:réponse de Nicolas.",
    ]);
    // Cut halfway through the second: it is not heard.
    speech.voice.hush();
    await said;
    expect(heard).toEqual([0]);
    expect(speech.played).toHaveLength(2);
  });

  test("says one thing after the other, in its language", async () => {
    const speech = fakeSpeech();
    const signal = new AbortController().signal;
    void speech.voice.say("Je transmets à la session Roamgate.", signal);
    void speech.voice.say("Ok.", signal);
    await flush();
    expect(speech.played).toEqual(["fr:Je transmets à la session Roamgate."]);
    expect(speech.voice.playing()).toBe(true);
    speech.finish();
    await flush();
    expect(speech.played).toHaveLength(2);
    expect(speech.claimed).toHaveLength(2);
    speech.finish();
    await flush();
    expect(speech.voice.playing()).toBe(false);
  });

  test("a longer answer is made and played sentence by sentence", async () => {
    const speech = fakeSpeech();
    const signal = new AbortController().signal;
    void speech.voice.say(
      "Non, la CI a échoué. C'est le job check-rust.",
      signal,
    );
    await flush();
    expect(speech.played).toEqual(["fr:Non, la CI a échoué."]);
    speech.finish();
    await flush();
    expect(speech.played).toEqual([
      "fr:Non, la CI a échoué.",
      "fr:C'est le job check-rust.",
    ]);
    speech.finish();
    await flush();
    expect(speech.voice.playing()).toBe(false);
  });

  test("speaking up stops what it says and what waits", async () => {
    const speech = fakeSpeech();
    const signal = new AbortController().signal;
    const first = speech.voice.say(
      "The GStreamer session waits on you.",
      signal,
    );
    const second = speech.voice.say("And CI failed.", signal);
    await flush();
    speech.voice.hush();
    await first;
    await second;
    expect(speech.signals[0]!.aborted).toBe(true);
    expect(speech.played).toHaveLength(1);
    expect(speech.voice.playing()).toBe(false);
    // Said again afterwards, it speaks.
    void speech.voice.say("Okay.", signal);
    await flush();
    expect(speech.played).toHaveLength(2);
  });
});

describe("while the user is in the middle of an utterance", () => {
  /** A voice whose turn gate opens on `turnEnds()`. */
  function gatedSpeech() {
    const fetched: string[] = [];
    const played: string[] = [];
    let turnEnds = () => {};
    let finish = () => {};
    const voice = createFrontVoice(
      {
        fetchAudio: async (text) => {
          fetched.push(text);
          return text;
        },
        playAudio: (audio, signal) => {
          played.push(audio);
          return new Promise<void>((resolve) => {
            finish = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
      () => {},
      (signal) =>
        new Promise<void>((resolve) => {
          turnEnds = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    return {
      voice,
      fetched,
      played,
      turnEnds: () => turnEnds(),
      finish: () => finish(),
    };
  }

  test("a reply waits for its end: nothing is made (in a call, played) before", async () => {
    const speech = gatedSpeech();
    const said = speech.voice.say(
      "Roamgate says it is still a bug. It fixes every case.",
      new AbortController().signal,
    );
    await flush();
    // In a call, making a sentence puts it in the mix: none is asked for.
    expect(speech.fetched).toEqual([]);
    expect(speech.played).toEqual([]);
    expect(speech.voice.playing()).toBe(true);
    speech.turnEnds();
    await flush();
    expect(speech.played).toEqual(["Roamgate says it is still a bug."]);
    speech.finish();
    await flush();
    speech.finish();
    await said;
    expect(speech.played).toHaveLength(2);
    expect(speech.voice.playing()).toBe(false);
  });

  test("speaking up meanwhile drops it, as it drops what waits", async () => {
    const speech = gatedSpeech();
    const said = speech.voice.say(
      "Never over the user.",
      new AbortController().signal,
    );
    await flush();
    speech.voice.hush();
    await said;
    expect(speech.fetched).toEqual([]);
    expect(speech.played).toEqual([]);
    expect(speech.voice.playing()).toBe(false);
  });
});

describe("where a say is", () => {
  test("each sentence is told as it starts playing, the very ones made", async () => {
    const fetched: string[] = [];
    const played: string[] = [];
    let finish = () => {};
    const voice = createFrontVoice({
      fetchAudio: async (text, language) => {
        fetched.push(text);
        return `${language}:${text}`;
      },
      playAudio: (audio) => {
        played.push(audio);
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    const heard: (number | null)[] = [];
    let told: readonly string[] = [];
    const said = voice.say(
      "Claude : the build passed. Two tests: flaky; rerun them!",
      new AbortController().signal,
      {
        onSentence: (index, sentences) => {
          heard.push(index);
          told = sentences;
        },
      },
    );
    await flush();
    // Nothing told before it plays; then the first, then each in turn.
    expect(heard).toEqual([0]);
    expect(told).toEqual(fetched);
    expect(told).toEqual(
      spokenSentences(
        "Claude : the build passed. Two tests: flaky; rerun them!",
      ),
    );
    for (let at = 1; at < told.length; at += 1) {
      finish();
      await flush();
      expect(heard[heard.length - 1]).toBe(at);
      expect(played[at]).toBe(`en:${told[at]}`);
    }
    finish();
    await said;
    expect(heard).toEqual([0, 1, 2, 3, 4, null]);
  });

  test("stopped, it ends there; never started, nothing is told", async () => {
    const speech = fakeSpeech();
    const signal = new AbortController().signal;
    const heard: (number | null)[] = [];
    const first = speech.voice.say("One. Two. Three.", signal, {
      onSentence: (index) => heard.push(index),
    });
    const queued: (number | null)[] = [];
    const second = speech.voice.say("Never said.", signal, {
      onSentence: (index) => queued.push(index),
    });
    await flush();
    speech.voice.hush();
    await first;
    await second;
    expect(heard).toEqual([0, null]);
    expect(queued).toEqual([]);
  });
});

describe("spokenSentences", () => {
  test("ends at sentence marks, colons and semicolons", () => {
    expect(
      spokenSentences(
        "Quatre agents travaillent : Roamgate et GStreamer. Rien d'autre ; voilà!",
      ),
    ).toEqual([
      "Quatre agents travaillent :",
      "Roamgate et GStreamer.",
      "Rien d'autre ;",
      "voilà!",
    ]);
    expect(spokenSentences("Ok")).toEqual(["Ok"]);
  });
});

describe("frontContext", () => {
  test("tells Ranger tasks, merge requests and what happened lately", () => {
    const now = Date.parse("2026-11-02T10:00:00Z");
    const task = {
      id: "t1",
      title: "Nightly CI watch",
      status: "active",
      next_run_at: "2026-11-03T02:00:00Z",
      last_run: { status: "succeeded", error: null },
    } as unknown as AssistantTask;
    const cancelled = {
      ...task,
      id: "t2",
      title: "Old",
      status: "cancelled",
    } as AssistantTask;
    const request = {
      ref: {
        provider: "gitlab",
        host: "gitlab.freedesktop.org",
        project: "gstreamer/gstreamer",
        number: 9876,
      },
      state: "ready",
      fetchedAt: "",
      request: {
        url: "",
        project: "gstreamer/gstreamer",
        title: "webrtcsink: fix leak",
        state: "open",
        draft: false,
        author: "",
        sourceBranch: "",
        targetBranch: "",
        updatedAt: "",
        pipeline: {
          status: "failed",
          failed: [
            { name: "check-rust" },
            { name: "lint", allowFailure: true },
          ],
        },
        approvals: null,
        unresolved: 2,
      },
    } as ForgeStatus;
    expect(
      frontContext({
        tasks: [task, cancelled],
        requests: [request, { ...request, state: "security" } as ForgeStatus],
        events: [{ text: "IGA-184: needs input", at: now - 3 * 60_000 }],
        now,
      }),
    ).toBe(
      [
        "Ranger tasks:",
        '- "Nightly CI watch": active, last run succeeded, next run 2026-11-03T02:00:00Z',
        "",
        "Merge requests:",
        '- gstreamer/gstreamer !9876 "webrtcsink: fix leak" open, CI failed (failed: check-rust), 2 open threads',
        "",
        "Lately:",
        "- 3 min ago: IGA-184: needs input",
      ].join("\n"),
    );
    expect(frontContext({ tasks: [], requests: [], events: [] })).toBe("");
  });
});

describe("voice events", () => {
  // Other files of a serial run leave events behind.
  beforeEach(() => __resetVoiceEventsForTests());
  afterEach(() => __resetVoiceEventsForTests());

  test("are kept, told to listeners, once", () => {
    const heard: string[] = [];
    const stop = onVoiceEvent((event) => heard.push(event.text));
    noteVoiceEvent({ text: "IGA-184: finished", paneId: "p1", at: 1000 });
    noteVoiceEvent({ text: "IGA-184: finished", paneId: "p1", at: 2000 });
    noteVoiceEvent({ text: "Ranger task failed: Nightly", at: 3000 });
    stop();
    noteVoiceEvent({ text: "later", at: 4000 });
    expect(heard).toEqual(["IGA-184: finished", "Ranger task failed: Nightly"]);
    expect(recentVoiceEvents(5000).map((event) => event.text)).toEqual([
      "IGA-184: finished",
      "Ranger task failed: Nightly",
      "later",
    ]);
  });

  test("the voice chat's own session is not told: its answer is read", () => {
    const key = { connectionId: "local", paneId: "p1" };
    expect(
      eventForFront(
        { text: "x", at: 0, connectionId: "local", paneId: "p1" },
        key,
      ),
    ).toBe(false);
    expect(
      eventForFront(
        { text: "x", at: 0, connectionId: "local", paneId: "p2" },
        key,
      ),
    ).toBe(true);
    expect(eventForFront({ text: "Ranger task", at: 0 }, key)).toBe(true);
  });
});

describe("routeSpeech", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("carries the words exactly as said, with the front's state", async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ to: "current", reply: "Je transmets." });
    }) as unknown as typeof fetch;
    const said = "Euh, oui, vas-y, pousse la branche et ouvre rien.";
    expect(
      await routeSpeech(said, "local/p1", [], "Ranger tasks:\n- x"),
    ).toEqual({ to: "current", reply: "Je transmets." });
    expect(bodies[0]).toEqual({
      said,
      current: "local/p1",
      sessions: [],
      routes: [...KNOWN_ROUTES],
      context: "Ranger tasks:\n- x",
    });
    // What went to nobody lately goes with it, for the front to take back.
    const skipped = [{ text: "lance les tests", at: 1000 }];
    await routeSpeech(
      "c'était pour toi",
      "local/p1",
      [],
      "",
      {},
      undefined,
      undefined,
      skipped,
    );
    expect(bodies[1]).toEqual({
      said: "c'était pour toi",
      current: "local/p1",
      sessions: [],
      routes: [...KNOWN_ROUTES],
      skipped,
    });
    bodies.splice(1, 1);
    // Without a front, no state goes: as it always did.
    await routeSpeech(said, "local/p1", []);
    expect(bodies[1]).toEqual({
      said,
      current: "local/p1",
      sessions: [],
      routes: [...KNOWN_ROUTES],
    });
  });
});

describe("with a front, only its own words are said", () => {
  test("no line saying words were not for it: the router alone says it", () => {
    expect(notForMeSpoken(true)).toBe(false);
    expect(notForMeSpoken(false)).toBe(true);
  });

  test("words the speaker check doubted are kept for the front, never lost", () => {
    // "Taken as not for you": the front gets them, to bring back when the
    // user says it was for it.
    const doubted = { text: "Et puis je disais ça.", forAgent: false };
    expect(withNotForAgent([], doubted, true, 1000)).toEqual([
      { text: "Et puis je disais ça.", at: 1000 },
    ]);
    // Words for the agent are not skipped; without a front, nobody to
    // bring them back.
    expect(
      withNotForAgent([], { text: "Pour toi.", forAgent: true }, true, 1000),
    ).toEqual([]);
    expect(withNotForAgent([], doubted, false, 1000)).toEqual([]);
    // Who said them goes with them, for the front to read.
    expect(
      withNotForAgent(
        [],
        { ...doubted, voiceLabel: "voice B, 0.07 like you" },
        true,
        1000,
      ),
    ).toEqual([
      {
        text: "Et puis je disais ça.",
        at: 1000,
        voice: "voice B, 0.07 like you",
      },
    ]);
  });

  test("words not for it are kept for the front, recent ones only", () => {
    let list = withSkipped([], "Vas-y, vas-y, ça laisse passer", 1000);
    list = withSkipped(list, "  ", 2000);
    expect(list).toEqual([
      { text: "Vas-y, vas-y, ça laisse passer", at: 1000 },
    ]);
    for (let at = 0; at < SKIPPED_KEPT + 2; at += 1)
      list = withSkipped(list, `said ${at}`, 3000 + at);
    expect(list).toHaveLength(SKIPPED_KEPT);
    expect(list[list.length - 1]).toEqual({
      text: `said ${SKIPPED_KEPT + 1}`,
      at: 3000 + SKIPPED_KEPT + 1,
    });
    // Older than SKIPPED_MAX_AGE_MS: forgotten.
    const later = 3000 + SKIPPED_KEPT + 1 + SKIPPED_MAX_AGE_MS;
    expect(withSkipped(list, "later", later)).toEqual([
      { text: `said ${SKIPPED_KEPT + 1}`, at: 3000 + SKIPPED_KEPT + 1 },
      { text: "later", at: later },
    ]);
  });

  test("words the front routed after all are no longer skipped", () => {
    const list = [
      { text: "lance les tests", at: 1000 },
      { text: "Vas-y, ça laisse passer", at: 2000 },
    ];
    expect(withoutRecovered(list, "lance les tests", 3000)).toEqual([
      { text: "Vas-y, ça laisse passer", at: 2000 },
    ]);
    expect(withoutRecovered(list, undefined, 3000)).toEqual(list);
  });
});
