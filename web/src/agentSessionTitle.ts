import { useEffect, useState } from "react";
import type { Pane } from "./types";
import { useConnectionClient } from "./useConnectionClient";

/** The title can change as the session goes on: read it again this often. */
const REFRESH_MS = 30_000;

/**
 * What a Claude pane's session is about: the name given with /rename, else
 * the title Claude Code wrote for it (session-title.ts); null without one.
 */
export function useAgentSessionTitle(
  pane: Pane,
  enabled: boolean,
): string | null {
  const client = useConnectionClient();
  const [title, setTitle] = useState<string | null>(null);
  const claude = enabled && pane.agent === "claude";
  useEffect(() => {
    setTitle(null);
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
    claude,
    pane.agent,
    pane.pane_id,
    pane.tab_id,
    pane.workspace_id,
  ]);
  return claude ? title : null;
}
