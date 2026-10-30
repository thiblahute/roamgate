import { describe, expect, test } from "bun:test";
import {
  type CleanerAsk,
  type CleanerReply,
  type ClaudeProcess,
  CleanSession,
  parseCleanerReply,
  sentences,
  VoiceCleaner,
} from "./voice-cleaner";

/** A model that answers each prompt with `answer(prompt)`, and keeps them. */
function fakeAsk(answer: (prompt: string) => CleanerReply) {
  const prompts: string[] = [];
  const ask: CleanerAsk = async (prompt) => {
    prompts.push(prompt);
    return answer(prompt);
  };
  return { ask, prompts };
}

/** The text after the last "Rest: " or "PIECE\n" of a prompt. */
function asked(prompt: string): string {
  const rest = prompt.lastIndexOf("Rest: ");
  if (rest >= 0) return prompt.slice(rest + 6);
  return prompt.slice(prompt.lastIndexOf("PIECE\n") + 6);
}

describe("sentences", () => {
  test("splits after end punctuation, keeping it", () => {
    expect(sentences("Okay. So um what now? Let's go")).toEqual([
      "Okay.",
      "So um what now?",
      "Let's go",
    ]);
    expect(sentences("")).toEqual([]);
  });
});

describe("parseCleanerReply", () => {
  test("reads the JSON object around any other text", () => {
    expect(
      parseCleanerReply('```json\n{"for_agent": false, "text": "Hi"}\n```'),
    ).toEqual({ for_agent: false, text: "Hi" });
    expect(() => parseCleanerReply("no")).toThrow();
  });
});

describe("CleanSession", () => {
  test("cleans the end alone when nothing settled before", async () => {
    const { ask, prompts } = fakeAsk((prompt) => ({
      for_agent: true,
      text: asked(prompt).replace("um ", ""),
    }));
    const session = new CleanSession(ask, "Agent: Want it?");
    expect(await session.final("Yes um do it.")).toEqual({
      text: "Yes do it.",
      forAgent: true,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Agent: Want it?");
    expect(prompts[0]).toContain("END\nCleaned so far: \nRest: Yes um do it.");
  });

  test("cleans settled sentences while the rest is said", async () => {
    const { ask, prompts } = fakeAsk((prompt) => ({
      text: asked(prompt).replaceAll("uh ", ""),
    }));
    const session = new CleanSession(ask, "");
    session.partial("First uh one. Second");
    // Not settled until it reads the same twice.
    expect(prompts).toHaveLength(0);
    session.partial("First uh one. Second uh one");
    expect(prompts).toEqual(["PIECE\nFirst uh one."]);
    const cleaned = await session.final("First uh one. Second uh one.");
    expect(prompts[1]).toBe(
      "END\nCleaned so far: First one.\nRest: Second uh one.",
    );
    expect(cleaned).toEqual({ text: "First one. Second one.", forAgent: true });
  });

  test("a piece the transcript no longer starts with is dropped", async () => {
    const { ask, prompts } = fakeAsk((prompt) => ({ text: asked(prompt) }));
    const session = new CleanSession(ask, "");
    session.partial("Fist one. Two");
    session.partial("Fist one. Two more");
    const cleaned = await session.final("First one. Two more.");
    expect(prompts.at(-1)).toBe(
      "END\nCleaned so far: \nRest: First one. Two more.",
    );
    expect(cleaned.text).toBe("First one. Two more.");
  });

  test("the end cleaned at a pause is not asked again", async () => {
    const { ask, prompts } = fakeAsk((prompt) => ({ text: asked(prompt) }));
    const session = new CleanSession(ask, "");
    session.partial("Do it now", true);
    expect(await session.final("Do it now")).toEqual({
      text: "Do it now",
      forAgent: true,
    });
    expect(prompts).toHaveLength(1);
  });

  test("the end can fix what was cleaned before, and say who it was for", async () => {
    const { ask } = fakeAsk((prompt) =>
      prompt.includes("END")
        ? {
            for_agent: false,
            text: "",
            fixes: [{ from: "red", to: "blue" }],
          }
        : { text: "Paint it red." },
    );
    const session = new CleanSession(ask, "");
    session.partial("Paint it red. Not red, blue I mean");
    session.partial("Paint it red. Not red, blue I mean");
    expect(await session.final("Paint it red. Not red, blue I mean.")).toEqual({
      text: "Paint it blue.",
      forAgent: false,
    });
  });

  test("a piece that comes back empty keeps its words", async () => {
    const { ask } = fakeAsk((prompt) =>
      prompt.includes("END") ? { text: asked(prompt) } : { text: "" },
    );
    const session = new CleanSession(ask, "");
    session.partial("Can I queue this, am I? But if I");
    session.partial("Can I queue this, am I? But if I start");
    expect(
      (await session.final("Can I queue this, am I? But if I start talking"))
        .text,
    ).toBe("Can I queue this, am I? But if I start talking");
  });

  test("a model that loses most of the words gives them as heard", async () => {
    const { ask } = fakeAsk(() => ({ text: "Talking." }));
    const session = new CleanSession(ask, "");
    expect(
      await session.final("I am not able to queue something else, am I"),
    ).toEqual({
      text: "I am not able to queue something else, am I",
      forAgent: true,
    });
  });

  test("a failing or slow model gives the words as heard", async () => {
    const failing = new CleanSession(async () => {
      throw new Error("down");
    }, "");
    expect(await failing.final("Uh hello.")).toEqual({
      text: "Uh hello.",
      forAgent: true,
    });
    const slow = new CleanSession(() => new Promise(() => {}), "", 20);
    expect(await slow.final("Uh hello.")).toEqual({
      text: "Uh hello.",
      forAgent: true,
    });
  });
});

/** A Claude Code process answering each message with `answer`. */
function fakeClaude(answer: (content: string) => string) {
  const written: string[] = [];
  const lines: string[] = [];
  let wake: (() => void) | null = null;
  let exit: () => void = () => {};
  const process: ClaudeProcess = {
    write: (line) => {
      written.push(line);
      const content = JSON.parse(line).message.content as string;
      lines.push(JSON.stringify({ type: "result", result: answer(content) }));
      wake?.();
    },
    lines: (async function* () {
      for (;;) {
        while (lines.length) yield lines.shift()!;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })(),
    kill: () => exit(),
    exited: new Promise<void>((resolve) => {
      exit = resolve;
    }),
  };
  return { process, written };
}

describe("VoiceCleaner", () => {
  test("asks a background session and reads its JSON", async () => {
    const claude = fakeClaude(
      (content) => `{"for_agent": true, "text": "${content.toUpperCase()}"}`,
    );
    let spawned = 0;
    const cleaner = new VoiceCleaner(() => {
      spawned += 1;
      return claude.process;
    }, 1);
    expect(await cleaner.ask("hi")).toEqual({ for_agent: true, text: "HI" });
    expect(await cleaner.ask("there")).toEqual({
      for_agent: true,
      text: "THERE",
    });
    expect(spawned).toBe(1);
    expect(JSON.parse(claude.written[0]!)).toEqual({
      type: "user",
      message: { role: "user", content: "hi" },
    });
  });

  test("requests no longer needed are dropped unasked", async () => {
    const claude = fakeClaude(() => '{"text": "ok"}');
    const cleaner = new VoiceCleaner(() => claude.process, 1);
    const first = cleaner.ask("first");
    const over = new AbortController();
    const second = cleaner.ask("second", over.signal);
    over.abort();
    await first;
    await expect(second).rejects.toThrow("No longer needed");
    expect(claude.written).toHaveLength(1);
  });
});
