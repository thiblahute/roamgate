import { isSpeechRate } from "../../../shared/speechRate";
import type { VoiceHelper } from "../voice/voice-helper";

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
 */
export function createVoiceRoutes(helper: VoiceHelper) {
  return async (req: Request, pathname: string): Promise<Response | null> => {
    const debug = Boolean(process.env.ROAMGATE_VOICE_DEBUG);
    if (pathname === "/api/voice" && req.method === "GET")
      return Response.json({
        ...helper.status(),
        speech_rate: helper.speechRate(),
        ...(debug ? { debug } : {}),
      });
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
      return new Response(speech.audio, {
        headers: {
          "content-type": "audio/ogg",
          "x-voice-language": speech.language,
          "x-voice-native-rate": String(speech.nativeRate),
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      return Response.json(
        { error: (error as Error).message },
        { status: 502 },
      );
    }
  };
}
