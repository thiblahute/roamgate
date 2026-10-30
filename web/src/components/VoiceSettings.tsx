import {
  Check,
  LoaderCircle,
  Mic,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Shuffle,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { CSSProperties } from "react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  formatSpeechRate,
  SPEECH_RATE_STEPS,
} from "../../../shared/speechRate";
import {
  MAX_RECORDING_SECONDS,
  MAX_VOICE_NAME_LENGTH,
  MIN_RECORDING_SECONDS,
  READING_TEXTS,
  ReadingEnd,
  RERECORD_RATE,
  VOICE_LANGUAGES,
  type VoiceLanguage,
  voiceLanguageLabel,
  wordErrorRate,
} from "../../../shared/voiceLibrary";
import {
  getSpeechRate,
  saveSpeechRate,
  subscribeSpeechRate,
} from "../voiceChat";
import {
  assignVoice,
  createVoice,
  deleteVoice,
  fetchVoiceLibrary,
  KOKORO,
  type NewVoice,
  playBlob,
  playVoiceSample,
  type Recording,
  renameVoice,
  startRecording,
  type VoiceInfo,
  type VoiceLibraryState,
} from "../voiceLibrary";
import "./VoiceSettings.css";

const METER_BARS = [0.5, 0.8, 1, 0.8, 0.5];

/** The voice of `id` as named on screen. */
function voiceName(state: VoiceLibraryState, id: string | null | undefined) {
  if (!id) return "None";
  if (id === KOKORO) return "Kokoro";
  return state.voices.find((voice) => voice.id === id)?.name ?? id;
}

/** Whether any language is read with `id`. */
function inUse(state: VoiceLibraryState, id: string) {
  return (
    state.assignments.all === id ||
    Object.values(state.assignments.languages).includes(id)
  );
}

/**
 * The voices replies are read with, simple enough for children: hear each
 * one, choose who reads, record a new one (read a short text aloud, give it
 * a name), rename or delete them; which voice reads a given language, and
 * the reading speed. The Configuration dialog's Voice tab, which the voice
 * card opens.
 */
export function VoiceSettings() {
  const [state, setState] = useState<VoiceLibraryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const playback = useRef<AbortController | null>(null);

  const stopPlaying = useCallback(() => {
    playback.current?.abort();
    playback.current = null;
    setPlaying(null);
  }, []);

  useEffect(() => {
    let live = true;
    fetchVoiceLibrary()
      .then((next) => live && setState(next))
      .catch((failure: Error) => live && setError(failure.message));
    return () => {
      live = false;
      stopPlaying();
    };
  }, [stopPlaying]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const hear = (id: string) => {
    if (playing === id) return stopPlaying();
    stopPlaying();
    const controller = new AbortController();
    playback.current = controller;
    setPlaying(id);
    void playVoiceSample(id, controller.signal)
      .catch((failure: Error) => setError(failure.message))
      .finally(() => {
        if (playback.current === controller) {
          playback.current = null;
          setPlaying(null);
        }
      });
  };

  const use = (id: string, language: VoiceLanguage | null = null) =>
    run(`use:${id}:${language}`, async () =>
      setState(await assignVoice(id, language)),
    );

  const voiceRows: { id: string; voice?: VoiceInfo }[] = [
    ...(state?.voices ?? []).map((voice) => ({ id: voice.id, voice })),
    ...(state?.kokoro ? [{ id: KOKORO }] : []),
  ];

  return (
    <div className="voice-settings">
      <p className="configuration-scope">
        Who reads voice replies aloud, on this server.
      </p>
      {error ? (
        <p className="voice-settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {!state ? (
        error ? null : (
          <p className="voice-settings-loading">
            <LoaderCircle size={16} className="is-spinning" /> Loading the
            voices...
          </p>
        )
      ) : creating ? (
        <NewVoiceFlow
          onCancel={() => setCreating(false)}
          onCreated={async () => setState(await fetchVoiceLibrary())}
          onUse={async (id) => {
            setState(await assignVoice(id, null));
            setCreating(false);
          }}
          onHear={hear}
          playing={playing}
        />
      ) : (
        <>
          <ul className="voice-settings-list">
            {voiceRows.map(({ id, voice }) => {
              const reading = state.assignments.all === id;
              const languages = Object.entries(state.assignments.languages)
                .filter(([, assigned]) => assigned === id)
                .map(([code]) => voiceLanguageLabel(code));
              return (
                <li
                  key={id}
                  className={`voice-settings-voice${reading ? " is-reading" : ""}`}
                >
                  <div className="voice-settings-voice-name">
                    {renaming === id && voice ? (
                      <RenameField
                        name={voice.name}
                        onDone={(name) => {
                          setRenaming(null);
                          if (name && name !== voice.name)
                            void run(`rename:${id}`, async () => {
                              await renameVoice(id, name);
                              setState(await fetchVoiceLibrary());
                            });
                        }}
                      />
                    ) : (
                      <>
                        <strong>{voice ? voice.name : "Kokoro"}</strong>
                        <span>
                          {voice
                            ? voice.languages
                                .map(voiceLanguageLabel)
                                .join(", ") || "Recorded voice"
                            : "Built in, every language"}
                          {reading ? " · reads replies" : ""}
                          {languages.length
                            ? ` · reads ${languages.join(", ")}`
                            : ""}
                        </span>
                      </>
                    )}
                  </div>
                  <div className="voice-settings-voice-actions">
                    <button
                      type="button"
                      className="voice-settings-icon"
                      aria-label={
                        playing === id ? "Stop" : `Hear ${voiceName(state, id)}`
                      }
                      title={playing === id ? "Stop" : "Hear it"}
                      onClick={() => hear(id)}
                    >
                      {playing === id ? (
                        <Square size={16} />
                      ) : (
                        <Play size={16} />
                      )}
                    </button>
                    {voice ? (
                      <>
                        <button
                          type="button"
                          className="voice-settings-icon"
                          aria-label={`Rename ${voice.name}`}
                          title="Rename"
                          onClick={() => setRenaming(id)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          className="voice-settings-icon"
                          aria-label={`Delete ${voice.name}`}
                          title={
                            inUse(state, id)
                              ? "It reads replies: choose another voice first"
                              : "Delete"
                          }
                          disabled={inUse(state, id) || busy !== null}
                          onClick={() => {
                            if (
                              !window.confirm(
                                voice.owned
                                  ? `Delete ${voice.name}? Its recording goes too.`
                                  : `Remove ${voice.name} from the list? Its file stays.`,
                              )
                            )
                              return;
                            void run(`delete:${id}`, async () => {
                              await deleteVoice(id);
                              setState(await fetchVoiceLibrary());
                            });
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className={`voice-settings-use${reading ? " is-reading" : ""}`}
                      disabled={busy !== null}
                      aria-pressed={reading}
                      title={
                        reading
                          ? "Reads every reply"
                          : "Read every reply with this voice"
                      }
                      onClick={() => {
                        if (!reading || languages.length) void use(id);
                      }}
                    >
                      {busy === `use:${id}:null` ? (
                        <LoaderCircle size={15} className="is-spinning" />
                      ) : reading ? (
                        <Check size={15} />
                      ) : null}
                      {reading ? "Reading" : "Use"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="voice-settings-new"
            disabled={!state.can_clone}
            title={state.can_clone ? undefined : state.clone_detail}
            onClick={() => {
              stopPlaying();
              setCreating(true);
            }}
          >
            <Plus size={18} /> New voice
          </button>
          {!state.can_clone && state.clone_detail ? (
            <p className="voice-settings-note">{state.clone_detail}</p>
          ) : null}
          <LanguageVoices
            state={state}
            busy={busy}
            onAssign={use}
            onClear={(language) =>
              run(`clear:${language}`, async () =>
                setState(await assignVoice(null, language)),
              )
            }
          />
          <ReadingSpeed onError={setError} />
        </>
      )}
    </div>
  );
}

function RenameField({
  name,
  onDone,
}: {
  name: string;
  onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState(name);
  return (
    <form
      className="voice-settings-rename"
      onSubmit={(event) => {
        event.preventDefault();
        onDone(value.trim() || null);
      }}
    >
      <input
        autoFocus
        aria-label="Voice name"
        value={value}
        maxLength={MAX_VOICE_NAME_LENGTH}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onDone(null);
          }
        }}
      />
      <button type="submit" className="voice-settings-icon" aria-label="Save">
        <Check size={15} />
      </button>
    </form>
  );
}

/** A voice of their own for some languages, like French read in French. */
function LanguageVoices({
  state,
  busy,
  onAssign,
  onClear,
}: {
  state: VoiceLibraryState;
  busy: string | null;
  onAssign: (voice: string, language: VoiceLanguage) => void;
  onClear: (language: VoiceLanguage) => void;
}) {
  const [adding, setAdding] = useState<VoiceLanguage | "">("");
  const assigned = Object.entries(state.assignments.languages) as [
    VoiceLanguage,
    string,
  ][];
  const free = VOICE_LANGUAGES.filter(
    ({ code }) => !(code in state.assignments.languages),
  );
  if (!state.voices.length) return null;
  const select = (language: VoiceLanguage, value: string) => (
    <select
      aria-label={`Voice for ${voiceLanguageLabel(language)}`}
      value={value}
      disabled={busy !== null}
      onChange={(event) => {
        if (event.currentTarget.value) {
          onAssign(event.currentTarget.value, language);
          setAdding("");
        }
      }}
    >
      {value ? null : <option value="">Choose a voice</option>}
      {state.voices.map((voice) => (
        <option key={voice.id} value={voice.id}>
          {voice.name}
        </option>
      ))}
    </select>
  );
  return (
    <details className="voice-settings-section" open={assigned.length > 0}>
      <summary>A voice for one language</summary>
      <p className="voice-settings-note">
        Replies in that language are read with it; the others with{" "}
        {voiceName(state, state.assignments.all)}.
      </p>
      {assigned.map(([language, id]) => (
        <div key={language} className="voice-settings-language">
          <span>{voiceLanguageLabel(language)}</span>
          {select(language, id)}
          <button
            type="button"
            className="voice-settings-icon"
            aria-label={`No voice of its own for ${voiceLanguageLabel(language)}`}
            title="Read it with the main voice"
            disabled={busy !== null}
            onClick={() => onClear(language)}
          >
            <X size={15} />
          </button>
        </div>
      ))}
      {free.length ? (
        <div className="voice-settings-language">
          <select
            aria-label="Language"
            value={adding}
            onChange={(event) =>
              setAdding(event.currentTarget.value as VoiceLanguage | "")
            }
          >
            <option value="">Add a language</option>
            {free.map(({ code, label }) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
          {adding ? select(adding, "") : null}
        </div>
      ) : null}
    </details>
  );
}

function ReadingSpeed({ onError }: { onError: (message: string) => void }) {
  const rate = useSyncExternalStore(subscribeSpeechRate, getSpeechRate);
  return (
    <div
      className="voice-settings-speed"
      role="group"
      aria-label="Reading speed"
    >
      <span>Speed</span>
      {SPEECH_RATE_STEPS.map((step) => (
        <button
          key={step}
          type="button"
          aria-pressed={Math.abs(step - rate) < 1e-6}
          onClick={() =>
            saveSpeechRate(step).catch((failure: Error) =>
              onError(`The reading speed was not kept: ${failure.message}`),
            )
          }
        >
          {formatSpeechRate(step)}
        </button>
      ))}
    </div>
  );
}

type Step =
  | { name: "setup" }
  | { name: "record" }
  | { name: "making" }
  | { name: "done"; created: NewVoice };

/**
 * A new voice: a name and a language, then a short text read aloud while
 * recording (heard back, recorded again if need be), then the server makes
 * the voice.
 */
function NewVoiceFlow({
  onCancel,
  onCreated,
  onUse,
  onHear,
  playing,
}: {
  onCancel: () => void;
  onCreated: () => Promise<void>;
  onUse: (id: string) => Promise<void>;
  onHear: (id: string) => void;
  playing: string | null;
}) {
  const [step, setStep] = useState<Step>({ name: "setup" });
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<VoiceLanguage>(() =>
    navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en",
  );
  const [textIndex, setTextIndex] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [take, setTake] = useState<{
    wav: Blob;
    seconds: number;
    /** It ended while speech went on. */
    cut: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState<AbortController | null>(null);
  const texts = READING_TEXTS[language];
  const text = texts[textIndex % texts.length]!;
  const recordingRef = useRef<Recording | null>(null);

  // When the reading is over: at its pause, or at the limit.
  const readingEnd = useRef<ReadingEnd | null>(null);

  const stopRecording = useCallback(async () => {
    const current = recordingRef.current;
    if (!current) return;
    recordingRef.current = null;
    const cut = readingEnd.current?.cut() ?? false;
    setRecording(null);
    setLevel(0);
    setTake({ ...(await current.stop()), cut });
  }, []);

  // Leaving drops a recording going on.
  useEffect(
    () => () => {
      if (recordingRef.current) {
        recordingRef.current.cancel();
        recordingRef.current = null;
      }
    },
    [],
  );

  useEffect(() => () => listening?.abort(), [listening]);

  const record = async () => {
    setError(null);
    setTake(null);
    setSeconds(0);
    listening?.abort();
    const end = new ReadingEnd(text);
    readingEnd.current = end;
    try {
      const started = await startRecording({
        onLevel: setLevel,
        onSeconds: setSeconds,
        // Over once the text is read and a pause follows, never mid-word
        // unless the limit comes first.
        onBlock: (rms, length) => {
          if (end.push(rms, length) !== "go on") void stopRecording();
        },
      });
      recordingRef.current = started;
      setRecording(started);
    } catch (failure) {
      setError(
        `The microphone could not be used: ${(failure as Error).message}`,
      );
    }
  };

  const make = async () => {
    if (!take) return;
    setStep({ name: "making" });
    setError(null);
    try {
      const created = await createVoice({
        name: name.trim(),
        language,
        text,
        recording: take.wav,
        cut: take.cut,
      });
      await onCreated();
      setStep({ name: "done", created });
    } catch (failure) {
      setError((failure as Error).message);
      setStep({ name: "record" });
    }
  };

  if (step.name === "setup")
    return (
      <form
        className="voice-new"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) setStep({ name: "record" });
        }}
      >
        <h3>A new voice</h3>
        <label className="voice-new-field">
          <span>Its name</span>
          <input
            autoFocus
            value={name}
            maxLength={MAX_VOICE_NAME_LENGTH}
            placeholder="Léa, Pirate, Grandpa..."
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <fieldset className="voice-new-languages">
          <legend>It speaks</legend>
          {VOICE_LANGUAGES.map(({ code, label }) => (
            <button
              key={code}
              type="button"
              aria-pressed={language === code}
              onClick={() => {
                setLanguage(code);
                setTextIndex(0);
              }}
            >
              {label}
            </button>
          ))}
        </fieldset>
        <div className="voice-new-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="voice-new-primary"
            disabled={!name.trim()}
          >
            Next
          </button>
        </div>
      </form>
    );

  if (step.name === "making")
    return (
      <div className="voice-new voice-new-making" aria-live="polite">
        <LoaderCircle size={32} className="is-spinning" />
        <p>Making {name.trim()}'s voice...</p>
        <p className="voice-settings-note">It takes a few seconds.</p>
      </div>
    );

  if (step.name === "done") {
    const { voice, heard, transcript, kind } = step.created;
    // Far from the text: better recorded again, reading it all.
    const different =
      kind !== "shown" &&
      (kind === "partial" || wordErrorRate(text, heard) > RERECORD_RATE);
    return (
      <div className="voice-new voice-new-done" aria-live="polite">
        <h3>{voice.name} is ready!</h3>
        {kind === "shown" ? null : (
          <p className="voice-settings-note">
            {kind === "partial"
              ? "Only the start of the text was read, so the voice learned from that part:"
              : "What was said was not the text, so the voice learned from what it heard:"}{" "}
            "{transcript}"
          </p>
        )}
        {different ? (
          <p className="voice-settings-note">
            It may sound better recorded again, reading the whole text.
          </p>
        ) : null}
        <div className="voice-new-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Back to the voices
          </button>
          {kind === "shown" ? null : (
            <button
              type="button"
              onClick={() =>
                void deleteVoice(voice.id)
                  .then(onCreated)
                  .then(() => {
                    setTake(null);
                    setStep({ name: "record" });
                  })
                  .catch((failure: Error) => setError(failure.message))
              }
            >
              <RotateCcw size={15} /> Record again
            </button>
          )}
          <button type="button" onClick={() => onHear(voice.id)}>
            {playing === voice.id ? <Square size={15} /> : <Play size={15} />}
            Hear {voice.name}
          </button>
          <button
            type="button"
            className="voice-new-primary"
            onClick={() =>
              void onUse(voice.id).catch((failure: Error) =>
                setError(failure.message),
              )
            }
          >
            <Check size={15} /> Read replies with {voice.name}
          </button>
        </div>
        {error ? (
          <p className="voice-settings-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const short = take !== null && take.seconds < MIN_RECORDING_SECONDS;
  const shownSeconds = recording ? seconds : (take?.seconds ?? 0);
  return (
    <div className="voice-new">
      <h3>
        {recording
          ? "Read this aloud, calmly"
          : take
            ? "Listen, then make the voice"
            : `Press the button, then read this aloud`}
      </h3>
      <blockquote className="voice-new-text" lang={language} aria-live="polite">
        {text}
      </blockquote>
      {texts.length > 1 && !recording ? (
        <button
          type="button"
          className="ghost voice-new-other"
          onClick={() => {
            setTextIndex((index) => index + 1);
            setTake(null);
          }}
        >
          <Shuffle size={14} /> Another text
        </button>
      ) : null}
      <div className="voice-new-recorder">
        <button
          type="button"
          className={`voice-new-record${recording ? " is-recording" : ""}`}
          aria-label={recording ? "Stop recording" : "Record"}
          style={{ "--voice-level": level } as CSSProperties}
          onClick={() => void (recording ? stopRecording() : record())}
        >
          {recording ? <Square size={28} /> : <Mic size={30} />}
        </button>
        <div className="voice-new-progress">
          <span className="voice-new-meter" aria-hidden="true">
            {METER_BARS.map((weight, index) => (
              <span
                key={index}
                style={
                  {
                    "--bar-weight": weight,
                    "--voice-level": level,
                  } as CSSProperties
                }
              />
            ))}
          </span>
          <span className="voice-new-time">
            {recording
              ? `${Math.max(0, Math.ceil(MAX_RECORDING_SECONDS - seconds))} s left`
              : `${Math.round(shownSeconds)} s`}
          </span>
          <span
            className="voice-new-bar"
            style={
              {
                "--done": Math.min(1, shownSeconds / MAX_RECORDING_SECONDS),
              } as CSSProperties
            }
          />
        </div>
      </div>
      {recording ? (
        <p className="voice-settings-note">
          Take your time: it stops by itself once you finish, or press stop.
        </p>
      ) : null}
      {take?.cut ? (
        <p className="voice-settings-note">
          The recording stopped while you were still reading: record again for
          the best voice.
        </p>
      ) : null}
      {short ? (
        <p className="voice-settings-note">
          A little short: record again and read the whole text.
        </p>
      ) : null}
      {error ? (
        <p className="voice-settings-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="voice-new-actions">
        <button
          type="button"
          className="ghost"
          onClick={() => {
            listening?.abort();
            setStep({ name: "setup" });
          }}
          disabled={recording !== null}
        >
          Back
        </button>
        {take ? (
          <>
            <button
              type="button"
              onClick={() => {
                if (listening) {
                  listening.abort();
                  setListening(null);
                  return;
                }
                const controller = new AbortController();
                setListening(controller);
                void playBlob(take.wav, controller.signal)
                  .catch(() => {})
                  .finally(() => setListening(null));
              }}
            >
              {listening ? <Square size={15} /> : <Play size={15} />}
              Listen
            </button>
            <button type="button" onClick={() => void record()}>
              <RotateCcw size={15} /> Again
            </button>
            <button
              type="button"
              className="voice-new-primary"
              disabled={short}
              onClick={() => void make()}
            >
              Make the voice
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
