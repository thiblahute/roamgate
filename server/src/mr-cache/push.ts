import type {
  ForgeSession,
  ForgeStatus,
  MrCachePush,
} from "../../../shared/forge";
import type { PullRequestStatus } from "../../../shared/pullRequest";
import type { MrCacheChange } from "./cache";

/**
 * The push for a change, null for what no client shows. The checkout's
 * host stays on the server; a client compares what the answer itself says
 * (the request, or the checkout's root and branch).
 */
export function mrCachePush(change: MrCacheChange): MrCachePush | null {
  const kind = change.key.split("\0", 1)[0];
  const value = change.value as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  if (kind === "chip")
    return { kind: "status", status: value as unknown as ForgeStatus };
  if (kind === "card")
    return {
      kind: "card",
      status: value as unknown as PullRequestStatus,
      fetchedAt: new Date(change.fetchedAt).toISOString(),
    };
  if (kind === "session")
    return { kind: "session", session: value as unknown as ForgeSession };
  return null;
}
