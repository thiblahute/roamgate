import { afterEach, describe, expect, jest, test } from "bun:test";
import type { AssistantTask } from "../../shared/assistant";
import type { ForgeStatus } from "../../shared/forge";
import {
  __resetVoiceEventsForTests,
  noteVoiceEvent,
  onVoiceEvent,
  recentVoiceEvents,
} from "./voiceEvents";
import {
  awaitFront,
  createFrontVoice,
  eventForFront,
  FRONT_SLOW_MS,
  frontReplySaid,
  frontContext,
  spokenSentences,
} from "./voiceFront";
import { KNOWN_ROUTES, routeSpeech } from "./voiceRoute";

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe("awaitFront", () => {
  test("a front that answers in time leaves the canned ack unsaid", async () => {
    jest.useFakeTimers();
    try {
      let slow = 0;
      let answer: (value: string) => void = () => {};
      const waited = awaitFront(
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
        { onSlow: () => (slow += 1) },
      );
      jest.advanceTimersByTime(FRONT_SLOW_MS - 100);
      answer("current");
      expect(await waited).toEqual({ value: "current", slow: false });
      jest.advanceTimersByTime(5000);
      expect(slow).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a slow front: the canned ack is said once, and the answer still used", async () => {
    jest.useFakeTimers();
    try {
      let slow = 0;
      let answer: (value: string) => void = () => {};
      const waited = awaitFront(
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
        { onSlow: () => (slow += 1) },
      );
      jest.advanceTimersByTime(FRONT_SLOW_MS);
      expect(slow).toBe(1);
      jest.advanceTimersByTime(3000);
      answer("self");
      expect(await waited).toEqual({ value: "self", slow: true });
      expect(slow).toBe(1);
    } finally {
      jest.useRealTimers();
    }
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

describe("a turn is acknowledged once", () => {
  test("the front's words are its ack, the canned one only when it is slow", () => {
    expect(FRONT_SLOW_MS).toBeGreaterThanOrEqual(3000);
    for (const to of ["current", "send", "ranger", "errand"]) {
      expect(frontReplySaid(to, false)).toBe(true);
      // The canned ack said it already: "Je transmets" is not said again.
      expect(frontReplySaid(to, true)).toBe(false);
    }
    // An answer of its own, or a switch, is said however slow.
    expect(frontReplySaid("self", true)).toBe(true);
    expect(frontReplySaid("open", true)).toBe(true);
    expect(frontReplySaid("mode", true)).toBe(true);
  });
});
