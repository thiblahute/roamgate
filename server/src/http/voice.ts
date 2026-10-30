import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSpeechRate } from "../../../shared/speechRate";
import {
  isVoiceLanguage,
  SAMPLE_SENTENCES,
} from "../../../shared/voiceLibrary";
import type { VoiceErrands } from "../voice/voice-errands";
import type { VoiceHelper } from "../voice/voice-helper";
import { KOKORO, VoiceError, type VoiceLibrary } from "../voice/voice-library";
import type { VoiceRouter, VoiceSessionInfo } from "../voice/voice-router";

/** Sent with voice requests: a page from elsewhere cannot add it. */
export const VOICE_REQUEST_HEADER = "x-roamgate-voice";
const MAX_SPOKEN_CHARS = 4000;

/**
 * GET /api/voice: whether voice chat is set up, and how fast replies are
 * read (`speech_rate`).
 * Listening goes over /api/voice/ws (see voice-socket).
 * POST /api/voice/speak: `{text, language?}` in, Ogg Opus speech out, its
 * language in X-Voice-Language and the rate it was made at in
 * X-Voice-Native-Rate (1: the voice's own pace), for the page to play it at
 * `speech_rate`.
 * POST /api/voice/settings: `{speech_rate}` kept in voice.json.
 * POST /api/voice/trace: `{line}` from a page reading aloud, logged with
 * ROAMGATE_VOICE_DEBUG set (which GET /api/voice reports as `debug`).
 * POST /api/voice/route: `{current, said, sessions}` in, who it was said to
 * out (voice-router.ts); GET /api/voice reports `route` when it is set up.
 * A question for Ranger ("ranger") is the page's to send. An errand
 * ("errand") is sent to the session in `errand_folder` with `job`, which
 * GET /api/voice/errand?job= follows until its answer is in.
 *
 * Voices (voice-library.ts): GET /api/voice/voices lists them, says which
 * reads what (`assignments`) and whether new ones can be recorded;
 * POST /api/voice/voices (form: name, language, text read, audio, and
 * cut=1 when it ended mid-speech) records
 * one; POST /api/voice/voices/assign `{voice, language?}` chooses who reads
 * (a language, or all of them), from the next sentence; POST
 * /api/voice/voices/sample `{voice, language?}` is a sentence in that voice,
 * as /speak; PATCH /api/voice/voices/<id> `{name}` renames one, DELETE
 * forgets it.
 */
export function createVoiceRoutes(
  helper: VoiceHelper,
  router: () => VoiceRouter | null = () => null,
  errands: VoiceErrands | null = null,
  errandFolder: () => string | undefined = () => undefined,
  library: VoiceLibrary | null = null,
) {
  return async (req: Request, pathname: string): Promise<Response | null> => {
    const debug = Boolean(process.env.ROAMGATE_VOICE_DEBUG);
    if (pathname.startsWith("/api/voice/voices"))
      return handleVoices(req, pathname, helper, library);
    if (pathname === "/api/voice" && req.method === "GET") {
      const routing = router();
      // Started now, so the first thing said does not wait for it.
      routing?.warm();
      return Response.json({
        ...helper.status(),
        ...(routing ? { route: true } : {}),
        speech_rate: helper.speechRate(),
        ...(debug ? { debug } : {}),
      });
    }
    if (pathname === "/api/voice/settings" && req.method === "POST") {
      if (req.headers.get(VOICE_REQUEST_HEADER) !== "1")
        return Response.json(
          { error: "Voice requests need their header." },
          { status: 403 },
        );
      const body = (await req.json().catch(() => null)) as {
        speech_rate?: unknown;
      } | null;
      const rate = body?.speech_rate;
      if (!isSpeechRate(rate))
        return Response.json(
          { error: "speech_rate must be a number from 0.5 to 2." },
          { status: 400 },
        );
      try {
        helper.setSpeechRate(rate);
      } catch (error) {
        return Response.json(
          { error: (error as Error).message },
          { status: 500 },
        );
      }
      return Response.json({ speech_rate: helper.speechRate() });
    }
    if (pathname === "/api/voice/errand" && req.method === "GET") {
      const job = new URL(req.url).searchParams.get("job") ?? "";
      const state = errands?.state(job);
      return state
        ? Response.json(state)
        : Response.json({ error: "No such errand." }, { status: 404 });
    }
    if (pathname === "/api/voice/route" && req.method === "POST") {
      const routing = router();
      if (req.headers.get(VOICE_REQUEST_HEADER) !== "1" || !routing)
        return Response.json({ to: "current" });
      const body = (await req.json().catch(() => null)) as {
        current?: unknown;
        said?: unknown;
        sessions?: unknown;
      } | null;
      const said = typeof body?.said === "string" ? body.said.trim() : "";
      const current = typeof body?.current === "string" ? body.current : "";
      const folder = errandFolder()?.replace(/\/+$/, "");
      const sessions = (
        Array.isArray(body?.sessions)
          ? body.sessions.filter(isSessionInfo).slice(0, 200)
          : []
      ).map((session) =>
        folder &&
        (session.folder === folder || session.folder.startsWith(`${folder}/`))
          ? { ...session, errands: true }
          : session,
      );
      if (!said || !current) return Response.json({ to: "current" });
      const started = performance.now();
      let route = await routing.route({ current, said, sessions });
      if (route.to === "errand") {
        try {
          if (!errands) throw new Error("no errands set up");
          route = {
            ...route,
            job: await errands.start(route.pane, `[Voice] ${said}`),
          };
        } catch (error) {
          if (debug)
            console.error(`[voice] errand failed: ${(error as Error).message}`);
          // Not for the agent on screen either: held, to send by hand.
          route = { to: "nobody" };
        }
      }
      if (debug)
        console.error(
          `[voice] routed in ${Math.round(performance.now() - started)} ms: ${JSON.stringify(route)} <- ${said.slice(0, 200)}`,
        );
      return Response.json(route);
    }
    if (pathname === "/api/voice/trace" && req.method === "POST") {
      if (req.headers.get(VOICE_REQUEST_HEADER) !== "1" || !debug)
        return new Response(null, { status: 204 });
      const body = (await req.json().catch(() => null)) as {
        line?: unknown;
      } | null;
      if (typeof body?.line === "string")
        console.error(`[voice-web] ${body.line.slice(0, 500)}`);
      return new Response(null, { status: 204 });
    }
    if (pathname !== "/api/voice/speak") return null;
    if (req.method !== "POST")
      return new Response("method not allowed", { status: 405 });
    if (req.headers.get(VOICE_REQUEST_HEADER) !== "1")
      return Response.json(
        { error: "Voice requests need their header." },
        { status: 403 },
      );
    try {
      const body = (await req.json().catch(() => null)) as {
        text?: unknown;
        language?: unknown;
      } | null;
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!text) return Response.json({ error: "No text." }, { status: 400 });
      const language =
        typeof body?.language === "string" && /^[a-z]{2}$/.test(body.language)
          ? body.language
          : undefined;
      const speech = await helper.speak(
        text.slice(0, MAX_SPOKEN_CHARS),
        language,
      );
      return speechResponse(speech);
    } catch (error) {
      return Response.json(
        { error: (error as Error).message },
        { status: 502 },
      );
    }
  };
}

/** The largest recording taken: 25 s of 48 kHz 16-bit WAV is 2.4 MB. */
const MAX_RECORDING_BYTES = 12 * 1024 * 1024;

function speechResponse(speech: Awaited<ReturnType<VoiceHelper["speak"]>>) {
  return new Response(speech.audio, {
    headers: {
      "content-type": "audio/ogg",
      "x-voice-language": speech.language,
      "x-voice-native-rate": String(speech.nativeRate),
      "cache-control": "no-store",
    },
  });
}

async function handleVoices(
  req: Request,
  pathname: string,
  helper: VoiceHelper,
  library: VoiceLibrary | null,
): Promise<Response> {
  if (!library)
    return Response.json({ error: "No voice library." }, { status: 404 });
  const writing = req.method !== "GET";
  if (writing && req.headers.get(VOICE_REQUEST_HEADER) !== "1")
    return Response.json(
      { error: "Voice requests need their header." },
      { status: 403 },
    );
  const body = async () =>
    ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  try {
    if (pathname === "/api/voice/voices" && req.method === "GET")
      return Response.json(library.state());
    if (pathname === "/api/voice/voices" && req.method === "POST")
      return Response.json(await createVoice(req, library), { status: 201 });
    if (pathname === "/api/voice/voices/assign" && req.method === "POST") {
      const { voice, language } = await body();
      if (voice !== null && typeof voice !== "string")
        return Response.json({ error: "Choose a voice." }, { status: 400 });
      return Response.json(await library.assign(voice, language));
    }
    if (pathname === "/api/voice/voices/sample" && req.method === "POST") {
      const { voice, language } = await body();
      if (typeof voice !== "string")
        return Response.json({ error: "Choose a voice." }, { status: 400 });
      const models = library.sampleModels(voice);
      const spoken = isVoiceLanguage(language)
        ? language
        : voice === KOKORO
          ? "en"
          : (library.state().voices.find((entry) => entry.id === voice)
              ?.languages[0] ?? "en");
      const code = isVoiceLanguage(spoken) ? spoken : "en";
      return speechResponse(
        await helper.speak(SAMPLE_SENTENCES[code], code, models),
      );
    }
    const id = decodeURIComponent(pathname.slice("/api/voice/voices/".length));
    if (id && !id.includes("/")) {
      if (req.method === "PATCH")
        return Response.json(library.rename(id, (await body()).name));
      if (req.method === "DELETE") {
        library.delete(id);
        return new Response(null, { status: 204 });
      }
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  } catch (error) {
    return Response.json(
      { error: (error as Error).message },
      { status: error instanceof VoiceError ? error.status : 502 },
    );
  }
}

/** POST /api/voice/voices: the recording, kept while the helper clones it. */
async function createVoice(req: Request, library: VoiceLibrary) {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_RECORDING_BYTES)
    throw new VoiceError(413, "The recording is too long.");
  const form = await req.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!form || !(audio instanceof Blob) || !audio.size)
    throw new VoiceError(400, "No recording.");
  if (audio.size > MAX_RECORDING_BYTES)
    throw new VoiceError(413, "The recording is too long.");
  const path = join(tmpdir(), `roamgate-voice-${randomUUID()}.wav`);
  writeFileSync(path, new Uint8Array(await audio.arrayBuffer()));
  try {
    return await library.create({
      name: form.get("name"),
      language: form.get("language"),
      text: form.get("text"),
      audio: path,
      cut: form.get("cut") === "1",
    });
  } finally {
    rmSync(path, { force: true });
  }
}

function isSessionInfo(value: unknown): value is VoiceSessionInfo {
  if (!value || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  if (
    session.active !== undefined &&
    (typeof session.active !== "number" || !Number.isFinite(session.active))
  )
    return false;
  return [
    "id",
    "machine",
    "workspace",
    "title",
    "folder",
    "agent",
    "status",
  ].every(
    (key) =>
      typeof session[key] === "string" && (session[key] as string).length < 500,
  );
}
