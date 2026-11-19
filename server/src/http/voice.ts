import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSpeechRate } from "../../../shared/speechRate";
import {
  isVoiceLanguage,
  SAMPLE_SENTENCES,
} from "../../../shared/voiceLibrary";
import { voiceMessage } from "../../../shared/voiceMessage";
import type { VoiceErrands } from "../voice/voice-errands";
import { serverLogger } from "../utils/logger";
import {
  callLines,
  type FrontReply,
  type FrontTiming,
  forwardedWords,
  recoveredWords,
  skippedContext,
  skippedWords,
  type VoiceFront,
} from "../voice/voice-front";
import {
  type CallHandle,
  type FrontMode,
  isFrontMode,
  LONGEST_PAUSE_MS,
  MIN_PAUSE_MS,
  maxPauseMs,
  type VoiceHelper,
} from "../voice/voice-helper";
import { KOKORO, VoiceError, type VoiceLibrary } from "../voice/voice-library";
import type { CompanionMemory } from "../voice/voice-memory";
import type { CompanionMemoryFiles } from "../voice/voice-memory-files";
import { researchContext, type VoiceResearch } from "../voice/voice-research";
import type { VoiceRouter, VoiceSessionInfo } from "../voice/voice-router";
import { parseVoiceTag } from "../voice/voice-speakers";
import { SurprisePicker } from "../voice/voice-surprise";
import { toolsContext, type VoiceTools } from "../voice/voice-tools";
import { turnCauses, turnContext } from "../voice/turn-causes";

/** Sent with voice requests: a page from elsewhere cannot add it. */
export const VOICE_REQUEST_HEADER = "x-roamgate-voice";
const MAX_SPOKEN_CHARS = 4000;
/** The state a page gives the front beyond the sessions (voice-front.ts). */
const MAX_CONTEXT_CHARS = 12000;
/** An event's words; an agent's answer is given whole, up to this. */
const MAX_EVENT_CHARS = 1000;
const MAX_ANSWER_CHARS = 12000;
/** What the page gives of the call lately, for the front (companionRecent). */
const MAX_RECENT_CHARS = 4000;

/**
 * An event about a session (`pane`: `<connection>/<pane>`) with what
 * started its turn, how long it ran (`turn_ms`, as the page saw it), the
 * user's last input there and whether they look at it (`looking`): the
 * front stays quiet on a turn the user just asked for themselves.
 */
export function withTurnContext(
  event: string,
  body: Record<string, unknown> | null,
  causes = turnCauses,
  now = Date.now(),
): string {
  const pane = typeof body?.pane === "string" ? body.pane : "";
  const slash = pane.indexOf("/");
  if (slash <= 0 || slash === pane.length - 1) return event;
  const turnMs =
    typeof body?.turn_ms === "number" &&
    Number.isFinite(body.turn_ms) &&
    body.turn_ms >= 0
      ? body.turn_ms
      : undefined;
  const turn = causes.turn(pane.slice(0, slash), pane.slice(slash + 1), turnMs);
  return `${event} ${turnContext(
    {
      ...turn,
      ...(turnMs !== undefined ? { turnMs } : {}),
      looking: body?.looking === true,
    },
    now,
  )}`;
}

/**
 * GET /api/voice: whether voice chat is set up, and how fast replies are
 * read (`speech_rate`).
 * Listening goes over /api/voice/ws (see voice-socket).
 * POST /api/voice/speak: `{text, language?, reading?, rate?}` in, Ogg Opus
 * speech out, made at `rate` (the page's reading speed, else
 * `speech_rate`) keeping its pitch, its language in X-Voice-Language and
 * the rate it was made at in X-Voice-Native-Rate (1: the voice's own
 * pace), so the page plays it as it is. With Surprise on, `reading` names the reply the sentence
 * is from: its first sentence picks one of the voices at random
 * (voice-surprise.ts), its others keep it; X-Voice-Name says who (URI
 * encoded). GET /api/voice reports `surprise` with a voice library.
 * POST /api/voice/settings: `{speech_rate}` kept in voice.json; so is
 * `{max_pause_ms}`, the longest pause before a turn that sounded finished
 * ends (voice-socket.ts), which GET /api/voice reports too.
 * POST /api/voice/timing: a turn's times on the page (numbers and short
 * words only), logged at debug level.
 * POST /api/voice/trace: `{line}` from a page reading aloud, logged with
 * ROAMGATE_VOICE_DEBUG set (which GET /api/voice reports as `debug`).
 * POST /api/voice/route: `{current, said, sessions}` in, who it was said to
 * out (voice-router.ts); GET /api/voice reports `route` when it is set up.
 * A question for Ranger ("ranger") or for the reviews agent ("reviews")
 * is the page's to send. An errand
 * ("errand") is sent to the session in `errand_folder` with `job`, which
 * GET /api/voice/errand?job= follows until its answer is in.
 * With a front (`front_model`, voice-front.ts), it decides in the router's
 * place, from `context` too (Ranger tasks, merge requests, what happened),
 * and the route carries `reply`: what to say aloud at once; "self" is
 * answered by `reply` alone. GET /api/voice reports `front`. With
 * `"stream": true` the answer is NDJSON: `{"early": {"to", "reply"}}` as
 * soon as the front has written its words (voice-front.ts earlyReply),
 * for the page to say them while the rest is decided, then the route.
 * The page lists the routes it knows (`routes`): one it does not (a page
 * from an older build, not reloaded yet) gets the nearest older one
 * instead (legacyRoute).
 * POST /api/voice/forward: `{pane, words}` in, `{job}` out: the voice
 * companion's call gives the words, as said, to that session, and follows
 * its answer as an errand's (GET /api/voice/errand?job=).
 * POST /api/voice/event: `{current, sessions, context, event, kind?,
 * agent?, pane?, turn_ms?, looking?}` in, `{reply}` out: what the front
 * tells of it now ("" to stay quiet); an event about a session (`pane`)
 * says what started its turn (withTurnContext); `kind` "answer" gives it
 * an agent's whole answer, "progress" what one wrote while it works,
 * `agent` who. GET /api/voice reports
 * `front_mode`: "companion" (answers told by the front, the default) or
 * "relay" (every answer read), which POST /api/voice/settings
 * `{front_mode}` keeps in voice.json.
 * Web searches (voice-research.ts): a front's "web" route starts one in
 * the background and carries its `job`, its `reply` saying at once that
 * it looks; "web_cancel" stops one and comes back as "self". The front is
 * given the searches with the state. GET /api/voice/research lists them
 * (`jobs`), ?job= gives one; POST /api/voice/research/cancel `{job?}`
 * stops one, or all those running. What a search found is only shown and
 * said: nothing here routes, forwards or sends because of it.
 * The companion's MCP tools (voice-tools.ts, voice.json `companion_mcp`):
 * a front's "tool" route starts a job in the background and comes back
 * with its `job`, as "web" does; "tool_confirm" makes the call a job held
 * for the user's yes, only when the words said are a yes
 * (voice-tools.ts saysYes), and comes back as "tool" with the job making
 * it; "tool_cancel" forgets it and comes back as "self". GET
 * /api/voice/tools lists the jobs, ?job= gives one; POST
 * /api/voice/tools/cancel `{job?}` stops one, or all those running.
 * POST /api/voice/tools/answer `{job, answer}` is the user's click on a
 * held call in the companion's conversation: "yes" makes that call as a
 * yes said does (`{job}` back, the job making it), "no" forgets it
 * (`{declined}`); 409 when nothing of `job` waits any more.
 * With a front, a route needs no `current`: with no session yet, the front
 * still answers, looks up and uses its tools.
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
/** The routes every page knows, from before the front. */
const LEGACY_ROUTES = new Set([
  "current",
  "nobody",
  "open",
  "send",
  "ranger",
  "errand",
  "ask",
]);

/** The voice's timing lines (a turn's route, a sentence's speech). */
const voiceLog = serverLogger.child("voice");

/**
 * `route` as a page that knows `routes` can take it. A page of an older
 * build does not list them, and takes a route it does not know for one to a
 * session (it crashed reading the pane of "self"): a remark to the voice
 * itself is held there, anything else goes to the agent on screen.
 */
export function legacyRoute(route: FrontReply, routes: unknown): FrontReply {
  const known = Array.isArray(routes)
    ? new Set(routes.filter((each) => typeof each === "string"))
    : LEGACY_ROUTES;
  if (known.has(route.to)) return route;
  // A search it cannot follow: what the front said of it, at least.
  if (route.to === "web" || route.to === "tool")
    return known.has("self") && route.reply
      ? { to: "self", reply: route.reply }
      : { to: "nobody" };
  if (route.to === "reset")
    return known.has("self") && route.reply
      ? { to: "self", reply: route.reply }
      : { to: "nobody" };
  return route.to === "self" ? { to: "nobody" } : { to: "current" };
}

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
  /** The front's web searches (voice-research.ts), with a front. */
  research: () => VoiceResearch | null = () => null,
  /** The call the helper runs now (voice-socket.ts). */
  currentCall: () => CallHandle | null = () => null,
  /** The companion's MCP tools (voice-tools.ts), with a front. */
  tools: () => VoiceTools | null = () => null,
  /** What the companion remembers across calls (voice-memory.ts). */
  memory: CompanionMemory | null = null,
  /** Its long-term memory files, shown and deleted in its panel. */
  memoryFiles: CompanionMemoryFiles | null = null,
) {
  /** Forgets everything the companion knows, by voice or from its button. */
  const resetCompanion = (fronting: VoiceFront | null) => {
    const epoch = memory?.reset() ?? 0;
    fronting?.restart();
    research()?.forget();
    tools()?.forget();
    voiceLog.debug("companion memory reset", { epoch });
    return epoch;
  };
  /** Keeps what a turn did, for the next calls. */
  const remember = (said: string, route: FrontReply) => {
    if (!memory || route.to === "nobody" || route.to === "reset") return;
    memory.record({ kind: "heard", text: said });
    if (route.reply) memory.record({ kind: "said", text: route.reply });
    if (route.to === "current" || route.to === "send") {
      memory.record({
        kind: "work",
        text: route.words ?? said,
        who: route.to === "send" ? route.say : "the current session",
      });
    } else if (
      route.to === "ranger" ||
      route.to === "reviews" ||
      route.to === "errand"
    ) {
      memory.record({
        kind: "work",
        text: said,
        who: ("say" in route ? route.say : undefined) ?? route.to,
      });
    } else if (route.to === "web") {
      memory.record({ kind: "lookup", text: route.query || said });
    } else if (route.to === "tool") {
      memory.record({ kind: "lookup", text: route.task || said, who: "tools" });
    }
  };

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
        ...(fronting
          ? {
              front: true,
              front_mode: mode() ?? "companion",
              ...(memory ? { companion_epoch: memory.epoch } : {}),
            }
          : {}),
        speech_rate: helper.speechRate(),
        max_pause_ms: helper.maxPauseMs(),
        ...surpriseStatus(library),
        ...(debug ? { debug } : {}),
      });
    }
    const memoryPath = pathname.match(
      /^\/api\/voice\/companion\/memories(?:\/([^/]+))?$/,
    );
    if (memoryPath && memoryFiles) {
      if (req.headers.get(VOICE_REQUEST_HEADER) !== "1")
        return Response.json(
          { error: "Voice requests need their header." },
          { status: 403 },
        );
      const file = memoryPath[1] ? decodeURIComponent(memoryPath[1]) : null;
      if (req.method === "GET" && !file)
        return Response.json({ memories: memoryFiles.list() });
      if (req.method === "DELETE" && file) {
        const named = memoryFiles.read(file);
        if (!named || !memoryFiles.remove(file))
          return Response.json({ error: "No such memory." }, { status: 404 });
        // The summary may say it too: the next session drops that as well.
        memory?.forget(`${named.name}: ${named.description}`);
        return Response.json({ deleted: file });
      }
      return new Response(null, { status: 405 });
    }
    if (pathname === "/api/voice/companion/reset" && req.method === "POST") {
      if (req.headers.get(VOICE_REQUEST_HEADER) !== "1")
        return Response.json(
          { error: "Voice requests need their header." },
          { status: 403 },
        );
      return Response.json({ epoch: resetCompanion(front()) });
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
        max_pause_ms?: unknown;
      } | null;
      if (body?.max_pause_ms !== undefined) {
        if (
          typeof body.max_pause_ms !== "number" ||
          maxPauseMs(body.max_pause_ms) !== body.max_pause_ms
        )
          return Response.json(
            {
              error: `max_pause_ms must be ${MIN_PAUSE_MS} to ${LONGEST_PAUSE_MS} ms.`,
            },
            { status: 400 },
          );
        try {
          helper.setMaxPauseMs(body.max_pause_ms);
        } catch (error) {
          return Response.json(
            { error: (error as Error).message },
            { status: 500 },
          );
        }
        if (body.speech_rate === undefined && body.front_mode === undefined)
          return Response.json({ max_pause_ms: helper.maxPauseMs() });
      }
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
    if (pathname === "/api/voice/research" && req.method === "GET") {
      const researching = research();
      const job = new URL(req.url).searchParams.get("job");
      if (job === null)
        return Response.json({ jobs: researching?.list() ?? [] });
      const state = researching?.state(job);
      return state
        ? Response.json(state)
        : Response.json({ error: "No such search." }, { status: 404 });
    }
    if (pathname === "/api/voice/research/cancel" && req.method === "POST") {
      if (req.headers.get(VOICE_REQUEST_HEADER) !== "1")
        return Response.json(
          { error: "Voice requests need their header." },
          { status: 403 },
        );
      const body = (await req.json().catch(() => null)) as {
        job?: unknown;
      } | null;
      const researching = research();
      const cancelled = !researching
        ? []
        : typeof body?.job === "string"
          ? researching.cancel(body.job)
            ? [body.job]
            : []
          : researching.cancelAll();
      return Response.json({ cancelled });
    }
    if (pathname === "/api/voice/tools" && req.method === "GET") {
      const using = tools();
      const job = new URL(req.url).searchParams.get("job");
      if (job === null) return Response.json({ jobs: using?.list() ?? [] });
      const state = using?.state(job);
      return state
        ? Response.json(state)
        : Response.json({ error: "No such job." }, { status: 404 });
    }
    if (pathname === "/api/voice/tools/cancel" && req.method === "POST") {
      if (req.headers.get(VOICE_REQUEST_HEADER) !== "1")
        return Response.json(
          { error: "Voice requests need their header." },
          { status: 403 },
        );
      const body = (await req.json().catch(() => null)) as {
        job?: unknown;
      } | null;
      const using = tools();
      const cancelled = !using
        ? []
        : typeof body?.job === "string"
          ? using.cancel(body.job)
            ? [body.job]
            : []
          : using.cancelAll();
      return Response.json({ cancelled });
    }
    if (pathname === "/api/voice/tools/answer" && req.method === "POST") {
      if (req.headers.get(VOICE_REQUEST_HEADER) !== "1")
        return Response.json(
          { error: "Voice requests need their header." },
          { status: 403 },
        );
      const body = (await req.json().catch(() => null)) as {
        job?: unknown;
        answer?: unknown;
      } | null;
      const job = typeof body?.job === "string" ? body.job : "";
      const answer = body?.answer;
      if (!job || (answer !== "yes" && answer !== "no"))
        return Response.json(
          { error: 'A job and its answer ("yes" or "no") are needed.' },
          { status: 400 },
        );
      const using = tools();
      if (!using?.heldJob(job))
        return Response.json(
          { error: "Nothing is waiting for a yes." },
          { status: 409 },
        );
      if (answer === "no") {
        using.decline(job);
        return Response.json({ declined: job });
      }
      const making = using.approve(job);
      if (debug && making)
        console.error(`[voice] held call of ${job} confirmed by a click`);
      return making
        ? Response.json({ job: making })
        : Response.json(
            { error: "Too many jobs run now: try again in a moment." },
            { status: 503 },
          );
    }
    if (pathname === "/api/voice/errand" && req.method === "GET") {
      const job = new URL(req.url).searchParams.get("job") ?? "";
      const state = errands?.state(job);
      // How the work went, whoever follows it (a call or the typed view).
      if (state?.done && state.answer)
        memory?.record({ kind: "answer", text: state.answer });
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
      const told = kind === "event" ? withTurnContext(event, body) : event;
      const started = performance.now();
      const reply = await fronting.event({
        current,
        event: { text: told, kind, ...(agent ? { agent } : {}) },
        sessions: routeSessions(body?.sessions),
        context: withSearches(contextOf(body?.context), research(), tools()),
      });
      if (kind === "answer")
        memory?.record({
          kind: "answer",
          text: event,
          ...(agent ? { who: agent } : {}),
        });
      if (reply) memory?.record({ kind: "said", text: reply });
      if (debug)
        console.error(
          `[voice] front told ${kind} in ${Math.round(performance.now() - started)} ms: ${JSON.stringify(reply)} <- ${told.slice(0, 300)}`,
        );
      voiceLog.debug("voice front told", {
        kind,
        front_ms: Math.round(performance.now() - started),
        said: reply ? "yes" : "no",
      });
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
        interrupted_at?: unknown;
        typed?: unknown;
        routes?: unknown;
        recent?: unknown;
        stream?: unknown;
        skipped?: unknown;
        voice?: unknown;
      } | null;
      const said = typeof body?.said === "string" ? body.said.trim() : "";
      // Who said it (the helper's voices), labelled with what the call
      // taught of the user's voice (voice-speakers.ts).
      const voiceTag = body?.typed === true ? null : parseVoiceTag(body?.voice);
      const voice = voiceTag
        ? helper.speakers.label(voiceTag) || undefined
        : undefined;
      // What was heard and said lately on the call (companionRecent).
      const recent =
        typeof body?.recent === "string"
          ? body.recent.trim().slice(0, MAX_RECENT_CHARS)
          : "";
      // The sentence being read when the user cut in, for the voice note.
      const interruptedAt =
        typeof body?.interrupted_at === "string"
          ? body.interrupted_at.trim().slice(0, 2000)
          : "";
      const current = typeof body?.current === "string" ? body.current : "";
      const sessions = routeSessions(body?.sessions);
      // What was routed to nobody lately: the front may route it now.
      const skipped = fronting ? skippedWords(body?.skipped) : [];
      // The router only chooses a session; the front also answers, looks
      // up and uses its tools, with no session yet as well.
      if (!said || (!current && !fronting))
        return Response.json({ to: "current" });
      // With `stream`, the answer is NDJSON: `{"early": {to, reply}}` as
      // soon as the front has written what it says (earlyReply), then the
      // route. The page says the words while the rest is decided.
      const streaming = body?.stream === true && fronting !== null;
      let tellEarly: ((early: { to: string; reply: string }) => void) | null =
        null;
      const decide = async (): Promise<FrontReply> => {
        const started = performance.now();
        const timing: FrontTiming = {};
        const researching = fronting ? research() : null;
        let route: FrontReply = fronting
          ? await fronting.turn({
              timing,
              onReply: (early) => tellEarly?.(early),
              current,
              said,
              sessions,
              voice,
              context: withSearches(
                [contextOf(body?.context), skippedContext(skipped)]
                  .filter(Boolean)
                  .join("\n\n"),
                researching,
                fronting ? tools() : null,
              ),
              ...callOf(
                callLines({
                  recent,
                  interruptedAt,
                  music: callMusic(currentCall()),
                }),
              ),
            })
          : routing
            ? await routing.route({ current, said, sessions, voice })
            : { to: "current" };
        // Words skipped earlier, routed now: only words the user said and
        // were listed; they are what is handled, not the complaint.
        if ("recovered" in route) {
          const recovered = recoveredWords(route.recovered, skipped);
          route = { ...route };
          delete route.recovered;
          if (recovered) route.recovered = recovered;
        }
        const asSaid = route.recovered ?? said;
        // Only the addressing is dropped, and only when what is left is what
        // was said: otherwise the words go whole.
        if ("words" in route && route.words !== undefined) {
          const words = forwardedWords(asSaid, route.words);
          route = { ...route, words };
          if (words === asSaid) delete route.words;
        }
        if (route.to === "web" || route.to === "web_cancel")
          route = webRoute(route, asSaid, researching);
        if (
          route.to === "tool" ||
          route.to === "tool_confirm" ||
          route.to === "tool_cancel"
        )
          route = toolRoute(
            route,
            asSaid,
            fronting ? tools() : null,
            Boolean(currentCall()?.music),
          );
        if (route.to === "music")
          route = await musicRoute(route, currentCall());
        // After the turn: its session answered this request before it goes.
        if (route.to === "reset" && fronting) resetCompanion(fronting);
        const forgetting = route.to === "forget";
        if (route.to === "forget") route = forgetRoute(route, said, memory);
        if (route.to === "errand") {
          try {
            if (!errands) throw new Error("no errands set up");
            route = {
              ...route,
              job: await errands.start(
                route.pane,
                // Words typed go as typed; words said marked as such.
                body?.typed === true
                  ? asSaid
                  : voiceMessage(asSaid, interruptedAt, route.context),
              ),
            };
          } catch (error) {
            if (debug)
              console.error(
                `[voice] errand failed: ${(error as Error).message}`,
              );
            // Not for the agent on screen either: held, to send by hand.
            route = { to: "nobody" };
          }
        }
        if (debug)
          console.error(
            `[voice] routed in ${Math.round(performance.now() - started)} ms: ${JSON.stringify(route)} <- ${said.slice(0, 200)}`,
          );
        if (fronting && !forgetting) remember(asSaid, route);
        // Which voice is the user's: the one whose words were taken up, or
        // what the front said of it; a turn that timed out tells nothing.
        if (voiceTag && timing.timedOut !== true) {
          helper.speakers.learn(voiceTag, route.to, route.voice);
          const learnt = helper.speakers.label(voiceTag);
          voiceLog.debug("voice turn speaker", {
            label: voice ?? "",
            to: route.to,
            verdict: route.voice ?? "",
            now: learnt,
            share: voiceTag.share,
            mixed: voiceTag.mixed,
            similarity: JSON.stringify(voiceTag.similarity),
          });
          if (debug)
            console.error(
              `[voice] speaker: [${voice ?? ""}] routed ${route.to}${route.voice ? `, the front says ${route.voice}` : ""}; now [${learnt}]`,
            );
        }
        if (route.voice) {
          route = { ...route };
          delete route.voice;
        }
        // Each turn's times (debug): where the companion's first words wait.
        voiceLog.debug("voice turn routed", {
          to: route.to,
          front: fronting ? "yes" : "no",
          streamed: streaming,
          waited_ms: timing.waitedMs,
          first_text_ms: timing.firstTextMs,
          reply_ms: timing.replyMs,
          front_ms: timing.totalMs,
          total_ms: Math.round(performance.now() - started),
          cold: timing.cold === true,
          timed_out: timing.timedOut === true,
          said_chars: said.length,
        });
        return legacyRoute(route, body?.routes);
      };
      if (!streaming) return Response.json(await decide());
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const line = (value: unknown) =>
            controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
          tellEarly = (early) => line({ early });
          decide().then(
            (route) => {
              tellEarly = null;
              line(route);
              controller.close();
            },
            () => {
              tellEarly = null;
              line({ to: "current" });
              controller.close();
            },
          );
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
        },
      });
    }
    if (pathname === "/api/voice/timing" && req.method === "POST") {
      if (req.headers.get(VOICE_REQUEST_HEADER) !== "1")
        return new Response(null, { status: 403 });
      const body = (await req.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      // Numbers and a few words only: nothing said goes in the log.
      const fields: Record<string, string | number> = {};
      for (const [key, value] of Object.entries(body ?? {}).slice(0, 12)) {
        if (!/^[a-z_]{1,24}$/.test(key)) continue;
        if (typeof value === "number" && Number.isFinite(value))
          fields[key] = Math.round(value);
        else if (typeof value === "string" && /^[a-z]{1,16}$/.test(value))
          fields[key] = value;
      }
      voiceLog.debug("voice turn first words", fields);
      return new Response(null, { status: 204 });
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
        rate?: unknown;
        call?: unknown;
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
      const rate = isSpeechRate(body?.rate) ? body.rate : helper.speechRate();
      // In a call: into its mix, which the page hears by WebRTC.
      const call = currentCall();
      if (call && body?.call === call.id) {
        try {
          const queued = await helper.speakInCall(
            call.id,
            spoken,
            language,
            reader?.models,
            rate,
          );
          return Response.json(
            {
              queued: true,
              call: call.id,
              start_ms: queued.startMs,
              duration_ms: queued.durationMs,
              now_ms: queued.nowMs,
              language: queued.language,
              native_rate: queued.nativeRate,
            },
            {
              headers: {
                "cache-control": "no-store",
                ...(reader?.name
                  ? { "x-voice-name": encodeURIComponent(reader.name) }
                  : {}),
              },
            },
          );
        } catch (error) {
          // The call ended meanwhile: a file, as without one.
          if (!/^no call/.test((error as Error).message)) throw error;
        }
      }
      const speech = await helper.speak(spoken, language, reader?.models, rate);
      return speechResponse(speech, reader?.name);
    } catch (error) {
      return Response.json(
        { error: (error as Error).message },
        { status: 502 },
      );
    }
  };
}

/**
 * The call's music for the front's state: on, off, waiting (on, silent
 * until the user's voice is learnt), or none at all.
 */
export function callMusic(
  call: Pick<CallHandle, "music" | "musicOn" | "musicWaiting"> | null,
): "on" | "off" | "waiting" | undefined {
  if (!call?.music) return undefined;
  if (!call.musicOn()) return "off";
  return call.musicWaiting() ? "waiting" : "on";
}

/** How much quieter or louder "down" and "up" make the music. */
const MUSIC_STEP = 1.6;
const MUSIC_FLOOR = 0.05;

/**
 * A front's "music" route, applied to the call's background (call.rs): what
 * the front said of it goes to the page as its own answer. With no music
 * playing, it is said instead.
 */
export async function musicRoute(
  route: Extract<FrontReply, { to: "music" }>,
  call: CallHandle | null,
): Promise<FrontReply> {
  if (!call?.music)
    return { to: "self", reply: "No music is playing on this call." };
  try {
    const now = await call.music_level({});
    const change =
      route.music === "off"
        ? { muted: true }
        : route.music === "on"
          ? { muted: false }
          : {
              muted: false,
              volume:
                route.music === "down"
                  ? Math.max(MUSIC_FLOOR, now.volume / MUSIC_STEP)
                  : Math.min(1, Math.max(MUSIC_FLOOR, now.volume) * MUSIC_STEP),
            };
    const after = await call.music_level(change);
    // As the log tells it: "volume 0.60" or "off".
    const musicState = (music: { volume: number; muted: boolean }) =>
      music.muted ? "off" : `volume ${music.volume.toFixed(2)}`;
    // The route is logged as what was said ("self"): the change is told here.
    console.error(
      `[voice] the call's music ${route.music}: ${musicState(now)} -> ${musicState(after)}`,
    );
  } catch (error) {
    console.error(
      `[voice] the call's music ${route.music} failed: ${(error as Error).message}`,
    );
    return { to: "self", reply: `The music: ${(error as Error).message}` };
  }
  return route.reply ? { to: "self", reply: route.reply } : { to: "nobody" };
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

/** The state a page gave the front, its web searches and its tools. */
export function withSearches(
  context: string,
  research: VoiceResearch | null,
  tools: VoiceTools | null = null,
) {
  const searches = research ? researchContext(research.list()) : "";
  const using = tools
    ? toolsContext(tools.configured(), tools.list(), tools.heldJob())
    : "";
  return [context, searches, using].filter(Boolean).join("\n\n");
}

const looksFrench = (text: string) =>
  /\b(le|la|les|est|une|des|du|pour|avec|dans|quel|quelle|quels|c'est|qu'est|horaires|demain|aujourd'hui)\b|[çèêàù]/i.test(
    text,
  );

/**
 * A front's "web" route with its search started (`job`), and what is said
 * at once; "web_cancel" done, said as "self". Without searches here, it is
 * said that it cannot look.
 */
/** A front's "forget": a background session deletes it; said here at once. */
export function forgetRoute(
  route: Extract<FrontReply, { to: "forget" }>,
  said: string,
  memory: CompanionMemory | null,
): FrontReply {
  const french = looksFrench(said);
  if (!memory)
    return {
      to: "self",
      reply: french
        ? "Je n'ai pas de mémoire à effacer d'ici."
        : "I have no memory to clear from here.",
    };
  memory.forget(route.what);
  return {
    to: "self",
    reply:
      route.reply ||
      (french ? "D'accord, j'oublie ça." : "OK, I'll forget that."),
  };
}

export function webRoute(
  route: Extract<FrontReply, { to: "web" | "web_cancel" }>,
  said: string,
  research: VoiceResearch | null,
): FrontReply {
  const french = looksFrench(said);
  if (route.to === "web_cancel") {
    const cancelled = !research
      ? []
      : route.search
        ? research.cancel(route.search)
          ? [route.search]
          : []
        : research.cancelAll();
    const reply =
      route.reply ||
      (cancelled.length
        ? french
          ? "C'est arrêté."
          : "Stopped."
        : french
          ? "Il n'y a pas de recherche en cours."
          : "No search is running.");
    return { to: "self", reply };
  }
  const query = route.query.trim() || said;
  const job = research?.start(query);
  if (!job || job.status !== "searching")
    return {
      to: "self",
      reply: !research
        ? french
          ? "Je ne peux pas chercher sur le web d'ici."
          : "I can't search the web from here."
        : french
          ? "Je n'arrive pas à lancer la recherche pour l'instant."
          : "I can't start that search right now.",
    };
  return {
    to: "web",
    query,
    job: job.id,
    reply:
      route.reply ||
      (french
        ? "Je regarde ça sur le web, je te redis."
        : "Let me look that up, I'll tell you."),
  };
}

/**
 * A front's "tool" route with its job started (`job`), and what is said
 * at once; "tool_confirm" makes the held call, only when what was said is
 * a yes, as a "tool" route following the job that makes it;
 * "tool_cancel" forgets it, said as "self" (or, with a corrected `task`,
 * started as "tool"). Without tools here, it is
 * said that they cannot be used.
 */
export function toolRoute(
  route: Extract<FrontReply, { to: "tool" | "tool_confirm" | "tool_cancel" }>,
  said: string,
  tools: VoiceTools | null,
  /** Asked on a call with music: music plays on call_music_device. */
  onCall = false,
): FrontReply {
  const french = looksFrench(said);
  if (!tools)
    return {
      to: "self",
      reply: french
        ? "Je n'ai pas d'outils pour ça d'ici."
        : "I don't have tools for that here.",
    };
  if (route.to === "tool_cancel") {
    const declined = tools.decline(route.action);
    // A change: the corrected request, read back again in its turn.
    if (route.task?.trim())
      return toolRoute(
        { to: "tool", task: route.task, reply: route.reply },
        said,
        tools,
        onCall,
      );
    return {
      to: "self",
      reply:
        route.reply ||
        (declined
          ? french
            ? "D'accord, je n'envoie rien."
            : "OK, I won't send anything."
          : french
            ? "Rien n'attendait de confirmation."
            : "Nothing was waiting for a yes."),
    };
  }
  if (route.to === "tool_confirm") {
    const held = tools.heldJob(route.action) ?? tools.heldJob();
    // The user's own yes, now, to a call still held: else nothing runs.
    const job = held ? tools.confirm(said, held.id) : null;
    if (!job)
      return {
        to: "self",
        reply: !held
          ? french
            ? "Rien n'attend de confirmation."
            : "Nothing is waiting for a yes."
          : french
            ? "Je n'ai rien fait. Dis oui pour confirmer, ou non pour annuler."
            : "I haven't done anything. Say yes to confirm, or no to cancel.",
      };
    return {
      to: "tool",
      task: job.question,
      job: job.id,
      reply: route.reply || (french ? "C'est parti." : "Doing it."),
    };
  }
  const task = route.task.trim() || said;
  const job = tools.start(task, onCall);
  if (!job || job.status !== "searching")
    return {
      to: "self",
      reply: french
        ? "Je n'arrive pas à lancer ça pour l'instant."
        : "I can't start that right now.",
    };
  return {
    to: "tool",
    task,
    job: job.id,
    reply: route.reply || (french ? "Je m'en occupe." : "On it."),
  };
}

/** The call lately for a turn, only when there is something to give. */
function callOf(call: string): { call?: string } {
  return call ? { call } : {};
}

function contextOf(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_CONTEXT_CHARS) : "";
}
