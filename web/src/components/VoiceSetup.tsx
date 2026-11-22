import { Cpu, Download, LoaderCircle, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import {
  CUSTOM_MODEL,
  downloadBytesFor,
  formatBytes,
  NO_MODEL,
  requirementHolds,
  settleChoices,
  startingChoices,
  type VoiceChoices,
  type VoiceHardware,
  type VoiceSetupJob,
  type VoiceSetupState,
  type VoiceTier,
} from "../../../shared/voiceSetup";
import {
  cancelVoiceSetup,
  fetchVoiceSetup,
  removeUnusedVoiceModels,
  setupRunning,
  startVoiceSetup,
} from "../voiceSetup";
import "./VoiceSetup.css";

const POLL_MS = 1000;

function HardwareSummary({ hardware }: { hardware: VoiceHardware }) {
  return (
    <dl className="voice-setup-hardware">
      <dt>System</dt>
      <dd>
        {hardware.osName ?? hardware.platform} ({hardware.arch})
      </dd>
      <dt>CPU</dt>
      <dd>
        {hardware.cpu.model}, {hardware.cpu.cores} threads
      </dd>
      <dt>Memory</dt>
      <dd>{formatBytes(hardware.ramBytes)}</dd>
      <dt>GPU</dt>
      <dd>
        {hardware.gpus.length
          ? hardware.gpus
              .map(
                (gpu) =>
                  `${gpu.name}${gpu.vramBytes ? `, ${formatBytes(gpu.vramBytes)}${gpu.unifiedMemory ? " shared" : ""}` : ""}`,
              )
              .join("; ")
          : "None found"}
      </dd>
      <dt>Models run on</dt>
      <dd>
        {hardware.acceleration === "cpu"
          ? "the CPU"
          : `the GPU, with ${hardware.acceleration === "cuda" ? "CUDA" : "Metal"}`}
      </dd>
      {hardware.note ? (
        <dd className="voice-setup-note">{hardware.note}</dd>
      ) : null}
    </dl>
  );
}

function JobProgress({
  job,
  onCancel,
}: {
  job: VoiceSetupJob;
  onCancel: () => void;
}) {
  const percent = job.totalBytes
    ? Math.floor((job.doneBytes * 100) / job.totalBytes)
    : 100;
  const running = job.state === "downloading" || job.state === "writing";
  return (
    <div className="voice-setup-job" role="status">
      {running ? (
        <>
          <progress max={100} value={percent} aria-label="Download" />
          <p>
            {job.state === "writing"
              ? "Writing voice.json..."
              : `${percent}% of ${formatBytes(job.totalBytes)}${job.bytesPerSecond ? `, ${formatBytes(job.bytesPerSecond)}/s` : ""}`}
          </p>
          {job.current ? (
            <p className="voice-setup-note">{job.current}</p>
          ) : null}
          <button type="button" onClick={onCancel}>
            <X size={16} /> Stop
          </button>
        </>
      ) : job.state === "done" ? (
        <p>
          Done: voice.json uses the new models.{" "}
          {job.reload === "after-call"
            ? "The voice helper loads them once the call in progress ends."
            : "The next voice request loads them."}
        </p>
      ) : job.state === "cancelled" ? (
        <p>Stopped. Starting again resumes where the download stopped.</p>
      ) : (
        <p className="voice-setup-error">
          The setup failed: {job.error ?? "unknown error"}. Starting again
          resumes it.
        </p>
      )}
    </div>
  );
}

/**
 * Voice settings' "Set up voice": the hardware found, a tier and a model
 * for each part of the voice helper (with sizes and speed), then the
 * download's progress, and the models no longer used to remove.
 */
export function VoiceSetup() {
  const id = useId();
  const [state, setState] = useState<VoiceSetupState | null>(null);
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<VoiceChoices>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const next = await fetchVoiceSetup();
    setState(next);
    return next;
  }, []);

  useEffect(() => {
    let live = true;
    fetchVoiceSetup()
      .then((next) => {
        if (!live) return;
        setState(next);
        setChoices(startingChoices(next));
        if (setupRunning(next)) setOpen(true);
      })
      .catch((failure: Error) => live && setError(failure.message));
    return () => {
      live = false;
    };
  }, []);

  const running = setupRunning(state);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      load().catch((failure: Error) => setError(failure.message));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const act = async (action: () => Promise<VoiceSetupState>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await action());
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!state)
    return error ? (
      <p className="voice-setup-error" role="alert">
        {error}
      </p>
    ) : null;

  const configured = Object.keys(state.current).length > 0;
  const tierOf = (tier: VoiceTier) => setChoices(startingChoices(state, tier));
  const choose = (component: string, option: string) =>
    setChoices((previous) =>
      settleChoices(state.components, { ...previous, [component]: option }),
    );
  const download = downloadBytesFor(state, choices);
  const unusedBytes = state.unused.reduce(
    (sum, model) => sum + model.sizeBytes,
    0,
  );

  return (
    <section className="voice-setup" aria-labelledby={`${id}-title`}>
      <div className="voice-setup-head">
        <span>
          <strong id={`${id}-title`}>Voice models</strong>
          <span>
            {configured
              ? `${state.tier === "heavy" ? "Heavy" : "Light"} tier proposed for this machine`
              : "Voice chat has no models yet"}
          </span>
        </span>
        {open ? null : (
          <button type="button" onClick={() => setOpen(true)}>
            <Cpu size={16} /> {configured ? "Change models" : "Set up voice"}
          </button>
        )}
      </div>
      {error ? (
        <p className="voice-setup-error" role="alert">
          {error}
        </p>
      ) : null}
      {state.configError && !running ? (
        <p className="voice-setup-note">voice.json: {state.configError}</p>
      ) : null}
      {open ? (
        <>
          <HardwareSummary hardware={state.hardware} />
          {state.job ? (
            <JobProgress
              job={state.job}
              onCancel={() => void act(cancelVoiceSetup)}
            />
          ) : null}
          {running ? null : (
            <>
              <div className="voice-setup-tiers" role="group" aria-label="Tier">
                {(["heavy", "light"] as const).map((tier) => (
                  <button key={tier} type="button" onClick={() => tierOf(tier)}>
                    {tier === "heavy" ? "Heavy (GPU)" : "Light (CPU)"}
                    {state.tier === tier ? " - proposed" : ""}
                  </button>
                ))}
              </div>
              {state.components.map((component) => {
                if (!requirementHolds(component.requires, choices)) return null;
                const options = component.options.filter((option) =>
                  requirementHolds(option.requires, choices),
                );
                const chosen = choices[component.id] ?? "";
                const option = options.find((entry) => entry.id === chosen);
                return (
                  <div key={component.id} className="voice-setup-part">
                    <label htmlFor={`${id}-${component.id}`}>
                      {component.title}
                    </label>
                    <select
                      id={`${id}-${component.id}`}
                      value={chosen}
                      onChange={(event) =>
                        choose(component.id, event.target.value)
                      }
                    >
                      {options.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}, {formatBytes(entry.sizeBytes)}
                          {entry.installed ? " (downloaded)" : ""}
                          {state.recommended[state.tier][component.id] ===
                          entry.id
                            ? " - proposed"
                            : ""}
                        </option>
                      ))}
                      {component.optional ? (
                        <option value={NO_MODEL}>None</option>
                      ) : null}
                      {chosen === CUSTOM_MODEL ? (
                        <option value={CUSTOM_MODEL}>
                          As voice.json has it
                        </option>
                      ) : null}
                    </select>
                    <p className="voice-setup-note">
                      {option
                        ? `${option.description} ${option.runsOn === "gpu" ? "GPU" : option.runsOn === "cpu" ? "CPU" : "GPU or CPU"}: ${option.speed}.`
                        : component.description}
                    </p>
                  </div>
                );
              })}
              {state.helper.found ? null : (
                <p className="voice-setup-note">
                  The voice helper is not at {state.helper.path}: build it
                  (voice/helper/linux/build.sh on Linux, cargo build --release
                  in voice/helper on macOS) and install it there.
                </p>
              )}
              <p className="voice-setup-note">
                {download
                  ? `To download: ${formatBytes(download)} into ${state.modelsDir}`
                  : "Everything chosen is downloaded already."}
                {state.freeBytes !== undefined
                  ? `, ${formatBytes(state.freeBytes)} free.`
                  : "."}
              </p>
              <div className="voice-setup-actions">
                <button
                  type="button"
                  className="voice-setup-primary"
                  disabled={busy}
                  onClick={() => void act(() => startVoiceSetup(choices))}
                >
                  {busy ? (
                    <LoaderCircle size={16} className="is-spinning" />
                  ) : (
                    <Download size={16} />
                  )}{" "}
                  {download ? "Download and use" : "Use these models"}
                </button>
                <button type="button" onClick={() => setOpen(false)}>
                  Close
                </button>
              </div>
            </>
          )}
          {state.unused.length && !running ? (
            <div className="voice-setup-unused">
              <p>Not used any more: {formatBytes(unusedBytes)}</p>
              <ul>
                {state.unused.map((model) => (
                  <li key={model.path}>
                    {model.name}, {formatBytes(model.sizeBytes)}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => removeUnusedVoiceModels("all"))}
              >
                <Trash2 size={16} /> Remove them
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
