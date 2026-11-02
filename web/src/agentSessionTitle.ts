import { useEffect, useState } from "react";
import type { Pane } from "./types";
import {
  connectionClientScopeKey,
  useConnectionClient,
} from "./useConnectionClient";
import { isPartialRead, PARTIAL_RETRY_MS } from "./partialRead";

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
      let partial = false;
      try {
        // A title: background work, behind what the user is doing.
        const result = (await client.call(
          "agent_session.get",
          {
            pane_id: pane.pane_id,
            workspace_id: pane.workspace_id,
            tab_id: pane.tab_id,
            agent: pane.agent,
          },
          undefined,
          { lane: "background" },
        )) as { title?: string | null; partial?: boolean };
        partial = isPartialRead(result);
        // Read from part of the session: a title known already stays.
        if (!partial || result.title || !knownTitles.has(key)) {
          knownTitles.set(key, result.title ?? null);
          if (live) setTitle(result.title ?? null);
        }
      } catch {
        // Not readable now: no title shows.
      }
      if (live)
        timer = window.setTimeout(
          load,
          partial ? PARTIAL_RETRY_MS : REFRESH_MS,
        );
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
