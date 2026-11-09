import { useCallback, useEffect, useMemo, useState } from "react";
import { listedDirectory, listedSite } from "../../shared/renderedPage";
import { roamgateLocalStorage } from "./browserStorage";
import { store } from "./store";
import { loadSitesWeWorkOn, saveSitesWeWorkOn } from "./sitesWeWorkOn";

/*
 * Whether what the Files preview shows runs its scripts, one rule for
 * every format: it is off unless the user turned it on for this file, or
 * listed its folder or site. Scripts always run in the sandbox frame.
 */

const KEY_PREFIX = "renderedScripts:";

function fileKey(connectionId: string, place: string) {
  return `${KEY_PREFIX}${connectionId}:${place}`;
}

export function useRenderedScripts(
  connectionId: string,
  place: string | undefined,
) {
  const [sites, setSites] = useState<string[]>([]);
  const [turnedOn, setTurnedOn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadSitesWeWorkOn().then(
      (list) => {
        if (!cancelled) setSites(list);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [place]);
  useEffect(() => {
    setTurnedOn(
      !!place &&
        roamgateLocalStorage.getItem(fileKey(connectionId, place)) === "1",
    );
  }, [connectionId, place]);
  const listed = useMemo(() => {
    if (!place) return null;
    return place.startsWith("/")
      ? listedDirectory(sites, place)
      : listedSite(sites, place);
  }, [sites, place]);
  const toggle = useCallback(() => {
    if (!place) return;
    setTurnedOn((current) => {
      const next = !current;
      const key = fileKey(connectionId, place);
      if (next) roamgateLocalStorage.setItem(key, "1");
      else roamgateLocalStorage.removeItem(key);
      return next;
    });
  }, [connectionId, place]);
  /** The folder of a file, or the whole site of a URL. */
  const alwaysEntry = useMemo(() => {
    if (!place) return null;
    if (place.startsWith("/"))
      return `${place.slice(0, place.lastIndexOf("/")) || ""}/`;
    try {
      return `${new URL(place).origin}/`;
    } catch {
      return null;
    }
  }, [place]);
  const always = useCallback(async () => {
    if (!alwaysEntry) return;
    try {
      const current = await loadSitesWeWorkOn();
      setSites(await saveSitesWeWorkOn([...current, alwaysEntry]));
      store.notify({
        kind: "success",
        message: "Scripts on from now on",
        detail: `${alwaysEntry} is in Sites we work on.`,
        autoDismissMs: 5000,
      });
    } catch (error) {
      store.notify({
        kind: "error",
        message: "Could not add it to Sites we work on",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }, [alwaysEntry]);
  return {
    on: !!listed || turnedOn,
    /** The list entry that turned scripts on, if any. */
    listed,
    /** Asked for on this file alone. */
    turnedOn,
    toggle,
    always,
    alwaysEntry,
  };
}
