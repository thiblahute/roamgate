import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  __resetCompanionCallForTests,
  companionCallState,
  companionTeller,
  setCompanionTeller,
} from "./companionCall";
import {
  answerCompanionTool,
  followCompanionTool,
  followCompanionWeb,
  plainHeldAnswer,
  toolAck,
  waitingHeldCall,
  webAck,
} from "./companionWeb";
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

describe("a tool request the companion follows", () => {
  test("is said at once, the front's own words first", () => {
    expect(toolAck(undefined, "Mets la musique en pause, s'il te plaît")).toBe(
      "Je m'en occupe.",
    );
    expect(toolAck(undefined, "Pause the music")).toBe("On it.");
    expect(toolAck("Je mets en pause.", "Pause")).toBe("Je mets en pause.");
  });

  test("is logged as a tool job, its result told", async () => {
    const told: string[] = [];
    setCompanionTeller((text) => told.push(text));
    const originalFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      return Response.json(
        job({
          id: "t1",
          question: "Pause",
          status: "done",
          spoken: "C'est en pause.",
        }),
      );
    }) as unknown as typeof fetch;
    jest.useFakeTimers();
    try {
      const following = followCompanionTool("t1", "Pause");
      jest.advanceTimersByTime(1500);
      await settle();
      await following;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(asked).toEqual(["/api/voice/tools?job=t1"]);
    expect(webEntry()).toMatchObject({ tool: true, status: "done" });
    expect(told).toEqual(["C'est en pause."]);
  });
});

describe("a call its tools hold for the user's yes", () => {
  const HELD = {
    tool: "mcp__claude_ai_WhatsApp__send_message",
    input: { jid: "33600", text: "J'arrive" },
  };
  const holding = job({
    id: "t1",
    question: "Dis à Marie que j'arrive",
    status: "done",
    spoken: "J'envoie à Marie : « J'arrive ». Je confirme ?",
    held: HELD,
  });
  /** Lets the held call's watcher run its reads (its waits are instant). */
  const drain = () => new Promise((resolve) => setTimeout(resolve, 0));
  const toolEntry = () => {
    const entry = companionCallState().log.find(
      (each) => each.kind === "web" && each.tool,
    );
    if (entry?.kind !== "web") throw new Error("no tool entry");
    return entry;
  };

  test("waits with its buttons until answered, wherever it was", async () => {
    let state: ResearchJob = holding;
    await followCompanionWeb("t1", "Dis à Marie que j'arrive", {
      tool: true,
      state: async () => state,
      wait: async () => {},
    });
    expect(toolEntry()).toMatchObject({ held: true });
    expect(toolEntry().heldOutcome).toBeUndefined();
    expect(waitingHeldCall()).toBe(toolEntry().id);
    // Said yes on the call: the server made it, the buttons go.
    state = { ...holding, heldOutcome: "confirmed" };
    await drain();
    expect(toolEntry().heldOutcome).toBe("confirmed");
    expect(waitingHeldCall()).toBeNull();
  });

  test("never answered, it stops waiting as the server forgets it", async () => {
    let reads = 0;
    await followCompanionWeb("t1", "Dis à Marie que j'arrive", {
      tool: true,
      state: async () => {
        reads += 1;
        return holding;
      },
      wait: async () => {},
    });
    await drain();
    expect(toolEntry().heldOutcome).toBe("expired");
    // The first read and about 5 minutes of them, no more.
    expect(reads).toBe(101);
  });

  test("a web search or a done call holds nothing", async () => {
    await followCompanionWeb("w1", "Météo", {
      state: async () => job({ status: "done", spoken: "Beau." }),
      wait: async () => {},
    });
    await followCompanionWeb("t2", "Pause", {
      tool: true,
      state: async () =>
        job({ id: "t2", status: "done", spoken: "C'est en pause." }),
      wait: async () => {},
    });
    expect(
      companionCallState().log.some((each) => each.kind === "web" && each.held),
    ).toBe(false);
    expect(waitingHeldCall()).toBeNull();
  });

  /**
   * A held call in the conversation: its result read once, its watcher
   * then waiting for good (these tests answer it themselves).
   */
  async function held() {
    let waits = 0;
    await followCompanionWeb("t1", "Dis à Marie que j'arrive", {
      tool: true,
      state: async () => holding,
      wait: () =>
        waits++ === 0 ? Promise.resolve() : new Promise<void>(() => {}),
    });
    return toolEntry().id;
  }

  test("a click on yes makes it, then follows the job making it", async () => {
    const id = await held();
    const asked: string[] = [];
    const followed: string[] = [];
    await answerCompanionTool(id, "yes", {
      answer: async (which, answer) => {
        asked.push(`${which} ${answer}`);
        return {
          job: job({
            id: "t2",
            question: "Dis à Marie que j'arrive (confirmed)",
          }),
        };
      },
      follow: async (which, task) => {
        followed.push(`${which}: ${task}`);
        return null;
      },
    });
    expect(asked).toEqual(["t1 yes"]);
    expect(followed).toEqual(["t2: Dis à Marie que j'arrive (confirmed)"]);
    expect(toolEntry().heldOutcome).toBe("confirmed");
    const lines = companionCallState().log.flatMap((each) =>
      each.kind === "heard" || each.kind === "said"
        ? [`${each.kind}: ${each.text}`]
        : [],
    );
    expect(lines.slice(-2)).toEqual([
      "heard: Yes, do it.",
      "said: C'est parti.",
    ]);
    // Answered: another click sends nothing.
    await answerCompanionTool(id, "no", {
      answer: async () => {
        throw new Error("not asked");
      },
    });
  });

  test("no forgets it; not through, its buttons come back", async () => {
    const id = await held();
    const told: string[] = [];
    setCompanionTeller((text) => told.push(text));
    await answerCompanionTool(id, "no", { answer: async () => null });
    expect(toolEntry().heldOutcome).toBeUndefined();
    await answerCompanionTool(id, "no", {
      answer: async () => ({ declined: true }),
    });
    expect(toolEntry().heldOutcome).toBe("declined");
    // Said on the call that runs: what it says of each.
    expect(told).toEqual([
      "Ça n'est pas passé, réessaie.",
      "D'accord, je n'envoie rien.",
    ]);
  });

  test("a click after it was forgotten says nothing waits", async () => {
    const id = await held();
    await answerCompanionTool(id, "yes", { answer: async () => "gone" });
    expect(toolEntry().heldOutcome).toBe("expired");
    expect(companionCallState().log.slice(-1)[0]).toMatchObject({
      kind: "said",
      text: "Rien n'attend de confirmation.",
    });
  });

  test("typed, only a plain yes or no answers it", () => {
    for (const yes of ["oui", "Oui !", "yes please", "vas-y", "OK", "envoie"])
      expect(plainHeldAnswer(yes)).toBe("yes");
    for (const no of ["non", "No.", "annule", "non merci", "don't"])
      expect(plainHeldAnswer(no)).toBe("no");
    for (const more of [
      "non, dis plutôt vingt minutes",
      "oui mais change le texte",
      "who is Marie?",
      "",
    ])
      expect(plainHeldAnswer(more)).toBeNull();
  });
});
