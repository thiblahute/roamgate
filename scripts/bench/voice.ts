/**
 * Voice latency (plan section 5.9): the parity suite's fake voice helper
 * (parity/src/fakes/voice.rs, `parity-fake` linked as roamgate-voice)
 * speaks the helper's real frame protocol and, with `timestamps`, logs when
 * it read and wrote each frame. The bench plays the page on /api/voice/ws
 * and POST /api/voice/speak.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { login } from "./client";
import {
  type BenchEnv,
  connectClock,
  PASSWORD,
  REPO,
  type ServerHandle,
  startServer,
  TestClock,
} from "./env";
import { type Options, stats } from "./metrics";

/**
 * How long a first sentence may go without progress before the helper is
 * pinged (server/src/voice/voice-helper.ts SPEAK_COLD_MS).
 */
const SPEAK_COLD_MS = 45_000;

/** About 3 s of 64 kbit/s Ogg Opus: the size of a spoken sentence. */
const AUDIO_BYTES = 24 * 1024;

/** 20 ms of 16 kHz mono S16LE, the page's audio frame. */
const AUDIO_FRAME = new Uint8Array(640);

/** Now, in microseconds since the Unix epoch (the fake's `at_us`). */
const nowUs = () => (performance.timeOrigin + performance.now()) * 1000;

/** The parity fakes binary: BENCH_PARITY_FAKE, else built here. */
export function parityFake(log: (line: string) => void): string {
  const given = process.env.BENCH_PARITY_FAKE;
  if (given) return given;
  // Where cargo puts it: CARGO_TARGET_DIR (relative to the checkout) or
  // the checkout's target/.
  const target = process.env.CARGO_TARGET_DIR
    ? resolve(REPO, process.env.CARGO_TARGET_DIR)
    : join(REPO, "target");
  const built = join(target, "release/parity-fake");
  log("building parity-fake (cargo build --release)");
  const result = spawnSync(
    "cargo",
    ["build", "--release", "-p", "roamgate-parity", "--bin", "parity-fake"],
    {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || !existsSync(built))
    throw new Error(
      `cargo build of parity-fake failed (status ${result.status}, ${built}${existsSync(built) ? "" : " missing"}): ${result.stderr.slice(-2000)}`,
    );
  return built;
}

type Frame = Record<string, any> & { at_us: number; pid: number };

function frames(path: string): Frame[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  // The last line may be half written.
  const out: Frame[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

async function waitFrame(
  path: string,
  match: (frame: Frame) => boolean,
  timeoutMs = 10_000,
): Promise<Frame> {
  const start = performance.now();
  for (;;) {
    const found = frames(path).find(match);
    if (found) return found;
    if (performance.now() - start > timeoutMs)
      throw new Error(`no frame of the fake voice helper matched in time`);
    await Bun.sleep(1);
  }
}

/** The world's voice setup: voice.json, the fake and its script. */
function setUpVoice(
  env: BenchEnv,
  fake: string,
  script: Record<string, unknown>,
  config: Record<string, unknown> = {},
) {
  const fakes = join(env.root, "voice-fakes");
  rmSync(fakes, { recursive: true, force: true });
  mkdirSync(fakes, { recursive: true });
  const helper = join(env.bin, "roamgate-voice");
  rmSync(helper, { force: true });
  symlinkSync(fake, helper);
  writeFileSync(
    join(fakes, "roamgate-voice.json"),
    JSON.stringify({ timestamps: true, ...script }),
  );
  const dir = join(env.home, ".config/roamgate");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "voice.json"),
    JSON.stringify({
      helper,
      whisper_model: helper,
      kokoro_model: helper,
      kokoro_voices: helper,
      ...config,
    }),
  );
  return {
    log: join(fakes, "roamgate-voice.frames.jsonl"),
    extraEnv: {
      PARITY_FAKES_DIR: fakes,
      // No model download reaches the network.
      HTTPS_PROXY: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
    },
  };
}

/** The page's voice socket. */
class VoiceSocket {
  ws!: WebSocket;
  private waiters: {
    match: (message: Record<string, any>) => boolean;
    resolve: (value: { message: Record<string, any>; atUs: number }) => void;
  }[] = [];

  async open(base: string, cookie: string) {
    this.ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/voice/ws`, {
      headers: { cookie, origin: base },
    } as unknown as string[]);
    this.ws.onmessage = (event) => {
      const atUs = nowUs();
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data);
      const index = this.waiters.findIndex((waiter) => waiter.match(message));
      if (index >= 0)
        this.waiters.splice(index, 1)[0]!.resolve({
          message,
          atUs,
        });
    };
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("voice socket error"));
    });
  }

  next(match: (message: Record<string, any>) => boolean, timeoutMs = 10_000) {
    return new Promise<{ message: Record<string, any>; atUs: number }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("no voice event in time")),
          timeoutMs,
        );
        this.waiters.push({
          match,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
        });
      },
    );
  }

  send(message: Record<string, unknown> | Uint8Array<ArrayBuffer>) {
    this.ws.send(
      message instanceof Uint8Array ? message : JSON.stringify(message),
    );
  }

  close() {
    this.ws.close();
  }
}

function speak(base: string, cookie: string, text: string) {
  return fetch(`${base}/api/voice/speak`, {
    method: "POST",
    headers: {
      cookie,
      origin: base,
      "content-type": "application/json",
      "x-roamgate-voice": "1",
    },
    body: JSON.stringify({ text, language: "en" }),
  });
}

/**
 * Final transcript to first audio: the helper hears the end of a sentence
 * (its `final`, on the first audio of a listening session), the page gets
 * it on /api/voice/ws and asks POST /api/voice/speak for the reply at once
 * (the companion's own time left out), the helper makes it at once, and
 * the page gets the audio's first bytes. Per turn, the whole and its legs:
 * the final through the server to the page, the speak request through the
 * server to the helper, the helper's audio through the server to the page.
 */
async function finalToFirstAudio(env: BenchEnv, fake: string, turns: number) {
  const audio = Buffer.alloc(AUDIO_BYTES, 0x4f).toString("base64");
  const voice = setUpVoice(env, fake, {
    on_audio: [
      { event: "final", session: "$session", text: "what time is it" },
    ],
    replies: { speak: { audio, language: "en" } },
  });
  const server = await startServer(env, {
    label: "voice",
    extraEnv: voice.extraEnv,
  });
  const samples: {
    total_ms: number;
    final_to_page_ms: number;
    speak_to_helper_ms: number;
    helper_ms: number;
    audio_to_page_ms: number;
  }[] = [];
  try {
    const cookie = await login(server.base, PASSWORD);
    const socket = new VoiceSocket();
    await socket.open(server.base, cookie);
    for (let turn = 0; turn < turns; turn++) {
      const listening = socket.next((m) => m.event === "listening");
      socket.send({ op: "listen", language: "en" });
      const session = (await listening).message.session;
      const final = socket.next(
        (m) => m.event === "final" && m.session === session,
      );
      socket.send(AUDIO_FRAME);
      const heard = await final;
      const text = `Reply ${turn}.`;
      const postUs = nowUs();
      const response = await speak(server.base, cookie, text);
      if (!response.ok || !response.body)
        throw new Error(`speak answered ${response.status}`);
      const reader = response.body.getReader();
      const first = await reader.read();
      const audioUs = nowUs();
      let bytes = first.value?.length ?? 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
      }
      if (bytes !== AUDIO_BYTES)
        throw new Error(`speak gave ${bytes} bytes, not ${AUDIO_BYTES}`);
      const said = await waitFrame(
        voice.log,
        (f) => f.sent?.event === "final" && f.sent?.session === session,
      );
      const asked = await waitFrame(
        voice.log,
        (f) => f.op === "speak" && f.text === text,
      );
      const made = await waitFrame(
        voice.log,
        (f) => f.sent?.id === asked.id && f.pid === asked.pid,
      );
      socket.send({ op: "stop" });
      samples.push({
        total_ms: (audioUs - said.at_us) / 1000,
        final_to_page_ms: (heard.atUs - said.at_us) / 1000,
        speak_to_helper_ms: (asked.at_us - postUs) / 1000,
        helper_ms: (made.at_us - asked.at_us) / 1000,
        audio_to_page_ms: (audioUs - made.at_us) / 1000,
      });
    }
    socket.close();
  } finally {
    await server.stop();
  }
  // The first turns start the helper and warm the paths.
  const kept = samples.length > 4 ? samples.slice(2) : samples;
  const of = (key: keyof (typeof samples)[number]) =>
    stats(kept.map((sample) => sample[key]));
  return {
    turns: samples.length,
    audio_bytes: AUDIO_BYTES,
    ms: of("total_ms"),
    samples_ms: samples.map(
      (sample) => Math.round(sample.total_ms * 1000) / 1000,
    ),
    legs: {
      final_to_page_ms: of("final_to_page_ms"),
      speak_to_helper_ms: of("speak_to_helper_ms"),
      helper_ms: of("helper_ms"),
      audio_to_page_ms: of("audio_to_page_ms"),
    },
  };
}

/**
 * The helper ping round trip: a sentence that makes no progress for
 * SPEAK_COLD_MS on the server's test clock gets the helper pinged; this
 * helper answers at once, so its speaker is taken as stuck and the helper
 * restarted. It runs behind a wrapper (`env`), which the server stops by
 * closing its input. Measured at the helper: from reading the ping to its
 * input closing (its answer read by the server and acted on), and its own
 * time in between; also from the clock's jump to the ping.
 */
async function helperPing(env: BenchEnv, fake: string, rounds: number) {
  const voice = setUpVoice(
    env,
    fake,
    { stall: ["speak"] },
    { helper_wrapper: ["env"] },
  );
  const clock = new TestClock(join(env.root, "voice-clock.sock"));
  const serverPromise = startServer(env, {
    label: "voice-ping",
    testClock: clock.path,
    extraEnv: voice.extraEnv,
  });
  await connectClock(clock, serverPromise);
  let server: ServerHandle | null = null;
  const samples: {
    round_trip_ms: number;
    helper_us: number;
    clock_to_ping_ms: number;
  }[] = [];
  const stuck: Promise<unknown>[] = [];
  try {
    server = await serverPromise;
    const cookie = await login(server.base, PASSWORD);
    for (let round = 0; round < rounds; round++) {
      const text = `Stuck ${round}.`;
      stuck.push(speak(server.base, cookie, text).catch(() => null));
      const asked = await waitFrame(
        voice.log,
        (f) => f.op === "speak" && f.text === text,
      );
      const jumpUs = nowUs();
      await clock.advance(SPEAK_COLD_MS + 1);
      const ping = await waitFrame(
        voice.log,
        (f) => f.op === "ping" && f.pid === asked.pid,
      );
      const answer = await waitFrame(
        voice.log,
        (f) => f.sent?.id === ping.id && f.pid === ping.pid,
      );
      const closed = await waitFrame(
        voice.log,
        (f) => f.eof === true && f.pid === ping.pid,
      );
      samples.push({
        round_trip_ms: (closed.at_us - ping.at_us) / 1000,
        helper_us: answer.at_us - ping.at_us,
        clock_to_ping_ms: (ping.at_us - jumpUs) / 1000,
      });
    }
  } finally {
    clock.close();
    await server?.stop();
    await Promise.all(stuck);
  }
  const kept = samples.length > 4 ? samples.slice(1) : samples;
  return {
    rounds: samples.length,
    ms: stats(kept.map((sample) => sample.round_trip_ms)),
    samples_ms: samples.map(
      (sample) => Math.round(sample.round_trip_ms * 1000) / 1000,
    ),
    helper_us: stats(kept.map((sample) => sample.helper_us)),
    clock_to_ping_ms: stats(kept.map((sample) => sample.clock_to_ping_ms)),
  };
}

export async function measureVoice(env: BenchEnv, options: Options) {
  const fake = parityFake(options.log);
  return {
    helper:
      "parity-fake as roamgate-voice (parity/src/fakes/voice.rs), timestamps on",
    final_to_first_audio: await finalToFirstAudio(
      env,
      fake,
      options.quick ? 6 : 52,
    ),
    helper_ping: await helperPing(env, fake, options.quick ? 3 : 21),
  };
}
