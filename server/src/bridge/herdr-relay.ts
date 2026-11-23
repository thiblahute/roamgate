/**
 * The relay an SSH tunnel runs on the host in front of Herdr's control
 * socket.
 *
 * Herdr reads a control connection's request without blocking and, when
 * nothing has arrived yet, sleeps 100 ms before it looks again. A local
 * client writes right after it connects, so its request is there at once;
 * through an ssh `-L` forward it never is: sshd connects to the socket when
 * the channel opens, and the request follows a round trip later, so every
 * call waited the full 100 ms. The relay listens on a socket of its own,
 * reads the request line first and only then connects to Herdr and writes
 * it, so Herdr finds it on its first read. The rest of the connection
 * (streamed answers, subscriptions) is copied both ways as it comes.
 *
 * It runs as the tunnel's remote command, prints {@link HERDR_RELAY_READY}
 * once it listens, and exits, removing its socket, when the tunnel's session
 * ends (its stdin closes). Sockets of relays that died without cleaning up
 * are removed by the next one.
 */

/** The line the relay prints once its socket listens. */
export const HERDR_RELAY_READY = "roamgate-herdr-relay ready";

/** Socket file names of relays, in the host's Roamgate cache directory. */
export const HERDR_RELAY_SOCKET_PREFIX = "herdr-relay-";

/** Where relays listen, under the host's HOME. */
export const HERDR_RELAY_DIRECTORY = ".cache/roamgate";

// Unix socket paths are limited to 104 bytes on macOS, 108 on Linux.
const MAX_SOCKET_PATH_BYTES = 100;

// Python 3.6 or newer, as macOS and Linux hosts ship it. Written without
// single quotes or backslashes, so it quotes alike in sh, bash, zsh and fish
// (fish reads \\ and \' as escapes inside single quotes).
export const HERDR_RELAY_SCRIPT = `
import os, socket, sys, threading, time
herdr, path = sys.argv[1], sys.argv[2]
NL = bytes([10])
directory = os.path.dirname(path)
os.makedirs(directory, mode=0o700, exist_ok=True)
def stale(other):
    probe = socket.socket(socket.AF_UNIX)
    try:
        probe.connect(other)
        return False
    except ConnectionRefusedError:
        return True
    except OSError:
        return False
    finally:
        probe.close()
for name in os.listdir(directory):
    other = os.path.join(directory, name)
    if name.startswith("${HERDR_RELAY_SOCKET_PREFIX}") and name.endswith(".sock") and other != path and stale(other):
        try:
            os.unlink(other)
        except OSError:
            pass
try:
    os.unlink(path)
except OSError:
    pass
mask = os.umask(0o177)
server = socket.socket(socket.AF_UNIX)
server.bind(path)
os.umask(mask)
server.listen(128)
def pump(source, target):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            target.sendall(data)
    except OSError:
        pass
    try:
        target.shutdown(socket.SHUT_WR)
    except OSError:
        pass
def serve(client):
    upstream = None
    try:
        request = b""
        while NL not in request and len(request) < 1048576:
            data = client.recv(65536)
            if not data:
                break
            request += data
        if request:
            upstream = socket.socket(socket.AF_UNIX)
            upstream.connect(herdr)
            upstream.sendall(request)
            back = threading.Thread(target=pump, args=(upstream, client))
            back.daemon = True
            back.start()
            pump(client, upstream)
            back.join()
    except OSError:
        pass
    finally:
        client.close()
        if upstream is not None:
            upstream.close()
def accept():
    while True:
        try:
            client, _ = server.accept()
        except OSError:
            time.sleep(0.05)
            continue
        worker = threading.Thread(target=serve, args=(client,))
        worker.daemon = True
        worker.start()
listener = threading.Thread(target=accept)
listener.daemon = True
listener.start()
sys.stdout.write("${HERDR_RELAY_READY}" + chr(10))
sys.stdout.flush()
try:
    while sys.stdin.buffer.read(65536):
        pass
finally:
    try:
        os.unlink(path)
    except OSError:
        pass
`;

/**
 * Single quotes as POSIX shells read them, with backslashes outside the
 * quotes, since fish reads \\ and \' inside single quotes as escapes.
 */
function anyShellQuote(value: string): string {
  return `'${value.replace(/['\\]/g, (c) => (c === "'" ? "'\\''" : "'\\\\'"))}'`;
}

export type HerdrRelay = {
  /** The relay's socket on the host: the tunnel's control forward target. */
  socket: string;
  /** The tunnel's remote command, run by the host's login shell. */
  command: string;
};

/**
 * The relay for one tunnel, or null when its socket path would be too long
 * for the host. `token` keeps two tunnels to the same host (two servers, a
 * reconnect while the old session lingers) apart.
 */
export function herdrRelay(args: {
  home: string;
  herdrSocket: string;
  token: string;
}): HerdrRelay | null {
  if (!/^[A-Za-z0-9]{1,32}$/.test(args.token)) {
    throw new Error("herdr relay token must be alphanumeric");
  }
  const socket = `${args.home.replace(/\/+$/, "")}/${HERDR_RELAY_DIRECTORY}/${HERDR_RELAY_SOCKET_PREFIX}${args.token}.sock`;
  if (
    !socket.startsWith("/") ||
    !args.herdrSocket.startsWith("/") ||
    Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES ||
    /[\0\n]/.test(socket + args.herdrSocket)
  ) {
    return null;
  }
  return {
    socket,
    command: `exec python3 -c ${anyShellQuote(HERDR_RELAY_SCRIPT)} ${anyShellQuote(args.herdrSocket)} ${anyShellQuote(socket)}`,
  };
}
