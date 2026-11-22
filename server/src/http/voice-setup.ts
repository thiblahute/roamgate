import {
  VOICE_COMPONENTS,
  type VoiceChoices,
} from "../../../shared/voiceSetup";
import type { VoiceSetupRunner } from "../voice/voice-setup";
import { VOICE_REQUEST_HEADER } from "./voice";

/**
 * The Voice settings' setup assistant (voice-setup.ts):
 *
 *   GET  /api/voice/setup         the hardware, the choices, the download
 *   POST /api/voice/setup         {choices}: download them, write voice.json
 *   POST /api/voice/setup/cancel  stop the download (resumed next time)
 *   POST /api/voice/setup/remove  {ids}: delete unused models
 *
 * The POSTs need the voice header, as the other voice changes do.
 */

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

function choicesFrom(value: unknown): VoiceChoices | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const choices: VoiceChoices = {};
  for (const [key, choice] of Object.entries(value)) {
    if (!(VOICE_COMPONENTS as readonly string[]).includes(key)) return null;
    if (typeof choice !== "string" || !choice) return null;
    choices[key as keyof VoiceChoices] = choice;
  }
  return choices;
}

export function createVoiceSetupRoute(runner: VoiceSetupRunner) {
  return async (req: Request, pathname: string): Promise<Response | null> => {
    if (pathname === "/api/voice/setup" && req.method === "GET")
      return json(runner.state());
    if (!pathname.startsWith("/api/voice/setup") || req.method !== "POST")
      return null;
    if (req.headers.get(VOICE_REQUEST_HEADER) !== "1")
      return json(
        { error: "Voice requests need their header." },
        { status: 403 },
      );
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    try {
      if (pathname === "/api/voice/setup") {
        const choices = choicesFrom(body?.choices);
        if (!choices)
          return json(
            { error: "choices must name a model for each part" },
            { status: 400 },
          );
        runner.start(choices);
        return json(runner.state(), { status: 202 });
      }
      if (pathname === "/api/voice/setup/cancel") {
        runner.cancel();
        return json(runner.state());
      }
      if (pathname === "/api/voice/setup/remove") {
        const ids = body?.ids;
        if (
          ids !== "all" &&
          !(Array.isArray(ids) && ids.every((id) => typeof id === "string"))
        )
          return json(
            { error: 'ids must be a list of model ids, or "all"' },
            { status: 400 },
          );
        const { freedBytes } = runner.removeUnused(ids as string[] | "all");
        return json({ ...runner.state(), freedBytes });
      }
    } catch (error) {
      return json(
        { error: (error as Error).message },
        { status: runner.running ? 409 : 400 },
      );
    }
    return null;
  };
}
