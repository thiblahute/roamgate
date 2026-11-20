import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { uploadRoot } from "./voice-images";

/**
 * An agent's long answer, for the voice companion (voice-front.ts): given
 * whole, it would fill the front's context, and cut, it leaves the front
 * with the start only (it could not go on with it, nor say what came
 * later). So an answer longer than LONG_ANSWER_CHARS is written whole to a
 * file of answersDir() and the front is given its start, the file's path
 * and its length: it reads the file (Read, confined to that folder) when
 * it needs more. The page keeps the text too, and reads it aloud itself
 * (voiceCompanion.ts). Files older than a day go when a new one is written.
 */

/** Past this, an answer reaches the front as its start and a file. */
export const LONG_ANSWER_CHARS = 4000;
/** Of a long answer, about this much is given inline. */
const START_CHARS = 3000;
/** Far beyond any real answer: past this, the rest is dropped. */
export const MAX_ANSWER_CHARS = 1_000_000;
/** How long an answer's file is kept. */
export const ANSWER_FILE_MS = 24 * 60 * 60_000;

/** Where long answers are written: the voice uploads' folder. */
export function answersDir(root = uploadRoot()): string {
  return join(root, "voice-answers");
}

/** The answers' folder, made (only the user reads it). */
export function ensureAnswersDir(dir = answersDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Not ours to change: it still works.
  }
  return dir;
}

/** The start of `text`, cut where a paragraph or a sentence ends. */
export function answerStart(text: string, chars = START_CHARS): string {
  if (text.length <= chars) return text;
  const head = text.slice(0, chars);
  const paragraph = head.lastIndexOf("\n\n");
  if (paragraph > chars / 2) return head.slice(0, paragraph).trimEnd();
  const sentence = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf(".\n"),
    head.lastIndexOf("? "),
    head.lastIndexOf("! "),
  );
  if (sentence > chars / 2) return head.slice(0, sentence + 1);
  return head.trimEnd();
}

function sweep(dir: string, now: number) {
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs > ANSWER_FILE_MS)
          rmSync(path, { force: true });
      } catch {
        // Gone already.
      }
    }
  } catch {
    // No folder yet.
  }
}

/**
 * What the front is given of an agent's answer: the answer itself, or,
 * past LONG_ANSWER_CHARS, its start and where it is whole (`file`). The
 * same answer told twice keeps its file.
 */
export function answerForFront(
  answer: string,
  dir = answersDir(),
  now = Date.now(),
): { text: string; file?: string } {
  const text = answer.slice(0, MAX_ANSWER_CHARS);
  if (text.length <= LONG_ANSWER_CHARS) return { text };
  try {
    ensureAnswersDir(dir);
    sweep(dir, now);
    const id = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const file = join(dir, `answer-${id}.md`);
    writeFileSync(file, text, { mode: 0o600 });
    return {
      text: `${answerStart(text)}\n\n[The answer goes on: ${text.length} characters in all, given here only to that point. It is whole in ${file}: Read it there when you need more.]`,
      file,
    };
  } catch {
    // No file: the start, said to be one.
    return {
      text: `${answerStart(text)}\n\n[The answer goes on: ${text.length} characters in all; only this start is given.]`,
    };
  }
}
