import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  __resetCompanionCallForTests,
  companionCallState,
  companionTeller,
  setCompanionTeller,
} from "./companionCall";
import { followCompanionWeb, webAck } from "./companionWeb";
import type { ResearchJob } from "./voiceRoute";

afterEach(() => {
  __resetCompanionCallForTests();
  jest.useRealTimers();
});

const job = (update: Partial<ResearchJob>): ResearchJob => ({
  id: "w1",
  question: "Quel temps demain à Lyon ?",
  status: "searching",
  steps: [],
  started: 0,
  ...update,
});

/** Lets the follower's awaited reads run. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
};

const webEntry = () => {
  const entry = companionCallState().log.find((each) => each.kind === "web");
  if (entry?.kind !== "web") throw new Error("no web entry");
  return entry;
};

describe("a web search the companion follows", () => {
  test("is said at once, in the language it was asked in", () => {
    expect(webAck(undefined, "Quel temps fera-t-il demain à Lyon ?")).toBe(
      "Je regarde ça sur le web, je te redis.",
    );
    expect(webAck("  ", "What's the weather tomorrow in Lyon?")).toBe(
      "Let me look that up, I'll tell you.",
    );
    // The front's own line, a provisional answer with it.
    expect(
      webAck(
        "Normalement c'est fermé le lundi, mais je vérifie.",
        "C'est ouvert lundi ?",
      ),
    ).toBe("Normalement c'est fermé le lundi, mais je vérifie.");
  });

  test("shows its steps, then its answer, told by the call that runs", async () => {
    jest.useFakeTimers();
    let state = job({});
    const told: string[] = [];
    setCompanionTeller((text) => told.push(text));
    const following = followCompanionWeb("w1", "Quel temps demain à Lyon ?", {
      state: async () => state,
    });
    expect(webEntry()).toMatchObject({
      job: "w1",
      question: "Quel temps demain à Lyon ?",
      status: "searching",
      steps: [],
    });
    state = job({ steps: ["Searching: météo Lyon demain"] });
    jest.advanceTimersByTime(1500);
    await settle();
    expect(webEntry().steps).toEqual(["Searching: météo Lyon demain"]);
    expect(told).toEqual([]);
    state = job({
      status: "done",
      steps: ["Searching: météo Lyon demain", "Reading meteofrance.com"],
      spoken: "D'après Météo-France, couvert et 9 degrés.",
      answer: "Couvert, 9 °C. [Météo-France](https://meteofrance.com/lyon)",
      sources: [{ title: "Météo-France", url: "https://meteofrance.com/lyon" }],
    });
    jest.advanceTimersByTime(1500);
    await settle();
    expect((await following)?.status).toBe("done");
    expect(webEntry()).toMatchObject({
      status: "done",
      spoken: "D'après Météo-France, couvert et 9 degrés.",
      answer: "Couvert, 9 °C. [Météo-France](https://meteofrance.com/lyon)",
      sources: [{ title: "Météo-France", url: "https://meteofrance.com/lyon" }],
    });
    // Told once, as written for the voice; the call writes what it says.
    expect(told).toEqual(["D'après Météo-France, couvert et 9 degrés."]);
    expect(companionCallState().log.filter((e) => e.kind === "said")).toEqual(
      [],
    );
  });

  test("outside a call, what it found is written in the conversation", async () => {
    const found = await followCompanionWeb(
      "w1",
      "Dernière version de GStreamer ?",
      {
        state: async () =>
          job({ status: "done", spoken: "C'est la 1.28.8.", answer: "1.28.8" }),
        wait: async () => {},
      },
    );
    expect(found?.spoken).toBe("C'est la 1.28.8.");
    expect(companionCallState().log.slice(-1)[0]).toMatchObject({
      kind: "said",
      text: "C'est la 1.28.8.",
    });
  });

  test("a failed search says so, a cancelled one says nothing", async () => {
    const told: string[] = [];
    setCompanionTeller((text) => told.push(text));
    await followCompanionWeb("w1", "Horaires de la Fnac de Grenoble", {
      state: async () => job({ status: "failed", error: "It took too long." }),
      wait: async () => {},
    });
    await followCompanionWeb("w2", "Météo à Lyon", {
      state: async () => job({ id: "w2", status: "cancelled" }),
      wait: async () => {},
    });
    expect(told).toEqual([
      "Je n'ai pas réussi à trouver ça sur le web : Horaires de la Fnac de Grenoble",
    ]);
    expect(
      companionCallState()
        .log.filter((entry) => entry.kind === "web")
        .map((entry) => entry.kind === "web" && entry.status),
    ).toEqual(["failed", "cancelled"]);
  });

  test("a search it loses track of is given up on", async () => {
    let reads = 0;
    expect(
      await followCompanionWeb("w9", "x", {
        state: async () => {
          reads += 1;
          return null;
        },
        wait: async () => {},
      }),
    ).toBeNull();
    expect(reads).toBe(5);
    expect(webEntry().status).toBe("failed");
  });

  test("a teller that left no longer tells", () => {
    const told: string[] = [];
    const first = setCompanionTeller((text) => told.push(`first ${text}`));
    const unsetSecond = setCompanionTeller((text) =>
      told.push(`second ${text}`),
    );
    // The first call's end does not unset the one that runs now.
    first();
    companionTeller()?.("found");
    unsetSecond();
    expect(companionTeller()).toBeNull();
    expect(told).toEqual(["second found"]);
  });
});
