# History synchronization

`createAgentSessionHandlers` shares one projection cache per connection across
History, summary, transcript preview, and ATIF export. Concurrent requests share
reads; raw preview and download reads stay separate.

## Codex session association

Codex runs with `--no-daemon` inside Herdr so each pane's session hooks inherit
that pane's environment. Roamgate's default Codex launch command uses this mode.
Install the Herdr Codex integration on the agent's machine; the hook reports
session identity automatically when starting, resuming, or forking a conversation.
Custom launch commands must also include `--no-daemon` (Codex 0.163.0 or newer).
For Bash or Zsh terminals, source `scripts/codex-herdr.sh` from the shell startup
file to apply the same rule to commands typed directly in Herdr, including
`resume` and `fork`. It preserves arguments, explicit remote connections and
shared-server management commands; outside Herdr it delegates unchanged. Copy
the script to a stable location before sourcing it if this checkout is temporary.
Existing aliases that invoke `codex`, `command codex`, or an executable path are
routed through the helper with their original arguments and executable intact.
Management subcommands are recognized after global options as well.

Codex's shared background server retains the environment of the terminal that
started it. Its hooks can therefore report another pane's identity, even when
the integration is current. Already-running shared-server sessions must be
closed normally and resumed with `codex --no-daemon resume <session-id>`.
The transcript remains in the same Codex directory. Herdr should own the terminal
process lifetime; it does not need a detached Codex background server.

Lookups use exact IDs under `CODEX_HOME` (default `~/.codex`), including
`sessions` and `archived_sessions`. SSH connections search on the remote host
using Python 3 and never use local transcripts. Duplicate transcript matches are
rejected. Roamgate never guesses an association from a directory or the newest
transcript, and does not offer manual session linking.

## Cache and consistency

The cache keeps at most 16 sessions, four recent revisions per session, and about
32 MiB of data (an estimate, not a heap bound). Oversized projections are served
but not cached.

Each refresh stats the session file. Changes to path, provider, session, file
identity, size, or mtime invalidate the projection; a change during the read
triggers up to three retries. Incomplete JSONL lines wait for the next change.
This is not a filesystem transaction: same-size in-place rewrites may be missed
until the next change.

### Large transcripts

A Claude transcript of 4 MiB or more is never read whole (`session-tail.ts`).
A history load reads the file backwards from its end, in doubling chunks, until
it covers the window and 20 more conversation entries, then reads only the
bytes appended since. Much appended at once (over 16 MiB), or a kept tail grown
past four times its first read, reads the end again; entry IDs then hold, as a
large transcript's message entries are identified by their record.

What needs the whole session (tasks, artifacts, title, commands, token usage,
turn count, a rewind's scan) comes from a slim index: built once by streaming
the file in 4 MiB chunks, then advanced by the appended bytes. It keeps what
those readers use of each record, long texts cut to their ends, and drops the
API request records nothing reads. Parsing yields to the event loop every few
milliseconds, so one large session does not stall the bridge's other calls.
At most eight large sessions are kept per connection, apart from the byte
budget above, and the last aggregates of 256 more: one unchanged since is
answered from them without reading its end again. ATIF exports still read the whole file, in chunks.

The index is kept on disk (`session-index-store.ts`, under
`~/.cache/roamgate/session-index`, per connection and path): its records,
appended to as it grows, and what they cover (the file's device and inode,
where the last indexed line ends, a hash of the 4 KiB before that end) with
the aggregates last computed. After a restart it is taken from there, and
only what was appended since is read; a file replaced, cut short or
rewritten in place is indexed again from its start. A session with nothing
appended since its index was saved is answered from the saved aggregates
without loading the index, or even reading its end, at all. An index is
made ready even when its session left the cache meanwhile, so a partial
answer is never asked again for long. A request never waits
for an index that is not ready: indexes are made ready in the background,
one at a time for the whole bridge, and meanwhile `agent_session.get`,
`agent_tasks.get`, `agent_commands.get`, `agent_artifacts.get` and
`connections.agent_tasks` answer from the aggregates saved with the index
(or, with none, from the end read for the history), with `partial: true`.
The browser asks such an answer again after two seconds and keeps what it
showed before meanwhile. A single task's details and a rewind's scan wait
for the whole index.

`agent_history.older` with a `before_id` returns up to `limit` (default 50,
at most 200) conversation entries before that entry, with their tool entries,
and `has_more`; a large transcript reads further back only as far as the page
needs.

## Version 2 protocol

Send `history_version: 2` to `agent_history.get`, optionally with the last
accepted `cursor: { epoch, revision }`. Legacy callers get conversation-only
`messages`.

| Mode       | Response                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot` | `entries` replaces the window. Returned for a missing session, an invalid or expired cursor, a replaced connection, eviction, or file replacement/truncation.   |
| `delta`    | `base_revision`, `upserts`, `removed`, and the full ID `order` only when membership or order changed. An unchanged reply keeps the revision with empty changes. |

The window holds the latest **200 conversation entries** (including errors);
associated tool calls do not count. Raw and ATIF exports stay complete. Entry IDs
identify projected entries, **not durable source records or ATIF step numbers**.
Clients accept a reply only against their request cursor and current
pane/connection lease.

History refreshes every four seconds while open and visible, never overlapping.
Cards show up to 4,000 characters; full tool details open on demand.

Tool entries arrive redacted: empty `text` plus `text_bytes` (UTF-8 length) and
`text_hash` (content hash) of the withheld payload. `agent_history.entry`
returns the full `text` with its `text_hash`. Clients keep a fetched payload
only while its hash matches the entry's, so a payload rewritten under the same
ID, even at the same length, is fetched again.

## Message filters

User and Agent start enabled; Tool starts disabled. Agent includes assistant
errors; Tool includes calls, outputs, and errors. Counts reflect the unfiltered
window, and the header shows visible/total when filtered. Filters persist while
the panel is mounted, not across reloads. **Show all types** restores them.

The **Chat view** has no type filters: it shows every entry, with consecutive
tool entries collapsed into blocks. Its search keeps a tool call and its
result together, so a match on either shows the whole step.

Search is a case-insensitive literal match over all loaded text and combines
with the type filters. It never fetches older messages or hidden tool payloads.
**Reset filters** clears search and type filters. Timestamps use local
`MM-DD HH:mm`, with the year outside the current year.

![History filtered to tool calls and outputs using synthetic data](screenshots/history-tool-filter.png)

## Resource limits

Smaller transcripts are re-read and re-projected in full when they change; large
ones are read by their end and an index (above). Raw previews and ATIF exports
can be large.
