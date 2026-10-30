import { describe, expect, test } from "bun:test";
import { SpeakableStream, speakStream } from "./voiceChat";

function feed(chunks: string[]): string[] {
  const stream = new SpeakableStream();
  const out: string[] = [];
  for (const chunk of chunks) out.push(...stream.push(chunk));
  out.push(...stream.flush());
  return out;
}

describe("SpeakableStream", () => {
  test("a sentence is given once it ends, not before", () => {
    const stream = new SpeakableStream();
    expect(stream.push("Hello th")).toEqual([]);
    expect(stream.push("ere. How ")).toEqual(["Hello there."]);
    expect(stream.push("are you")).toEqual([]);
    expect(stream.flush()).toEqual(["How are you"]);
  });

  test("the same sentences as reading the whole text", () => {
    const text =
      "First one. Second **bold** one!\n\n- A list item.\n- Another, with [a link](https://x.y).\n\nDone?";
    for (const size of [1, 2, 3, 7, 13])
      expect(
        feed(text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? []),
      ).toEqual([
        "First one.",
        "Second bold one!",
        "A list item.",
        "Another, with a link.",
        "Done?",
      ]);
  });

  test("a code block waits for its end, then is left out", () => {
    const stream = new SpeakableStream();
    expect(stream.push("Run this.\n```sh\necho hi. ")).toEqual(["Run this."]);
    expect(stream.push("echo there.\n")).toEqual([]);
    expect(stream.push("```\nThen stop. ")).toEqual(["Then stop."]);
  });

  test("a table row is cut at its line's end only", () => {
    expect(feed(["| a. b | c. ", "d |\n", "After it."])).toEqual(["After it."]);
  });

  test("markup cut in two is not read out", () => {
    expect(feed(["**Bold. sentence** ends", " here."])).toEqual([
      "Bold.",
      "sentence ends here.",
    ]);
  });

  test("a mark after a space ends nothing", () => {
    expect(feed(["Use src ! sink here. Next."])).toEqual([
      "Use src ! sink here.",
      "Next.",
    ]);
  });
});

async function* chunks(list: string[], gate?: Promise<void>) {
  for (const [index, chunk] of list.entries()) {
    if (index === 1 && gate) await gate;
    yield chunk;
  }
}

describe("speakStream", () => {
  test("speaks each sentence in order as it completes", async () => {
    const fetched: string[] = [];
    const played: string[] = [];
    const heard: (string | null)[] = [];
    await speakStream(
      chunks(["One. Tw", "o. Three"]),
      new AbortController().signal,
      (sentence) => heard.push(sentence),
      {
        fetchAudio: async (text) => {
          fetched.push(text);
          return new Blob([text]);
        },
        playAudio: async (audio) => {
          played.push(await audio.text());
        },
      },
    );
    expect(fetched).toEqual(["One.", "Two.", "Three"]);
    expect(played).toEqual(["One.", "Two.", "Three"]);
    expect(heard).toEqual(["One.", "Two.", "Three", null]);
  });

  test("the first sentence plays before the text is over", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const played: string[] = [];
    const done = speakStream(
      chunks(["Early. ", "Late."], gate),
      new AbortController().signal,
      undefined,
      {
        fetchAudio: async (text) => new Blob([text]),
        playAudio: async (audio) => {
          played.push(await audio.text());
        },
      },
    );
    for (let i = 0; i < 20 && !played.length; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    expect(played).toEqual(["Early."]);
    release();
    await done;
    expect(played).toEqual(["Early.", "Late."]);
  });

  test("fetches ahead, but no more than asked", async () => {
    const fetched: string[] = [];
    let playing = 0;
    let maxAhead = 0;
    await speakStream(
      chunks(["A one. A two. A three. A four. A five."]),
      new AbortController().signal,
      undefined,
      {
        prefetch: 2,
        fetchAudio: async (text) => {
          fetched.push(text);
          maxAhead = Math.max(maxAhead, fetched.length - playing);
          return new Blob([text]);
        },
        playAudio: async () => {
          playing += 1;
        },
      },
    );
    expect(fetched.length).toBe(5);
    // The one about to play, and two ahead of it.
    expect(maxAhead).toBeLessThanOrEqual(3);
  });

  test("stops when aborted", async () => {
    const controller = new AbortController();
    const played: string[] = [];
    await speakStream(
      chunks(["One. Two. Three."]),
      controller.signal,
      undefined,
      {
        fetchAudio: async (text) => new Blob([text]),
        playAudio: async (audio) => {
          played.push(await audio.text());
          controller.abort();
        },
      },
    );
    expect(played).toEqual(["One."]);
  });
});
