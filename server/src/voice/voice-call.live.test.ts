/**
 * Opt-in live voice tests: what is said into a voice chat comes out as
 * said, through the real path. An isolated bridge (its own HOME, port 0,
 * generated-token login) runs a real voice helper with real models;
 * headless Chrome's fake microphone plays speech (Chrome's echo
 * cancellation, noise suppression and auto gain on it), and the page's own
 * voice link (web/src/voiceListenHarness.ts) listens in a loop, on the
 * voice socket or in a WebRTC call. The transcripts are scored by word
 * error rate: in English and in French, with music (a sung track) under the
 * call and heard by the microphone, with that music waiting, silent, until
 * the speaker's voice is learnt, with someone else speaking first, and
 * with one speaker going from English to French (Parakeet drifts to English
 * on some French: Whisper reads it again, reread.rs). Replies read in the
 * call are heard on its replies leg, decoded; a call whose helper is killed
 * is made again and goes on; and a call of three minutes keeps its
 * signalling and both legs (ROAMGATE_LIVE_VOICE_SOAK=1).
 *
 * `bun run test:voice-live` on a Mac with the voice helper set up; skipped
 * otherwise (`bun test` never launches a browser). See CONTRIBUTING.md.
 * - ROAMGATE_LIVE_VOICE_CONFIG: the voice.json to take the helper and its
 *   models from (~/.config/roamgate/voice.json by default);
 * - ROAMGATE_LIVE_VOICE_HELPER: another helper binary to test;
 * - ROAMGATE_LIVE_VOICE_CLIPS: a directory of your own recordings,
 *   `<name>.wav` with what they say in `<name>.txt`, heard as one speaker;
 * - ROAMGATE_LIVE_VOICE_REFERENCE: your speaker_reference recordings for
 *   them, comma-separated;
 * - ROAMGATE_LIVE_VOICE_MUSIC: a WAV of music to play under the call and
 *   the speech (chords with a sung voice otherwise);
 * - ROAMGATE_LIVE_VOICE_SOAK=1: also the three-minute call.
 * Speech is made with macOS's `say` and `afconvert`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromePath, launchChrome } from "./testdata/chrome";

const LIVE = process.env.ROAMGATE_LIVE_VOICE === "1";
const REPO = join(import.meta.dir, "..", "..", "..");
const RATE = 48_000;
/** Silence before the first thing said: a call connects meanwhile. */
const LEAD_S = 6;
/** Silence after each thing said: the turn ends, the text comes. */
const GAP_S = 6;
/** Silence in which each reply is read. */
const REPLY_S = 10;

/** Word error rate of `heard` against `said`, words lowercased. */
export function wordErrorRate(said: string, heard: string): number {
  const words = (text: string) =>
    text
      .toLowerCase()
      .normalize("NFC")
      .replace(/[’'-]/g, " ")
      .replace(/[^\p{L}\p{N} ]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  const reference = words(said);
  const hypothesis = words(heard);
  let row = Array.from({ length: hypothesis.length + 1 }, (_, i) => i);
  for (const word of reference) {
    const next = [row[0]! + 1];
    hypothesis.forEach((other, j) =>
      next.push(
        Math.min(
          row[j + 1]! + 1,
          next[j]! + 1,
          row[j]! + (word === other ? 0 : 1),
        ),
      ),
    );
    row = next;
  }
  return row[hypothesis.length]! / Math.max(1, reference.length);
}

const SENTENCES = {
  en: [
    "Are you working with WebRTC now, right?",
    "Please open the pull request and tell me when the tests pass.",
    "Why did the helper restart in the middle of the call?",
    "I want you to check the logs and find out what went wrong.",
  ],
  fr: [
    "Est-ce que tu m'entends bien maintenant ?",
    "Relance le build sur la branche et dis-moi quand c'est fini.",
    "Je voudrais que tu regardes les journaux du serveur.",
    "Pourquoi l'appel s'est coupé au milieu de la conversation ?",
  ],
  /** Said by someone else, before the speaker. */
  other: [
    "Breaking news tonight, the storm is moving east along the coast.",
    "Traffic is slow on the bridge, expect delays of twenty minutes.",
  ],
  /** The speaker's reference recording: other words than the test's. */
  reference: [
    "This is my voice, recorded at my desk for the voice chat.",
    "I usually speak a little fast, and sometimes I mumble.",
  ],
  referenceFr: [
    "Voici ma voix, enregistrée à mon bureau pour le chat vocal.",
    "Je parle souvent un peu vite, et parfois je marmonne.",
  ],
  /** Sung over the music's chords. */
  lyrics:
    "Dancing all night under the summer stars, singing with the radio in our cars.",
};

type Clip = { samples: Int16Array; text: string };

function readWav(path: string): Int16Array {
  const data = readFileSync(path);
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === "data") {
      const bytes = data.subarray(offset + 8, offset + 8 + size);
      const copy = new Uint8Array(bytes.length - (bytes.length % 2));
      copy.set(bytes.subarray(0, copy.length));
      return new Int16Array(copy.buffer);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data`);
}

function writeWav(path: string, samples: Int16Array) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.byteLength, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer)]));
}

/** Any audio file as 48 kHz mono 16-bit samples (afconvert). */
function toSamples(path: string, work: string): Int16Array {
  const out = join(
    work,
    `converted-${Math.random().toString(36).slice(2)}.wav`,
  );
  const made = Bun.spawnSync([
    "afconvert",
    "-f",
    "WAVE",
    "-d",
    `LEI16@${RATE}`,
    "-c",
    "1",
    path,
    out,
  ]);
  if (made.exitCode !== 0) throw new Error(`afconvert ${path} failed`);
  return readWav(out);
}

/** `text` said by macOS's `voice`. */
function say(voice: string, text: string, work: string): Clip {
  const aiff = join(work, `said-${Math.random().toString(36).slice(2)}.aiff`);
  const made = Bun.spawnSync(["say", "-v", voice, "-o", aiff, text]);
  if (made.exitCode !== 0) throw new Error(`say -v ${voice} failed`);
  return { samples: toSamples(aiff, work), text };
}

/** Loud part's RMS: the speech, not its silences. */
function speechRms(samples: Int16Array): number {
  const block = 480;
  const levels: number[] = [];
  for (let i = 0; i + block <= samples.length; i += block) {
    let sum = 0;
    for (let j = i; j < i + block; j += 1) sum += samples[j]! ** 2;
    levels.push(sum / block);
  }
  levels.sort((a, b) => b - a);
  const loud = levels.slice(0, Math.max(1, levels.length >> 1));
  return Math.sqrt(loud.reduce((a, b) => a + b, 0) / loud.length);
}

/**
 * Music of a kind: chords with a beat, a little noise, and `singer` sung
 * over them in a loop, as loud as the chords.
 */
function syntheticMusic(seconds: number, singer?: Int16Array): Int16Array {
  const samples = new Int16Array(seconds * RATE);
  const chords = [
    [220, 277.2, 329.6],
    [196, 246.9, 293.7],
    [174.6, 220, 261.6],
    [196, 246.9, 329.6],
  ];
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / RATE;
    const chord = chords[Math.floor(t / 2) % chords.length]!;
    const beat = 0.6 + 0.4 * Math.abs(Math.sin(Math.PI * 2 * t));
    let value = 0;
    for (const hz of chord) value += Math.sin(2 * Math.PI * hz * t);
    value = (value / chord.length) * beat + (Math.random() * 2 - 1) * 0.05;
    samples[i] = Math.round(value * 8000);
  }
  if (singer?.length) {
    const gain = (speechRms(samples) / speechRms(singer)) * 0.7;
    for (let i = 0; i < samples.length; i += 1)
      samples[i] = Math.max(
        -32768,
        Math.min(32767, samples[i]! + singer[i % singer.length]! * gain),
      );
  }
  return samples;
}

type Scenario = {
  name: string;
  mode: "socket" | "webrtc";
  clips: Clip[];
  /** Said first and not scored: someone else, or the speaker's warm-up. */
  before?: Clip[];
  /** Music in the microphone, this far below the speech (dB). */
  musicDb?: number;
  /** The same music under the call (call_background), on from its start. */
  callMusic?: boolean;
  /** voice.json's speaker_reference. */
  reference?: string[];
  /** Silence between what is said `before` and the scored clips. */
  quietS?: number;
  /** The bridge's helper killed a second into that silence. */
  kill?: boolean;
  /** Replies read in the call after the clips, each in its own silence. */
  replies?: string[];
  /** The call's legs and their RTP followed. */
  watch?: boolean;
  /** The microphone hears what the call plays, this far below it (dB). */
  echoDb?: number;
  /**
   * Where the replies leg's level is measured, given when each scored clip
   * ends (seconds from the microphone's start).
   */
  levels?: (ends: number[]) => [number, number][];
};

/** What the page's harness gives (web/src/voiceListenHarness.ts). */
type Heard = {
  at: number;
  speechAt?: number;
  text: string | null;
  error?: string;
};
type HarnessResult = {
  callAt: number | null;
  heard: Heard[];
  replies: {
    at: number;
    text: string;
    inCall: boolean;
    level: number | null;
    quiet: number | null;
    error?: string;
  }[];
  legs: {
    down: { at: number; replies: boolean; microphone: boolean }[];
    windows: { at: number; received: number; sent: number }[];
  } | null;
  levels: (number | null)[];
};

type Outcome = {
  said: string;
  heard: string;
  wer: number;
  /** What was said `before`, and heard of it. */
  saidBefore: string;
  heardBefore: string;
  serverLog: string;
  result: HarnessResult;
  /** When the helper was killed, from the microphone's start. */
  killedAt: number | null;
  killed: number[];
};

/** The bridge's own voice helpers: its children, never another process. */
function helperPids(bridge: number, helper: string): number[] {
  return Bun.spawnSync(["pgrep", "-P", String(bridge)])
    .stdout.toString()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((pid) =>
      Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)])
        .stdout.toString()
        .startsWith(helper),
    );
}

const work = LIVE ? mkdtempSync(join(tmpdir(), "roamgate-voice-live-")) : "";
let harness = "";
/** The music's sung voice (say's "Good News", which sings). */
let singer: Int16Array | undefined;
const configPath =
  process.env.ROAMGATE_LIVE_VOICE_CONFIG ??
  join(homedir(), ".config", "roamgate", "voice.json");

/**
 * The voice.json the test bridge runs: the helper and its listen models,
 * and the music under the call when `background` names a WAV.
 */
function testConfig(
  reference?: string[],
  background?: string,
): Record<string, unknown> {
  const mine = JSON.parse(readFileSync(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  const kept: Record<string, unknown> = {
    helper: process.env.ROAMGATE_LIVE_VOICE_HELPER ?? mine.helper,
  };
  for (const key of [
    "parakeet_model",
    "whisper_model",
    "speaker_model",
    "turn_model",
    "text_turn_model",
    "kokoro_model",
    "kokoro_voices",
  ])
    if (mine[key] !== undefined) kept[key] = mine[key];
  // Kokoro's ONNX model loads fastest; any-tts models only without it.
  if (!kept.kokoro_model && mine.tts_models) kept.tts_models = mine.tts_models;
  if (reference) kept.speaker_reference = reference;
  if (background) {
    kept.call_background = `filesrc location="${background}" ! wavparse ! audioconvert`;
    kept.call_music_at_start = true;
  }
  return kept;
}

async function run(scenario: Scenario): Promise<Outcome> {
  const dir = join(work, scenario.name);
  const home = join(dir, "home");
  mkdirSync(join(home, ".config", "roamgate"), { recursive: true });
  // The microphone: a lead, then each clip and a pause; the music under it.
  const parts: Int16Array[] = [new Int16Array(RATE * LEAD_S)];
  const finishAt: number[] = [];
  let length = RATE * LEAD_S;
  const add = (clip: Clip) => {
    parts.push(clip.samples, new Int16Array(RATE * GAP_S));
    length += clip.samples.length + RATE * GAP_S;
    finishAt.push((length - RATE * GAP_S) / RATE + 3.5);
  };
  for (const clip of scenario.before ?? []) add(clip);
  const quietAt = length / RATE;
  if (scenario.quietS) {
    parts.push(new Int16Array(RATE * scenario.quietS));
    length += RATE * scenario.quietS;
  }
  const scoredFrom = length / RATE;
  const ends: number[] = [];
  for (const clip of scenario.clips) {
    add(clip);
    ends.push((length - RATE * GAP_S) / RATE);
  }
  const replies = (scenario.replies ?? []).map((text) => {
    const at = length / RATE + 2;
    parts.push(new Int16Array(RATE * REPLY_S));
    length += RATE * REPLY_S;
    return { at, text };
  });
  const microphone = new Int16Array(length);
  let at = 0;
  for (const part of parts) {
    microphone.set(part, at);
    at += part.length;
  }
  const music =
    scenario.musicDb !== undefined || scenario.callMusic
      ? process.env.ROAMGATE_LIVE_VOICE_MUSIC
        ? toSamples(process.env.ROAMGATE_LIVE_VOICE_MUSIC, dir)
        : syntheticMusic(Math.ceil(length / RATE) + 30, singer)
      : null;
  let background: string | undefined;
  if (music && scenario.callMusic) {
    background = join(dir, "music.wav");
    writeWav(background, music);
  }
  const config = testConfig(scenario.reference, background);
  writeFileSync(
    join(home, ".config", "roamgate", "voice.json"),
    JSON.stringify(config),
  );
  if (music && scenario.musicDb !== undefined) {
    const level =
      scenario.clips.reduce((sum, clip) => sum + speechRms(clip.samples), 0) /
      scenario.clips.length;
    const gain = (level / speechRms(music)) * 10 ** (scenario.musicDb / 20);
    for (let i = 0; i < microphone.length; i += 1)
      microphone[i] = Math.max(
        -32768,
        Math.min(32767, microphone[i]! + music[i % music.length]! * gain),
      );
  }
  const microphonePath = join(dir, "microphone.wav");
  writeWav(microphonePath, microphone);

  const serverLog = join(dir, "server.log");
  writeFileSync(serverLog, "");
  const bridge = Bun.spawn([process.execPath, "server/src/index.ts"], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      HOST: "127.0.0.1",
      PORT: "0",
      OPEN_BROWSER: "0",
      ROAMGATE_PASSWORD: "",
      ROAMGATE_PIN: "",
      ROAMGATE_CONNECTIONS_PATH: join(home, "connections.json"),
      ROAMGATE_SETTINGS_PATH: join(home, "settings.json"),
      HERDR_SOCKET_PATH: join(home, "missing-control.sock"),
      HERDR_CLIENT_SOCKET_PATH: join(home, "missing-render.sock"),
      ROAMGATE_VOICE_DEBUG: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  void (async () => {
    for await (const chunk of bridge.stderr)
      appendFileSync(serverLog, new TextDecoder().decode(chunk));
  })();
  const chrome = await (async () => {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no bridge")), 30_000);
      void (async () => {
        let text = "";
        for await (const chunk of bridge.stdout) {
          const decoded = new TextDecoder().decode(chunk);
          appendFileSync(serverLog, decoded);
          text += decoded;
          const port = text.match(
            /INFO bridge listening\b[^\r\n]*:(\d+)\b/,
          )?.[1];
          if (port) {
            clearTimeout(timer);
            resolve(`http://127.0.0.1:${port}`);
          }
        }
      })();
    });
    const browser = await launchChrome(chromePath()!, microphonePath);
    return { base, browser };
  })();
  try {
    const { base, browser } = chrome;
    const token = readFileSync(
      join(home, ".config", "roamgate", "auth-token"),
      "utf8",
    ).trim();
    const page = await browser.page();
    // The generated token's login, as a page opened with it; then a page
    // of the bridge's own, where the harness runs.
    await page.navigate(`${base}/?token=${encodeURIComponent(token)}`);
    await page.navigate(`${base}/healthz`);
    await page.evaluate(harness);
    let settled = false;
    const listening = page
      .evaluate<HarnessResult>(
        `voiceHarness(${JSON.stringify({
          mode: scenario.mode,
          seconds: length / RATE + 10,
          finishAt,
          replies,
          watch: scenario.watch ?? false,
          echoDb: scenario.echoDb,
          levels: scenario.levels?.(ends) ?? [],
        })})`,
      )
      .finally(() => {
        settled = true;
      });
    let killedAt: number | null = null;
    let killed: number[] = [];
    if (scenario.kill) {
      // Timed from the microphone's start, as the page says it.
      while (!settled && !page.console.includes("harness: microphone opened"))
        await Bun.sleep(20);
      const opened = Date.now();
      await Bun.sleep((quietAt + 1) * 1000 - (Date.now() - opened));
      if (!settled) {
        killed = helperPids(bridge.pid, String(config.helper));
        for (const pid of killed) process.kill(pid, "SIGKILL");
        killedAt = (Date.now() - opened) / 1000;
      }
    }
    const result = await listening;
    const text = (from: number, to: number) =>
      result.heard
        .filter((h) => {
          const at = h.speechAt ?? h.at;
          return at > from - 1.5 && at <= to - 1.5;
        })
        .map((h) => h.text ?? "")
        .filter(Boolean)
        .join(" ");
    const heard = text(scoredFrom, Number.POSITIVE_INFINITY);
    const said = scenario.clips.map((clip) => clip.text).join(" ");
    return {
      said,
      heard,
      wer: wordErrorRate(said, heard),
      saidBefore: (scenario.before ?? []).map((clip) => clip.text).join(" "),
      heardBefore: text(0, scoredFrom),
      serverLog: readFileSync(serverLog, "utf8"),
      result,
      killedAt,
      killed,
    };
  } finally {
    await chrome.browser.close();
    bridge.kill();
    await bridge.exited;
  }
}

const ready =
  LIVE &&
  process.platform === "darwin" &&
  chromePath() !== null &&
  existsSync(configPath);

describe.skipIf(!ready)(
  "what is said into a voice chat comes out as said",
  () => {
    const clips: Record<string, Clip[]> = {};
    /**
     * Each voice's speaker_reference: recordings of other words than the
     * test's, one per language it speaks.
     */
    const references: Record<string, string[]> = {};
    // The body runs at collection even when skipped: read nothing then.
    const mine = (
      ready ? JSON.parse(readFileSync(configPath, "utf8")) : {}
    ) as Record<string, unknown>;
    /** Whisper reads again what Parakeet writes in English (reread.rs). */
    const rereads = Boolean(mine.parakeet_model && mine.whisper_model);

    beforeAll(async () => {
      const built = await Bun.build({
        entrypoints: [join(REPO, "web", "src", "voiceListenHarness.ts")],
        target: "browser",
        // Evaluated in the page as a script.
        format: "iife",
      });
      if (!built.success) throw new Error(built.logs.map(String).join("\n"));
      harness = await built.outputs[0]!.text();
      clips.en = SENTENCES.en.map((text) => say("Samantha", text, work));
      clips.fr = SENTENCES.fr.map((text) => say("Thomas", text, work));
      clips.other = SENTENCES.other.map((text) => say("Daniel", text, work));
      // One voice in both languages, as someone bilingual.
      clips.floEn = SENTENCES.en.map((text) =>
        say("Flo (English (US))", text, work),
      );
      clips.floFr = SENTENCES.fr.map((text) =>
        say("Flo (French (France))", text, work),
      );
      const recorded: [string, string, string][] = [
        ["en", "Samantha", SENTENCES.reference[0]!],
        ["en", "Samantha", SENTENCES.reference[1]!],
        ["fr", "Thomas", SENTENCES.referenceFr[0]!],
        ["fr", "Thomas", SENTENCES.referenceFr[1]!],
        ["flo", "Flo (English (US))", SENTENCES.reference[0]!],
        ["flo", "Flo (French (France))", SENTENCES.referenceFr[0]!],
      ];
      for (const [who, voice, text] of recorded) {
        references[who] ??= [];
        const path = join(
          work,
          `reference-${who}-${references[who].length}.wav`,
        );
        writeWav(path, say(voice, text, work).samples);
        references[who].push(path);
      }
      singer = say("Good News", SENTENCES.lyrics, work).samples;
    }, 180_000);

    afterAll(() => {
      // Kept with ROAMGATE_LIVE_VOICE_KEEP: each scenario's server.log.
      if (work && !process.env.ROAMGATE_LIVE_VOICE_KEEP)
        rmSync(work, { recursive: true, force: true });
      else if (work) console.log(`kept: ${work}`);
    });

    /** Runs `scenarios` a few at a time. */
    async function all(scenarios: Scenario[]): Promise<Outcome[]> {
      const outcomes: Outcome[] = [];
      for (let i = 0; i < scenarios.length; i += 3)
        outcomes.push(
          ...(await Promise.all(scenarios.slice(i, i + 3).map(run))),
        );
      for (const [index, outcome] of outcomes.entries())
        console.log(
          `${scenarios[index]!.name}: WER ${outcome.wer.toFixed(3)}\n  said:  ${outcome.said}\n  heard: ${outcome.heard}`,
        );
      return outcomes;
    }

    test("English and French, on the voice socket and in a WebRTC call", async () => {
      const outcomes = await all([
        { name: "socket-en", mode: "socket", clips: clips.en! },
        { name: "socket-fr", mode: "socket", clips: clips.fr! },
        { name: "webrtc-en", mode: "webrtc", clips: clips.en! },
        { name: "webrtc-fr", mode: "webrtc", clips: clips.fr! },
      ]);
      for (const outcome of outcomes)
        expect(outcome.wer).toBeLessThanOrEqual(0.1);
      // One signalling socket for the call, never opened again.
      for (const outcome of outcomes.slice(2))
        expect(outcome.serverLog.match(/a page signals on port/g)).toHaveLength(
          1,
        );
    }, 600_000);

    /**
     * Each reply was read into the call and heard on its replies leg: the
     * decoded level well above the silence before it.
     */
    function expectRepliesHeard(outcome: Outcome) {
      for (const reply of outcome.result.replies) {
        console.log(
          `  reply at ${reply.at.toFixed(1)} s: ${reply.level?.toFixed(1)} dBFS over ${reply.quiet?.toFixed(1)} dBFS before${reply.inCall ? "" : ", NOT in the call"}${reply.error ? `, ${reply.error}` : ""}: ${reply.text}`,
        );
        expect(reply.error).toBeUndefined();
        expect(reply.inCall).toBe(true);
        expect(reply.level!).toBeGreaterThan(-50);
        expect(reply.level! - reply.quiet!).toBeGreaterThanOrEqual(20);
      }
    }

    test("a reply read in the call is heard where the call is answered", async () => {
      const [outcome] = await all([
        {
          name: "reply",
          mode: "webrtc",
          clips: [clips.en![0]!],
          replies: [
            "I found it in the logs: the helper restarted at noon.",
            "Le build est fini, et tous les tests passent.",
          ],
        },
      ]);
      expect(outcome!.result.replies).toHaveLength(2);
      expectRepliesHeard(outcome!);
      expect(outcome!.wer).toBeLessThanOrEqual(0.1);
    }, 600_000);

    test("a helper killed mid-call is made again, and the call goes on", async () => {
      const [outcome] = await all([
        {
          name: "killed",
          mode: "webrtc",
          before: [clips.en![0]!],
          quietS: 20,
          kill: true,
          clips: [clips.en![1]!, clips.en![2]!],
          replies: ["Back after the helper restarted."],
          watch: true,
        },
      ]);
      const { result, killedAt, serverLog } = outcome!;
      const down = result.legs?.down ?? [];
      console.log(
        `  killed ${outcome!.killed.join(", ")} at ${killedAt?.toFixed(1)} s; legs down ${down.length ? `from ${down[0]!.at.toFixed(2)} to ${down.at(-1)!.at.toFixed(2)} s (${down.length} samples)` : "never"}\n  before the kill: ${outcome!.heardBefore}`,
      );
      expect(outcome!.killed.length).toBeGreaterThan(0);
      expect(result.callAt).not.toBeNull();
      // Heard before the kill, and after it, as said.
      expect(
        wordErrorRate(outcome!.saidBefore, outcome!.heardBefore),
      ).toBeLessThanOrEqual(0.1);
      expect(outcome!.wer).toBeLessThanOrEqual(0.1);
      // The listening under the kill ends on its own: nothing fails.
      expect(result.heard.filter((h) => h.error)).toEqual([]);
      expect(serverLog).toContain("ended with the helper");
      // The call is made again once, its page told, and its signalling
      // opened again once, on the new helper's port.
      expect(
        serverLog.match(/made again in the restarted helper/g),
      ).toHaveLength(1);
      expect(serverLog).toContain("the voice helper restarted");
      expect(serverLog.match(/a page signals on port/g)).toHaveLength(2);
      // Both legs are back within ten seconds, and stay.
      for (const sample of down) {
        expect(sample.at).toBeGreaterThan(killedAt! - 1);
        expect(sample.at).toBeLessThan(killedAt! + 10);
      }
      expectRepliesHeard(outcome!);
    }, 600_000);

    test.skipIf(process.env.ROAMGATE_LIVE_VOICE_SOAK !== "1")(
      "a call of three minutes keeps its signalling and both legs",
      async () => {
        const [outcome] = await all([
          {
            name: "soak",
            mode: "webrtc",
            before: [clips.en![0]!],
            quietS: 150,
            clips: [clips.en![1]!],
            replies: ["Still here after three minutes."],
            watch: true,
          },
        ]);
        const { result, serverLog } = outcome!;
        const windows = result.legs?.windows ?? [];
        console.log(
          `  call from ${result.callAt?.toFixed(1)} s to ${result.heard.at(-1)?.at.toFixed(0)} s; ${windows.length} windows of RTP, bytes received ${windows.map((w) => `${w.at.toFixed(0)}s:${w.received}`).join(" ")}, the least sent ${Math.min(...windows.map((w) => w.sent))}\n  first: ${outcome!.heardBefore}`,
        );
        expect(
          wordErrorRate(outcome!.saidBefore, outcome!.heardBefore),
        ).toBeLessThanOrEqual(0.1);
        expect(outcome!.wer).toBeLessThanOrEqual(0.1);
        // One signalling socket, never closed nor opened again.
        expect(serverLog.match(/a page signals on port/g)).toHaveLength(1);
        expect(serverLog).not.toContain("opening it again");
        expect(serverLog).not.toContain("the signalling did not open");
        // Both legs all along, each carrying RTP every ten seconds.
        expect(result.legs?.down).toEqual([]);
        expect(windows.length).toBeGreaterThanOrEqual(17);
        for (const window of windows) {
          expect(window.received).toBeGreaterThan(0);
          expect(window.sent).toBeGreaterThan(0);
        }
        expectRepliesHeard(outcome!);
      },
      600_000,
    );

    test("with sung music under the call, heard by the microphone too", async () => {
      // As recommended with music: the speaker's voice from their
      // recordings, not from the first voice heard (the singer's).
      const outcomes = await all([
        {
          name: "music-en",
          mode: "webrtc",
          clips: clips.en!,
          musicDb: -15,
          callMusic: true,
          reference: references.en,
        },
        {
          name: "music-fr",
          mode: "webrtc",
          clips: clips.fr!,
          musicDb: -15,
          callMusic: true,
          reference: references.fr,
        },
        {
          name: "music-socket",
          mode: "socket",
          clips: clips.en!,
          musicDb: -15,
          reference: references.en,
        },
      ]);
      // The music in the microphone alone takes nothing away.
      expect(outcomes[2]!.wer).toBeLessThanOrEqual(0.15);
      // While the call's music plays, headless Chrome's echo canceller,
      // which has no echo path to learn, also takes some of the speaker's
      // words away (a man's voice more, where the chords are): whatever
      // the helper does.
      for (const outcome of outcomes.slice(0, 2))
        expect(outcome.wer).toBeLessThanOrEqual(0.35);
      // The singer's words are never taken for the speaker's: with a
      // reference, nor without one, where the hold keeps them out.
      const sung = /\b(dancing|night|summer|stars|singing|radio|cars)\b/gi;
      for (const outcome of outcomes)
        expect(outcome.heard.match(sung) ?? []).toEqual([]);
      // The call's music plays, and the listener holds while it does.
      for (const outcome of [outcomes[0]!, outcomes[1]!]) {
        expect(outcome.serverLog).toContain("music on");
        expect(outcome.serverLog).toContain("the call's music is heard");
      }
    }, 900_000);

    test("music asked for before anyone speaks waits for their voice, then plays", async () => {
      // No reference: the speaker check learns the first voice it hears.
      // The microphone hears the call back, singer included, unremoved.
      const [outcome] = await all([
        {
          name: "music-waits",
          mode: "webrtc",
          clips: clips.en!,
          callMusic: true,
          echoDb: -6,
          // Before anyone speaks, and once two sentences were said.
          levels: (ends) => [
            [2, LEAD_S - 0.3],
            [ends[1]! + 1, ends[1]! + GAP_S - 0.5],
          ],
        },
      ]);
      const log = outcome!.serverLog;
      console.log(
        `music-waits: levels ${JSON.stringify(outcome!.result.levels)} dBFS, WER ${outcome!.wer.toFixed(3)}, heard ${JSON.stringify(outcome!.heard)}`,
      );
      // Silent at the page until the speaker spoke, then playing.
      const [before, after] = outcome!.result.levels;
      expect(before).not.toBeNull();
      expect(before!).toBeLessThan(-70);
      expect(after!).toBeGreaterThan(-50);
      const waits = log.indexOf("the call's music waits for a voice");
      const plays = log.indexOf("a voice was taken: the call's music plays");
      expect(waits).toBeGreaterThanOrEqual(0);
      expect(plays).toBeGreaterThan(waits);
      // The voice taken is the speaker's, from what they said first.
      const taken = log.match(/the speaker's voice was taken from: (.*)/)?.[1];
      expect(wordErrorRate(SENTENCES.en[0]!, taken ?? "")).toBeLessThan(0.5);
      const sung = /\b(dancing|night|summer|stars|singing|radio|cars)\b/gi;
      expect(outcome!.heard.match(sung) ?? []).toEqual([]);
      // The music heard back holds the gate, and the speaker is still heard.
      expect(log).toContain("the call's music is heard");
      expect(outcome!.wer).toBeLessThanOrEqual(0.35);
    }, 600_000);

    test("someone else speaking first: heard as the speaker only without a reference of their voice", async () => {
      const [plain, referenced] = await all([
        {
          name: "other-first",
          mode: "webrtc",
          clips: clips.en!,
          before: clips.other!,
        },
        {
          name: "other-first-reference",
          mode: "webrtc",
          clips: clips.en!,
          before: clips.other!,
          reference: references.en,
        },
      ]);
      // With the speaker's recordings, their voice is kept, not the first
      // one heard; the other voice says nothing.
      expect(referenced!.wer).toBeLessThanOrEqual(0.1);
      expect(referenced!.serverLog).toContain(
        "the speaker's voice is taken from their reference recordings",
      );
      // Without, whoever spoke first is taken for the speaker: printed,
      // to compare.
      expect(plain!.serverLog).toContain(
        "the first voice heard is taken as theirs",
      );
    }, 600_000);

    test("one speaker going from English to French", async () => {
      const both = [...clips.floEn!, ...clips.floFr!];
      const [plain, referenced] = await all([
        { name: "bilingual", mode: "webrtc", clips: both },
        {
          name: "bilingual-reference",
          mode: "webrtc",
          clips: both,
          reference: references.flo,
        },
      ]);
      // With a recording in each language, the French is not taken for
      // someone else's voice; what Parakeet writes in English of it (it
      // does on some French, not always) is read again in French.
      expect(referenced!.wer).toBeLessThanOrEqual(0.2);
      if (rereads)
        console.log(
          `read again by Whisper: ${referenced!.serverLog.match(/said in fr, not English/g)?.length ?? 0}`,
        );
      // Without, the voice is learnt from the English only: printed, to
      // compare.
      expect(plain!.serverLog).toContain(
        "the first voice heard is taken as theirs",
      );
    }, 600_000);

    const own = process.env.ROAMGATE_LIVE_VOICE_CLIPS;
    const ownReference = process.env.ROAMGATE_LIVE_VOICE_REFERENCE?.split(",");
    test.skipIf(!own)(
      "your own recordings, in a WebRTC call",
      async () => {
        const names = readdirSync(own!)
          .filter((name) => name.endsWith(".wav"))
          .sort();
        const mine = names.map((name) => ({
          samples: toSamples(join(own!, name), work),
          text: readFileSync(
            join(own!, name.replace(/\.wav$/, ".txt")),
            "utf8",
          ),
        }));
        const [outcome] = await all([
          {
            name: "own",
            mode: "webrtc",
            clips: mine,
            ...(ownReference ? { reference: ownReference } : {}),
          },
        ]);
        expect(outcome!.wer).toBeLessThanOrEqual(0.15);
      },
      900_000,
    );
  },
);
