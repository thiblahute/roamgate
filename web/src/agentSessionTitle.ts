import { useEffect, useState } from "react";
import type { Pane } from "./types";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "./useConnectionClient";

/** The title can change as the session goes on: read it again this often. */
const REFRESH_MS = 30_000;

// The titles last read, by connection and pane.
const knownTitles = new Map<string, string | null>();

/**
 * What a Claude pane's session is about: the name given with /rename, else
 * the title Claude Code wrote for it (session-title.ts); null without one.
 */
export function useAgentSessionTitle(
  pane: Pane,
  enabled: boolean,
): string | null {
  const client = useConnectionClient();
  const key = connectionClientScopeKey(client, pane.pane_id);
  const [title, setTitle] = useState<string | null>(
    () => knownTitles.get(key) ?? null,
  );
  const claude = enabled && pane.agent === "claude";
  useEffect(() => {
    // The title a pane had last shows at once; the read corrects it.
    setTitle(knownTitles.get(key) ?? null);
    if (!claude) return;
    let live = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const result = (await client.call("agent_session.get", {
          pane_id: pane.pane_id,
          workspace_id: pane.workspace_id,
          tab_id: pane.tab_id,
          agent: pane.agent,
        })) as { title?: string | null };
        knownTitles.set(key, result.title ?? null);
        if (live) setTitle(result.title ?? null);
      } catch {
        // Not readable now: no title shows.
      }
      if (live) timer = window.setTimeout(load, REFRESH_MS);
    };
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [
    client,
    key,
    claude,
    pane.agent,
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
  ]);
  return claude ? title : null;
}
