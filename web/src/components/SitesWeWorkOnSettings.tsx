import { useEffect, useState } from "react";
import { normalizeSite } from "../../../shared/renderedPage";
import {
  loadSiteRoots,
  loadSitesWeWorkOn,
  saveSiteRoots,
  saveSitesWeWorkOn,
} from "../sitesWeWorkOn";
import "./SitesWeWorkOnSettings.css";

/**
 * Settings, Instance: the sites (URL prefixes) and directories whose pages
 * a rendered review shows with their scripts on. Anything else is shown
 * static, its scripts blocked. Each may have a root, where its pages'
 * root-absolute links start (else found from them, for a directory).
 */
export function SitesWeWorkOnSettings({
  load = loadSitesWeWorkOn,
  save = saveSitesWeWorkOn,
  loadRoots = loadSiteRoots,
  saveRoots = saveSiteRoots,
}: {
  load?: () => Promise<string[]>;
  save?: (sites: string[]) => Promise<string[]>;
  loadRoots?: () => Promise<Record<string, string>>;
  saveRoots?: (
    roots: Record<string, string>,
  ) => Promise<Record<string, string>>;
}) {
  const [sites, setSites] = useState<string[] | null>(null);
  const [roots, setRoots] = useState<Record<string, string>>({});
  const [rootDrafts, setRootDrafts] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    load().then(
      (list) => live && setSites(list),
      (cause: Error) => live && setError(cause.message),
    );
    loadRoots().then(
      (found) => live && setRoots(found),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [load, loadRoots]);

  const without = (map: Record<string, string>, key: string) => {
    const rest = { ...map };
    delete rest[key];
    return rest;
  };

  /** Keeps the root typed for `site`: empty clears it. */
  const storeRoot = async (site: string) => {
    const draft = rootDrafts[site];
    if (draft === undefined) return;
    const typed = draft.trim();
    const root = typed ? normalizeSite(typed) : null;
    if (typed && (!root || !site.startsWith(root))) {
      setError(`The root of ${site} is a directory or site that contains it.`);
      return;
    }
    if ((roots[site] ?? "") === (root ?? "")) {
      setRootDrafts((drafts) => without(drafts, site));
      return;
    }
    const others = without(roots, site);
    setBusy(true);
    setError("");
    try {
      setRoots(await saveRoots(root ? { ...others, [site]: root } : others));
      setRootDrafts((drafts) => without(drafts, site));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const store = async (next: string[]) => {
    setBusy(true);
    setError("");
    try {
      setSites(await save(next));
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const normalized = draft.trim() ? normalizeSite(draft) : null;
  const invalid = draft.trim() !== "" && normalized === null;

  return (
    <div className="sites-settings">
      <h3>Rendered pages: sites we work on</h3>
      <p className="sites-settings-hint">
        Pages of a rendered review (an HTML file, or a site an agent or you
        open) are shown static: their scripts are blocked and they reach nothing
        but their own files. Pages under these sites or directories run their
        scripts and forms, still in a sandbox with no access to Roamgate, its
        cookies or its connection. An agent cannot add to this list. A
        directory&apos;s root-absolute links (/docs/x.html) start where they are
        found above it, or at the Root you give.
      </p>
      {sites === null && !error ? (
        <p className="sites-settings-hint">Loading...</p>
      ) : null}
      {sites?.length === 0 ? (
        <p className="sites-settings-hint">None: every page is static.</p>
      ) : null}
      {sites?.length ? (
        <ul className="sites-settings-list">
          {sites.map((site) => (
            <li key={site}>
              <div className="sites-settings-entry">
                <code>{site}</code>
                <label className="sites-settings-root">
                  Root
                  <input
                    type="text"
                    value={rootDrafts[site] ?? roots[site] ?? ""}
                    placeholder="found from its links"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={busy}
                    aria-label={`Root of ${site}`}
                    title="Where its pages' root-absolute links (/docs/x.html) start: a directory or site containing it"
                    onChange={(event) => {
                      const value = event.target.value;
                      setRootDrafts((drafts) => ({ ...drafts, [site]: value }));
                      setError("");
                    }}
                    onBlur={() => void storeRoot(site)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void storeRoot(site);
                      }
                    }}
                  />
                </label>
              </div>
              <button
                type="button"
                disabled={busy}
                aria-label={`Remove ${site}`}
                onClick={() =>
                  void store(sites.filter((other) => other !== site))
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!normalized || !sites) return;
          void store([...sites, normalized]).then((ok) => {
            if (ok) setDraft("");
          });
        }}
      >
        <label htmlFor="sites-settings-new">Add a site or directory</label>
        <div className="sites-settings-add">
          <input
            id="sites-settings-new"
            type="text"
            value={draft}
            placeholder="http://localhost:8080/ or /home/me/docs/"
            spellCheck={false}
            autoComplete="off"
            disabled={busy || sites === null}
            aria-invalid={invalid}
            onChange={(event) => {
              setDraft(event.target.value);
              setError("");
            }}
          />
          <button
            type="submit"
            disabled={busy || sites === null || !normalized}
          >
            Add
          </button>
        </div>
        {invalid ? (
          <p className="sites-settings-error" role="alert">
            An http(s) URL or an absolute directory.
          </p>
        ) : normalized && normalized !== draft.trim() ? (
          <p className="sites-settings-hint">Adds {normalized}</p>
        ) : null}
      </form>
      {error ? (
        <p className="sites-settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
