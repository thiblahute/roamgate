import {
  SSH_NONINTERACTIVE_ARGS,
  sshReadCommandArgv,
  validateSshDestination,
} from "../bridge/ssh-command";
import { annotateSshArgv } from "../bridge/ssh-metrics";
import {
  HOLD_CLIENT_CHECKSUM,
  HOLD_CLIENT_INSTALLED_SCRIPT,
} from "../conversation/holder-script";
import { REVIEW_CLIENT_CHECKSUM } from "./agent-client";
import { REVIEW_SKILL } from "./agent-skill";
import {
  REVIEW_CLIENT_INSTALLED_SCRIPT,
  REVIEW_HOME_DIR,
} from "./agent-server";

type Run = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const SETUP_TIMEOUT_MS = 20_000;

/**
 * One command on the host: install the client unless this version is already
 * there, clear a stale socket left by an earlier connection (sshd does not
 * replace one by default), and print where the forward must go.
 */
export function remoteSetupScript(): string {
  const encoded = Buffer.from(REVIEW_CLIENT_INSTALLED_SCRIPT).toString(
    "base64",
  );
  return [
    "set -e",
    `d="$HOME/${REVIEW_HOME_DIR}"`,
    'mkdir -p "$d/bin"',
    'chmod 700 "$d"',
    'f="$d/bin/roamgate-review"',
    `if ! grep -q 'roamgate-review ${REVIEW_CLIENT_CHECKSUM}' "$f" 2>/dev/null; then`,
    `  python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.argv[1]))' '${encoded}' > "$f.tmp"`,
    '  chmod 755 "$f.tmp"',
    '  mv "$f.tmp" "$f"',
    "fi",
    // Conversation mode's pane holder, beside it.
    'h="$d/bin/roamgate-hold"',
    `if ! grep -q 'roamgate-hold ${HOLD_CLIENT_CHECKSUM}' "$h" 2>/dev/null; then`,
    `  python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.argv[1]))' '${Buffer.from(HOLD_CLIENT_INSTALLED_SCRIPT).toString("base64")}' > "$h.tmp"`,
    '  chmod 755 "$h.tmp"',
    '  mv "$h.tmp" "$h"',
    "fi",
    'mkdir -p "$d/skills/roamgate-review"',
    `python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode(sys.argv[1]))' '${Buffer.from(REVIEW_SKILL).toString("base64")}' > "$d/skills/roamgate-review/SKILL.md"`,
    // Linked where agents look, as on this machine: never over the user's.
    'link() { [ -d "${2%/*}" ] || return 0; if [ -L "$2" ]; then case "$(readlink "$2")" in "$1") return 0 ;; *.cache/roamgate/*) rm -f "$2" ;; *) return 0 ;; esac; elif [ -e "$2" ]; then return 0; fi; ln -s "$1" "$2" || true; }',
    'link "$d/skills/roamgate-review" "$HOME/.claude/skills/roamgate-review"',
    'link "$f" "$HOME/.local/bin/roamgate-review"',
    'rm -f "$d/review.sock"',
    'printf %s "$d/review.sock"',
  ].join("\n");
}

/** Adds the reverse socket forward to the running master, no new login. */
export function remoteForwardArgv(
  host: string,
  controlPath: string,
  remoteSocket: string,
  localSocket: string,
): string[] {
  return [
    "ssh",
    "-S",
    controlPath,
    ...SSH_NONINTERACTIVE_ARGS,
    "-O",
    "forward",
    "-R",
    `${remoteSocket}:${localSocket}`,
    "--",
    validateSshDestination(host),
  ];
}

/**
 * Makes `roamgate-review` work in the host's panes: installs the client and
 * forwards the host's well-known socket to this connection's agent socket.
 * Both ride the connection's SSH master. A host without python3 or one whose
 * sshd refuses socket forwards only loses the review client.
 */
export async function setupRemoteReviewAgent(args: {
  host: string;
  controlPath: string;
  localSocket: string;
  connectionId: string;
  run: Run;
}): Promise<{ remoteSocket: string }> {
  const setup = await args.run(
    annotateSshArgv(
      sshReadCommandArgv(args.host, remoteSetupScript(), [], "review.setup"),
      { connection: args.connectionId },
    ),
    SETUP_TIMEOUT_MS,
  );
  const remoteSocket = setup.stdout.trim();
  if (setup.code !== 0 || !remoteSocket.startsWith("/"))
    throw new Error(
      (setup.stderr || "review client setup failed").trim().slice(0, 300),
    );
  const forward = await args.run(
    annotateSshArgv(
      remoteForwardArgv(
        args.host,
        args.controlPath,
        remoteSocket,
        args.localSocket,
      ),
      { tag: "review.forward", connection: args.connectionId, master: true },
    ),
    SETUP_TIMEOUT_MS,
  );
  if (forward.code !== 0)
    throw new Error(
      (forward.stderr || "the host refused the review socket forward")
        .trim()
        .slice(0, 300),
    );
  return { remoteSocket };
}
