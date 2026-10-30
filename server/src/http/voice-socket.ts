import type { CleanSession, VoiceCleaner } from "../voice/voice-cleaner";
import type {
  VoiceEvent,
  VoiceHelper,
  VoiceSession,
} from "../voice/voice-helper";

/**
 * /api/voice/ws: a browser streams its microphone to the voice helper and
 * hears back when speech starts and what was said.
 *
 * From the browser, JSON: `{"op": "listen", "hold": true, "language": "es",
 * "end_silence_ms": 2500, "new_speaker": true}` starts a session (ending
 * the one before; with `new_speaker`, whoever speaks first is the voice
 * kept from then on),
 * With a cleaner set up, `"context"` (the conversation's end) goes with it
 * and what was said is cleaned before it is told:
 * `{"event": "final", "text": "clean", "raw": "as heard", "for_agent": false}`.
 * `{"op": "release"}`, `{"op": "finish"}` and `{"op": "stop"}` act on it;
 * binary messages are its audio, 16 kHz mono S16LE. To the browser, JSON:
 * `{"event": "listening", "session": 4}`, then the helper's events for it
 * (`speech_start`, `text`, `final`, `error`).
 */
export type VoiceSocket = {
  send: (message: string) => unknown;
};

export function createVoiceSocket(
  helper: VoiceHelper,
  cleaner: () => VoiceCleaner | null = () => null,
) {
  const sessions = new Map<VoiceSocket, VoiceSession>();
  const cleaning = new Map<VoiceSocket, () => void>();

  const stop = (ws: VoiceSocket) => {
    sessions.get(ws)?.stop();
    sessions.delete(ws);
    cleaning.get(ws)?.();
    cleaning.delete(ws);
  };

  /**
   * The helper's events to the browser, the words cleaned on the way: the
   * final text waits for its cleaning, so events keep their order.
   */
  const relay = (ws: VoiceSocket, context: string | null) => {
    const using = context === null ? null : cleaner();
    if (!using) return (event: VoiceEvent) => ws.send(JSON.stringify(event));
    using.warm();
    let session: CleanSession = using.session(context ?? "");
    cleaning.set(ws, () => session.close());
    let chain = Promise.resolve();
    return (event: VoiceEvent) => {
      chain = chain
        .then(async () => {
          if (event.event === "partial" && event.text)
            session.partial(event.text, event.pause === true);
          if (event.event === "final" && event.text) {
            const started = performance.now();
            const cleaned = await session.final(event.text);
            // Held words are shown as they were heard when nothing is left.
            if (!cleaned.forAgent && !cleaned.text) cleaned.text = event.text;
            if (process.env.ROAMGATE_VOICE_DEBUG)
              console.error(
                `[voice] cleaned in ${Math.round(performance.now() - started)} ms${cleaned.forAgent ? "" : ", not for the agent"}: ${cleaned.text}\n[voice]   heard: ${event.text}`,
              );
            session = using.session(context ?? "");
            event = {
              ...event,
              text: cleaned.text,
              raw: event.text,
              for_agent: cleaned.forAgent,
            };
          }
          ws.send(JSON.stringify(event));
        })
        .catch(() => {});
    };
  };

  return {
    message(ws: VoiceSocket, message: string | Uint8Array) {
      if (typeof message !== "string") {
        sessions.get(ws)?.audio(message);
        return;
      }
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(message);
      } catch {
        return;
      }
      const session = sessions.get(ws);
      switch (request.op) {
        case "listen": {
          stop(ws);
          try {
            const started = helper.listen(
              relay(
                ws,
                typeof request.context === "string"
                  ? request.context.slice(-4000)
                  : null,
              ),
              {
                hold: request.hold === true,
                newSpeaker: request.new_speaker === true,
                language:
                  typeof request.language === "string" &&
                  /^[a-z]{2}$/.test(request.language)
                    ? request.language
                    : undefined,
                endSilenceMs:
                  typeof request.end_silence_ms === "number" &&
                  request.end_silence_ms >= 300 &&
                  request.end_silence_ms <= 10_000
                    ? request.end_silence_ms
                    : undefined,
              },
            );
            sessions.set(ws, started);
            ws.send(
              JSON.stringify({ event: "listening", session: started.id }),
            );
          } catch (error) {
            ws.send(
              JSON.stringify({
                event: "error",
                error: (error as Error).message,
              }),
            );
          }
          return;
        }
        case "release":
          session?.release();
          return;
        case "finish":
          session?.finish();
          return;
        case "stop":
          stop(ws);
          return;
      }
    },
    close(ws: VoiceSocket) {
      stop(ws);
    },
  };
}
