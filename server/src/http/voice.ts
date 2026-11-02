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
import {
  type FrontReply,
  forwardedWords,
  type VoiceFront,
} from "../voice/voice-front";
import {
  type FrontMode,
  isFrontMode,
  type VoiceHelper,
} from "../voice/voice-helper";
import { KOKORO, VoiceError, type VoiceLibrary } from "../voice/voice-library";
import type { VoiceRouter, VoiceSessionInfo } from "../voice/voice-router";
import { SurprisePicker } from "../voice/voice-surprise";

/** Sent with voice requests: a page from elsewhere cannot add it. */
export const VOICE_REQUEST_HEADER = "x-roamgate-voice";
const MAX_SPOKEN_CHARS = 4000;
/** The state a page gives the front beyond the sessions (voice-front.ts). */
const MAX_CONTEXT_CHARS = 12000;
/** An event's words; an agent's answer is given whole, up to this. */
const MAX_EVENT_CHARS = 1000;
const MAX_ANSWER_CHARS = 12000;

/**
 * GET /api/voice: whether voice chat is set up, and how fast replies are
 * read (`speech_rate`).
 * Listening goes over /api/voice/ws (see voice-socket).
 * POST /api/voice/speak: `{text, language?, reading?}` in, Ogg Opus speech
 * out, its language in X-Voice-Language and the rate it was made at in
 * X-Voice-Native-Rate (1: the voice's own pace), for the page to play it at
 * `speech_rate`. With Surprise on, `reading` names the reply the sentence
 * is from: its first sentence picks one of the voices at random
 * (voice-surprise.ts), its others keep it; X-Voice-Name says who (URI
 * encoded). GET /api/voice reports `surprise` with a voice library.
 * POST /api/voice/settings: `{speech_rate}` kept in voice.json.
 * POST /api/voice/trace: `{line}` from a page reading aloud, logged with
 * ROAMGATE_VOICE_DEBUG set (which GET /api/voice reports as `debug`).
 * POST /api/voice/route: `{current, said, sessions}` in, who it was said to
 * out (voice-router.ts); GET /api/voice reports `route` when it is set up.
 * A question for Ranger ("ranger") is the page's to send. An errand
 * ("errand") is sent to the session in `errand_folder` with `job`, which
 * GET /api/voice/errand?job= follows until its answer is in.
 * With a front (`front_model`, voice-front.ts), it decides in the router's
 * place, from `context` too (Ranger tasks, merge requests, what happened),
 * and the route carries `reply`: what to say aloud at once; "self" is
 * answered by `reply` alone. GET /api/voice reports `front`.
 * POST /api/voice/forward: `{pane, words}` in, `{job}` out: the voice
 * companion's call gives the words, as said, to that session, and follows
 * its answer as an errand's (GET /api/voice/errand?job=).
 * POST /api/voice/event: `{current, sessions, context, event, kind?,
 * agent?}` in, `{reply}` out: what the front tells of it now ("" to stay
 * quiet); `kind` "answer" gives it an agent's whole answer, "progress"
 * what one wrote while it works, `agent` who. GET /api/voice reports
 * `front_mode`: "companion" (answers told by the front, the default) or
 * "relay" (every answer read), which POST /api/voice/settings
 * `{front_mode}` keeps in voice.json.
 *
 * Voices (voice-library.ts): GET /api/voice/voices lists them, grouped by
 * model (`voices` recorded, `stock` Qwen3-TTS speakers, `kokoro`), says
 * which reads what (`assignments`) and whether new ones can be recorded;
 * POST /api/voice/voices (form: name, language, text read, audio, and
 * cut=1 when it ended mid-speech) records
 * one; POST /api/voice/voices/assign `{voice, language?}` chooses who reads
 * (a language, or all of them), from the next sentence; POST
 * /api/voice/voices/sample `{voice, language?}` is a sentence in that voice,
 * as /speak; POST /api/voice/voices/surprise `{on}` turns Surprise on or
 * off (choosing a voice turns it off); PATCH /api/voice/voices/<id>
 * `{name}` renames one, DELETE forgets it.
 */
export function createVoiceRoutes(
  helper: VoiceHelper,
  router: () => VoiceRouter | null = () => null,
  errands: VoiceErrands | null = null,
  errandFolder: () => string | undefined = () => undefined,
  library: VoiceLibrary | null = null,
  front: () => VoiceFront | null = () => null,
  /** What the front does with answers (voice-helper.ts frontMode). */
  mode: () => FrontMode | null = () => null,
  saveMode: (mode: FrontMode) => void = () => {},
) {
  const surprise = new SurprisePicker();
  /** The sessions a page lists, those of the errands folder marked. */
  const routeSessions = (value: unknown): VoiceSessionInfo[] => {
    const folder = errandFolder()?.replace(/\/+$/, "");
    return (
      Array.isArray(value) ? value.filter(isSessionInfo).slice(0, 200) : []
    ).map((session) =>
      folder &&
      (session.folder === folder || session.folder.startsWith(`${folder}/`))
        ? { ...session, errands: true }
        : session,
    );
  };
  return async (req: Request, pathname: string): Promise<Response | null> => {
    const debug = Boolean(process.env.ROAMGATE_VOICE_DEBUG);
    if (pathname.startsWith("/api/voice/voices"))
      return handleVoices(req, pathname, helper, library);
    if (pathname === "/api/voice" && req.method === "GET") {
      const fronting = front();
      const routing = fronting ? null : router();
      // Started now, so the first thing said does not wait for it.
      fronting?.warm();
      routing?.warm();
      return Response.json({
        ...helper.status(),
        ...(routing || fronting ? { route: true } : {}),
        ...(fronting ? { front: true, front_mode: mode() ?? "companion" } : {}),
        speech_rate: helper.speechRate(),
        ...surpriseStatus(library),
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
        front_mode?: unknown;
      } | null;
      if (body?.front_mode !== undefined) {
        if (!isFrontMode(body.front_mode))
          return Response.json(
            { error: 'front_mode must be "companion" or "relay".' },
            { status: 400 },
          );
        try {
          saveMode(body.front_mode);
        } catch (error) {
          return Response.json(
            { error: (error as Error).message },
            { status: 500 },
          );
        }
        if (body.speech_rate === undefined)
          return Response.json({ front_mode: mode() ?? body.front_mode });
      }
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
    if (pathname === "/api/voice/forward" && req.method === "POST") {
      if (req.headers.get(VOICE_REQUEST_HEADER) !== "1")
        return Response.json(
          { error: "Voice requests need their header." },
          { status: 403 },
        );
      const body = (await req.json().catch(() => null)) as {
        pane?: unknown;
        words?: unknown;
      } | null;
      const pane = typeof body?.pane === "string" ? body.pane : "";
      const words =
        typeof body?.words === "string" ? body.words.trim().slice(0, 8000) : "";
      if (!/^[^/]+\/[^/]+$/.test(pane) || !words)
        return Response.json(
          { error: "A session and words are needed." },
          { status: 400 },
        );
      if (!errands)
        return Response.json({ error: "No jobs here." }, { status: 404 });
      try {
        const job = await errands.start(pane, words);
        if (debug)
          console.error(
            `[voice] companion job ${job} on ${pane}: ${words.slice(0, 200)}`,
          );
        return Response.json({ job });
      } catch (error) {
        return Response.json(
          { error: (error as Error).message },
          { status: 502 },
        );
      }
    }
    if (pathname === "/api/voice/errand" && req.method === "GET") {
      const job = new URL(req.url).searchParams.get("job") ?? "";
      const state = errands?.state(job);
      return state
        ? Response.json(state)
        : Response.json({ error: "No such errand." }, { status: 404 });
    }
    if (pathname === "/api/voice/event" && req.method === "POST") {
      const fronting = front();
      if (req.headers.get(VOICE_REQUEST_HEADER) !== "1" || !fronting)
        return Response.json({ reply: "" });
      const body = (await req.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      const kind =
        body?.kind === "answer" || body?.kind === "progress"
          ? body.kind
          : "event";
      const event =
        typeof body?.event === "string"
          ? body.event
              .trim()
              .slice(0, kind === "event" ? MAX_EVENT_CHARS : MAX_ANSWER_CHARS)
          : "";
      const agent =
        typeof body?.agent === "string" ? body.agent.trim().slice(0, 80) : "";
      const current = typeof body?.current === "string" ? body.current : "";
      if (!event) return Response.json({ reply: "" });
      const started = performance.now();
      const reply = await fronting.event({
        current,
        event: { text: event, kind, ...(agent ? { agent } : {}) },
        sessions: routeSessions(body?.sessions),
        context: contextOf(body?.context),
      });
      if (debug)
        console.error(
          `[voice] front told ${kind} in ${Math.round(performance.now() - started)} ms: ${JSON.stringify(reply)} <- ${event.slice(0, 200)}`,
        );
      return Response.json({ reply });
    }
    if (pathname === "/api/voice/route" && req.method === "POST") {
      const fronting = front();
      const routing = fronting ? null : router();
      if (
        req.headers.get(VOICE_REQUEST_HEADER) !== "1" ||
        !(routing || fronting)
      )
        return Response.json({ to: "current" });
      const body = (await req.json().catch(() => null)) as {
        current?: unknown;
        said?: unknown;
        sessions?: unknown;
        context?: unknown;
      } | null;
      const said = typeof body?.said === "string" ? body.said.trim() : "";
      const current = typeof body?.current === "string" ? body.current : "";
      const sessions = routeSessions(body?.sessions);
      if (!said || !current) return Response.json({ to: "current" });
      const started = performance.now();
      let route: FrontReply = fronting
        ? await fronting.turn({
            current,
            said,
            sessions,
            context: contextOf(body?.context),
          })
        : routing
          ? await routing.route({ current, said, sessions })
          : { to: "current" };
      // Only the addressing is dropped, and only when what is left is what
      // was said: otherwise the words go whole.
      if ("words" in route && route.words !== undefined) {
        const words = forwardedWords(said, route.words);
        route = { ...route, words };
        if (words === said) delete route.words;
      }
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
        reading?: unknown;
      } | null;
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!text) return Response.json({ error: "No text." }, { status: 400 });
      const language =
        typeof body?.language === "string" && /^[a-z]{2}$/.test(body.language)
          ? body.language
          : undefined;
      const spoken = text.slice(0, MAX_SPOKEN_CHARS);
      const reading =
        typeof body?.reading === "string" && body.reading.length <= 100
          ? body.reading
          : undefined;
      const reader = surpriseReader(library, surprise, reading);
      const speech = await helper.speak(spoken, language, reader?.models);
      return speechResponse(speech, reader?.name);
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

function speechResponse(
  speech: Awaited<ReturnType<VoiceHelper["speak"]>>,
  /** Who reads it, when the page is to say so. */
  name?: string,
) {
  return new Response(speech.audio, {
    headers: {
      "content-type": "audio/ogg",
      "x-voice-language": speech.language,
      "x-voice-native-rate": String(speech.nativeRate),
      ...(name ? { "x-voice-name": encodeURIComponent(name) } : {}),
      "cache-control": "no-store",
    },
  });
}

/** Whether Surprise is on, for GET /api/voice; nothing without a library. */
function surpriseStatus(library: VoiceLibrary | null): { surprise?: boolean } {
  if (!library) return {};
  try {
    return { surprise: library.state().surprise };
  } catch {
    return {};
  }
}

/**
 * With Surprise on, who reads this sentence of `reading` and the models
 * that read in that voice; null to read as voice.json says (Surprise off,
 * or the voices unreadable: a reply is read anyway).
 */
function surpriseReader(
  library: VoiceLibrary | null,
  picker: SurprisePicker,
  reading: string | undefined,
): { name: string; models: ReturnType<VoiceLibrary["sampleModels"]> } | null {
  try {
    const voices = library?.surpriseVoices();
    if (!library || !voices) return null;
    const id = picker.pick(voices, reading);
    const voice = voices.find((entry) => entry.id === id);
    if (!voice) return null;
    return { name: voice.name, models: library.sampleModels(voice.id) };
  } catch {
    return null;
  }
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
    if (pathname === "/api/voice/voices/surprise" && req.method === "POST") {
      const { on } = await body();
      if (typeof on !== "boolean")
        return Response.json(
          { error: "on must be true or false." },
          { status: 400 },
        );
      return Response.json(library.setSurprise(on));
    }
    if (pathname === "/api/voice/voices/sample" && req.method === "POST") {
      const { voice, language } = await body();
      if (typeof voice !== "string")
        return Response.json({ error: "Choose a voice." }, { status: 400 });
      const models = library.sampleModels(voice);
      const known = () => {
        const state = library.state();
        return (
          state.voices.find((entry) => entry.id === voice)?.languages[0] ??
          state.stock.find((entry) => entry.id === voice)?.native
        );
      };
      const spoken = isVoiceLanguage(language)
        ? language
        : voice === KOKORO
          ? "en"
          : (known() ?? "en");
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

function contextOf(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_CONTEXT_CHARS) : "";
}
