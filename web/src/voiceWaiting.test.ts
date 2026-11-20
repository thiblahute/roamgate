import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetCompanionCallForTests,
  companionCallState,
} from "./companionCall";
import {
  mentionLine,
  mentionWaitingAnswers,
  mentionWaitingInConversation,
  pickWaiting,
  readItRequest,
  takeWaiting,
  type WaitingAnswer,
  type WaitingDeps,
} from "./voiceWaiting";

afterEach(() => __resetCompanionCallForTests());

const gst: WaitingAnswer = {
  job: "b01a370e",
  label: "gst",
  question: "Quel outil de reconnaissance du locuteur on utilise ?",
  at: 1000,
  mentioned: false,
  chars: 40,
};
const roamgate: WaitingAnswer = {
  job: "55fe1613",
  label: "roamgate",
  question: "Pourquoi est-ce que l'appel a coupé ?",
  at: 2000,
  mentioned: false,
  chars: 30,
};

/** A server with `given` waiting (its own copies), every call recorded. */
function server(given: WaitingAnswer[]) {
  const answers = given.map((answer) => ({ ...answer }));
  const calls: string[] = [];
  const texts: Record<string, string> = {
    b01a370e: "On utilise pyannote.",
    "55fe1613": "La page a rechargé sur un déploiement.",
  };
  const deps: WaitingDeps = {
    list: async () => {
      calls.push("list");
      return answers.map((answer) => ({ ...answer }));
    },
    text: async (job) => {
      calls.push(`text ${job}`);
      const kept = answers.find((answer) => answer.job === job);
      return kept
        ? {
            job,
            label: kept.label,
            question: kept.question,
            answer: texts[job]!,
            pane: "local/w3:p1",
          }
        : null;
    },
    mentioned: async (jobs) => {
      calls.push(`mentioned ${jobs.join(",")}`);
      for (const answer of answers)
        if (jobs.includes(answer.job)) answer.mentioned = true;
    },
    heard: async (job) => {
      calls.push(`heard ${job}`);
      const at = answers.findIndex((answer) => answer.job === job);
      if (at >= 0) answers.splice(at, 1);
    },
  };
  return { calls, deps, answers };
}

describe("answers that came while the user was away", () => {
  test("are mentioned briefly, in the language of the question, once each", () => {
    expect(mentionLine([])).toBe("");
    expect(mentionLine([{ ...gst, mentioned: true }])).toBe("");
    expect(mentionLine([gst])).toBe(
      "Une réponse de gst est arrivée pendant ton absence ; tu la veux ?",
    );
    expect(
      mentionLine([
        { ...gst, question: "Which speaker recognition tool do we use?" },
      ]),
    ).toBe("One answer from gst arrived while you were away; want it?");
    expect(mentionLine([gst, roamgate, { ...gst, job: "x" }])).toBe(
      "3 réponses sont arrivées pendant ton absence, de gst et roamgate ; tu les veux ?",
    );
    expect(
      mentionLine(
        [{ ...gst, mentioned: true }, roamgate, { ...gst, job: "x" }],
        "en",
      ),
    ).toBe(
      "2 answers arrived while you were away, from roamgate and gst; want them?",
    );
  });

  test("the next chat's start gets exactly one mention, marked once said", async () => {
    const { calls, deps, answers } = server([gst]);
    const said: string[] = [];
    let got: WaitingAnswer[] = [];
    const first = await mentionWaitingAnswers(
      {
        got: (waiting) => {
          got = waiting;
        },
        say: async (line) => {
          said.push(line);
          // Marked only once it was said: not before.
          expect(calls).toEqual(["list"]);
        },
      },
      deps,
    );
    expect(said).toEqual([
      "Une réponse de gst est arrivée pendant ton absence ; tu la veux ?",
    ]);
    expect(calls).toEqual(["list", "mentioned b01a370e"]);
    // The page's list says it was mentioned, as the server's does.
    expect(got.map((answer) => answer.mentioned)).toEqual([true]);
    expect(first).toBe(got);
    expect(answers[0]!.mentioned).toBe(true);
    // The chat after: still waiting, nothing said of it again.
    const second = await mentionWaitingAnswers(
      {
        say: async (line) => {
          said.push(line);
        },
      },
      deps,
    );
    expect(said).toHaveLength(1);
    expect(second).toEqual([{ ...gst, mentioned: true }]);
    expect(calls).toEqual(["list", "mentioned b01a370e", "list"]);
    // A new answer since is mentioned, alone.
    answers.push({ ...roamgate });
    await mentionWaitingAnswers(
      {
        say: async (line) => {
          said.push(line);
        },
      },
      deps,
    );
    expect(said[1]).toBe(
      "Une réponse de roamgate est arrivée pendant ton absence ; tu la veux ?",
    );
    expect(calls[calls.length - 1]).toBe("mentioned 55fe1613");
  });

  test("a mention cut short (the call ended) is not marked: said next time", async () => {
    const { calls, deps } = server([gst]);
    const cut = mentionWaitingAnswers(
      { say: () => new Promise<void>(() => {}) },
      deps,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["list"]);
    void cut;
  });

  test("without a server, nothing is said and nothing breaks", async () => {
    const said: string[] = [];
    const waiting = await mentionWaitingAnswers(
      {
        say: async (line) => {
          said.push(line);
        },
      },
      {
        list: async () => {
          throw new Error("offline");
        },
        text: async () => null,
        mentioned: async () => {},
        heard: async () => {},
      },
    );
    expect(waiting).toEqual([]);
    expect(said).toEqual([]);
  });

  test("opened to type, the conversation mentions them in writing, once", async () => {
    const { calls, deps } = server([gst]);
    await mentionWaitingInConversation(deps);
    await mentionWaitingInConversation(deps);
    expect(
      companionCallState().log.map((entry) =>
        entry.kind === "said" ? entry.text : entry.kind,
      ),
    ).toEqual([
      "Une réponse de gst est arrivée pendant ton absence ; tu la veux ?",
    ]);
    expect(calls).toEqual(["list", "mentioned b01a370e", "list"]);
  });

  test("asked for plainly or by its agent, read; taken, it is heard", async () => {
    expect(readItRequest("Lis-la.")).toEqual({});
    expect(readItRequest("oui, lis-la moi")).toEqual({});
    expect(readItRequest("Lis-moi la réponse, s'il te plaît")).toEqual({});
    expect(readItRequest("read it")).toEqual({});
    expect(readItRequest("Yes, read it to me please")).toEqual({});
    expect(readItRequest("je la veux")).toEqual({});
    expect(readItRequest("la réponse de gst")).toEqual({ agent: "gst" });
    expect(readItRequest("Lis-moi la réponse de Roamgate.")).toEqual({
      agent: "roamgate",
    });
    expect(readItRequest("read gst's answer")).toEqual({ agent: "gst" });
    // Work, a yes to an agent, or a reading of the call's own answer: not it.
    expect(readItRequest("lis le README et dis-moi")).toBeNull();
    expect(readItRequest("oui")).toBeNull();
    expect(readItRequest("vas-y")).toBeNull();
    expect(readItRequest("lis-moi toute la réponse")).toBeNull();
    expect(readItRequest("reprends la lecture")).toBeNull();

    expect(pickWaiting([gst, roamgate])).toEqual(roamgate);
    expect(pickWaiting([gst, roamgate], "GST")).toEqual(gst);
    expect(pickWaiting([gst, roamgate], "la session roamgate")).toEqual(
      roamgate,
    );
    expect(pickWaiting([gst, roamgate], "ranger")).toBeNull();
    expect(pickWaiting([])).toBeNull();

    const { calls, deps, answers } = server([gst, roamgate]);
    // By its job (the front named it), whatever the list.
    expect(await takeWaiting({ job: "b01a370e" }, [], deps)).toEqual({
      job: "b01a370e",
      label: "gst",
      question: gst.question,
      answer: "On utilise pyannote.",
      pane: "local/w3:p1",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["text b01a370e", "heard b01a370e"]);
    expect(answers.map((answer) => answer.job)).toEqual(["55fe1613"]);
    // By its agent; with none and `last`, the most recent; else nothing.
    expect(
      (await takeWaiting({ agent: "roamgate" }, answers, deps))?.answer,
    ).toBe("La page a rechargé sur un déploiement.");
    expect(await takeWaiting({ agent: "ranger" }, answers, deps)).toBeNull();
    expect(await takeWaiting({}, answers, deps)).toBeNull();
    answers.push({ ...gst });
    expect((await takeWaiting({ last: true }, answers, deps))?.label).toBe(
      "gst",
    );
    // Gone meanwhile (dismissed elsewhere, a day passed): nothing to read.
    expect(await takeWaiting({ job: "nope" }, answers, deps)).toBeNull();
  });
});
