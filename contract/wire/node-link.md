# Node link

The link between a Roamgate server (the **home**) and `roamgate node
--stdio` on one of its SSH hosts (the **node**). An SSH profile opts in with
`"node": true` in `connections.json`; without it nothing here runs. The home
side is `roamgate_connections::node_host`, the node side
`crates/roamgate/src/node/stdio.rs`, their shared parts
`roamgate_sidecar::node`.

The link carries the core channel's frames and messages
([core-channel.md](core-channel.md), Frames and Messages): the same codec,
`hello`, `welcome`, `call` and `reply`, `http` with streamed bodies and their
window, `ping`, `pong` and `bye`. Only what differs is written here.

## Process

- The home starts the link once its SSH tunnel and command master are up, for
  each runtime generation of the profile: one long-lived ssh child,
  `ssh -S <master> ... -- <destination> 'exec ~/.local/share/roamgate-node/bin/roamgate node --stdio'`,
  held as a long-lived session of the destination (a share of the master,
  else a connection of its own).
- The node's stdin and stdout are the link. Its stderr goes to the home with
  ssh's, where the last 16 KiB say why a node that ended failed.
- The node writes the line `roamgate-node\n` on stdout before its first frame.
  The home discards what comes before it (a login shell's output), at most
  64 KiB; an end of the output before it is a failed start.
- The node exits when the link closes (stdin ends). It writes nothing global:
  no install, no Herdr lifecycle, no hooks, no pane environment, no log file.
  The home's `bye` ends it, then TERM and KILL of the ssh child 2 s apart.

## Handshake

The home says `hello` with an empty `token` (ssh authenticated the link),
`side: "rust"`, its version and `families: ["node"]`. The node answers
`welcome` with `side: "rust"` and

```json
{
  "t": "welcome",
  "protocol": 1,
  "side": "rust",
  "node": { "version": "0.8.15", "contract": 1 }
}
```

- `node.version`: the node's `roamgate` version, logged by the home.
- `node.contract`: the node link's contract version (`NODE_CONTRACT`), raised
  with any change of what follows. The home links only to a node of the same
  one.

## Fallback

A node that is missing (the ssh child exits, typically 127), fails to start,
gives no preamble or `welcome` within 8 s, says `refused`, has no `node` in its
`welcome` or another `contract` is not used for that runtime generation: the
home logs `node unavailable, using the SSH tunnel` once, with the reason, and
the profile works as one without `node` (Herdr through the tunnel, host
commands over the master). A link that was up and closes (the ssh child ended,
30 s of silence) is logged as `node link closed, using the SSH tunnel`; calls
go back to the tunnel at once and the home starts the link again after 1 s,
doubling up to 60 s while it fails.

Each time the link comes up or goes down, the home sets the host's agent
socket up again (as when the command master becomes ready): over the link
with `node.listen` while it is up, with the master's `ssh -O forward -R`
otherwise, or when `node.listen` fails.

## Calls

### `node.run`

A host command run whole on the node, as a local spawn: `/bin/sh -c
<command>` in the node's HOME, with the node's environment (the ssh login's).

| Params       |                                                            |
| ------------ | ---------------------------------------------------------- |
| `command`    | the command line, as the home would have sent it to ssh    |
| `stdin`      | optional: its whole input, base64                          |
| `timeout_ms` | optional: the process is killed past it and the call fails |

The result is `{"code": <exit code>, "stdout": <base64>, "stderr": <text>}`.
The home gives up `timeout_ms` plus 5 s after the call. While a link is up,
every host command of the profile's destination that would have run whole over
ssh (`HostOps::run`) runs this way; commands the home spawns itself (streams,
uploads, bridges) and the master's own commands (the review client setup)
stay on ssh.

### Socket streams

An `http` request with method `CONNECT` and a request body opens a byte
stream to a Unix socket on the node: the request body is what the home writes
to the socket, the response body what the socket sends back.

- The URL is `herdr:control` (`~/.config/herdr/herdr.sock`), `herdr:client`
  (`~/.config/herdr/herdr-client.sock`) or an absolute socket path (a
  profile's `remote_control_socket_path`).
- The node connects once the first chunk of the request body arrived and
  writes it at once: Herdr reads a control connection whose request has not
  arrived yet again only 100 ms later. A request body that ends before any
  chunk is answered `204`, an unknown URL `404`, a socket it cannot connect to
  `502`; the home reads those as a stream that ended.
- Otherwise the node answers `200` and streams the socket's bytes until the
  socket ends. The end of the request body (the home closed its side) closes
  the socket.
- The home sends the request with its first bytes without waiting for the
  answer, so a Herdr call costs one round trip of the link.

Each Herdr control call of the profile's runtime and its event subscription
is one such stream while the link is up (the Herdr client's connector); the
events then reach the home as the subscription's lines, with no polling.

The runtime's render socket (`client_socket_path`) is a proxy the home
listens on beside the tunnel's (`node-render.sock` in the profile's runtime
directory): each connection to it (a terminal, the notifications client, the
boot id read) is a `CONNECT` to the profile's render socket (`herdr:client`
or `remote_client_socket_path`) while the link is up, the tunnel's socket
otherwise. A stream keeps the way it opened with; one over a link that
closes ends, and its client reconnects through the tunnel.

### `node.listen`

The node listens on a Unix socket for the home, as `ssh -R` would:

| Params |                                                               |
| ------ | ------------------------------------------------------------- |
| `path` | an absolute socket path on the node; a file there is replaced |
| `id`   | what the node's streams name: `agent:<id>`                    |

Each connection accepted there is a `CONNECT` the node opens to the home
with the URL `agent:<id>`; the home connects it at once (no first-bytes
wait) to the local socket it named for that id, here the connection's agent
socket, and the two are bridged until either ends. Calling it again for a
path replaces its listener. The node removes the files it bound, unless
something else replaced them, when the link closes. The home uses it for
the host's review socket (`~/.cache/roamgate/review.sock`, which
`roamgate-review` and `roamgate-hold` connect to), after the review client
setup, which still runs as an ssh command.
