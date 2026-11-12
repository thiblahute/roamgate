#!/usr/bin/env bun
/**
 * Dictates an audio file through a running Roamgate, as the Android app
 * does (the voice socket's dictation mode, docs/ARCHITECTURE.md): for a
 * corpus of dictations and the dictation model's benchmark. Prints the
 * final event as one JSON line; partials go to stderr with --verbose.
 *
 *   ROAMGATE_PASSWORD=... bun scripts/dictate-wav.ts --url http://127.0.0.1:8787 \
 *     --kind chat --app com.whatsapp --before "Salut Gwen, " say.wav
 *
 * Any file ffmpeg reads is converted to 16 kHz mono S16LE first; a WAV
 * already in that format is read as it is. The audio is sent in real time
 * unless --fast.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: "http://127.0.0.1:8787" },
    cookie: { type: "string" },
    kind: { type: "string", default: "text" },
    app: { type: "string" },
    hint: { type: "string" },
    before: { type: "string", default: "" },
    after: { type: "string", default: "" },
    language: { type: "string" },
    fast: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
});

const file = positionals[0];
if (!file) {
  console.error("usage: dictate-wav.ts [options] <audio file>");
  process.exit(2);
}

/** 16 kHz mono S16LE samples of `path`. */
function pcm(path: string): Uint8Array<ArrayBuffer> {
  const data = readFileSync(path);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const isWav =
    data.subarray(0, 4).toString() === "RIFF" &&
    data.subarray(8, 12).toString() === "WAVE";
  if (isWav) {
    let at = 12;
    let format: { channels: number; rate: number; bits: number } | null = null;
    while (at + 8 <= data.length) {
      const id = data.subarray(at, at + 4).toString();
      const size = view.getUint32(at + 4, true);
      if (id === "fmt ")
        format = {
          channels: view.getUint16(at + 10, true),
          rate: view.getUint32(at + 12, true),
          bits: view.getUint16(at + 22, true),
        };
      if (
        id === "data" &&
        format?.channels === 1 &&
        format.rate === 16_000 &&
        format.bits === 16
      )
        return new Uint8Array(data.subarray(at + 8, at + 8 + size));
      at += 8 + size + (size % 2);
    }
  }
  const converted = Bun.spawnSync([
    "ffmpeg",
    "-loglevel",
    "error",
    "-i",
    path,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "s16le",
    "-",
  ]);
  if (!converted.success)
    throw new Error(`ffmpeg could not read ${path}: ${converted.stderr}`);
  return new Uint8Array(converted.stdout);
}

async function cookie(base: URL): Promise<string> {
  if (values.cookie) return values.cookie;
  const password = process.env.ROAMGATE_PASSWORD;
  if (!password) return "";
  const response = await fetch(new URL("/api/login", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
    redirect: "manual",
  });
  const set = response.headers.get("set-cookie");
  if (!set) throw new Error(`Login failed: ${response.status}`);
  return set.split(";")[0] ?? "";
}

const audio = pcm(file);
const base = new URL(values.url);
const url = new URL("/api/voice/ws", base);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(url, {
  headers: { cookie: await cookie(base) },
} as unknown as string[]);
ws.binaryType = "arraybuffer";
const started = performance.now();
let finishedAt = 0;

ws.onmessage = (message) => {
  if (typeof message.data !== "string") return;
  const event = JSON.parse(message.data) as Record<string, unknown>;
  if (event.event === "partial" && values.verbose)
    console.error(`heard: ${event.text}`);
  if (event.event === "final" || event.event === "error") {
    console.log(
      JSON.stringify({
        ...event,
        file,
        audio_ms: audio.length / 32,
        after_finish_ms: Math.round(performance.now() - finishedAt),
      }),
    );
    ws.close();
    process.exit(event.event === "final" ? 0 : 1);
  }
};
ws.onerror = () => {
  console.error(`Could not reach ${url}`);
  process.exit(1);
};
ws.onopen = async () => {
  ws.send(
    JSON.stringify({
      op: "listen",
      mode: "dictation",
      ...(values.language ? { language: values.language } : {}),
      field: {
        kind: values.kind,
        ...(values.app ? { app: values.app } : {}),
        ...(values.hint ? { hint: values.hint } : {}),
      },
      before: values.before,
      after: values.after,
    }),
  );
  // 20 ms chunks, as the phone sends them.
  const chunk = 640;
  for (let at = 0; at < audio.length; at += chunk) {
    ws.send(audio.slice(at, at + chunk));
    if (!values.fast) {
      const due = started + (at + chunk) / 32;
      const wait = due - performance.now();
      if (wait > 0) await Bun.sleep(wait);
    }
  }
  finishedAt = performance.now();
  ws.send(JSON.stringify({ op: "finish" }));
};
