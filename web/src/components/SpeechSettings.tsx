import {
  type ReactNode,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from "react";
import {
  formatSpeechRate,
  SPEECH_RATE_STEPS,
} from "../../../shared/speechRate";
import {
  setVoiceOutputMode,
  subscribeVoiceOutputMode,
  type VoiceOutputMode,
  voiceOutputMode,
} from "../voiceOutput";
import {
  type BrowserCallBlock,
  retryBrowserVoiceInCalls,
  setReadWith,
  useSpeechEngine,
} from "../speechEngine";
import {
  updateSpeechPreferences,
  useSpeechPreferences,
} from "../speechPreferences";
import { store } from "../store";
import {
  getMaxPause,
  getSpeechRate,
  MAX_PAUSE_STEPS,
  saveMaxPause,
  saveSpeechRate,
  subscribeMaxPause,
  subscribeSpeechRate,
} from "../voiceChat";
import "./SpeechSettings.css";

/** What the Speech section says reads aloud, and what voice chat can do. */
export function speechEngineSummary({
  engine,
  server,
}: {
  engine: "server" | "browser" | null;
  server: boolean | null;
}): string {
  const reads =
    engine === "server"
      ? "Replies are read by Roamgate's voice engine on the server."
      : engine === "browser"
        ? "Replies are read by this browser's speech synthesis."
        : "Nothing here can read replies aloud.";
  const listens =
    server === true
      ? " Voice chat listens through the server's voice engine."
      : server === false
        ? " The server has no voice engine, so voice chat cannot listen."
        : "";
  return reads + listens;
}

/**
 * What Speech settings say when this browser's voice reads but not in
 * voice calls here (speechEngine.ts browserCallBlock).
 */
export function browserCallNote(block: BrowserCallBlock): string {
  return block === "android"
    ? "This browser's voice can't play during voice calls on Android: the microphone opens as a phone call, and the browser's speech is cut off or not heard beside it. Calls read with Roamgate's voice engine."
    : "This browser's voice did not play in a voice call on this device, so calls read with Roamgate's voice engine.";
}

export function SpeechSettings({
  serverVoices,
  voiceSetup,
}: {
  /** The server engine's voices and speed (VoiceSettings), when it has one. */
  serverVoices?: ReactNode;
  /**
   * The voice setup assistant (VoiceSetup), for a server without its voice
   * engine yet; VoiceSettings shows it otherwise.
   */
  voiceSetup?: ReactNode;
} = {}) {
  const id = useId();
  const preferences = useSpeechPreferences();
  const speech = useSpeechEngine();
  const serverRate = useSyncExternalStore(subscribeSpeechRate, getSpeechRate);
  const maxPause = useSyncExternalStore(subscribeMaxPause, getMaxPause);
  const output = useSyncExternalStore(
    subscribeVoiceOutputMode,
    voiceOutputMode,
  );
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const synthesis =
    typeof window === "undefined" ? null : window.speechSynthesis;
  const supported =
    Boolean(synthesis) && typeof window.SpeechSynthesisUtterance === "function";
  useEffect(() => {
    if (!synthesis || !supported) return;
    const refresh = () => setVoices(synthesis.getVoices());
    refresh();
    synthesis.addEventListener("voiceschanged", refresh);
    return () => synthesis.removeEventListener("voiceschanged", refresh);
  }, [synthesis, supported]);
  const missingVoice =
    preferences.voiceURI !== "" &&
    !voices.some((voice) => voice.voiceURI === preferences.voiceURI);
  return (
    <fieldset className="speech-settings">
      <legend>Speech</legend>
      <p id={`${id}-description`}>
        Listen to agent replies with Speak in Agent History Chat, and in voice
        chat. Some browser voices use an online service and may send message
        text to the voice provider. Playback may stop when the browser is in the
        background or the screen is locked.
      </p>
      <p role="status" className="speech-settings-engine">
        {speechEngineSummary(speech)}
      </p>
      {speech.server ? (
        <>
          <label htmlFor={`${id}-engine`}>Read aloud with</label>
          <select
            id={`${id}-engine`}
            value={speech.readWith}
            onChange={(event) =>
              setReadWith(
                event.target.value === "browser" ? "browser" : "server",
              )
            }
          >
            <option value="server">Roamgate's voice engine (server)</option>
            <option value="browser" disabled={!supported}>
              This browser's voice
            </option>
          </select>
          {speech.engine === "browser" && speech.callBlock ? (
            <p role="status" className="speech-settings-call-note">
              {browserCallNote(speech.callBlock)}
              {speech.callBlock === "failed" ? (
                <>
                  {" "}
                  <button type="button" onClick={retryBrowserVoiceInCalls}>
                    Try it in calls again
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
          <label htmlFor={`${id}-max-pause`}>
            Longest pause before your turn ends
          </label>
          <select
            id={`${id}-max-pause`}
            aria-describedby={`${id}-max-pause-help`}
            value={String(maxPause)}
            onChange={(event) =>
              saveMaxPause(Number(event.target.value)).catch((error) =>
                store.notify({
                  kind: "error",
                  message: "The longest pause was not kept",
                  detail: (error as Error).message,
                }),
              )
            }
          >
            {[...new Set<number>([...MAX_PAUSE_STEPS, maxPause])]
              .sort((a, b) => a - b)
              .map((ms) => (
                <option key={ms} value={String(ms)}>
                  {`${ms / 1000} s`}
                </option>
              ))}
          </select>
          <p id={`${id}-max-pause-help`}>
            When your voice sounds finished but your words do not. A pause that
            sounds unfinished, or after "um" or "euh", waits up to 15 s.
          </p>
          {/* The server's voices, when shown, have their own speed. */}
          {serverVoices ? null : (
            <>
              <label htmlFor={`${id}-server-rate`}>
                Server reading speed: {formatSpeechRate(serverRate)}
              </label>
              <select
                id={`${id}-server-rate`}
                value={String(serverRate)}
                onChange={(event) =>
                  saveSpeechRate(Number(event.target.value)).catch((error) =>
                    store.notify({
                      kind: "error",
                      message: "The reading speed was not kept",
                      detail: (error as Error).message,
                    }),
                  )
                }
              >
                {[...new Set<number>([...SPEECH_RATE_STEPS, serverRate])]
                  .sort((a, b) => a - b)
                  .map((rate) => (
                    <option key={rate} value={String(rate)}>
                      {formatSpeechRate(rate)}
                    </option>
                  ))}
              </select>
            </>
          )}
        </>
      ) : null}
      {!supported ? (
        <p role="status">Speech is not supported by this browser.</p>
      ) : null}
      {/* Only for this browser's voice: the server's engine reads at the
          server's speed, so a browser rate here would not apply. */}
      {speech.engine === "server" ? null : (
        <>
          <label htmlFor={`${id}-voice`}>Browser voice</label>
          <select
            id={`${id}-voice`}
            disabled={!supported}
            aria-describedby={`${id}-description`}
            value={preferences.voiceURI}
            onChange={(event) =>
              updateSpeechPreferences({ voiceURI: event.target.value })
            }
          >
            <option value="">Browser default</option>
            {missingVoice ? (
              <option value={preferences.voiceURI}>
                Saved voice unavailable (using browser default)
              </option>
            ) : null}
            {voices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name} ({voice.lang})
                {voice.localService ? "" : " - online"}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-rate`}>
            Browser speaking rate: {preferences.rate.toFixed(1)}x
          </label>
          <input
            id={`${id}-rate`}
            type="range"
            min="0.5"
            max="2"
            step="0.1"
            disabled={!supported}
            value={preferences.rate}
            aria-valuetext={`${preferences.rate.toFixed(1)} times normal speed`}
            onChange={(event) =>
              updateSpeechPreferences({ rate: Number(event.target.value) })
            }
          />
        </>
      )}
      {speech.server ? (
        <>
          <label htmlFor={`${id}-output`}>
            Voice chat replies play (this device)
          </label>
          <select
            id={`${id}-output`}
            value={output}
            onChange={(event) =>
              setVoiceOutputMode(event.target.value as VoiceOutputMode)
            }
          >
            <option value="context">With the microphone's audio</option>
            <option value="element">As media (previous way)</option>
          </select>
          <p>
            Calls play replies by WebRTC; this applies when a call cannot. Cars
            and headsets may pause or cut replies played as media during a call.
          </p>
        </>
      ) : null}
      {speech.server && serverVoices ? (
        <div className="speech-settings-server">{serverVoices}</div>
      ) : null}
      {speech.server === false && voiceSetup ? (
        <div className="speech-settings-server">{voiceSetup}</div>
      ) : null}
    </fieldset>
  );
}
