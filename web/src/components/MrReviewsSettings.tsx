import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ForgeProvider } from "../../../shared/forge";
import {
  DEFAULT_MR_HOME_PROMPT,
  type MrReviewsSettings,
} from "../../../shared/mrReviews";
import { MrMergeSettingsSection } from "./MrMergeSettings";
import {
  loadMrReviewsSettings,
  mrReviewsCall,
  saveMrReviewsSettings,
} from "../mrReviews";

/**
 * The reviews settings, in the panel as Ranger's are in its own: the
 * hosts (the signed-in ones unless listed), followed projects, when the
 * review worktree follows the selected request, how long a closed
 * request's state is kept, and the curation.
 */
export function MrReviewsSettingsView({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<MrReviewsSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [project, setProject] = useState("");
  const [host, setHost] = useState("");
  const [extraHost, setExtraHost] = useState("");
  const [extraProvider, setExtraProvider] = useState<ForgeProvider>("gitlab");

  useEffect(() => {
    loadMrReviewsSettings().then(
      (value) => {
        setSettings(value);
        setHost(value.hosts[0]?.host ?? value.discoveredHosts?.[0]?.host ?? "");
      },
      (cause) => setError(String(cause?.message ?? cause)),
    );
  }, []);

  if (!settings)
    return (
      <div className="assistant-panel-empty">
        {error ? (
          <span role="alert">{error}</span>
        ) : (
          <LoaderCircle className="assistant-spinner" size={24} />
        )}
      </div>
    );

  const knownHosts = settings.hosts.length
    ? settings.hosts
    : (settings.discoveredHosts ?? []);

  const save = async (change: Partial<MrReviewsSettings>) => {
    setBusy(true);
    setError(null);
    try {
      // The inbox's order is the list's to change: never an old copy of it.
      const saved = await saveMrReviewsSettings({
        ...settings,
        order: undefined,
        ...change,
      });
      setSettings({
        ...saved,
        discoveredHosts: settings.discoveredHosts ?? [],
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const addProject = () => {
    const path = project.trim().replace(/^\/+|\/+$/g, "");
    const forge = knownHosts.find((entry) => entry.host === host);
    if (!path || !forge) return;
    void save({
      followed: [
        ...settings.followed,
        { host: forge.host, provider: forge.provider, project: path },
      ],
    }).then(() => setProject(""));
  };

  return (
    <div className="assistant-tasks mr-reviews-settings">
      {error ? (
        <div className="assistant-task-error" role="alert">
          {error}
        </div>
      ) : null}
      <section className="assistant-task-overview">
        <h3 className="mr-reviews-section-title">Forge hosts</h3>
        <p className="assistant-hint">
          {settings.hosts.length
            ? "Only these hosts are read."
            : "The hosts glab and gh are signed in to on this machine."}
        </p>
        <ul className="mr-reviews-settings-list">
          {knownHosts.map((entry) => (
            <li key={entry.host}>
              <span>
                {entry.host} <small>{entry.provider}</small>
              </span>
              {settings.hosts.length ? (
                <button
                  type="button"
                  className="ghost"
                  aria-label={`Stop reading ${entry.host}`}
                  disabled={busy}
                  onClick={() =>
                    void save({
                      hosts: settings.hosts.filter(
                        (other) => other.host !== entry.host,
                      ),
                    })
                  }
                >
                  <Trash2 size={13} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="mr-reviews-settings-add">
          <input
            aria-label="Host to read"
            placeholder="gitlab.example.org"
            value={extraHost}
            onChange={(event) => setExtraHost(event.target.value)}
          />
          <select
            aria-label="Forge"
            value={extraProvider}
            onChange={(event) =>
              setExtraProvider(event.target.value as ForgeProvider)
            }
          >
            <option value="gitlab">GitLab</option>
            <option value="github">GitHub</option>
          </select>
          <button
            type="button"
            className="ghost"
            disabled={busy || !extraHost.trim()}
            onClick={() =>
              void save({
                hosts: [
                  ...knownHosts,
                  {
                    host: extraHost.trim().toLowerCase(),
                    provider: extraProvider,
                  },
                ],
              }).then(() => setExtraHost(""))
            }
          >
            <Plus size={13} /> Add host
          </button>
        </div>
      </section>
      <section className="assistant-task-overview">
        <h3 className="mr-reviews-section-title">Followed projects</h3>
        <p className="assistant-hint">
          Their open requests are the candidates Claude picks suggestions from.
        </p>
        {settings.followed.length ? (
          <ul className="mr-reviews-settings-list">
            {settings.followed.map((entry) => (
              <li key={`${entry.host}/${entry.project}`}>
                <span>
                  {entry.project} <small>{entry.host}</small>
                </span>
                <input
                  aria-label={`Workspaces group of ${entry.project}'s reviews`}
                  title="Where its review workspace goes in the Workspaces tree: names separated by >, matched case-insensitively and made when missing. Empty: a Reviews group under the clone's workspace."
                  placeholder="Reviews"
                  defaultValue={(
                    settings.treeGroups[
                      `${entry.host}/${entry.project}`.toLowerCase()
                    ] ?? []
                  ).join(" > ")}
                  disabled={busy}
                  onBlur={(event) => {
                    const key = `${entry.host}/${entry.project}`.toLowerCase();
                    const path = event.target.value
                      .split(">")
                      .map((part) => part.trim())
                      .filter(Boolean);
                    const current = settings.treeGroups[key] ?? [];
                    if (path.join(">") === current.join(">")) return;
                    const treeGroups = { ...settings.treeGroups };
                    if (path.length) treeGroups[key] = path;
                    else delete treeGroups[key];
                    void save({ treeGroups });
                  }}
                />
                <button
                  type="button"
                  className="ghost"
                  aria-label={`Unfollow ${entry.project}`}
                  disabled={busy}
                  onClick={() =>
                    void save({
                      followed: settings.followed.filter(
                        (other) =>
                          other.host !== entry.host ||
                          other.project !== entry.project,
                      ),
                    })
                  }
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="assistant-hint">None yet.</p>
        )}
        <div className="mr-reviews-settings-add">
          <select
            aria-label="Project host"
            value={host}
            onChange={(event) => setHost(event.target.value)}
          >
            {knownHosts.map((entry) => (
              <option key={entry.host} value={entry.host}>
                {entry.host}
              </option>
            ))}
          </select>
          <input
            aria-label="Project path"
            placeholder="group/project"
            value={project}
            onChange={(event) => setProject(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addProject();
              }
            }}
          />
          <button
            type="button"
            className="ghost"
            disabled={busy || !project.trim() || !host}
            onClick={addProject}
          >
            <Plus size={13} /> Follow
          </button>
        </div>
      </section>
      <section className="assistant-task-overview">
        <h3 className="mr-reviews-section-title">Clones</h3>
        <p className="assistant-hint">
          A project's clone is looked for on the default connection first, then
          on the others; with none, Reviews asks. Its review worktree and
          workspace go next to it.
        </p>
        {Object.keys(settings.clones).length ? (
          <ul className="mr-reviews-settings-list">
            {Object.entries(settings.clones).map(([project, clone]) => (
              <li key={project}>
                <span>
                  {project}{" "}
                  <small>
                    {clone.connectionId}: {clone.path}
                  </small>
                </span>
                <button
                  type="button"
                  className="ghost"
                  aria-label={`Forget the clone picked for ${project}`}
                  disabled={busy}
                  onClick={() => {
                    const clones = { ...settings.clones };
                    delete clones[project];
                    void save({ clones });
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="assistant-hint">No clone picked by hand.</p>
        )}
        {settings.reviewWorktrees?.length ? (
          <>
            <p className="assistant-hint">Review worktrees:</p>
            <ul className="mr-reviews-settings-list">
              {settings.reviewWorktrees.map((entry) => (
                <li key={entry.project}>
                  <span>
                    {entry.project}{" "}
                    <small>
                      {entry.connectionId}: {entry.path}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="ghost"
                    title="Its next review makes a new review worktree (on the default connection first). This one and its workspace stay: remove them yourself."
                    disabled={busy}
                    onClick={() =>
                      void mrReviewsCall("forget_worktree", {
                        project: entry.project,
                      }).then(
                        () =>
                          setSettings({
                            ...settings,
                            reviewWorktrees: (
                              settings.reviewWorktrees ?? []
                            ).filter((each) => each.project !== entry.project),
                          }),
                        (cause) =>
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : String(cause),
                          ),
                      )
                    }
                  >
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
      <section className="assistant-task-overview">
        <h3 className="mr-reviews-section-title">Review worktree</h3>
        <label className="form-field">
          <span>The checkout follows the selected request</span>
          <select
            value={settings.checkout}
            disabled={busy}
            onChange={(event) =>
              void save({
                checkout: event.target.value as MrReviewsSettings["checkout"],
              })
            }
          >
            <option value="immediately">Immediately</option>
            <option value="on_demand">
              When browsing files or asking Claude
            </option>
          </select>
        </label>
        <label className="form-field">
          <span>Forget a request's review this many days after it closes</span>
          <input
            type="number"
            min={0}
            max={365}
            value={settings.retentionDays}
            disabled={busy}
            onChange={(event) => {
              const days = Number(event.target.value);
              if (Number.isInteger(days) && days >= 0 && days <= 365)
                void save({ retentionDays: days });
            }}
          />
        </label>
      </section>
      <section className="assistant-task-overview">
        <h3 className="mr-reviews-section-title">Review homes</h3>
        <label className="form-field">
          <span>
            What a request's home agent is told first (Start a review with a
            home): {"{url} {ref} {title} {author} {target} {source} {project}"}{" "}
            take the request's; empty, the default
          </span>
          <textarea
            rows={5}
            aria-label="Home prompt"
            placeholder={DEFAULT_MR_HOME_PROMPT}
            defaultValue={settings.homePrompt ?? ""}
            disabled={busy}
            onBlur={(event) => {
              if (event.target.value !== (settings.homePrompt ?? ""))
                void save({ homePrompt: event.target.value });
            }}
          />
        </label>
      </section>
      <section className="assistant-task-overview">
        <h3 className="mr-reviews-section-title">Suggestions</h3>
        <label className="mr-reviews-settings-check">
          <input
            type="checkbox"
            checked={settings.curation}
            disabled={busy}
            onChange={(event) => void save({ curation: event.target.checked })}
          />
          Claude picks suggestions from the followed projects (it only filters;
          it never reviews on its own)
        </label>
        <label className="form-field">
          <span>
            Suggest requests updated within this many days (older ones once they
            change)
          </span>
          <input
            type="number"
            min={1}
            max={365}
            value={settings.suggestDays}
            disabled={busy}
            onChange={(event) => {
              const days = Number(event.target.value);
              if (Number.isInteger(days) && days >= 1 && days <= 365)
                void save({ suggestDays: days });
            }}
          />
        </label>
        <label className="form-field">
          <span>
            Hints for the picks (areas you maintain, people you work with)
          </span>
          <textarea
            rows={3}
            defaultValue={settings.hints}
            disabled={busy}
            onBlur={(event) => {
              if (event.target.value !== settings.hints)
                void save({ hints: event.target.value });
            }}
          />
        </label>
      </section>
      <section className="assistant-task-overview">
        <h3 className="mr-reviews-section-title">Your own work</h3>
        <label className="mr-reviews-settings-check">
          <input
            type="checkbox"
            checked={settings.inference}
            disabled={busy}
            onChange={(event) => void save({ inference: event.target.checked })}
          />
          Claude infers whose move it is and the next step of your requests and
          branches, from their threads and status (what you set by hand wins)
        </label>
        <label className="form-field">
          <span>
            Read again what moved every this many hours (and at once, one
            request, when someone else answers, a pipeline fails, changes are
            requested, it conflicts or is merged)
          </span>
          <input
            type="number"
            min={1}
            max={168}
            value={settings.inferenceHours}
            disabled={busy}
            onChange={(event) => {
              const hours = Number(event.target.value);
              if (Number.isInteger(hours) && hours >= 1 && hours <= 168)
                void save({ inferenceHours: hours });
            }}
          />
        </label>
      </section>
      <MrMergeSettingsSection
        merge={settings.merge ?? { scopes: {} }}
        busy={busy}
        onSave={(merge) => void save({ merge })}
      />
      <MrReviewsBackup onImported={onSaved} />
    </div>
  );
}

type ImportChange = {
  path: string;
  kind: "added" | "removed" | "changed";
  newerLocal?: boolean;
};

/**
 * Export and import of what the Reviews authored (the order, overrides,
 * views, efforts and their ledgers): a file to keep or carry; an import
 * says what it would change and applies only once confirmed.
 */
export function MrReviewsBackup({ onImported }: { onImported: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    name: string;
    text: string;
    changes: ImportChange[];
  } | null>(null);
  const exportNow = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { text } = await mrReviewsCall<{ text: string }>("export", {});
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `roamgate-reviews-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMessage("Exported");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const preview = async (file: File) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await file.text();
      const answer = await mrReviewsCall<{ changes: ImportChange[] }>(
        "import",
        { text },
      );
      setPending({ name: file.name, text, changes: answer.changes });
    } catch (cause) {
      setPending(null);
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await mrReviewsCall("import", { text: pending.text, apply: true });
      setMessage(`Imported ${pending.changes.length} changes`);
      setPending(null);
      onImported();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const newer = pending?.changes.filter((change) => change.newerLocal).length;
  return (
    <section className="assistant-task-overview" aria-label="Export and import">
      <h3 className="mr-reviews-section-title">Export and import</h3>
      <p className="assistant-hint">
        What you and your agents authored here: the order, pins, removals, what
        was set by hand, saved views, requests not proposed yet, groups headed
        upstream and efforts with their ledgers. Never secrets, nothing read
        from the forges. Also <code>roamgate reviews export</code> and{" "}
        <code>roamgate reviews import</code>.
      </p>
      <div className="assistant-task-buttons">
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void exportNow()}
        >
          Export
        </button>
        <label className="ghost mr-reviews-import">
          Import...
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Import a Reviews export"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void preview(file);
            }}
          />
        </label>
      </div>
      {pending ? (
        <div className="mr-reviews-import-preview" role="status">
          <p>
            {pending.name}:{" "}
            {pending.changes.length
              ? `${pending.changes.length} change${pending.changes.length === 1 ? "" : "s"}`
              : "nothing would change"}
            {newer ? `, ${newer} where yours is newer` : ""}
          </p>
          <ul>
            {pending.changes.slice(0, 200).map((change) => (
              <li
                key={`${change.kind}:${change.path}`}
                className={`is-${change.kind}${change.newerLocal ? " is-newer" : ""}`}
              >
                {change.kind === "added"
                  ? "+"
                  : change.kind === "removed"
                    ? "-"
                    : "~"}{" "}
                <code>{change.path}</code>
                {change.newerLocal ? <small> yours is newer</small> : null}
              </li>
            ))}
            {pending.changes.length > 200 ? (
              <li>and {pending.changes.length - 200} more</li>
            ) : null}
          </ul>
          <div className="assistant-task-buttons">
            <button
              type="button"
              className="primary"
              disabled={busy || !pending.changes.length}
              onClick={() => void apply()}
            >
              Apply
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {message ? <p className="assistant-hint">{message}</p> : null}
    </section>
  );
}
