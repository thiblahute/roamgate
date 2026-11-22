import { Gamepad2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import type { LowGpuStatus } from "../../../shared/voiceLowGpu";
import { formatBytes } from "../../../shared/voiceSetup";
import { fetchLowGpu, setLowGpu, switchLowGpuNow } from "../voiceSetup";
import "./VoiceSetup.css";

const POLL_MS = 5000;

/** What the running helper has, against what the profile wants. */
export function lowGpuRunning(status: LowGpuStatus): string {
  const wanted = status.active ? "low-gpu" : "full";
  if (status.running === null)
    return status.active
      ? "The next call starts with the light models."
      : "The next call starts with the full models.";
  if (status.running === wanted)
    return status.running === "low-gpu"
      ? "The voice runs with the light models now."
      : "The voice runs with the full models now.";
  return status.pending
    ? `The call going on keeps the ${status.running === "full" ? "full" : "light"} models until it ends.`
    : "The voice switches models at the next request.";
}

/**
 * The low-GPU voice profile in the Voice settings: on or off from here,
 * who else holds it (a game's hook, GameMode), and the models it uses.
 */
export function VoiceLowGpu() {
  const id = useId();
  const [status, setStatus] = useState<LowGpuStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchLowGpu());
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const change = async (on: boolean | "now") => {
    setBusy(true);
    try {
      setStatus(await (on === "now" ? switchLowGpuNow() : setLowGpu(on)));
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!status && !error) return null;
  const others = status
    ? [
        ...status.holders.filter((holder) => holder !== "manual"),
        ...(status.gameMode ? ["GameMode"] : []),
      ]
    : [];
  return (
    <section
      className="voice-setup voice-low-gpu"
      aria-labelledby={`${id}-title`}
    >
      <div className="voice-setup-head">
        <Gamepad2 size={18} aria-hidden="true" />
        <span>
          <strong id={`${id}-title`}>Gaming: light voice models</strong>
          <span>Voice calls while a game or another job needs the GPU</span>
        </span>
      </div>
      {error ? (
        <p className="voice-setup-error" role="alert">
          {error}
        </p>
      ) : null}
      {status ? (
        <>
          <label className="voice-low-gpu-switch">
            <input
              type="checkbox"
              checked={status.active}
              disabled={busy}
              onChange={(event) => void change(event.target.checked)}
            />
            Low GPU: keep the GPU for a game or another job
          </label>
          {others.length ? (
            <p className="voice-setup-note">
              On for: {others.join(", ")}
              {status.holders.includes("manual") ? ", and here" : ""}. Turning
              it off here lets every holder go.
            </p>
          ) : null}
          <p className="voice-setup-note" role="status">
            {lowGpuRunning(status)}
            {status.pending ? (
              <>
                {" "}
                <button
                  type="button"
                  className="voice-low-gpu-now"
                  disabled={busy}
                  onClick={() => void change("now")}
                >
                  Switch now
                </button>
              </>
            ) : null}
          </p>
          {status.error ? (
            <p className="voice-setup-error">{status.error}</p>
          ) : (
            <p className="voice-setup-note">
              {status.models
                .filter((model) => model.runsOn !== "none")
                .map(
                  (model) =>
                    `${model.name} (${model.runsOn === "gpu" ? "GPU" : model.runsOn === "any" ? "CPU or GPU" : "CPU"})`,
                )
                .join(", ")}
              : about {formatBytes(status.gpuBytes)} of GPU memory. GameMode
              running as a call starts turns it on too.
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
