import { describe, expect, test } from "bun:test";
import { markdownToSpeech } from "./markdownToSpeech";
import { SpeakableStream, sentences, speakStream } from "./voiceChat";

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

  test("a code block waits for its fence to close, then is announced once", () => {
    const stream = new SpeakableStream();
    expect(stream.push("Run this.\n``")).toEqual(["Run this."]);
    expect(stream.push("`sh\necho hi. ")).toEqual([]);
    expect(stream.push("echo there.\n`")).toEqual([]);
    expect(stream.push("``\nThen stop. ")).toEqual([
      "sh code block omitted.",
      "Then stop.",
    ]);
    expect(stream.flush()).toEqual([]);
  });

  test("a table is read once it is finished, its rows with their labels", () => {
    const stream = new SpeakableStream();
    expect(stream.push("| Name | Size |\n| - | - |\n| alpha | ")).toEqual([]);
    expect(stream.push("2 |\n| c | 3 |")).toEqual([]);
    expect(stream.push("\n\nAfter it. ")).toEqual([
      "Table.",
      "Name: alpha.",
      "Size: 2.",
      "Name: c.",
      "Size: 3.",
      "After it.",
    ]);
  });

  test("a list item is read once the next one starts, with its number", () => {
    const stream = new SpeakableStream();
    expect(stream.push("1. First step.\n2. Sec")).toEqual(["1. First step."]);
    expect(stream.push("ond step.\n\n")).toEqual(["2. Second step."]);
  });

  test("streamed in pieces of any size, it reads what the whole reply reads", () => {
    const text = [
      "Here is the plan. It has **three** parts, see [the docs](https://example.com/a).",
      "",
      "1. Build it.",
      "2. Run `bun test`. Then check.",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "| Step | Time |",
      "| - | - |",
      "| build | 2 s |",
      "",
      "> Quoted. Still quoted.",
      "",
      "## Done",
      "That is all. Bye!",
    ].join("\n");
    const whole = sentences(markdownToSpeech(text));
    for (const size of [1, 2, 3, 5, 8, 13, 40])
      expect(
        feed(text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? []),
      ).toEqual(whole);
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
        voice: {
          prepare: async (text: string) => {
            fetched.push(text);
            return text;
          },
          play: async (audio: string) => {
            played.push(audio);
          },
        },
      },
    );
    expect(fetched).toEqual(["One.", "Two.", "Three"]);
    expect(played).toEqual(["One.", "Two.", "Three"]);
    expect(heard).toEqual(["One.", "Two.", "Three", null]);
  });

  test("skips the sentences already heard, wherever the text is cut", async () => {
    const played: string[] = [];
    await speakStream(
      chunks(["One. Tw", "o. Three. Four."]),
      new AbortController().signal,
      undefined,
      {
        skip: 2,
        voice: {
          prepare: async (text: string) => text,
          play: async (audio: string) => {
            played.push(audio);
          },
        },
      },
    );
    expect(played).toEqual(["Three.", "Four."]);
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
        voice: {
          prepare: async (text: string) => text,
          play: async (audio: string) => {
            played.push(audio);
          },
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
        voice: {
          prepare: async (text: string) => {
            fetched.push(text);
            maxAhead = Math.max(maxAhead, fetched.length - playing);
            return text;
          },
          play: async () => {
            playing += 1;
          },
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
        voice: {
          prepare: async (text: string) => text,
          play: async (audio: string) => {
            played.push(audio);
            controller.abort();
          },
        },
      },
    );
    expect(played).toEqual(["One."]);
  });
});
