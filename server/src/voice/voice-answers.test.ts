import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANSWER_FILE_MS,
  answerForFront,
  answerStart,
  LONG_ANSWER_CHARS,
} from "./voice-answers";

const made: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-answers-test-"));
  made.push(dir);
  return join(dir, "voice-answers");
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true });
});

describe("an agent's answer for the front", () => {
  test("a short one is given whole, as it is", () => {
    const dir = folder();
    const text = "x".repeat(LONG_ANSWER_CHARS);
    expect(answerForFront(text, dir)).toEqual({ text });
    expect(existsSync(dir)).toBe(false);
  });

  test("a long one is its start and the file where it is whole", () => {
    const dir = folder();
    // The answer of the 2026-11-20 call: 21k characters, cut at 12000.
    const paragraph = "Nicolas répond point par point à slomo. ".repeat(10);
    const text = Array.from(
      { length: 60 },
      (_, at) => `${at}. ${paragraph}`,
    ).join("\n\n");
    expect(text.length).toBeGreaterThan(20_000);
    const given = answerForFront(text, dir);
    expect(given.file).toStartWith(`${dir}/answer-`);
    expect(readFileSync(given.file!, "utf8")).toBe(text);
    expect(statSync(given.file!).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(given.text.length).toBeLessThan(LONG_ANSWER_CHARS);
    expect(given.text).toStartWith("0. Nicolas");
    expect(given.text).toContain(
      `${text.length} characters in all, given here only to that point. It is whole in ${given.file}`,
    );
    // The same answer told again keeps its file.
    expect(answerForFront(text, dir).file).toBe(given.file!);
  });

  test("its start ends with a paragraph or a sentence", () => {
    expect(answerStart(`${"a".repeat(2000)}\n\n${"b".repeat(2000)}`)).toBe(
      "a".repeat(2000),
    );
    expect(answerStart(`${"Phrase un. ".repeat(400)}`)).toEndWith("un.");
  });

  test("files older than a day go when another is written", () => {
    const dir = folder();
    const old = answerForFront("o".repeat(5000), dir).file!;
    const stale = (Date.now() - ANSWER_FILE_MS - 60_000) / 1000;
    utimesSync(old, stale, stale);
    writeFileSync(join(dir, "kept.md"), "recent");
    answerForFront("n".repeat(5000), dir);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(dir, "kept.md"))).toBe(true);
  });
});
