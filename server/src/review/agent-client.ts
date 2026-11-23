import { createHash } from "node:crypto";
import { ROAMGATE_REVIEW_PY } from "../assets";

/**
 * The agent-side client, installed by the bridge as
 * `~/.cache/roamgate/bin/roamgate-review` on the bridge's machine and on each
 * SSH host. Python 3 standard library only, so a host needs nothing beyond the
 * interpreter it almost always has. It speaks JSON over the unix socket the
 * bridge listens on (forwarded over the connection's SSH master on a remote
 * host).
 */
export const REVIEW_CLIENT_SCRIPT = ROAMGATE_REVIEW_PY;

export const REVIEW_CLIENT_CHECKSUM = createHash("sha256")
  .update(REVIEW_CLIENT_SCRIPT)
  .digest("hex")
  .slice(0, 16);
