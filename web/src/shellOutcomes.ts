import type { AgentChatShell } from "../../shared/agentChat";
import type { HistoryEntry } from "./components/agentHistory";

/**
 * The transcript's `!` lines with the connection they ran on and, for
 * those run from this chat, how they ended: the transcript keeps no exit
 * code, the browser keeps the last runs it sent. Matched newest first, by
 * command; the same array when there is nothing to add.
 */
export function withShellOutcomes(
  entries: HistoryEntry[],
  sent: AgentChatShell[],
  host: string | undefined,
): HistoryEntry[] {
  if (!host && !sent.length) return entries;
  if (!entries.some((entry) => entry.shell)) return entries;
  const unused = [...sent];
  const out = [...entries];
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const entry = out[index]!;
    if (!entry.shell) continue;
    const command = entry.shell.command.trim();
    let at = -1;
    for (let each = unused.length - 1; each >= 0; each -= 1)
      if (unused[each]!.command.trim() === command) {
        at = each;
        break;
      }
    const run = at >= 0 ? unused.splice(at, 1)[0] : undefined;
    out[index] = {
      ...entry,
      shell: {
        ...entry.shell,
        ...(host ? { host } : {}),
        ...(run
          ? {
              status: run.status,
              exit_code: run.exit_code,
              started_at: run.started_at,
              ...(run.finished_at ? { finished_at: run.finished_at } : {}),
              ...(!entry.shell.cwd && run.cwd ? { cwd: run.cwd } : {}),
            }
          : {}),
      },
    };
  }
  return out;
}
