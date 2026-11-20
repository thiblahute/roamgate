import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WAITING_MS,
  WaitingAnswers,
  waitingAnswersFile,
  waitingContext,
} from "./voice-waiting";

const made: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-waiting-test-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true });
});

const gst = {
  job: "b01a370e",
  pane: "local/w3:p1",
  label: "gst",
  question: "What speaker recognition tool do we use?",
  answer: "We use pyannote, through the voice helper.",
};

describe("answers waiting for the user", () => {
  test("an answer is kept with the session's name and the question, until heard", () => {
    let now = 1_000_000;
    const waiting = new WaitingAnswers(null, () => now);
    waiting.keep(gst);
    expect(waiting.list()).toEqual([
      { ...gst, at: 1_000_000, mentioned: false },
    ]);
    expect(waiting.get("b01a370e")?.answer).toBe(gst.answer);
    // Mentioned once: still waiting, never mentioned again.
    expect(waiting.mention(["b01a370e", "other"])).toBe(1);
    expect(waiting.mention(["b01a370e"])).toBe(0);
    expect(waiting.list().map((answer) => answer.mentioned)).toEqual([true]);
    // Heard (told, read or dismissed): gone.
    expect(waiting.heard("b01a370e")).toBe(true);
    expect(waiting.heard("b01a370e")).toBe(false);
    expect(waiting.list()).toEqual([]);
    // A day later, an answer not heard goes by itself.
    waiting.keep({ ...gst, job: "old" });
    now += WAITING_MS + 1;
    expect(waiting.list()).toEqual([]);
    expect(waiting.get("old")).toBeNull();
  });

  test("dismissed without a job, every answer waiting goes", () => {
    const waiting = new WaitingAnswers(null, () => 5);
    waiting.keep(gst);
    waiting.keep({ ...gst, job: "55fe1613", label: "roamgate" });
    expect(waiting.dismiss("nope")).toEqual([]);
    expect(waiting.dismiss()).toEqual(["b01a370e", "55fe1613"]);
    expect(waiting.list()).toEqual([]);
  });

  test("the same job answered again keeps one entry; the oldest go past the cap", () => {
    const waiting = new WaitingAnswers(null, () => 5);
    waiting.keep(gst);
    waiting.keep({ ...gst, answer: "Settled later." });
    expect(waiting.list().map((answer) => answer.answer)).toEqual([
      "Settled later.",
    ]);
    for (let i = 0; i < 25; i++) waiting.keep({ ...gst, job: `job-${i}` });
    expect(waiting.list()).toHaveLength(20);
    expect(waiting.get("b01a370e")).toBeNull();
    expect(waiting.get("job-24")).not.toBeNull();
  });

  test("kept in a file, so a restart (each deploy) loses nothing", () => {
    const file = waitingAnswersFile(join(folder(), "uploads"));
    const first = new WaitingAnswers(file, () => 7);
    first.keep(gst);
    first.mention(["b01a370e"]);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([
      { ...gst, at: 7, mentioned: true },
    ]);
    const second = new WaitingAnswers(file, () => 8);
    expect(second.list()).toEqual([{ ...gst, at: 7, mentioned: true }]);
    second.heard("b01a370e");
    expect(new WaitingAnswers(file).list()).toEqual([]);
    // A file that is not a list of answers is taken as none.
    const broken = waitingAnswersFile(join(folder(), "broken"));
    expect(new WaitingAnswers(broken).list()).toEqual([]);
  });

  test("the front's state lists them, with how to read or drop one", () => {
    const now = Date.parse("2026-11-20T10:00:00Z");
    expect(waitingContext([], now)).toBe("");
    const context = waitingContext(
      [
        { ...gst, at: now - 2 * 60 * 60_000, mentioned: true },
        {
          job: "55fe1613",
          pane: "local/w5:p2",
          label: "roamgate",
          question: "Why did the call cut?",
          answer: `The call cut because ${"the page reloaded. ".repeat(40)}`,
          at: now - 3 * 60_000,
          mentioned: false,
        },
      ],
      now,
    );
    expect(context).toStartWith("Answers waiting (");
    expect(context).toContain('{"to": "read", "job": "<id>"}');
    expect(context).toContain(
      `- job b01a370e: gst, 2 h ago, asked "What speaker recognition tool do we use?", mentioned. Starts: "We use pyannote, through the voice helper." (42 characters)`,
    );
    expect(context).toContain(
      '- job 55fe1613: roamgate, 3 min ago, asked "Why did the call cut?", not mentioned yet. Starts: "The call cut because the page reloaded.',
    );
    expect(context).toContain('..." (780 characters)');
  });
});
