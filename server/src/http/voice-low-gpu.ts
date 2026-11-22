import type { VoiceLowGpu } from "../voice/voice-low-gpu";
import { isHolderName } from "../voice/voice-low-gpu";
import { VOICE_REQUEST_HEADER } from "./voice";

/**
 * The low-GPU voice profile (voice-low-gpu.ts), for the Voice settings:
 *
 *   GET  /api/voice/low-gpu  its status: on or off, for whom, the set
 *   POST /api/voice/low-gpu  {on, holder?, now?}: hold it on or let it go
 *                            (off without a holder: every holder);
 *                            {now: true} alone: a call going on switches
 *                            now rather than when it ends
 *
 * The CLI (`roamgate voice profile low-gpu`) writes the same state file,
 * which the server follows. The POST needs the voice header, as the other
 * voice changes do.
 */

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

export function createVoiceLowGpuRoute(profile: VoiceLowGpu) {
  return async (req: Request, pathname: string): Promise<Response | null> => {
    if (pathname !== "/api/voice/low-gpu") return null;
    if (req.method === "GET") return json(profile.status());
    if (req.method !== "POST")
      return json({ error: "method not allowed" }, { status: 405 });
    if (req.headers.get(VOICE_REQUEST_HEADER) !== "1")
      return json(
        { error: "Voice requests need their header." },
        { status: 403 },
      );
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (body?.on === undefined && body?.now === true) {
      const applied = await profile.apply(true);
      return json({ ...profile.status(), applied });
    }
    if (typeof body?.on !== "boolean")
      return json({ error: "on must be true or false" }, { status: 400 });
    const holder = body.holder;
    if (
      holder !== undefined &&
      !(typeof holder === "string" && isHolderName(holder))
    )
      return json(
        { error: "holder is letters, digits, dots, dashes or underscores" },
        { status: 400 },
      );
    const applied = await profile.hold({
      on: body.on,
      ...(holder === undefined ? {} : { holder }),
      now: body.now === true,
    });
    return json({ ...profile.status(), applied });
  };
}
