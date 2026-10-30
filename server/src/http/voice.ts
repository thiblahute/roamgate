import { isSpeechRate } from "../../../shared/speechRate";
import type { VoiceErrands } from "../voice/voice-errands";
import type { VoiceHelper } from "../voice/voice-helper";
import {
  conversationEnd,
  type VoiceRouter,
  type VoiceSessionInfo,
} from "../voice/voice-router";

/** The history entries of a pane's agent session on a connection. */
export type ReadSessionEntries = (
  connectionId: string,
  paneId: string,
) => Promise<readonly { role?: unknown; text?: unknown }[]>;

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
 * A question about another session ("status") comes back with `answer`, a
 * summary of its conversation's end. An errand ("errand") is sent to the
 * session in `errand_folder` with `job`, which GET /api/voice/errand?job=
 * follows until its answer is in.
 */
export function createVoiceRoutes(
  helper: VoiceHelper,
  router: () => VoiceRouter | null = () => null,
  readEntries: ReadSessionEntries | null = null,
  errands: VoiceErrands | null = null,
  errandFolder: () => string | undefined = () => undefined,
) {
  return async (req: Request, pathname: string): Promise<Response | null> => {
    const debug = Boolean(process.env.ROAMGATE_VOICE_DEBUG);
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
      if (route.to === "status") {
        const slash = route.pane.indexOf("/");
        const connectionId = route.pane.slice(0, slash);
        const paneId = route.pane.slice(slash + 1);
        let answer: string;
        try {
          if (!readEntries) throw new Error("no session reader");
          answer = await routing.summarize(
            said,
            route.say,
            conversationEnd(await readEntries(connectionId, paneId)),
          );
        } catch (error) {
          if (debug)
            console.error(
              `[voice] summary failed: ${(error as Error).message}`,
            );
          answer = `I couldn't read the ${route.say || "session"} session.`;
        }
        route = { ...route, answer };
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
          route = {
            to: "status",
            pane: route.pane,
            say: route.say,
            answer: `I couldn't pass that to the ${route.say || "errands"} session.`,
          };
        }
      }
      if (route.to === "overview") {
        let answer: string;
        try {
          if (!readEntries) throw new Error("no session reader");
          const read = readEntries;
          const ends = await Promise.all(
            overviewSessions(sessions).map(async (session) => {
              const slash = session.id.indexOf("/");
              const entries = await withTimeout(
                read(session.id.slice(0, slash), session.id.slice(slash + 1)),
                OVERVIEW_READ_MS,
              ).catch(() => []);
              return {
                name: `${session.title || session.workspace} (${session.machine}, ${session.status})`,
                conversation: conversationEnd(entries, 4, 600),
              };
            }),
          );
          answer = await routing.summarizeAll(said, ends);
        } catch (error) {
          if (debug)
            console.error(
              `[voice] overview failed: ${(error as Error).message}`,
            );
          answer = "I couldn't read the sessions.";
        }
        route = { to: "overview", answer };
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

/** How long one session's history may take to read for an overview. */
const OVERVIEW_READ_MS = 10_000;
/** At most this many sessions go into an overview. */
const OVERVIEW_SESSIONS = 15;

/** The sessions an overview covers: the most recently active, today's. */
export function overviewSessions(
  sessions: readonly VoiceSessionInfo[],
): VoiceSessionInfo[] {
  const timed = sessions.filter((session) => session.active !== undefined);
  if (!timed.length) return sessions.slice(0, OVERVIEW_SESSIONS);
  return timed
    .filter((session) => session.active! < 24 * 60)
    .sort((a, b) => a.active! - b.active!)
    .slice(0, OVERVIEW_SESSIONS);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), ms),
    ),
  ]);
}
