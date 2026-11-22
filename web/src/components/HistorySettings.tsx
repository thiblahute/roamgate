import { History } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import type { HistoryStatus } from "../../../shared/history";
import { formatBytes } from "../../../shared/voiceSetup";
import { commitHistory, fetchHistory, setHistory } from "../history";
import "./HistorySettings.css";

const POLL_MS = 15_000;

/** "3 min ago", from an ISO time. */
export function sinceText(at: string, now = Date.now()): string {
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return at;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return new Date(at).toLocaleString();
}

/**
 * Settings' "History and backup": the local history's status (last
 * commit, size, files by area, what was kept out or failed), where it is,
 * whether it is written, and a commit now.
 */
export function HistorySettings({
  load = fetchHistory,
}: {
  load?: () => Promise<HistoryStatus>;
}) {
  const id = useId();
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await load());
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (run: () => Promise<HistoryStatus>) => {
    setBusy(true);
    try {
      setStatus(await run());
      setError(null);
      setDraft(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const location = draft ?? status?.location ?? "";
  const areas = status
    ? Object.entries(status.files)
        .filter(([name]) => name !== "FORMAT" && name !== "README.md")
        .sort(([a], [b]) => a.localeCompare(b))
    : [];
  return (
    <section className="history-settings" aria-labelledby={`${id}-title`}>
      <div className="history-settings-head">
        <History size={18} aria-hidden="true" />
        <span>
          <strong id={`${id}-title`}>History and backup</strong>
          <span>
            A git repository of what you and your agents wrote: the Work board,
            reviews, settings without secrets, and more
          </span>
        </span>
      </div>
      {error ? (
        <p className="history-settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {status ? (
        <>
          <label className="history-settings-switch">
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={busy}
              onChange={(event) =>
                void act(() => setHistory({ enabled: event.target.checked }))
              }
            />
            Keep a local history
          </label>
          <dl className="history-settings-facts" role="status">
            <dt>Last commit</dt>
            <dd>
              {status.lastCommit ? (
                <>
                  {sinceText(status.lastCommit.at)}:{" "}
                  <span title={status.lastCommit.sha}>
                    {status.lastCommit.subject}
                  </span>
                </>
              ) : status.exists ? (
                "none yet"
              ) : (
                "no repository yet: it is made on the next change"
              )}
            </dd>
            {status.exists ? (
              <>
                <dt>Size</dt>
                <dd>
                  {formatBytes(status.sizeBytes)}, {status.commits} commit
                  {status.commits === 1 ? "" : "s"}
                </dd>
              </>
            ) : null}
            {areas.length ? (
              <>
                <dt>Files</dt>
                <dd>{areas.map(([name, n]) => `${name} ${n}`).join(", ")}</dd>
              </>
            ) : null}
            {status.running || status.pending.length ? (
              <>
                <dt>Waiting</dt>
                <dd>
                  {status.running
                    ? "committing now"
                    : `${status.pending.join(", ")}: committed 30 s after the last change`}
                </dd>
              </>
            ) : null}
            {status.deferred ? (
              <>
                <dt>Deferred</dt>
                <dd>{status.deferred}</dd>
              </>
            ) : null}
          </dl>
          {status.blocked.length ? (
            <div className="history-settings-problems" role="alert">
              <strong>Kept out of the history: a secret was found</strong>
              <ul>
                {status.blocked.map((hit) => (
                  <li key={`${hit.file}:${hit.line}`}>
                    <code>
                      {hit.file}:{hit.line}
                    </code>{" "}
                    ({hit.kind}). Remove it where it was written; the file is
                    committed once it is gone.
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {status.errors.length ? (
            <div className="history-settings-problems" role="alert">
              <strong>Not written in the last pass</strong>
              <ul>
                {status.errors.map((each) => (
                  <li key={`${each.area ?? ""}:${each.message}`}>
                    {each.area ? `${each.area}: ` : ""}
                    {each.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <form
            className="history-settings-location"
            onSubmit={(event) => {
              event.preventDefault();
              void act(() => setHistory({ location }));
            }}
          >
            <label htmlFor={`${id}-location`}>Location</label>
            <input
              id={`${id}-location`}
              type="text"
              value={location}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="history-settings-actions">
              <button
                type="submit"
                disabled={busy || draft === null || draft === status.location}
              >
                Save
              </button>
              <button
                type="button"
                disabled={busy || status.location === status.defaultLocation}
                onClick={() => void act(() => setHistory({ location: null }))}
              >
                Use the default
              </button>
              <button
                type="button"
                disabled={busy || !status.enabled}
                onClick={() => void act(commitHistory)}
              >
                Commit now
              </button>
            </div>
            <p className="history-settings-note">
              A new location starts a repository there; the old one stays where
              it is. The default is {status.defaultLocation}.
            </p>
          </form>
          <p className="history-settings-note">
            Nothing leaves this machine: the history does not survive the loss
            of this disk. Pushing it to a remote and backing it up are coming as
            their own settings.
          </p>
        </>
      ) : null}
    </section>
  );
}
