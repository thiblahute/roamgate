# Roamgate Features

A Web/PWA client for a running [Herdr](https://herdr.dev) server.
[Install](./docs/DEPLOYMENT.md) · [Tutorial](./docs/TUTORIAL.md) ·
[Keyboard shortcuts](#keyboard-shortcuts)

## Workspace, Tab, and Pane Navigation

- Create, rename, pin, reorder, switch, and close workspaces and tabs. Linked Git
  worktrees group under their repository. Pinned tabs lead the tab strip and
  cannot be closed from Roamgate. Drag-to-reorder needs Herdr 0.7.2+.
- Linked GitHub PRs and GitLab MRs appear in right-side sidebar badges with their
  number (`#N` for GitHub, `!N` for GitLab) and an open, draft, merged, or closed
  icon, preserving the workspace name. When several requests match, the sidebar
  shows the most recently created one. The workspace menu opens that request
  directly. Status refreshes every
  minute after each check; unresolved requests keep the branch label. A
  refresh keeps the current badge visible, and a failed refresh keeps the last
  known request dimmed with its last successful check time. A rebase stopped on
  a detached HEAD keeps the rebased branch's request. This uses
  the same host-side authentication as the
  [PR/MR status card](#workspace-inspector).
- New workspace paths accept absolute paths or `~/` and suggest subdirectories
  as you type. Leave the field blank to use Herdr's default directory.
- Split, resize, focus, swap (drag the handle at a pane's top center), zoom, and
  close panes.
- Drag a pane's handle onto another tab to move the pane there, or onto **+**
  to give it a tab of its own. Hold it over a tab to open that tab, then drop
  it on a pane's edge to place it on that side. Running programs keep going.
- The command menu searches workspaces, worktrees, files, tabs, panes, and
  agents, and opens typed file paths.
- Desktop **Zen mode** hides app chrome so the terminal fills the window. The
  small tab at the top edge exits Zen or opens the application menu in place.
  When a view with its own header fills the top of the screen (the expanded
  inspector, the review, a pane's chat, a file's Review only bar), those two
  buttons sit at the end of that header instead of hanging over it.
- **Configuration > Integrations > Automatic tab renaming** names default tabs
  from the focused agent's bound session title, or its own terminal title.
  Existing custom labels are preserved. After a bridge restart, previously named
  tabs are also preserved rather than adopted again. The setting is shared by
  connections; turn it off to stop automatic updates.

When a pane on an SSH connection prints a `localhost` URL, clicking it offers to
**forward the port** over SSH (to the same port number when free) and opens the
forwarded address. **Forward a port** in the command menu does the same. The
connection switcher lists the ports your own processes listen on, on either
side, and forwards either way: a remote port brought here, or a local one exposed
to the remote so processes there, agents included, can reach it. Active forwards
are listed with a stop button. Forwards bind loopback here and ask for loopback
on the remote (a remote sshd with `GatewayPorts yes` binds every interface
instead), close with their connection, and are offered only when Roamgate runs
on the machine you browse from.

Each browser keeps its own workspace and tab selection on endpoint connections;
older (legacy) connections share navigation. Pane focus, layout, and terminal
sizes within a tab are always shared. See
[compatibility](docs/DEPLOYMENT.md#herdr-compatibility).

### Overlay Tab

Each Space (Herdr workspace) can float one of its tabs above the others: press
`Option+F` (`Alt+F` on Windows/Linux) to show it, and again to hide it. The
first press in a Space without one creates a tab with a shell in the workspace
root (the checkout Herdr reports, otherwise the focused pane's folder) and shows
it. **Show as overlay** in a tab's menu or the command menu floats any other tab
instead, which sends the previous one back to the tab strip; **Back to tabs**
undoes it.

The overlay is an ordinary tab: split, focus, resize, and close its panes as
anywhere else, with the same paste, selection, image paste, and theme; its
split buttons sit in its title bar, where they hide no terminal text. Its
terminals stay attached while it is hidden, so showing it is instant. Showing
it puts the keyboard in its focused pane, even from an agent chat's message box,
and hiding it gives the keyboard back to the pane underneath. Drag its title bar
to move it and its edges or corners to resize it (double-click the title bar to
recentre it). Its maximise button, or `Option+Shift+F` (`Alt+Shift+F`) while
it shows, fills the main area right of the sidebar and below the header, and
restores its floating size and place the same way. Each browser remembers
where it was, whether it was maximised, and whether it was shown in each Space:
only hiding it (the shortcut, Hide, Back to tabs, or Stop) hides it, so
switching Spaces shows each Space's overlay as it was left there, and a reload
brings it back. Pressed in a review, `Option+F` shows the overlay above the
review, and hiding it gives the keyboard back to the review. On a phone it
opens as a sheet over the terminal from **⋮ > Overlay tab**, and Back hides
it; a switch or a reload leaves it closed there.

The overlay tab never appears in the tab strip, tab counts, the phone's tabs
button, the pane switchers, workspace rows, or Ranger's lists. The choice of tab
is kept on the Roamgate server, so every browser sees the same one, and it
survives restarts of Herdr, Roamgate, and the machine. **Stop** in its title bar
closes the tab and its shells; closing the workspace closes it too. Herdr's own
TUI shows it as a regular tab.

### Recent Pane Switcher

Switch between the 12 most recently focused panes across tabs and workspaces.
On macOS hold Ctrl and press Tab (Shift reverses); release the modifier or press
Enter to switch, Esc to cancel. Press K to switch to search mode.
Pressing the shortcut twice comes back to the pane it started from, whichever
connection that pane is on.

With **All servers** selected in the workspaces panel, other connections' panes
follow yours, labelled with their connection: one per workspace here (the one
most recently used there), every pane in search. Selecting one switches to that
connection and focuses the pane. With **Current** the switcher covers only the
connection you are on.

### Workspace Scope

**Switch between workspaces** in Menu → Configuration → Behavior turns the
switcher into a workspace switcher: one entry per workspace, most recently used
first across every connection, landing on the pane you last used there. One
press returns to the workspace you were on just before; each extra press while
the modifier is held goes one workspace further back. The history is kept in
this browser, so it survives a reload. The recent switcher and its
search both follow the setting, which is remembered for this browser, and
search lists its matches in the same order. Every
workspace is listed, including ones never visited here, and a search still
matches on the tab, directory, or agent of any pane in a workspace.

### Pane Search

`Alt+K` searches **every** live pane by workspace, tab, cwd, or agent
name/status. Agents on the other ready servers follow, attention first, and
every row shows its server, which is searchable too. All terms must match, in
any order. Enter switches, opening another server's agent on its server;
`Alt+K` or Esc closes.

With **All servers** selected, search covers every pane of every connection, not
only agent panes, so typing a workspace, agent, or connection name finds it
wherever it lives.

## Full Browser Terminal

- Server-rendered terminals with full keyboard input, IME, CJK punctuation, and
  multiline paste.
- Scroll with wheel, trackpad, touch, or page shortcuts. Mouse-aware apps
  receive clicks and drags; hold Option (macOS) or Shift to select text instead.
- On macOS, Option types characters (`@`, `[`, `~` on many layouts) by default.
  **Menu > Configuration > Behavior > Option key as Alt in terminals** makes it
  send Alt-modified keys instead, for shell and Herdr Alt bindings.
- Paste images or drop files onto a pane to upload them to that pane's host and
  insert their quoted paths (without pressing Enter). Dropping explorer rows
  inserts paths without uploading. Uploads expire after 24 hours by default.
- `Cmd/Ctrl`-click opens URLs in a browser tab and file paths in the preview.
  On touch, long-press and choose **Open link** or **File actions**.
- OSC 52 clipboard writes go to the browser that most recently typed into the
  foreground session, which is not necessarily the pane that produced the
  write; see [clipboard limits](docs/DEPLOYMENT.md#herdr-compatibility).

Herdr 0.9.1+ resolves URLs that wrap across lines. See
[link contracts](docs/ARCHITECTURE.md#links).

## Workspace Inspector

Open **Files**, **Changes**, **Commits**, or **Agent History** from the
Inspector button, shortcuts, or workspace/agent menus.

- Dock right or bottom, resize, or expand. Narrow layouts use drill-down views.
- Single-click opens a temporary preview tab; double-click keeps it. Open files
  are restored per connection and checkout. A file outside the checkout, and
  any file of a workspace without one (whose Files root follows its focused
  pane), is kept by its absolute path, so it reopens where it really is.
- Files search covers names, paths, and file contents across the checkout
  (respecting `.gitignore`, up to 100 results).
- Files refresh automatically after an agent step completes in the workspace,
  preserving expanded directories and selections.
- Commits browses the current branch with per-commit diffs and file previews.
  Wide panels show commits, changed files, and diffs in three columns; drag the
  commit-list divider to resize it, or double-click to reset. Narrow panels
  navigate from commits to files to diffs, with Back returning one level.
- Changes counts the lines of untracked files when there are at most 500 of
  them; a larger untracked tree is listed without line counts.
- `gt` / `gT` go to the next and previous view (`2gt` to the second), from
  anywhere in the inspector but a text field; the tabs' arrow keys stay.
- With reviews set to open in Changes (`:set reviewin=changes`) and Vim keys
  on (`:vim`), Changes takes the review's cursor: `j`/`k` (counts too),
  `J`/`K`, `gg`/`G` and `12G` or `:12` (line 12 of all the changes),
  Ctrl-d/u/f/b/e/y, PageUp/PageDown, `H`/`M`/`L`, `zz`/`zt`/`zb`, `{`/`}`
  hunks, `[`/`]` files, `w`/`b`/`E`, `h`/`l`/`0`/`^`/`$`, Left and Right to
  change side in a side by side diff, `/`, `*`, `#`, `n`/`N` (a search that
  finds no line goes file to file by path, the tree marks the files with a
  hit), `V` Visual lines (Shift+click too), `S` side by side, `R`/`gr`
  reload, `f` the tree, `o` Review only. A click puts the cursor on a line,
  a second click there opens the comment box. Ctrl-f is then the page down
  (Cmd+F still finds on a Mac) and `:split` / `:unified` switch, as in the
  review pane. On the classic setting (the default), Changes keeps its own
  keys and mouse.
- The same setting gives Changes the review's comments. `c`, Enter, `i` or
  `a` comment on the cursor's line, or on the lines `V` selected, in the
  review's Vim editor under that line (Cmd+Enter, Save or `:w` sends it, Esc
  keeps what you wrote as a draft that comes back, a key or two is a stray
  and is not sent, an image pasted in is stored with the review, `s` or
  `:suggest` starts a suggestion with the line as it reads, a GitLab
  suggestion as the review pane writes it; on a removed line it says
  suggestions are for the new version). The editor says where the comment
  goes, as the review pane's: a review comment, for the agent as you save, or
  held until Send; a review comment (no agent the comments go to) is saved by
  Esc too. On a line with an open discussion `c` answers it; on your review
  comment there `c` rewrites it; `C` asks the agent anew, and `:ask` answers
  where the line is discussed, else asks. With no agent to ask, the question
  is held for Send in the workspace's threads, and drawn on its line saying
  so. `gn` / `gN` go to the next /
  previous unresolved thread through every file (`n` / `N`, with no search
  going, go thread to thread), `gH` shows only the unresolved ones, `g;` the
  comment written last, `za` folds the thread on the line, `r` resolves or
  reopens it, `e` rewrites the message selected if it is yours, else your
  last comment on the line, else your latest anywhere (the cursor goes
  there), `dd` deletes your comment on the line (not the agent's), `T` lists
  the comments, `t` hides them all. Words selected in a message offer
  **Comment**, a discussion quoting them, and a comment on a part of a message
  is written in the review's editor too. A comment on a file and no line is
  drawn at the file's head, above its lines. The review's overall comment is
  above the diff, as in the review pane: **Overall comment** in the head (or
  the agent group's **Overall**, `:overall`) opens it in the review's editor,
  Esc keeps it as written; once written it shows with Edit and Delete. `j` / `k` step into the messages drawn under a line, and the parts of a
  message, before going on to the next line (`k` up onto a line lands on its
  last message); `n` / `N` go message to message, `gl` to the thread's last
  message, `c` on a message answers it (on a part, comments on that part),
  `u` brings back the comment `dd` deleted, and the `+` in a message's margin
  comments on its part. A comment on its way shows "Sending..." under its
  line, then "Not saved" with Retry and Discard if the server refused it
  (it is also kept in this browser). Comments on the whole review or on code
  the diff no longer shows are listed above the diff, the forge's under
  GitLab. A comment
  written on a staged or unstaged entry is drawn on the line that still
  reads as it did, in whichever entry of the file has it. Once the checkout's
  review has an agent, the diff's head gets its agent group: **Live**
  (comments go to the agent as you write them), **Hold**, **Send**,
  **Review** and **Overall**, also `:send`, `:hold`, `:review [focus]` and
  `:overall`.
- Threads in Changes are drawn as the review pane draws them: under each of
  your messages how it goes to the agent (sent, on its way, held, not
  delivered with Retry, not sent with Send, for another review's thread that
  review's way), "edited" and forge draft marks, Edit and Delete (`u` brings
  a deleted one back); Reply, Resolve or Reopen, and Fold on a resolved one,
  in the thread's bar; a reply or a rewrite in the review's editor, shown at
  once with "Sending...", then "Not saved" with Retry and Discard (its text
  comes back in the reply). `n` / `N` and Tab / Shift+Tab go message by
  message through every thread, the review's own above the diff first, and
  around past either end; `j` / `k` go through the review's own messages and
  down to the first line. The head has a comments button (`t`,
  `:comments`) with the hidden count, the unresolved threads' arrows (where
  you are among them, and only them), and the review's status line (the
  agent waiting for an answer, not delivered, reviewing, working, what a
  review pass left, unsent drafts kept). Lines with a thread keep a dot in
  their margin while the comments are hidden; a click on one shows them, and
  so do the agent's new answers and a comment you write. `T` lists the
  comments, open ones first, the latest written first.
- Changes then shows more of the code around the changes, as the review pane:
  between the hunks and at the file's ends a line says how many lines are
  hidden, with **↓ 20**, **Show all** and **↑ 20** (the end of the file
  reads **more lines** and **Show the rest** until the file is read). `zo` or
  `x` shows 20 more lines on both sides of the hunk at the cursor (a count
  asks for that many times 20), `zO` or `X` every hidden line around it,
  `zR` the whole file; the cursor stays on its line. A thread on unchanged
  code the diff hides opens the hunk nearer to it, three lines past it, so it
  is read on its line. The lines come from the checkout's file; a file that
  reads otherwise there (other changes in it not shown) says so and shows no
  more.
- A reviewed file folded to its header opens again when it is picked in the
  tree, the cursor on its first line.
- On the working changes, `gs` stages the file at the cursor, and `:stage`,
  `:unstage`, `:discard` and `:delete` act on the file at the cursor or the
  files `V` selected, with the same confirmations as the tree's menus (a
  discard or a delete asks first). There is no single-letter staging key.
- On the working changes `r` marks the chunk at the cursor reviewed (or the
  chunks `V` selected; on a line with a comment it resolves the thread
  first), then goes on to the next chunk not reviewed, and `r` again unmarks
  it. `v` and `Option+V` (`Alt+V`) mark the file, every chunk of it. `gu` and
  `gU` jump to the next and previous chunk not reviewed. The marks are the
  checkout review's, so a chunk keeps its mark when it is staged. The diff
  shows each file once, its staged and unstaged changes together against
  `HEAD` (an untracked file as new), the lines comments are anchored on, so
  staging never moves a comment. Every chunk carries its state in the
  margin, told line by line from the index: green staged, amber unstaged,
  both when it is partly staged; a reviewed chunk is dimmed.
  The tree lists the working changes in groups, **Staged**, **Changes** and
  **Untracked**, a file changed twice in both (each row shows the same
  diff, and its menu acts on that group's change), with its reviewed chunks
  (`3/7`, a check once every chunk is) beside its name. Comments written on
  the staged or unstaged diffs before are moved onto that file's lines by
  their text; one whose line is gone is listed in the Comments panel.
- The **PR/MR status** card in **Changes** and **Commits** shows the branch's
  GitHub pull request or GitLab merge request: state, checks, and reviews. It
  needs `gh` or `glab` authenticated on the checkout host and never changes
  anything remotely. If a refresh fails, it keeps the last known request marked
  **Last known**. A detached checkout resolves a request only while a branch
  rebase is in progress.

Sidebar and worktree PR/MR badges keep the last successful summary in this
browser (up to 200 checkouts). Reloading or reconnecting shows it as **Last known**
while the status refreshes. Temporary Git, network, CLI, or authentication
failures do not erase a known link. Cached summaries are isolated by connection
destination, repository, checkout, and branch; a confirmed missing or ambiguous
request clears the cached link. Cached links require a known branch; temporary
Git status failures retain the last confirmed branch. A detached checkout waits
for Git to confirm an active branch rebase before showing a request, and must
confirm it again after reconnecting.

Inspector state is scoped to each checkout; see
[resource ownership](docs/ARCHITECTURE.md#workspace-resource-ownership).

## Agent Awareness and Session Inspection

- See recognized agents and their working/blocked/done/idle status in the
  sidebar, switcher, command menu, Agent panel, and notifications.
- Choose nested, **Separate**, or **Compact** agent views with optional
  attention-first ordering and grouping.
- Sort **Separate** agents by **Recently opened**: blocked, done, and working
  agents stay first, and idle agents follow the last time this browser opened
  them. Open times stay in this browser's local storage.
- A workspace row gives its name the whole line, cut at the end; a worktree
  under its repository drops the name prefix it repeats (`gstreamer-ocio`
  under `gstreamer` reads `ocio`). At the right sits one compact status: the
  changes (Δ12), else commits ahead or behind (↑1, ↓4), and a dot in the most
  urgent agent state of its tabs. Rows of a server other than the default
  local one start with a dot in that server's colour, always the same, so
  the list keeps its order, nesting, folds and colours whichever server is
  displayed: only the selection moves. When the sidebar is wide enough, a muted second line
  shows the branch (when it differs from the name), the PR or MR, and numbered
  tab chips colored by agent state (click one to open that tab, on any
  server; extra tabs fold into +N). Hovering a row on a desktop shows a card
  with its full name, server, branch, path, changes, ahead and behind, and
  panes.
- Switch **Current / All servers** in the **Workspaces** heading in any agent
  layout. **All servers** marks the other servers' workspaces with their dot,
  preserving the existing worktree nesting and indentation. **Nested** also
  shows agents under their workspace, **Compact** keeps them out of the list,
  and **Separate**
  collects agents in their own panel. Selecting a workspace or agent opens its
  server. Disconnected servers and failed reads remain visible. Other servers'
  context menus offer navigation; switch to their server for workspace and pane
  actions. Creating a workspace from **All servers** lets you select a connected
  server in the dialog; choosing one switches the current server and checks the
  working directory there. The scope and creation server selectors are hidden
  when fewer than two servers are connected.
- Arrange the **Workspaces** list your way: any workspace can hold others, from
  any repository and any server, and plain label groups (the folder button in
  the heading, or **New workspace group** in the command menu) nest at any
  depth. **Move into…** in a row's context menu (long press on a phone, or the
  menu key) and in the command menu opens a searchable list of groups and
  workspaces, or makes a new group. **Move to top level** (also the first
  choice in **Move into…**) takes a workspace out of anything, including the
  repository the list would nest a worktree under, and keeps it at the top
  level in the list's order; **Back to its usual place** undoes any placement.
  Drag a row onto the middle of another to nest it, or into the gap between two
  rows to make it a sibling at that level: between a deeper row and a
  shallower one, the pointer's horizontal position picks the level, and the
  drop line starts at that indentation. Dropping between two top-level rows
  puts a workspace at the top level there, and the very top and bottom of the
  list take a workspace or group above or below everything. Workspaces you
  have not placed show as before. A worktree or workspace made for an agent lands under
  the workspace that asked: from a workspace's **New worktree…** (when that is
  not already where the list nests it), from Ranger, and from
  `roamgate-review worktree`, `workspace` and `place`, which agents use; with
  `--group gst/upstreaming` these put it in that group instead (names matched
  case-insensitively, `--create-group` makes missing ones, and
  `roamgate-review groups` lists the paths). The arrangement lives on the Roamgate server, so every browser and device shows
  the same one. A parent row sums up everything below it in the agent status
  colours: agents working, agents idle with work running in the background,
  agents waiting on you (asking, or finished unseen), and subagents running;
  collapsing keeps the sum, and the collapsed state of
  a group is kept with the arrangement. A placed workspace whose server is
  down, or that is no longer open, stays where it was, greyed, with a button to
  remove it.
- Under a Claude agent in the **Nested** layout, a collapsed line such as
  "3 subagents · 1 running" opens onto its running subagents and workflows,
  its teammates (idle ones stay: a message wakes them), and failures you have
  not opened yet, each with its live elapsed time. Finished subagents leave
  the list for the **Tasks** sheet, which keeps them all, as it keeps
  background commands and monitors; "N done" opens it. One started in a
  part of the session since rewound carries the same rewind arrow as in
  the sheet. Clicking a subagent opens it in the Tasks sheet. The lists follow the agents' own state changes,
  without polling, and whether a line is open is kept in this browser.
- A Claude agent Herdr calls idle while its subagents, running teammates,
  workflows, background commands or monitors still run shows a hollow,
  breathing dot instead of the idle one, in the Workspaces list (its row,
  its workspace's dot and hover card, which lists what runs), the pane
  switcher and Find workspace, with "idle · 2 running" as its status. An
  idle teammate waiting for a message does not count. This comes from the
  tasks the list already reads; Herdr's own status is unchanged.
- In agent chats (and Ranger's), GitLab merge requests and GitHub pull
  requests become live chips: `!123` and `#123` (read against the pane's
  repository: its `upstream` remote, else `origin`, or the parent of a fork),
  `group/project!123`, `owner/repo#123`, and their web URLs, in your messages
  and the agent's, never inside code. A chip shows the number, state (open,
  draft, merged, closed), pipeline or checks, approvals and unresolved
  threads; hovering it shows the title, author, branches, failed jobs and when
  it last changed. A click opens its page; **Review** opens a GitLab merge
  request in the review overlay. The chat's header shows the request of each
  repository the session works on (the pane's checkout, its `subprojects/` on
  a branch, and repositories the agent worked in), folded into one "3 MRs"
  chip listing them when there are several. The request button next to it
  lists every request of the conversation by repository: its branches', those
  it created (`glab mr create`, `gh pr create`) and those it named. Statuses
  are read through glab and gh on the checkout's host, only while shown, and
  a running pipeline is followed until it ends. A host glab or gh is not
  signed in to shows "not signed in"; confidential security projects show no
  content.
- **Agent History** shows the latest 200 conversation entries with search, a
  minimap, and tool details. The **Chat view** toggle reads them as
  conversation bubbles with rendered replies and collapsible tool-call blocks
  that follow new output (a collapsed block lists what its running calls and
  its last few finished ones do, one line each, in plain words: the file read
  or edited, the agent a message went to, the review thread answered, the
  tools loaded; MCP tools go by readable names such as "Spotify: search").
  What an agent writes in Roamgate's threads (a reply, a new thread or
  review comment, an edit), through its tools or `roamgate-review` in a
  shell, shows as its own tool row even in a collapsed block: the call's
  `description` (the short words the agent gave it), else where it went and
  the first words ("Replied on "the header bar" · Fixed..."); opened, the
  row shows the words written, and its link opens the thread's review where
  it lives. So the agent does not repeat its answers in the chat, and the
  voice companion reads none of these rows: a turn that only answered in
  threads is read as "Answered 2 threads." The chat has
  a message box that types into the agent's terminal and shares the
  pane's terminal composer draft. Paste images or use
  **Add images** to choose them on desktop or mobile; the box shows each as
  `[Image #N]` with a thumbnail above it (and a button to remove it) while the
  draft keeps its uploaded path, which is what the agent gets. In the
  conversation, an image sent that way shows as the image, loaded from the
  pane's host through the file download, instead of its path; a click shows
  it over the app fitted to the window (a click on it gives its own size;
  Esc, the backdrop or the close button put it away), and Cmd, Ctrl or a
  middle click opens it in a tab. In a Claude session, typing `/` lists the
  commands that match what follows (Claude Code's own, then the session's
  skills and custom commands, read from its transcript); a click, or the
  arrows and Tab or Enter, fill in `/name`, Enter on a whole name sends it,
  and Esc closes the list. **Vim keys** in Configuration > Behavior (on by
  default; one setting for every device, which the review's `:vim` and
  `:set novim` change too) makes chat message boxes Vim editors: insert mode
  first, `:w` sends, Alt+Enter queues while the agent answers (and sends
  otherwise), PageUp/PageDown scroll the conversation, and on touch
  screens an **Esc** button stands in for the missing key. Enter sends and
  Shift+Enter adds a line; on touch keyboards Enter adds a line and the Send
  button sends. Messages are submitted in the terminal with the agent's
  submit key (see **Agent submit keys** below). On phones the box replaces the terminal composer dock while the
  chat is open. Sending to a working agent queues the message (it shows as
  **Queued** in the conversation until the agent takes it); sending to a
  blocked agent or one in an unknown state first shows where the text will
  land and needs **Send anyway**. The timeline view adds User/Agent/Tool filters. Exports are always
  complete. **Session Inspector** adds metadata, a timeline, raw/ATIF
  transcripts, and export.
  In a Claude session, messages sent while Claude works show where it took
  them, and those still waiting in its queue show at the end marked
  **Queued**. What Claude Code writes into the user's turn itself (system
  reminders, task notifications, notes on images a tool read) is not shown as
  the user's, and a compaction summary shows as one **Conversation
  compacted** line that opens the summary.
  **Speak** beside an assistant message reads its full text aloud; **Stop**,
  another message, or closing/switching the chat cancels it. Two engines read
  aloud, here and in voice chat. When the server has Roamgate's voice engine
  ([voice chat](docs/DEPLOYMENT.md#voice-chat)), its voices read a sentence
  at a time, at the server's reading speed, and the sentence being read is
  highlighted; otherwise the browser's speech synthesis reads, with the voice
  and speaking rate saved for this browser (unavailable voices fall back to
  the browser default). **Configuration > Speech** says which
  engine reads and whether voice chat can listen, sets the browser voice and
  rate, and with the server engine its reading speed and whether this browser
  reads with its own voices instead. Both engines read the same text: code
  blocks, Mermaid diagrams, oversized tables, and long hashes/values are
  omitted or announced instead of read aloud, simple tables retain column
  labels, and raw HTML blocks are omitted. On desktop, Speak appears on hover
  or keyboard focus, like Copy; Stop remains visible during playback. On
  mobile, the speech control stays visible. Playback reads a snapshot, never
  automatically narrates new replies, and is limited to one message per
  browser tab. Some browser voices use online services and may send message
  text to their provider; the browser engine needs no microphone or
  server-side speech software. Browser support and voices vary; background
  and locked-screen playback are not guaranteed, including on iOS.
- An agent pane can show its conversation **as a chat** instead of its
  terminal, which keeps running underneath and does not take the keyboard:
  the chat button in the pane's toolbar, Ctrl+Cmd+M (Ctrl+Alt+M elsewhere), or
  on a phone the bottom bar's **Chat** or **Chat in pane** in More options.
  The chat takes the whole pane, with one slim row for
  the agent's icon, what a Claude session is about (its `/rename` name, else
  the title Claude Code gives it, also shown as Agent History's heading), its
  status, the pages the session published with Claude Code's Artifact tool
  (a list to open or copy each link; each publish also links under the tool
  calls that made it), search, **Stop** (Esc in the terminal) and, on a
  desktop, the way back to the terminal (on a phone, **Terminal** in More
  options); on a phone that row stands for the top bar, which hides,
  and the message box sits in the bottom bar, taking the whole width while
  you write. Below the conversation, a working agent shows its own word for
  what it does, read from its screen (Claude Code's "Sublimating... (1m 5s)"),
  and an agent asking something shows its question with its choices as
  buttons. The question takes the keys its terminal menu does: the arrows or
  `j`/`k` (`h`/`l` between questions), 1 to 9, Tab, Enter, Esc and Space; the
  choice the agent's cursor is on is marked. The message box steps aside
  while only a choice is asked, and comes back for a "Type something." answer.
  A menu shows as a question even before the agent's hooks report it blocked
  (a new session asking to trust its folder). Each pane
  remembers its view; until switched, an agent pane opens as a chat on a
  phone, and on the desktop as **Open agents as a chat** in Configuration >
  Behavior (off by default) says. Review
  feedback sent to a pane shown as a chat is pre-filled in its message box;
  its **Send** button sends it at once.
  A Claude pane is the exception: it shows the view of its mode
  (conversation mode below), never a chat over its terminal mode, except
  where the server has no conversation mode (an older Roamgate, a Windows
  host).
- A message sent from a chat's message box (in a pane or in Agent History)
  shows at once at the end of the conversation, dimmed with **Sending...**,
  then **On its way** once the pane took it, until the transcript's own entry
  replaces it. One the pane refused, or that the transcript has not shown 90
  seconds later, stays marked **Not delivered** with **Send again** and
  **Discard**, also after switching the pane to its terminal and back; it is
  still replaced if its entry shows up later. Answers typed into a question,
  `/commands` and `!` lines are sent as before. With Roamgate's permission hook (see
  [Deployment](docs/DEPLOYMENT.md#permission-prompts)), what an agent asks
  leave to do shows in its chat, or as a card over its terminal, with
  **Allow**, **Always** (the terminal's don't-ask-again rules) and **Deny**,
  and its multiple-choice questions as a form (one choice, several, or one's
  own words), a sheet of its own on a phone; **In the terminal** hands either
  back, and the terminal asks anyway once the hook stops waiting. **Dismiss**
  (Esc, or `d` on a permission card) puts either away unanswered: the agent
  is told the user dismissed it and goes on, and its chat shows the step as
  _Dismissed_. A conversation-mode pane shown as a terminal says when Claude
  waits on a question, with **Show the question** and **Dismiss it**; on a
  call, "dismiss it" (or "laisse tomber la question") does the same.
  A pane's chat keeps your place in it. Leave it for another pane,
  workspace or connection, for its terminal, for a phone's Workspaces
  sheet, or reload the page, and coming back shows the conversation where
  you were reading: the same message at the same height, kept by the
  message rather than by a scroll offset, so what the agent answered
  meanwhile waits under it, and a place among older messages reads them
  back in. Left at the end, the chat follows the newest message as before.
  Messages that came under your place are counted in a **N new messages**
  pill at the bottom of the chat, which goes to the newest. The chat's
  comment threads come back as you left them: folded or unfolded, the
  comments panel open, and the reply or comment you were writing with its
  words (kept in the tab's memory, not across a reload). A pane whose agent
  started a new session opens at its end.
  With [voice chat](docs/DEPLOYMENT.md#voice-chat) set up, the call button
  beside the message box talks hands-free: speak, and what you said is sent
  once you pause; the agent's answer is read aloud by the engine Speak uses
  (as Speak cleans it), in its language with the server's voices (English,
  French, Spanish...), then it listens
  again; speaking up while it reads stops the reading and is heard. It
  listens while the agent works too: each further message said is sent,
  queued behind the others, and the answer read is the one to the last.
  The agent's messages are read as it works, each once it is complete, so
  progress is heard; at the end, only what was not read yet is. A
  pause of 2.5 s sends what was said, or a tap at once. While it is on, a
  call bar floats over the chat: who you talk to (the agent and its
  workspace), what it is doing, the call's length and the microphone level
  on the left; mute, the reading speed and a red hang-up button on the
  right. Hang-up ends it at any time; so do saying just "stop" ("arrête",
  "para"...) and a tap on the call's name while it waits or listens before
  anything was said. A tap there while it reads stops the reading and
  listens. It keeps listening through silence,
  waits while the agent asks something on screen, and reconnects on its
  own; when the voice helper on the Mac restarts, what was being said is
  sent and it listens again, the call going on. Only one thing reads aloud at a time. Voice chat is a WebRTC call
  with the Mac, and the microphone is only sent while it listens. With a
  headset, or in a car, the phone treats it as a phone call (its echo
  cancellation takes the replies out of what the microphone hears); a phone
  without one plays the replies on its loudspeaker, and the Mac takes
  their echo out. On an Android phone, a button by hang-up shows where the
  call plays (loudspeaker, earpiece, a headset) and moves it to the next;
  the replies come at broadcast loudness so the loudspeaker is loud enough
  ([setup](docs/DEPLOYMENT.md#voice-calls)). The phone's screen stays on
  during a call: Chrome on Android gives a web page no microphone with
  the screen off. Turned off anyway (the power button), the call bar
  shows "Microphone paused by the phone" and the call says it aloud;
  once the screen is back the microphone opens again and the call goes
  on, never hung up. On a phone with the Roamgate Android app, a call
  started in the web UI goes to the app, which keeps the microphone with
  the screen off: the call bar then says "In the Roamgate app", and
  hang-up still works from the page; a "Move to the Roamgate app" button
  does it by hand when the app did not open by itself. On Tailscale, the call's audio needs `call_ice_address`
  ([setup](docs/DEPLOYMENT.md#voice-calls)). Where the call cannot be
  made, or does not connect (a note then says so), replies play with the
  microphone's audio; with replies played as
  media (Speech settings), other apps' music or podcasts on a phone pause
  while voice chat is on.
  Its mute button, on the call bar, stops listening without
  ending it: replies are still read, and what was being said when it was
  pressed is sent, as a tap would.
  With a speaker model set up, the voices heard are told apart, and the
  companion hears each thing said with who said it: you, another voice
  (a radio, a TV, someone nearby), or both. It learns which voice is yours
  from the conversation (the voice it answers, or that tells it "c'est
  moi"), answers you, leaves background voices unless they clearly speak
  to it, and asks briefly when unsure. Only your voice cuts a reply. The
  voices heard often are kept across calls on this machine, as voice
  prints, never audio: you are known from your first words, and the people
  around you by the names you give them on a call ("c'est Simon qui
  parle"), corrected the same way (voice profiles in
  [deployment](docs/DEPLOYMENT.md#voice-chat): where they are kept and how
  to delete them). For
  noisy places, `drop_other_voices` keeps only the first voice heard in a
  voice chat (its first two seconds of speech), other voices left out;
  with recordings of your voice (`speaker_reference`), yours is the one
  listened to from the start, in each language you recorded. While a
  call's music plays, it is not taken for your words; with
  `drop_other_voices` and without recordings of your voice, the music
  waits, silent, until you have spoken a little, so that its singer is not
  taken for you.
  With a turn model set up, a pause sends what was said only when it sounds
  finished, and the words read as finished too when a text turn model is
  set up: a pause after "I think we should", or after an "um", "euh", "and"
  or "du coup", waits for the rest. Five seconds of silence sends it anyway
  (ten after an "um").
  With a cleaner set up, what was said is cleaned before it is sent:
  fillers, false starts and misheard words go, self-corrections keep what
  was meant. Words said to someone else in the room are held, greyed above
  the box, with a tap to send them after all; a cleaned message's voice
  label shows what was heard.
  Dictate, the microphone on the message box, types what you say there
  instead of sending it: the words show as they are heard, and when you
  press it again the cleaned text (fillers, false starts and
  self-corrections gone, spoken punctuation written, each language kept)
  goes in at the cursor. It hides during a voice call, which listens
  instead. The same microphone is on every comment box and shows at the
  right edge of any other text box while it has the focus (titles,
  settings, notes), except filters on names, such as the workspace and
  shortcut searches. While the server loads its listening models the
  status line says so; what is said meanwhile is still heard. The
  Android dictation app uses the same server side to type into any app
  ([protocol](docs/ARCHITECTURE.md#dictation)).
  With a router set up, voice chat reaches every agent session: each thing
  said goes to the agent on screen unless it asks for another session, by
  what it is about ("go to the tracer session in gst-plugins-rs", "tell
  IGA-184 to build the image"), on any connection. Roamgate says "Switched
  to …", shows that session's chat, sends it the words if they were for it,
  reads its answer and keeps listening there. When two sessions fit, it
  asks which one. A question about your sessions ("what is IGA-184 up to?",
  "which ones wait on me?", "has its merge request been merged?") goes to
  [Ranger](#ranger), which reads them and answers aloud, in its own chat,
  without switching. Talk about Roamgate itself goes to the session working on
  Roamgate. A question or errand about nothing in your sessions (the news,
  a WhatsApp message) goes to the session in your errands folder, without
  switching; its answer is read and shown when it comes. Talk to someone
  else in the room is held as above. What the router says (a switch, its
  question) shows on one line above the message box, labelled Roamgate,
  never in the conversation with the agent. An answer from Ranger or the
  errands session is read aloud, and that line's **Open** shows it in full,
  in Ranger's chat or that session's.
  With a front set up, a fast model answers each thing said within a second
  or two, in your language, before any agent does: it says what it does
  with the words ("Je lance ça sur la session roamgate") and the
  words go on exactly as said, or it answers what Roamgate already knows
  itself (what runs, which sessions wait on you, a Ranger task, a merge
  request's CI) and nothing is sent. It never works, approves or answers for
  an agent. With a front, a call is with it: **Call the companion** in the
  application menu or the command menu (`Cmd+Option+V`, `Ctrl+Alt+V`), or
  an agent chat's call button, whose session is then only where work goes
  by default. The call lives in the top bar, wherever you go: the
  companion's chip (Speech settings name it) says what it does (idle,
  listening, thinking, speaking, jobs running) with the call's timer,
  microphone and hang-up, and one line under the top bar shows what is
  said now, pushing the page down rather than covering it. The chip opens
  its own conversation: what it heard and said, and the work it started on
  which session and how it went. On a phone a call shows that conversation
  on the whole screen, with **Mute** (the microphone is closed until you
  unmute; it still speaks) and **Hang up**; hanging up goes back to where
  you were. The conversation keeps the newest in view as it comes, unless
  you scrolled up to read: then it stays put and **Jump to latest** brings
  you back. While you speak, what the transcriber hears so far is written
  as a caption under the last line, and becomes your line once you pause;
  its send button (`Cmd+Enter` / `Ctrl+Enter`) sends it at once, without
  waiting for the pause. Work for another session ("ask gst2 to
  rebase") starts there and the call stays with it, the answer coming back
  through it; the session gets your words with only its addressing
  dropped ("rebase", not "ask gst2 to rebase"), a yes or an answer exactly
  as said, marked `[Voice]` as in voice chat (with the sentence you cut
  off), so its chat shows them as said by voice. It
  answers what it already knows (recent answers, sessions, notifications)
  and only starts work when a session must look or work. You talk with it
  alone: the agents' answers are not
  read as they come but given to it, and it tells you about them as the
  conversation goes (a short summary naming the agent, the exact words when
  they matter, or nothing yet while you are on something else). "Read me
  the whole answer" ("lis-moi toute la réponse") reads one as written;
  "read everything" ("lis tout") has every answer read for the rest of the
  call, "just summarize" goes back. Speech settings' **Answers on calls**
  keeps either as the default. When an agent asks you something (a
  permission, a question with choices, its terminal's menu), the question
  and every choice are read at once as written, and the choice you say
  ("two", "yes", "release/1.2") answers it; everything still shows in the
  chat. It answers general questions itself, briefly, from what it knows
  (a fact, an explanation, a definition, quick help). A question that
  needs fresh or checked information (news, opening hours, prices, the
  weather, a release, "check that") is looked up on the web in the
  background: it says at once that it looks ("Je regarde ça sur le web,
  je te redis"), the call goes on, and it tells you what it found once you
  are not talking, naming the source when it matters. Several searches can
  run at once; ask "where is that search?" or "cancel that search". Each
  shows in its conversation with its steps, its whole answer and its
  links, and a **Cancel** button while it searches. With the MCP tools
  voice.json lists for it (`companion_mcp`, see
  [deployment](docs/DEPLOYMENT.md)), it also does what they do: pause,
  skip or play music, find a video or its transcript, read your messages.
  It says at once that it does it ("Je mets en pause.") and tells you how
  it went. Anything that would send, write or delete (a message, a mail, a
  reaction) is never done as asked: it reads back exactly what it would
  send and to whom, and does it only when you say yes. In its conversation
  that read-back has **Yes, do it** and **No** buttons, and a plain yes or
  no typed there answers it too; it stops waiting after 5 minutes.
  Its conversation also takes text, in a call or without one, for a quick
  question with no microphone: **Ask the companion** in the application
  menu or the command menu (`Cmd+Option+Shift+V`, `Ctrl+Alt+Shift+V`), or
  its chip when no call runs, opens it with its message box focused (full
  screen on a phone). The box is the agent chats' message box, with Vim keys
  under **Vim keys** (Esc then leaves insert mode first, and
  closes the dialog the next time), and its draft is kept until sent. Enter
  sends, on a phone too; it says it is thinking while it decides,
  then answers in writing as it would on a call (an answer, a web search,
  its tools, work started on a session, Ranger), and nothing is read
  aloud. With no agent session open, it still answers; work then needs a
  session named. The companion remembers across calls: when you come back
  (a new call, or later, after a restart or a move to the other host) it
  knows what was said, the work it started and how it went, and what is
  still open, from a summary written when the call ends. It also keeps
  long-term memories that last across calls, in
  `~/.config/roamgate/companion-memories` (a `MEMORY.md` index and one fact
  per Markdown file): who people are,
  how you want things done, projects, decisions. Ask it what it remembers,
  tell it to forget one thing, or open **Memories** in its panel to read
  and delete them. Say "repars de zéro" or "start over" to it, or use
  **Start over** in its conversation, and it forgets the conversation and
  the summary only: memories stay, gone one at a time only when you ask.
  Between turns it
  tells you what happened elsewhere when it is worth it (a session done or
  waiting for input, a Ranger task run), never over you. Speaking up stops
  it. Only its own words are said: no canned "Got it, on it." while it is
  slow, and silence for what it takes as not for it (talk in the room),
  which the card still shows. Say "c'était pour toi" or "you didn't
  answer me" and it takes back the last thing it skipped and handles it
  ("Ah, tu me demandais de ..., je m'en occupe."). While
  it or the router decides, the call bar says "Choosing who it's for".
  Voice chat follows you between workspaces (sidebar, Find workspace,
  shortcuts, the phone's switcher): the workspace you go to shows its agent's
  chat (the pane on screen when it is an agent, else its most recently used
  one, on any connection), a review pinned there steps aside (Option+R
  brings it back), and the conversation goes on there; what was held
  stays with the pane it was said to, and only one voice chat listens at a
  time. A
  workspace with no agent is not switched to: Roamgate says so and asks
  whether to move anyway; "yes" or Move switches and turns voice off for
  the keyboard, anything else or Stay keeps voice where it was, and the
  answer is never sent to the agent.
  What is heard shows above the message box as it is said (with Parakeet,
  updated about every second). With Whisper's model set up too, a sentence
  Parakeet wrote in English while the conversation is in another language
  (it drifts to English on some French) is read again in that language
  when it was said in it.
  Replies are read a little faster than the voice's own pace (1.2x); the
  speed button on the voice card steps through 1x, 1.1x, 1.2x, 1.3x and
  1.5x, from the next sentence on in a call (the sentence playing on
  otherwise), and every browser keeps it; the server makes the speech at
  that speed, keeping the voice's pitch.
  With the server engine, the same **Speech** section (in the menu, on
  phones too) lists its voices
  after the browser's settings, grouped by model: your recorded voices,
  Qwen3-TTS's stock speakers (Ryan, Aiden, Vivian, Serena... with a
  CustomVoice model) and Kokoro. Hear each voice say a short sentence in the
  language chosen above the list (the browser's by default), choose which one
  reads every reply or only one language (French read in a French voice,
  say), rename or delete the recorded ones, and set the speed. **New voice** clones one, simple enough for
  children: give it a name and a language, press the big button and read the
  two short sentences shown aloud (a level meter follows the voice); the
  recording stops by itself at the pause after the reading, or on stop, never
  mid-sentence before its 30 s limit. Listen back or record again, then
  **Make the voice**; a few seconds later it can be heard and chosen. When
  only part of the text was read, or something else was said, the voice
  learns from what the recording says, shows it, and offers to record again. A choice applies from the next sentence, without
  restarting anything.
  **Surprise** (in the Speech section) reads each
  reply with one of your recorded voices at random, never the same one twice
  in a row: a whole reply in one voice, whatever its language (a voice
  recorded in French reads English with its own timbre). The voice call says
  who speaks ("Éloïse is speaking"); choosing a voice with **Use** turns it
  off. Every browser keeps it.
  **Music under a call**: with `call_background` set in `voice.json` (such
  as what the Spotify app plays on the Mac), a voice call can hear it under
  the conversation, ducked while either side talks, at its own speed
  whatever the reading speed. A call starts without it: ask the companion
  to put the music on, then to turn it down, up or off
  ([setup](docs/DEPLOYMENT.md#music-under-a-call)).
  An open request ("mets de la musique", "something calm", "un truc pour
  bosser") is picked from your Spotify taste: your own playlists and liked
  songs first, then your top artists and genres, never the same pick twice
  in a row, and the companion says in a few words what it picked and why.
  "Pas ça" or "autre chose" right after a pick puts it aside for a month;
  a lasting dislike said on a call ("plus jamais de jazz") is remembered.
  A request that names what to play ignores it, and the companion can say
  what you listen to lately
  ([setup](docs/DEPLOYMENT.md#your-music-taste)).
  The sentence being read is highlighted. What is said goes to the agent
  marked `[Voice]`, with the sentence it cut short when it interrupted the
  reading, so the agent knows it talks live and what was heard; the chat
  shows that as a label on the message.
  Listening needs the server's voice engine: without it, the microphone is
  dimmed and says so when tapped. Reading works with either engine; with the
  browser's voices, the speed button steps the browser's speaking rate.
  Starting voice chat while Speak reads with the server's voices lets it
  play on, until you talk over it.
  **Conversation mode** (Claude Code): a Claude pane has two modes, each
  with one view. In terminal mode the pane shows Claude Code's terminal
  only, with **Conversation mode** in its toolbar (and the pane's chat
  shortcut, or **Chat** on a phone, which asks first): it hands the session
  to a headless Claude Code that the chat drives. While Claude works, waits
  on a question or runs background work, the switch says so and waits for
  it, until cancelled; when it cannot go (a draft in the prompt box, say),
  the terminal says why. When another Claude runs the same session in
  another pane (one left open there), it says where, by the workspace and
  tab names the sidebar shows (and the connection when it is not local),
  that only one Claude can write a session, and whether that one is idle;
  **Go to it** shows that pane and, while that Claude is idle, **Quit it
  and switch** exits it (its pane and shell stay) and switches. One that
  works or waits on a question is never quit. In conversation mode the
  pane shows the chat only,
  with no mode label in its header, and **Open in terminal** in that header
  (on a phone, **Terminal** in More options) hands the session back; when it
  cannot go, the header says why until you put it away. **Ctrl+Z** in the
  chat suspends the conversation as a job of the pane's shell, as Ctrl+Z
  suspends a program there: the pane shows its terminal with the shell's
  prompt (no Claude runs; the session is saved), a line over it says what
  is suspended, and `fg` typed there (or the line's **fg** button) brings the
  conversation back as it was, in the chat. Ctrl+Z never takes undo from a
  message box: it suspends the conversation only with the box empty, in Vim's
  normal mode, or on a Mac (where undo is Cmd+Z); `:suspend` (`:sus`,
  `:stop`) in the Vim box and **Suspend** in the chat's header (on
  a phone too) do the same. The shell's own jobs keep their order: `fg`
  alone takes its current job, and `fg %?roamgate-hold` (or the **fg**
  button, which names it) picks the conversation's. Nothing switches by
  itself: which view a device shows never moves the session. A
  terminal-mode Claude's History is read only, with the switch in its
  header. When the pane's environment has an
  `ANTHROPIC_API_KEY`, the headless Claude uses it only if you said yes to
  Claude Code's own question about it; if you never answered, the chat asks
  the same question (the API key, billed to the API, or your subscription
  login) before Claude starts, messages waiting meanwhile, and files your
  answer where Claude Code keeps it, so the terminal does not ask again.
  In conversation mode replies, tool calls and
  their results appear as they are written; messages sent while Claude works
  wait in Roamgate's queue (taken back or edited as below) and go as one
  turn when it ends; **Stop** interrupts the turn, keeping what was written;
  a command or subagent the turn waits for shows **Background** on its
  block (Ctrl+B in the chat moves all of them, as in the terminal): it
  goes on running, the turn goes on without it, and its block then links
  to it in the background tasks, where a running one shows **Stop**;
  `/compact`, `/clear`, `/cost`, `/context` and `/rewind` work, and other
  terminal-only commands are refused. `/model` opens a picker of the models
  the session's Claude offers, with the other models of its profile's
  endpoint (a gateway's whole list), the current one marked; typing filters
  it or names a model it lacks. `/model <name>` switches at once, a turn
  running or not (that turn keeps its model). The chat says which model it
  is now, or why Claude refused it, and the choice holds when the process
  restarts (idle stop, hand-back) until the session has answered with it.
  `/mcp` opens the session's MCP servers: each one's state, where it comes
  from and its tools, with Reconnect, Enable or Disable (kept for the
  project, in the terminal too) and Sign in for one that needs it. A
  sign-in opens the server's page; from a phone or another machine, paste
  the address that page ends on to finish it. A message starting with `!` runs as a
  shell command, as Claude Code's bash mode does: on the pane's host (over
  SSH for a remote one), in the session's directory, with your login shell.
  The chat shows its output as it comes, its exit code and **Stop**; Claude
  reads the command and its output (the first 30,000 characters of each
  stream) with your next message, without a turn of its own. After a turn,
  Claude Code's guess at your next message (its prompt suggestions, unless
  turned off in your Claude Code settings) shows in grey in the empty box:
  Tab or Right puts it in the box to edit, typing anything else puts it
  away, and nothing is ever sent by itself. A phone shows it as a chip
  above the box that fills it; a voice call shows none. Voice reads each sentence as soon as it is written,
  cleaned as Speak cleans a whole reply: a list item once the next starts, a
  table once it is complete, a code block announced once its fence closes;
  speaking up while Claude only writes interrupts the turn and starts the
  next one, while it runs a tool steers that turn, and "stop" interrupts it.
  **Start claude in conversation mode** (Configuration > Integrations, off
  by default): a `claude` you start by hand in a Herdr pane, here or on an
  SSH host, goes to conversation mode as soon as it is up, with the flags
  it was started with (`--model`, `--permission-mode`, `-c`, `--resume`);
  a prompt given on its command line runs in the terminal first. It stays
  in the terminal when something is typed in its prompt box first, for
  `ROAMGATE_CLAUDE_START=terminal claude`, and for a session just handed
  back. See [Starting claude in conversation
  mode](docs/DEPLOYMENT.md#starting-claude-in-conversation-mode).
  **Agent profiles** (Configuration > Integrations): run Claude Code
  against another backend (an Anthropic-compatible gateway, its models in
  each of Claude Code's model slots, its token in a secret file), picked
  from the gateway's own model list. The default profile starts new
  sessions, conversation mode and Roamgate's own helpers; **Run with:
  <profile>** in a Claude pane's profile menu (the gauge in its toolbar) or
  the command menu moves that session to another profile, keeping its
  history: the terminal's Claude exits and resumes the same session, a
  conversation restarts its process. A chat's header always shows the
  model its agent runs ("Opus 5.5", "Sonnet 5.5", "GLM 5p3"; a Pi or Codex
  session's too) beside its status, its title the whole model id and the
  profile, and follows `/model`, a profile switch or a fallback; a
  terminal's profile chip says the model too, while over a chat only a
  session not on the default shows its model there. When a session hits a usage limit
  ("You've hit your 5-hour limit · resets 5:20pm"), the pane shows
  **Limit · 5:20 PM** (in local time) with **Use <profile>**; its menu
  also has **Retry** (sends `continue` on the same profile, for a limit
  that is over or an account that changed) and **Continue with** each
  profile. The notice goes once a later turn succeeds, after a retry, or
  past the reset time; optionally the session goes back to the default
  after the reset. On a narrow header only the icons stay, their words in
  the titles and the menu. The agent launcher offers **Agent: <profile>**
  for a new session. See [Agent profiles](docs/DEPLOYMENT.md#agent-profiles).
  With Roamgate's Claude Code mod the chip's title and menu also show the
  session's context and plan usage ("Context 34% · 5-hour 61% · weekly
  15%").
  **Resume after a usage limit**: a Claude session that stopped on a usage
  limit (5-hour or weekly; terminal or conversation mode, asleep or not,
  on any connection) shows **Paused · 1:41 AM** in its pane's toolbar, on
  its row in the agents lists and in the phone's tab sheet ("Paused by the
  usage limit, resumes at 1:41 AM"), and at the end of its chat. A minute
  after the limit resets, Roamgate sends it a message (by default: continue
  where you stopped, and restart the background agents and workflows the
  limit stopped) as you would, typed into the idle terminal or queued in
  the conversation, waking it. Only once per reset, and not if you resumed
  it already. **Resume now** sends it at once; **Don't resume** leaves that
  session to you (**Resume at the reset** undoes it). Ranger sees the pause
  too. The switch, the margin and the message are in Configuration >
  Integrations; see [Resuming after a usage
  limit](docs/DEPLOYMENT.md#resuming-after-a-usage-limit).
  A message queued in a Claude chat can be taken back before the agent
  reads it (the cross beside **Queued**) or into the box to edit (the
  pencil); Up in the empty box takes the whole queue back to edit, as in
  Claude Code's prompt. The others stay queued, in order. When Roamgate
  cannot read the conversation process any more, the chat says **Lost the
  conversation process** and why, with **Recover**, which ends that process
  and resumes the session in a new one with the queued messages; messages
  that wait 30 seconds with Claude not at work show the same warning.
  **Stop idle conversations** (Configuration > Integrations, after 30
  minutes by default): a conversation idle that long has its headless
  Claude stopped to free its memory, the pane and its chat staying as they
  are. The next message of any kind (typed, spoken, a review comment, the
  voice companion, Ranger, another agent's) starts it again, with **Waking
  Claude...** in the chat, then goes to it once. Never while Claude works,
  asks you something, runs background work, during a voice call or a
  companion job on it, or within 10 minutes of another session's message.
  A Claude chat rewinds as /rewind does: the arrow beside one of your
  messages restores the code and the conversation, or either, to before
  it, through Claude Code's own rewind menu. The message comes back in the
  box to edit, and the turns undone leave the chat. Your messages the
  rewind cut stay as one "Rewound" line in their place, never as queued
  or current: open it to send one again, or to put it back in the box. /rewind typed in the
  box lists your messages, newest first, to pick one with the arrows or
  j/k and Enter, then the restore's number.
  In conversation mode the headless Claude Code rewinds itself, the code
  included, and the rewind lasts: the terminal, shown later, goes on from
  the same point. A turn running is stopped first if you confirm; queued
  messages must be sent or taken back first. What a rewind takes out is no
  longer read aloud. Restoring the code undoes the edits Claude made with
  its file tools, not what commands changed: when the turns undone edited
  no file, or only before Claude Code kept checkpoints, the code choices
  are off and say why, and the conversation alone is rewound.
  A Claude chat also lists what the session runs on the side (the tasks
  button in its top row, counting those still running; `/tasks` typed in
  the chat; Ctrl+Cmd+T, Ctrl+Alt+Shift+M elsewhere, from the chat or
  over the pane's terminal; or **Show background tasks** in the command
  menu): background
  commands, monitors, subagents, teammates (by name) and workflows, with
  how each ended (or **lost**: no end notice a day later). A command shows
  the end of its output, followed while it runs; a subagent or teammate its
  own conversation; a workflow its phases in order with their progress
  (done ones folded, the running one open, failures marked), each agent's
  state and time, its conversation, and the result. **Follow** keeps the
  running agent in sight until you move or scroll. Each block of tool calls
  that started one links to it. The files a block's calls changed (Edit,
  Write, NotebookEdit) show under it as the terminal shows them, whether
  folded or not: the file, the lines added and removed, and the change
  with its line numbers, its first ten lines and the rest a tap away; a
  call that failed shows none, and one still running shows what it asks.
  A permission card for such a call shows the change it asks to make. In the sheet, `j`/`k` (or arrows) move,
  `g`/`G` go to the first or last, `n`/`N` and `e`/`E` to the next or
  previous running or failed one, `Enter` opens, `h`/`l` fold and unfold a
  phase, `f` follows, `Esc` or `Backspace` goes back and then closes, and
  `?` lists the keys. Closed and opened again, the list comes back where it
  was left in that session (in this browser tab): the task or agent shown,
  the row, the folded phases, the scroll and whether it followed. A task
  opened from its link in the chat goes back to that place.
  A task started in turns a rewind undid stays listed while it runs (a
  teammate also while idle), marked **started in a rewound part**, and
  leaves the list once it ends.
  Once the turn has ended while some of them still run (subagents, running
  teammates, workflows, background commands, monitors), the chat's status
  reads **Idle · 2 subagents running** in its own colour instead of a bare
  Idle, with what runs in its tooltip; clicking it opens the list. An idle
  teammate waiting for a message does not count. Herdr's own status is left
  as it is.
- **Claude Code mod**: Configuration > Integrations > Claude Code mod
  installs, on this machine or an SSH host, a Claude Code mod that runs
  inside each Claude session in a Herdr pane. What Roamgate has for a
  session (review and chat comments, other sessions' messages, companion
  errands, the usage-limit resume, Retry) then arrives as a prompt once
  Claude is idle, never typed into a permission prompt, a menu or your
  draft; a session you stopped with Esc gets it after your next prompt's
  turn. Its status (working, waiting on you, idle), session, model and
  usage come from Claude itself instead of the screen. Sessions without it
  are typed into as before. Every Claude session with the mod, conversation
  mode included, also gets tools to answer review and chat comments, leave
  review comments, tell you to act and message other sessions: Markdown goes
  as written, with no shell quoting, and the comments it gets name the tools
  instead of `roamgate-review` command lines. In Claude, `/rg-review` opens
  Roamgate's review of the branch (or `worktree`, `BASE..HEAD`, `compare OLD
  NEW`, a merge request URL) and `/threads` lists the threads waiting for
  that session's answer. See [Claude Code
  mod](docs/DEPLOYMENT.md#claude-code-mod).
- **Menu > Configuration > Integrations** installs, updates, or removes Herdr's
  bundled agent integrations (not the agents themselves). See
  [version lookup](docs/ARCHITECTURE.md#agent-integrations).

- Session inspection supports **Codex, Claude, Kimi, Grok Build, Pi, OMP, Muse
  Code, and Antigravity CLI**. OMP sessions are discovered across local profiles
  and configured roots, including `PI_CONFIG_DIR` (resolved relative to the
  user's home directory). Remote panes must report the transcript path because
  local profile discovery is never used over SSH. Transcripts must be readable
  by the bridge. Over SSH, Roamgate reads the session path Herdr reports, or
  finds a Claude, Codex or Pi transcript by its ID on the remote host; it never
  searches local files for a remote Claude, Codex or Pi pane. A Claude session
  that went on in a new transcript (a resume or `/clear` that Herdr still
  reports under the old ID) is followed there. Session folders that are
  symbolic links are followed. A Pi pane whose session Herdr does not report
  (no Pi integration) shows the newest session Pi keeps for the pane's
  directory, on this machine or the SSH host. This fallback cannot distinguish
  two Pi panes in the same directory; install Herdr's Pi integration to bind
  each pane to its own session. Muse needs session logging
  enabled (no `--no-session-log`). See
  [History synchronization](docs/HISTORY.md).

## Ranger

Ranger is an **experimental** assistant that answers questions about your
workspaces and can manage them. Open it from the topbar, the mobile **⋮** menu,
or its shortcut.

- **Setup:** connect a model provider in **Settings** (or pick Claude Code,
  which uses the bridge's `claude` sign-in) and choose which
  workspaces Ranger may access (none by default). See
  [model setup](docs/DEPLOYMENT.md#ranger-model-connection). Interrupted Claude
  Code turns stop without automatic retry: review action receipts before
  sending a new question.
- **Ask:** Ranger reads workspace status, agent history, diffs, and terminal
  output, and cites its sources. Type **@** (or use the **@** button) to point
  it at a workspace or agent: the picker lists them, all or by kind, and a pick
  becomes a chip above the message box, sent with the message as a reference.
  Ranger's box is the agent chats' message box, Vim keys included: the picker
  opens as **@** is typed in insert mode, its arrows, Enter and Tab pick, and
  Esc puts it away without leaving insert mode.
  When the model shares its reasoning, a collapsible **Thinking** section shows
  it above the reply.
- **Chat:** Ranger's conversation is an agent chat: Markdown replies with copy
  and speak buttons, search, and the minimap, whose jumps scroll the
  conversation alone. Select words of a reply and **Comment** to open a thread on them, as
  in an agent's chat: Ranger gets the comment in that chat and answers in the
  thread. A chat's comments wait while another chat shows. The microphone
  starts a [voice chat](docs/DEPLOYMENT.md#voice-chat) with Ranger: what you
  say goes to Ranger, its answer is read as it is written, with the acks, and
  its tool use is narrated. Action and task cards show under the reply that
  proposed them.
- **Mobile:** Chat and Tasks share a compact header. History, new chat, and
  settings icons sit beside Close. Ranger uses the bottom Message input while
  open, keeping its draft separate from the terminal draft. Model and thinking
  options open above the input; the message box grows with your draft.
- **Steer or queue:** while Ranger answers, **Enter** (or **Steer**) adds your
  message to the current answer after its next step (with Claude Code, once
  the answer finishes), and **Alt+Enter** (**Option+Enter** on macOS, or
  **Queue**) sends it once the answer finishes. Waiting messages show above the
  message box, where you can edit or remove queued ones; **Up** in the empty
  box takes the last one back to edit.
  After **Stop** they wait until you choose **Send next**.
- **Go to:** asked to go to or open a workspace or agent session, Ranger shows
  it in the browser you asked from, switching connection when needed.
- **Arrange:** asked to group, nest or reorder workspaces in the Workspaces
  list, Ranger reads the arrangement and changes it with the same moves as the
  list itself, across every server, in one change and without asking you to
  confirm, since it only moves rows and can be undone.
- **Act:** Ranger can create workspaces, worktrees, tabs, and splits, and start,
  prompt, or close agents and panes. You confirm each action unless
  **High-permission mode** is on. Closing never deletes files or history.
  A workspace or worktree Ranger creates is one it may use in that chat (and
  that task run) without changing your workspace choice, which a scheduled
  task over it still needs; with **Full access**, workspaces created while
  Ranger answers are in reach too.
- **Schedule:** the **Tasks** view runs a prompt once, daily, or every N minutes
  while the bridge is running, and can notify you when a run finishes or when
  Ranger decides something needs attention.

Conversations are saved on the bridge and shared across your devices. Ranger
has the same [full authority](SECURITY.md#trust-model) as any Roamgate user.

## Git Worktree Lifecycle

Open **Worktree Lifecycle** from a workspace menu or the command menu to:

- Create a worktree from `origin`'s freshly fetched default branch without
  touching the current checkout. Creation stops if the remote is unavailable.
  An optional [worktree command](docs/DEPLOYMENT.md#worktree-command), such
  as `git recworktree add`, can create it instead of Herdr, and a remove
  command, such as `git recworktree remove`, remove it.
- See each worktree's path, branch status, uncommitted changes, and PR/MR badge.
- Focus, pull, configure branch updates, or remove worktrees (with confirmation
  and hooks).

### Worktree Hooks

`roamgate.json` (or legacy `paseo.json`) defines `setup`, `opened`, `teardown`,
and `removed` hooks. **Hooks are on by default and run unsandboxed repository
code** on the connected host; review or disable them under **Worktree hooks**.
A failed teardown stops removal. See
[configuration](docs/DEPLOYMENT.md#worktree-hooks).

### Automatic Branch Updates

Opt in per checkout to fetch and merge `origin`'s default branch every 10
minutes while the workspace is open. Dirty or detached checkouts are skipped,
conflicts are aborted, and nothing is ever pushed.

## File Explorer and Preview

- Browse the tree with Git status badges, hidden-file toggle, and name/glob
  filtering of loaded entries.
- **Browse filesystem** opens read-only browsing outside the checkout.
- Preview text with highlighting and search, Markdown (with Mermaid diagrams,
  centred in the chat's reading column however wide the view; wider tables,
  code and diagrams scroll in their own box), static HTML (workspace CSS/images/fonts; scripts blocked; 512 MiB limit),
  images, PDFs, and audio up to 25 MiB. Browsers without a native PDF viewer
  use a responsive three-page window with previous/next navigation.
- A file written on disk after it was shown says so above the preview
  (**Changed on disk**), locally and over SSH, without reloading by itself:
  `R`, `:refresh` (or **Reload**, or the refresh button) reads it again
  where you are in it, scroll, cursor and threads kept. The check is a stat
  every few seconds while the preview is seen, and at once when an agent step
  completes.
- Upload by drag and drop, download files or folders (`.tar.gz`), copy paths,
  create folders, move files by dragging, and delete with confirmation. All of
  this works over SSH (moves need `python3` on the remote host).
- With [host file reveal](docs/DEPLOYMENT.md#host-file-reveal) enabled, local
  loopback clients can open files in the host's Finder/File Explorer.
- Drag a file into a terminal or the composer to insert its path.

## Workspace threads

**Threads** (in the tab bar, `Cmd+Option+A`, or **⋮** on a phone) lists the
workspace's comments in one panel, independently of the Inspector:

1. **To send**: the comments held for your Send. Selecting terminal text and
   commenting on it holds the comment in the chat review of the agent running
   in that pane, the same review its chat threads are in; a review's `C` with
   no agent pane in the workspace is held here too. Each card says where
   it was written; edit its words, move it up or down, delete it, or go to it
   (its pane, its file or its review). Its words are edited in the comment
   editors' Vim editor while **Vim keys** is on (Esc in
   normal mode leaves it, the words kept as typed).
2. **Send** hands every held comment to the agent pane picked below them in
   one prompt, **Pre-fill** types it into that pane's input or chat message
   box without sending (review it and press Enter yourself), and **Copy** puts
   the same text on the clipboard; without an agent pane, Send copies. The
   agent answers each in its thread. **Go to agent** goes to the pane it was
   sent to, and **Clear held** deletes them all, after asking.
3. **Conversations**: every thread of the workspace's reviews (diffs, files,
   sites, chats, and the terminal comments sent), open ones first, with the
   threads panel's keys: `j`/`k`, Enter goes to the thread in its review,
   `r` resolves, `R` replies, `/` searches, Esc closes.

Comments written in the Files, Changes, Commits and History views go to the
review of what they are on at once (below); they are not held here. A
comment Roamgate cannot save yet stays in this browser and is moved, held
for your Send, on the next load.

## Review

Option+R (Ctrl+Alt+R elsewhere), **Review** in the tab bar, or on a phone **Review** in the ⋮ More options sheet, opens a review of
the focused workspace's branch against its default branch, over the
terminals. That base is the one Changes' Branch scope shows under Automatic
(below), and the review's title names it. Option+Shift+R lists the reviews in progress, the ones with new
commits or discussions waiting on you first. Closing a review only hides
it: Option+R brings it back exactly as you left it (view, place, folds,
drafts), and a workspace's other repositories keep theirs too. On a phone,
Back closes it too, and the header scrolls with Close kept in reach. When the
code changes under an open review it says so; `R`, `gr`, `:e` (or **Reload**) reads it
again, and comments follow their code or show as outdated.

- Comment a line with `c` (to the agent while **Comments → Agent** is on,
  else a review comment) or `C` (always a discussion with the agent working
  on the code; with no agent pane in the workspace, it waits in
  [Workspace threads](#workspace-threads)' To send). A message to the agent or a draft reply on the forge leaves only when
  you save it (`Cmd+Enter`, Save, `:w`); Esc or moving away keeps it unsent
  until you reopen it. Unsent text, and text whose save failed, stays in this
  browser through reloads and connection switches. `t` hides every comment until you show them again, click a
  marked line, or the agent answers; each review opens with them shown.
  **Conversations** (`T`, `:conversations`, or the `N open · M` chip at the
  head's right end) opens a panel on the right listing every thread of the
  review, in any commit and resolved ones too, open ones first and then
  the latest message, and goes to the one you pick; a thread whose commit
  a rebase took out of the review opens in that commit, as long as git
  keeps it. Resolved ones are hidden until `H` (or their count) shows them
  after the open ones, one line each until unfolded; the choice is kept in
  the browser. A click selects
  a thread; `j`/`k` move, Enter or `o` goes, Space folds, `r` resolves or
  reopens (the selection moves to the next open one and the list stays
  where it is), `R` (or `a`, or **Reply**) answers right there, and Esc or `q` closes.
  `/` searches them all (file, author or words), where arrows select,
  Enter goes and Esc returns to the list.
  `gn`/`gN` (or the up and down arrows beside the chip) go to the next or
  previous unresolved thread only, in any file or commit of the review:
  a reviewed or folded file opens, and the thread it is drawn in unfolds.
  Past the last one they wrap around to the first and say so; the arrows
  show where you are ("2 of 5 unresolved"). `gH`, `:unresolved` or the
  filter button beside them shows only the unresolved threads (`n`/`N`
  then skip the resolved ones, and `r` goes on to the next unresolved
  one); the choice is kept in the browser, for agent chats too.
  A long message is read in parts (paragraphs, list items, each code
  line): `n`/`N` select it whole, `j`/`k` step into its parts, and `c` or
  the `+` in a part's margin
  comments on that part, as does **Comment** on words selected with the
  mouse. Each such comment is its own thread, drawn under the part it
  quotes and given to the agent with the quote. `za` folds any thread,
  resolved or not, and unfolds it again; `gl` goes to the last message of
  the thread selected or on the line, and `g;` to the comment written last,
  in any view (in an agent chat too).
  In an agent chat, Claude's messages are in parts too: the `+` in a
  part's margin, or **Comment** on words selected, starts a thread under
  that part. On a phone, the part tapped shows its `+` at its own left
  edge, a finger wide, and **Comment** comes below the selection's
  handles. The threads are the chat's own review: Claude gets them with
  the quote and where it is, answers in them, and you reply, resolve or
  fold them there. The message that hands them over shows as one line.
  They go to the chat's Claude session in whichever pane runs it now.
  When it runs in none, each comment it did not get says so ("Not
  delivered: Claude for this chat is not running in any pane") with
  **Retry**, the comments chip counts them ("1 not delivered"), and they
  go by themselves once the session runs in a pane again.
  The files Claude changed take comments the same way, in their cards
  under the tool blocks: the `+` over a line's number (a tap on the line
  shows it on a phone), **Comment** on lines selected, or the head's
  comment button for the file as a whole. The thread is drawn under its
  last line, and Claude gets it as a review comment on that code: the
  file, the lines as its change numbered them, and their text. A folded
  card shows down to its last thread, and a thread whose lines are no
  longer in the change shows at the card's end with what it quotes.
  From the chat's message box, Up on its first line (or `k` there in
  Vim's normal mode, or Alt+Up) goes up into the conversation: `j`/`k` step through the
  parts of Claude's messages, the lines of the files it changed (each
  card's head first) and the threads under them, `gg`/`G` to the
  first or last, `zz`/`zt`/`zb` place the one you are on, `c` or Enter
  comments on a part or answers a thread, **Reply** on a thread's message
  (or `R` on it) answers that message in a thread on the whole of it,
  drawn under it, `r` resolves, `za` folds, `dd`
  deletes your own comment, `J`/`K` go message by message, `n`/`N` go
  to the next or previous thread, `gn`/`gN` (or the arrows beside the
  comments chip, with "2 of 5 unresolved") to the next or previous
  unresolved one, reading older messages for it if need be, and `gH`
  shows only the unresolved ones,
  and `i` or Esc (or Down past the last one) go back to the box. `T` (or the comments chip at the top
  of the chat) opens the chat's comments, open ones first: `j`/`k` select,
  Enter goes to one, `r` resolves (the selection moves to the next open
  one and the list stays where it is), `H` shows or hides the resolved
  ones, Esc closes.
  A thread stays on its message when the chat is read anew and the
  message comes back with another id (a long transcript read from its
  end): it is found by its time and the words it quotes; a thread on a
  file Claude changed is found by its tool call. Open threads on
  messages not shown are counted beside the chip ("2 on messages not
  shown") and listed in the panel, where Go to it reads older messages
  until it is there.
  Comments are Markdown; paste or drop a screenshot into one and it is
  kept with the review, shown in the comment, and given to the agent as
  a file path it can read. Comments follow their code through rebases and
  show as outdated once it is gone. Discussion comments reach the agent as
  you write them; with **Hold** (`:hold`) they wait until **Send** (`:send`)
  hands them over in one go. Comments go to the agent's session wherever
  it runs now, not to a pane it left. A comment that could not reach the
  agent says so ("not delivered" and why) with **Retry**, and goes by
  itself once the session runs in a pane again. Threads show on their
  lines: a large file with open threads starts unfolded, and a thread on
  unchanged code shows with three lines each side. `e` rewrites your
  last message; the agent hears about the change, and can rewrite its own
  answers too.
  While the agent works on a thread, the thread says so with what it is
  doing and for how long, until it answers there.
- `gf` (or a file's **Open**) opens the file at the cursor line in the
  file preview, as the checkout has it now; the review steps aside until
  Option+R. The preview moves with Vim keys too (`j`/`k`, `gg`/`G`, `/`,
  Ctrl-d/u...) unless `:vim` turned them off, and `:files` (or its button
  beside refresh) hides the file tree next to it, until shown again.
- Vim keys throughout: counts, `gg`/`G`, Ctrl-d/u/f/b, `{`/`}` hunks, `]`/`[`
  files, word motions, `*`/`#` and `/`/`?` search, `:` commands, `zo`/`zO`/`zR`
  to show more context. Comments are written in a Vim editor (`:vim` toggles
  Configuration's **Vim keys**, on every device);
  on touch screens its **Esc** button stands in for the missing key.
  `j`/`k` stop on each message under a line as on a line, so `r`, `e` and `dd`
  act on it there; side by side they go straight down or up on one side, and
  only the left and right arrows change side.
- **Local** and **GitLab**: a local review shows the checkout's diff and only
  your local comments. **GitLab** (the MR chip, `gm`, `:switch`) opens the
  review of the branch's merge request in the same overlay: the diff and
  commits as GitLab has them, its discussions on their lines (older ones
  moved to today's code), and your review comments and overall comment as
  GitLab draft notes, shared with any other tool that writes them. Review
  comments written in the local review (and the agent's draft replies) wait
  there until **GitLab draft (N)** puts them on GitLab as draft notes; you
  submit the review on GitLab. In this mode the head's **Send** (and each
  held comment's) reads **Send to Claude** (the agent's name): it only
  hands your comments and the open discussions to the agent, and nothing
  labelled Send reaches GitLab or GitHub. **Local** goes back to the local review; each keeps its own place.
  A GitHub pull request's conversation comments show as discussions of the
  whole request; GitHub keeps no draft of a reply to them, so they are
  answered on GitHub. Replies to discussions are draft replies too, published only when you
  submit your review on the forge; `r` on a forge discussion only folds it
  here (resolving there is public). Roamgate publishes nothing itself.
  Security merge requests are never shared with agents.
- `<` / `>` (or the arrows of the commit bar) step through the branch's
  commits and its whole change, wrapping around; on the default branch
  itself, through its history, latest first. The bar names the commit shown
  by its subject; clicking it, `gc` or `:commits` opens a list of the
  commits by subject, sha, author and date, the one shown marked: typing
  searches subject words (letters in order too) or a sha prefix, `j`/`k`
  (until you type) or the arrows move, Enter shows it, Esc closes.
  `:commit 2` goes to the second one, `:commit words` to the one matching,
  `:all` back to the whole change. In diff only (`o`) a quiet strip at the
  bottom keeps the commit's name and its arrows, and these keys still work.
- `r` resolves the thread on the line (or the selected message's), and
  reopens a resolved one. On a line without a thread it marks the chunk
  (hunk) there reviewed: it folds to one "chunk reviewed" line and the
  cursor goes on to the next chunk not reviewed, in any file. `r` again
  unmarks it; a click or `za` shows it again (`za` folds it back), and a
  chunk with comments stays open. After `V`, `r` marks every chunk the
  selection covers. `gu`/`gU` (or `:unreviewed`) go to the next or
  previous chunk not reviewed, wrapping around. Resolved threads fold.
- `Option+V` (`Alt+V` on Windows/Linux, or `v`) marks the whole file
  reviewed, as in tuicr: it folds to its header and the file list ticks it;
  `Option+V` again unmarks it and its chunks.
  A file whose every chunk is reviewed is reviewed too; until then the file
  list shows how many are ("3/7 chunks"). Marks are kept per view (all the
  changes, or each commit) and a chunk is known by its changed lines, not
  its place: a rebase or new changes elsewhere keep the marks, while a
  chunk whose own lines change is no longer reviewed, nor its file. The
  same chunk marked in another view counts too, unless unmarked in this one.
- **Several repositories**: a workspace's review covers each repository its
  panes (and the `subprojects/` on a branch, not pinned by a build tool)
  have recent changes in, or that the agent edits or names; `p` searches them (name, branch or path) and `(` /
  `)` step through them. Option+R reopens the repository last reviewed in
  the workspace, else the focused pane's, else the agent's.
- **Agent review** asks the agent in the workspace for review comments, with
  an optional focus. **Send to** hands it the open discussions, and your
  overall comment when it has not had it yet.
- The overall comment is a comment like the others: **Overall comment** (or
  `:overall`) opens the same editor, and it then shows as a card with Edit,
  Delete and whether the agent has it. With comments sent as written, saving
  it sends it.

Agents drive a review with `~/.cache/roamgate/bin/roamgate-review` (open,
watch, reply, add, summary...); `roamgate-review skill` prints how. Where
they exist, Roamgate links its skill into `~/.claude/skills/roamgate-review`
and the client into `~/.local/bin`, never over a file of yours.
`open --repo PATH=BASE..HEAD` adds another repository's range, for a series
across a project and its subprojects. It works in panes on SSH hosts too.

### Commenting on rendered files and sites

Comments happen in place, in the Files preview of the workspace inspector:
Markdown, HTML pages, SVG, images, and any site's page (the **URL** button, or
an agent's `review_open` with `file`/`url`, which opens the same preview).
Select words and comment; with **Point** (or Alt) click a diagram, SVG or
image for a point or drag a box. Animations pause while the comment is
written, and the agent gets the source lines, the words, the region in
fractions of the graphic, the element, the animation's time and a snapshot.
Threads sit under what they are on and in the Comments panel, drawn and
keyed as an agent chat's: resolved ones folded, what is commented on marked.
The stops are the blocks, but each list item (nested ones too) and each table
cell (the header's too) is a stop of its own, in a chat's messages as in the
preview: a comment on one takes its own lines and words, and sits under the
item or under its cell, in the cell's column (under the row, indented and
pointing at the cell, when the column is too narrow for it), a row's threads
by column. An open thread's words are highlighted where they are, even part
of a word or across inline code; words said twice are told apart by the
thread's line. j / k step through the stops and the threads'
messages; in a table they move as in a grid, h / l along a row and j / k down
and up a column. n / N and gn / gN go thread to thread, c comments on a stop,
R answers (on a thread's message, Reply on it or R answers that message in a
thread on the whole of it, drawn under it), r resolves, za folds, dd deletes,
gH shows only the unresolved ones, `g;` goes to the comment written last, T lists them, and a page's frame
hands these keys on.

A file's threads are shared with the code reviews of its checkout (the
branch, a range, its work, a merge request): a comment written on the
rendered file shows on its line in each code review whose changes have the
file, and a comment written on a Markdown, HTML or SVG file in a code review
shows in its rendered view, on the block of its line. Each stays in the
review it was written in, which sends it to the agent once; replying,
resolving and reopening work from either view. A thread finds its line again
by the line's text after the file changes; one on a removed line is listed in
the Comments panel only. A merge request's GitLab discussions and your GitLab
drafts on the file show there too, as the review pane draws them (Draft
reply, Edit, Delete); nothing written on the rendered file becomes a GitLab
draft by itself. A part of a comment takes a thread of its own (+, words
selected, c on a part), as in the review pane and a chat. **Review** in the
preview's bar shows the file in its checkout's code review at the cursor's
line, and **Rendered** beside a file's Open in the review pane shows it
rendered at the cursor's line. `o` or `:only` (or the expand button) hides all the
chrome, in the rendered view and in the source alike; `o`, Esc or Show all
brings it back.

`:` opens the inspector's command line, the review pane's (Tab / Shift+Tab
complete, a command's argument too, Enter runs, Esc or Backspace on nothing
leaves it and gives the focus back), wherever the inspector has the focus:
its tab strip and buttons, the Files tree and preview (the rendered file, a
page's or a site's frame, whose script hands `:` over even for a key the page
handles, Review only, a phone's keyboard), Changes, Commits and History;
never in a comment box, a search box or another field, where `:` is text. In
the Files preview's source view its Vim keys' `:` runs the same commands
(but `:set`, which stays the editor's own there). A preview shown outside
the inspector has the same prompt, with its own commands. The review pane's
prompt is the same one, with the review's commands. Each command does what a
key or a button already does, where that one is; the shown view's come
first, then the inspector's own. `?` (or `:help`) lists them with the view's
keys, filtered as you type; `:help WORD` opens the list filtered:

| Command                             | Does                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `:view NAME` (`:v`)                 | the Files, Changes, Commits or History tab; the start of a name is enough (`:v c` is Changes)                                    |
| `:files`                            | Files, beside a file: hides or shows the file tree (its button); Changes: its changed files' tree; Commits: its commit list      |
| `:only` (`:o`)                      | Changes: Review only, the diff alone over the app; Esc, `:only` or **Show all** bring the inspector back                         |
| `:dock` (`right` / `bottom`)        | the dock button                                                                                                                  |
| `:expand`                           | the expand button, or restore                                                                                                    |
| `:vim`, `:novim`                    | Vim keys in the review, its comments and the previews, on / off (one setting)                                                    |
| `:set vim` / `novim`                | the same                                                                                                                         |
| `:set reviewin=classic` / `changes` | where reviews open: the review pane (the default) or Changes; `:set reviewin` says which. On classic, Changes keeps its own keys |
| `:help` (`WORD`)                    | the shortcut list (`?`), filtered by the word                                                                                    |
| `:q` (`:quit`, `:close`)            | Files: closes the file's tab; elsewhere closes the inspector                                                                     |

The Files tree, its toolbar's:

| Command                      | Does                                  |
| ---------------------------- | ------------------------------------- |
| `:refresh`                   | **Refresh**                           |
| `:hidden` (`on` / `off`)     | **Show hidden files**                 |
| `:newfolder` (`:mkdir`)      | **New folder** in the workspace root  |
| `:browse`                    | **Browse filesystem**                 |
| `:search` (`:find`, `WORDS`) | the search box, filled with the words |

The Files preview, for the file shown (from the tree too):

| Command                                | Does                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| `:only` (`:o`, `:zen`)                 | Review only (`o`)                                                 |
| `:conversations` (`:threads`, `:conv`) | the Comments panel (`T`)                                          |
| `:unresolved` (`:openonly`)            | only the unresolved threads, or all again (`gH`)                  |
| `:next`, `:previous` (`:prev`)         | the next or previous unresolved thread (`gn` / `gN`)              |
| `:comment`                             | a comment on the cursor's block, or an answer to its thread (`c`) |
| `:fold`                                | folds or unfolds the cursor's thread (`za`)                       |
| `:N`                                   | the cursor on the block of line N                                 |
| `:source`, `:rendered` (`:preview`)    | the Source switch                                                 |
| `:scripts` (`on` / `off`)              | **Scripts off** / **Scripts on**                                  |
| `:point`                               | **Point**                                                         |
| `:review`                              | **Review**: the file in its checkout's code review, at the line   |
| `:reload` (`:refresh`, `:e`, `:edit`)  | the refresh button (`R`); `:refresh` here with the focus in it    |
| `:copy`                                | **Copy**                                                          |
| `:url` (`ADDRESS`)                     | **URL**: its form, or that page opened                            |
| `:back`, `:forward`                    | Back and Forward (Alt+Left / Alt+Right, Cmd+[ / Cmd+] on a Mac)   |
| `:q` (`:quit`, `:close`)               | outside the inspector: closes the preview                         |

Changes, its toolbar's and its diff's (a commit's diff in Commits has the
diff's too):

| Command                                | Does                                                           |
| -------------------------------------- | -------------------------------------------------------------- |
| `:scope working` / `branch` / `last`   | the scope switch (Working tree, Against the branch, Last step) |
| `:reload` (`:e`, `:edit`, `:refresh`)  | **Refresh**                                                    |
| `:base BRANCH` (`auto`)                | **Compare against**, scope branch only                         |
| `:next`, `:previous` (`:prev`)         | the next or previous change (the arrows)                       |
| `:find` (`:search`, `WORDS`)           | the find field, filled with the words                          |
| `:diff` (`:s`)                         | **Split** / **Unified**, whichever is not shown                |
| `:split`, `:unified`                   | **Split** / **Unified**                                        |
| `:wrap`                                | **Wrap**                                                       |
| `:conversations` (`:threads`, `:conv`) | the comments chip                                              |

Commits:

| Command                               | Does                                                           |
| ------------------------------------- | -------------------------------------------------------------- |
| `:reload` (`:e`, `:edit`, `:refresh`) | **Refresh commits**                                            |
| `:files`                              | hides or shows the commit list beside the commit (not compact) |
| `:commit N` / `WORDS`                 | the commit of row N, or whose subject or sha has the words     |
| `:more`                               | **Load more commits**                                          |
| `:preview`, `:diff`                   | **Preview at commit** for the file shown, **Back to diff**     |

History:

| Command                               | Does                                        |
| ------------------------------------- | ------------------------------------------- |
| `:reload` (`:e`, `:edit`, `:refresh`) | **Refresh**                                 |
| `:search` (`:find`, `WORDS`)          | the search field, filled with the words     |
| `:chat`, `:timeline`                  | the **Chat view** switch                    |
| `:details`                            | **Session details**                         |
| `:transcript`, `:export`              | **Open transcript**, **Export raw session** |

Where the source view's own Vim keys take the threads' keys, the bar's
hints name these commands instead.

Back and Forward (the arrows at the start of the preview's bar, Alt+Left /
Alt+Right or Cmd+[ / Cmd+] on a Mac, `:back` / `:forward`) work as a
browser's, with the focus in the preview or in a page's frame (its script
hands the keys over): through the files a link in the preview opened and the
pages a page's or a site's frame went to (links, a script's pushState), each
shown again where it was scrolled. Each tab keeps its own history; the
arrows are disabled when there is nothing to go to.

A tab is shown again as it was left: back from Changes, Commits or History,
from another workspace, or after a page reload, the preview has the same
file at the same scroll (a page's frame too), with its cursor, its threads
folded or opened, the Comments panel, the Source switch and its Back /
Forward history. A page the frame had gone to that is not there any more
gives way to the tab's own file, and that place leaves the history; a link
to a page that is not there shows why, with a link back to the tab's file.

Scripts are one choice for every format (Markdown, HTML, SVG, sites): off by
default, always shown in the preview. **Scripts off** in the preview turns them
on for that file; **Always here** adds its folder or site to **Settings,
Instance, Sites we work on**. They always run in a sandbox with no access to
Roamgate; in Markdown only its SVG and raw HTML blocks are framed, the rest
stays commentable by source line. A listed folder's links that start with `/`
start at the site's root: the folder above it where they are found (below
your home folder), or the **Root** set beside the entry in Settings.

Comments written from the Files, Changes, Commits and History views are
threads of the review of what they are on, as the review pane's: the view
draws each under what it is on and lists it in its Comments panel, the focus
stays where you wrote it, and the workspace's agent gets it as that review's
settings say (as you write, or held until Send), answering in the thread. A
click on a block, a list item or a table cell, or words selected in it, puts
the Files preview's cursor there. A comment on terminal text is a thread of
the chat of the agent in that pane, held in [Workspace threads](#workspace-threads)
until you send it with the others (**Send**, **Pre-fill**, **Copy**).

### Agents messaging each other

Agent sessions talk to each other through the same client, across every
connection: `roamgate-review sessions` lists the sessions Roamgate manages
(name, workspace, connection, agent, mode, state, and an address such as
`desktop/w17:p1`), and `roamgate-review message ADDRESS -- TEXT` sends one a
message. A session in conversation mode gets it through Roamgate's queue; a
terminal Claude running Roamgate's Claude Code mod through the mod, as a
prompt once it is idle; another terminal session gets it typed in once it
is idle (never while it asks you something). The receiver is told it comes from another agent, not from you,
that it carries none of your authority and approves nothing, and how to
reply. Both chats show it: **From NAME** in the receiver's, **To NAME** in the
sender's. Only sessions Roamgate manages can send or be addressed, and a
rate limit stops two sessions answering each other in a loop.

## Reviews Inbox

**Menu > Reviews**, the command menu or `Option+M` (`Alt+M`) opens the
merge and pull requests waiting for you, from every GitLab and GitHub host
glab and gh are signed in to on the Roamgate machine (or the hosts listed in
its settings); the same key hides it again. It sits beside the page as
Ranger does, as tall as Ranger's panel, with the same head, list and detail.
Maximized (its head's button) it covers the workspace; Esc hides it as it is,
and it comes back maximized until you restore it (kept in the browser). **To
review** lists the open requests where you are a
requested reviewer, an assignee or mentioned (a pending GitLab to-do, a
GitHub mention); **Mine** lists the requests you opened, open ones and those
merged or closed in the last few days (the closed-review setting);
**Suggested** lists those Claude picked from the projects
you follow, each with why. A row shows the state, the pipeline, what changed
since you last looked (new commits, new comments) and how many drafts you
have pending on the forge. On a phone it fills the screen. **All**, **To
review** and **Mine** above the list (`f`, `:all`, `:review`, `:mine`) show
everything or one side only; the choice is kept in the browser.

**Mine is a status board of your own work**, in lanes saying who it is on
is: **Needs you**, **Waiting**, **Merging**, **Blocked**, **Not proposed
upstream yet**, **Stale** and **Merged or closed**, each with its count; `za` (or a click on
its title) folds a lane, kept in the browser. Each row is one line
(reference, title, chips) and a second line saying the **next step**.
Before anything is set by hand, the lane and the next step come from what
the forge says: a failed pipeline, conflicts, changes requested, unresolved
threads, a needed rebase or a draft put it in Needs you ("Fix the failed
pipeline", "Answer 2 unresolved threads"); otherwise it waits for review
(or, approved, to be merged); no activity for 90 days (the `stale_days`
setting) makes it Stale. Claude then **infers** who it is on and the
next step from the request's threads (the last note of each, who wrote
it, resolved or not), its description and status, and your branches' local
state ("Answer bob on the locking question", "Waiting for bob to
re-review"): marked "inferred" on the row and shown beside what you set by
hand in its details, which always wins. It runs twice a day over what
moved (every 12 hours, the **Your own work** settings, which also name
its model: empty, Sonnet, or any model name), and at once for
one request when someone else answers, a pipeline fails, changes are
requested, it conflicts or it is merged or closed (at most every two hours
a request); your own pushes wait for the next run. `:infer` reads the
selected one again now. References in descriptions and notes (`!12`,
`group/project!12`, request URLs) and a request whose commits are all in
another make it wait for that one, even without the model. A request that waits for another of yours is
drawn under it, indented and joined by a thin tree line, with "after !12" on
it and "blocks N" on its parent, and counts in Blocked; `za` on the parent
folds them. `J`/`K` and drags move a request within its lane (or among the
requests under the same parent); a request changes lane when its whose-move
changes, not by a drag.

**Branches headed upstream** show before any request exists. A group of
the Workspaces tree marked **Headed upstream** (its menu; groups inside it
are too) says its workspaces hold work meant to go upstream; a workspace
there shows **Headed upstream (as GROUP)** in its menu and can say **Not
headed upstream**. A workspace in no such group is marked **Headed
upstream** by itself from its own menu (unchecked again the same way). A
checkout with no remote on one of your forge hosts is left out. Each such
workspace's branch
with commits beyond its target (the `upstream`, else `origin` remote's
default branch) is a row in **Not proposed upstream yet**: its commits,
how far behind it is, changed and unpushed files, and its next step
("Propose 3 commits upstream", "Commit or stash 2 changed files", "Rebase
on origin/main"). `b` (or `:unsent [TITLE]`, or **Will be a request** in its
details) says it will be a request, **not proposed yet**, titled after its
first commit unless you name it; when the request opens on that project
from that branch it takes the row's place in your order and what you set
on it. A branch whose request is open (same branch, or one holding all its
commits by patch id) shows no row: its request says "from BRANCH" and what
is not pushed. Enter and `w` go to its workspace. Branches are read from
the checkouts, at most once a minute; a request's head is fetched into the
clone (`refs/roamgate/mr/N`, never your own branches) only when it moved.

**Upstreaming efforts** follow a large branch commit by commit until all
of it is upstream. Declare one on a group or a workspace headed upstream
(its menu, **Declare an upstreaming effort…**, which from a workspace's
menu starts from that workspace's branch, or `:declare` in Reviews): the
source branch (resolved once to one exact ref of the clone, the local
branch first, refused when only several remote ones fit), its target (`origin/main` unless said), feeders (branches
landing into it) and a name; **Preview** first shows what it holds and the
other efforts or branches holding the same commits, with the proposed
layout (one effort and a feeder, stacked efforts, or shared commits put in
one part only). Its card at the top of Mine shows a bar by disposition and
"N of M upstream"; Enter or `i` opens it maximized, on the tab last shown
there. **Board** (`B`, the first) shows its work as the inbox's own
requests: a card per planned request in columns, side by side on a wide
screen, one list under the columns' titles on a phone. A plan without a
part is **Planned** ("proposed" or "accepted"), one whose part has no
request yet **Not proposed yet** (its branch's row when the inbox has
one), one whose request is open in that request's lane (**Needs you**,
**Waiting**, **Merging**, **Blocked**, **Stale**) drawn with the inbox's
card (number, title, pipeline, approvals, next step, merge-after, home
button), and merged ones in **Done**, folded until you open it. A part's
branch links to its request by name (a request opened from
`you:upstream/<name>` too) or by the patch ids of its commits, from the
requests the inbox already read. Each card says the plan's "after X", its
commits and its part's state (ported, conflict). The inbox's keys work on
it: `j`/`k` from card to card in a column (through every column on a
phone), `h`/`l` between columns, Enter the request's review in its home
(a part with no request: its workspace; a plan with no part: its place in
Plans), `o` on the forge, `e` its next step and who it is on, `w` its
workspace, `za` folds a column, and `c` comments on the card for the
leader. **Progress**
(counts, a burndown, a breakdown by directory, overlaps), **Ledger** (every
commit of `target..source`: `j`/`k`, `x` and `V` select, `/` filters with
words and `disposition:`, `dir:`, `file:`, `author:`, `:mark not-upstream
REASON`, `:supersede REF`, `:plan NAME`, `:unsort`, `u` undoes the last
bulk change, Enter shows the commit's versions across rewords and rebases)
and **Feeders** (their commits not on the source yet, their drift); `B`,
`P`, `L`, `F` switch tabs. A commit upstream under another patch id (reworded,
reworked) gets **proposed matches**: upstream commits since the merge base
touching the same files with a close subject, author and size, scored
locally, shown in its row ("like abc1234 (0.8)") and under the ledger;
`:confirm [N]` makes it upstream by hand pointing at that commit (and adds
it to the commit's versions), `:reject [N|all]` never proposes it again.
`d` takes you to the head workspace and shows the commit's diff in its
Changes, as Enter on a request opens its review in its home (the Reviews
pane hides); in a commit's versions (Enter), pick two and `d` compares
them there, tree to tree (as text in the pane when that workspace is not
open).
**Plans** (`R`) lists the planned requests, each the content of one future
request: the leader session proposes them, you **Accept**, `:split NEW`
(the selected commits out of their plan) or **Drop** them, and `:plan NAME` puts the selected commits in one
(a commit is in one planned request only, across efforts). An accepted
one's **Make its part** (`:part [NAME]`) makes a worktree workspace
through your worktree command, nested under the effort's head workspace
in the Workspaces tree (in the effort's group when it has no head), moves it onto its
base and cherry-picks its commits in order, then folds each `fixup!`,
`squash!` or `amend!` commit into its target (a plan's fixup rows say
where they fold; one whose target is not in the plan stays a commit and
is said). Its base is the part of the plan it depends on (the last one
in source order), or, for a plan made only of fixups of another plan's
commits, that plan's part (refused until that part exists); the target
otherwise. When a local `upstream/<plan name>` branch already holds the
plan's changes over the target, the part starts at its commit instead,
nothing picked, that branch left as it is. When that branch is a port of
the plan (its content differs) sitting on the part's base, the part
starts there too, never with the source's commits: the card says "from
`upstream/<plan name>` (ported: differs from the plan's commits)" and the
result lists the files only in the plan and only in the branch. A conflict stops there and
is reported, left for that worktree's session to resolve. Its branch is
then a request not proposed yet, until its request opens. A part whose
branch was moved by hand (onto a port or a squashed commit) gets
**Refresh part** (`part_create` with `refresh: true` for the leader): it
makes, picks and moves nothing, reads its worktree and the branch it is
on now, and rewrites only the part's record, with Undo: its base, the
`upstream/*` branch at its commit (or the one named by `from`), ported or
not, which fixups it still holds as commits and its stop; the card then
shows that. A worktree or branch gone is refused, saying so; `from` then
names an existing branch to attach the part to (its worktree, or a new
one at a free path, that branch not moved). **What changed**
(`W`, and "N changed" on the card) lists what moved since you last looked:
new unsorted commits, commits landed upstream or now in review, feeders
landed, parts merged, matches to confirm, and commits upstream anyway;
**Seen** (`:seen`) starts it again. A commit is upstream when its patch is in the target
(fetched into `refs/roamgate/upstream/...`, never your own remote-tracking
refs, only when it moved), in review when one of your open requests holds
it, in a part when a branch of the group holds it; what you mark by hand
(not for upstream, superseded, planned) follows the commit across rewording
and rebases. **Leader session** (`gl`) goes to the Claude session of its head
workspace, which leads the effort through the board's tools; with none, it
offers to start one there, and nothing starts it but you.
Comment anywhere in an effort's view, for its leader: select words, or
point at something (a click, `j`/`k`, the ledger's cursor) such as a card
of the Board, a plan card, a commit row of the ledger, a plan or What changed, a count of
Progress, a directory, a feeder or a heading of What changed, then `c` or
**Comment**; `C` comments on the tab. The thread sits under what it is on
(a ledger row shows how many are open on it, its threads under the ledger
when the cursor is on it) and keeps its place across refreshes and
rebases, a commit by its ledger key; one whose item is gone is listed with
the tab's own. It goes to the leader session as review comments do, with
the tab, the item and the words quoted, and the leader answers in the
thread. While no leader session runs, comments wait ("waiting for the
leader session", **Retry**) and go once one does. The heading counts the
open threads; `n`/`N` and `gn`/`gN` go from thread to thread (the open ones,
on any tab), and on a thread `r` resolves or reopens it, `R` replies, `dd`
deletes your lone comment and `za` folds it, as in Changes. `?` lists the
view's keys. **Delete effort…**
in its view (or `:delete`) takes an effort out, a duplicate declared by
mistake for one, after a confirmation naming it: its card, ledger marks,
plans and history leave Reviews and Undo brings them back; its parts'
branches and worktrees stay as they are, and so do the other efforts'
ledgers, even over the same commits.

**Export and import** what you authored in Reviews (the order, pins,
removals, what was set by hand, views, requests not proposed yet, groups
headed upstream, efforts and their ledgers) from the Reviews settings or
with `roamgate reviews export` / `import`: a stable JSON file without
secrets; an import shows what it would change before you apply it
([deployment](docs/DEPLOYMENT.md#export-and-import-of-the-reviews-state)).

**Set it by hand** when you know better: `e` (or **Set by hand** in its
details) edits who it is on (you, the reviewer's, external, or a
person's), the next step, the requests it waits for, labels, a link (a URL,
or a file opened in its workspace's Files preview with `gx`) and stale.
What you set wins and says "set by you" (or "set by Claude" when an agent
set it); once the request moves on (a push, a comment, a state change),
whose-move and the next step show dimmed as "changed since" until you look
again, while labels, links and dependencies never age. `E` clears it all.
The `:` line does the same in a word: `:note TEXT`, `:whose
me|reviewer|external|NAME`, `:after group/project!12`, `:label X`, `:unlabel
X`, `:link URL`, `:stale`, `:clear [FIELD]`. Each change offers Undo, and
is kept in Roamgate's settings (`mr_reviews.overrides`), so every device has
it. Any agent session reads and annotates the board too (`roamgate-review
reviews reviews_list` and `reviews_override`, with the order and pin tools);
what it changes shows on every page with Undo, naming the session ("Claude
in sequence-head set the next step on !12").

One of your own requests shows where it stands: its pipeline, who approved
it, who asked for changes (GitHub), its unresolved threads, conflicts, and
whether GitLab wants it rebased. What changed since
you last looked is marked on those chips and said in the row ("pipeline
failed, approved by bob, 2 new comments", "merged"): a pipeline that changed,
new approvals, conflicts, threads to resolve, a merge or close, new commits
and comments. It stays marked until you look: its details (`i`), its review,
`o` or its workspace. Your requests are never shown "new": only what happens
on them after they first show is. Every open one shows, however old.
They come from a light list per host and refresh, with the costly details read
only for those that changed since (or whose pipeline is still running), served
from the inbox's store at once and read again in the background as the inbox
is; a host that lacks some of the fields
is asked the basic ones (pipeline, conflicts, rebase).

A request's own workspaces, on every connection, are a click away: the
house button on its row (with their count when there are several), its
details' **Workspaces** (each with its connection and why), `w` (`2w`
for the second), or Enter, which goes to the first one and opens the
request's review only when it has none. A workspace is a request's when its checkout is on the
request's source branch, or tracks it, in a clone of the project (or of a
fork of it), when its name carries the request's number (`!12`, `#12`,
`mr-12`) or branch, or when it is the request's review workspace. The
target's branch never counts. With none, `w` says so and goes nowhere. These
are read from your workspaces and their checkouts, at most once a minute per
connection; never from the forge.

The list is in your order: drag a request by its grip, or select it and
use its up and down buttons (on a phone) or `J`/`K`, within its section.
**Scheduled merges and merge bots** show on your own requests. A label
that schedules the merge after a delay ("Merge after: 2 days",
"merge-after: 1 week", "merge after 3d") gives a chip "merge after 2 days ·
mergeable Thu 14:00", counted from when the label was added (else the last
approval, else the last update; the chip's tooltip and the details say
which): the request waits on time in **Waiting**, then goes to Needs you
("Mergeable: the merge-after delay passed") the moment the time passes. A
request a merge bot is merging (Marge-bot, bors, Mergify, Kodiak, assigned
or as a reviewer), with a queue label, in GitHub's merge queue (with its
position) or with auto-merge set goes to **Merging** ("queued to merge by
marge-bot"). A failed attempt (the bot's note "I couldn't merge this
branch: CI failed!", the bot unassigning itself, a removal from the merge
queue) puts it in Needs you with the bot's reason as the next step. These
facts win over what Claude infers; what you set by hand still wins over
them. The patterns, bot names, failure notes and queue labels are settings
(**Scheduled merges and merge bots** in the Reviews settings, one per line,
the defaults shown when empty), with scopes for a host, a group
(`host/group/*`) or a project replacing the lists there ("Off here" turns
a detection off). Roamgate only reads: it never assigns a bot, sets
auto-merge or posts anything.

Your order is kept in Roamgate's settings (`mr_reviews.order` in
`settings.json`), so it is the same after a reload and on every device, and
it wins over the inbox's own sort in every section, Suggested included. A
change made on any device (a drag, `J`/`K`, or the reviews agent) shows on
all the others at once, without losing your selection, scroll or a drag in
progress; a new request comes first. The search
box (`/`) narrows the list to the requests whose title, project, author,
number (`!123`, `#45`), branches, labels or next step hold every word typed,
and reads GitLab-style tokens: `project:group/name` (or `group/*`),
`label:x` (the forge's labels and yours), `waiting:me|reviewer|external|NAME`,
`lane:needs-you|waiting|merging|blocked|not-sent|stale|done`
(`lane:your-move` still works),
`state:open|draft|merging|merged|closed`, `merge-after:yes|no|waiting|ready`,
`bot:NAME|any|queued|failed`, `waiting:time`, `stale:yes`, `draft:yes|no`, `author:NAME`,
`pipeline:failed|running|success`, `is:mine|review|pinned|suggested|unread`;
`-` before a token or word excludes it, and several values of one key match
any of them. Tab and the arrows complete keys, then values taken from the
list (projects, labels, people). `:save NAME` keeps the search as a **saved
view**: a chip after All, To review and Mine, on every device (Roamgate's
settings, `mr_reviews.views`, at most 20); `f` and `F` cycle all the chips,
`:view NAME` shows one and `:delview NAME` deletes it. Agent sessions create
and delete views too (`reviews_view`), and `reviews_list` takes the same
filter.

**Add** and **remove** requests from the view. `p` opens a one-line prompt
where the `:` command line opens (on a phone, the head's **+** button) that
takes the URL of any merge or pull request on one of your hosts, or
`group/project!12`: Enter adds it, Esc closes it. `:add URL` (or `:pin URL`)
does the same; a request's URL pasted in the search offers **Add this
request**, which Enter takes (or goes to the request when the list has it),
and pasting a URL anywhere else in the panel, or dropping a link on it,
adds it at once. It goes into a **Pinned**
section above For you, read from the forge, and stays there whether or not
a query lists it, with its state, pipeline and what changed like any row.
One the forge does not give (not found, no access, host down) shows why,
with a button to remove it. `P` (or the pin button of the selected row, its
details' **Pin**, `:pin`) pins any request of the list on top without a
call to the forge; `P` again (or `:unpin`) puts it back where a query lists
it, and the toast's Undo takes either back. Pinned requests keep your order and answer the
search. Removing a request (`dd` or `Delete`, `x` on a request that is not a
suggestion, or the row's button) unpins a pinned one; any other one is
hidden until something happens on it (a push, a comment, a state change),
and an **N hidden** chip (`H`) lists the hidden ones with Restore. `u` right
after takes the removal back (a toast offers it for a few seconds). `x` on
a suggestion stays "not interested". Pins and hidden requests are kept in
the settings (`mr_reviews.pinned`, `mr_reviews.hidden`), so every device
follows. The keys, as in Roamgate's other lists (`?` lists them, and so
does the shortcut cheat sheet):

| Key                      | Action                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `j`/`k`, Down/Up         | Next / previous request; a count repeats (`3j`)                                                                                       |
| `gg`/`G`, Home/End       | First / last (`2G`: the second)                                                                                                       |
| `zz` / `zt` / `zb`       | Show the selected request in the middle, at the top, at the bottom of the list                                                        |
| `Enter`, a click         | Its review in its home (the first); with none, in the project's review workspace                                                      |
| `i`                      | Its details                                                                                                                           |
| `c`                      | Its Claude session                                                                                                                    |
| `o`                      | Open it on GitLab or GitHub                                                                                                           |
| `w`                      | Go to its workspace (`2w`: the second), on its connection                                                                             |
| `P`                      | Pin it on top, or unpin it                                                                                                            |
| `e` / `E`                | Set by hand (who it is on, next step, waits for, labels, link) / clear it                                                             |
| `b`                      | A branch headed upstream will be a request (not proposed yet), or back                                                                |
| `za`                     | Fold the requests under it, or its lane                                                                                               |
| `gx`                     | Open its link (a URL, or a file in its workspace)                                                                                     |
| `gH`                     | Start a review with a home: its own workspace and a Claude told its job (`:home`)                                                     |
| `h`/`l`, Tab/Shift+Tab   | On a wide pane (columns): the column on the left / right                                                                              |
| `f` / `F`                | Next / previous of all, to review, mine and your saved views                                                                          |
| `:`                      | A command: `note`, `whose`, `after`, `label`, `unlabel`, `link`, `stale`, `clear`, `pin`, `unpin`, `all`, `review`, `mine`, `refresh` |
| `J`/`K`, Alt+Down/Alt+Up | Move it down / up in your order (`3J`)                                                                                                |
| `/`                      | Search; in the box Enter opens, Esc clears and goes back                                                                              |
| `p`                      | Add a request: a prompt to paste its URL in (Enter adds, Esc closes; `:add URL` too)                                                  |
| `dd` / `Delete`          | Remove it from the view (a pinned one is unpinned)                                                                                    |
| `u`                      | Undo the last change (a removal, a pin, what was set by hand, an agent's change)                                                      |
| `H`                      | The hidden requests, to restore                                                                                                       |
| `x` / `+`                | Not interested / more like this (a suggestion); `x` on another request removes it                                                     |
| `r`                      | Refresh                                                                                                                               |
| `a`                      | Ask the reviews agent                                                                                                                 |
| `?`                      | List the keys                                                                                                                         |
| `Esc`                    | Step back: the key list, the search, then hide the panel (maximized or not)                                                           |

**A request's home** is a workspace of its own: one on its branch, one named
after it ("!3326"), or one made for it. Enter, a click and **Review** open
its review in its home's Changes (the first; the others are in its details),
its head fetched there; only a request with no home opens in the project's
shared review workspace below. **Start a review with a home** (`gH`,
`:home`, the row's button on a request without one, or its details) makes
one: a worktree through your worktree path (your `worktree_command`, else
Herdr's) on the request's branch name at its head, named after the request
("!3326 rtpgccbwe: Fix..."), placed where the project's reviews go in the
Workspaces tree, with the review shown there and a Claude session started
in it and told its job: this workspace is the home of that review; review it
with Roamgate's review tools, read the forge discussions, draft comments as
your pending drafts (only you send them), never post to the forge, and keep
its notes there. The text is a setting (Reviews' settings, **Review homes**;
`{url}`, `{ref}`, `{title}`, `{author}`, `{target}`, `{source}`,
`{project}` take the request's) and shows in the button's tooltip. The board
remembers the home (`mr_reviews` state), so the request goes there from now
on; git only fetches from the forge.

**The search and the filter are kept**: reopening the panel, reloading the
page or restarting shows the search you left (`project:gstreamer/*`), on
your other devices too (`mr_reviews.panel`); Esc or clearing the box empties
it everywhere. A saved view whose search it is shows selected.

**On a wide pane** (maximized, or any width that fits two columns of 420 px)
the lanes show side by side as a board: each lane, and To review, Pinned and
Suggested, a column with its title and count that scrolls on its own;
requests waiting for another stay nested under it in its column; a folded
lane is a narrow column, an empty Suggested none. The board scrolls sideways
when there are more columns than fit, so the lanes keep their order on one
line. `j`/`k` stay in a column, `h`/`l` and Tab go across at the same
height, `zz` centers in its column; the add box, search and filters span the
top, the efforts' cards too. Narrow panes and phones keep the one list.

Opening a request gives each project one review worktree,
`<your clone>.worktrees/review`, shown as a **Reviews · project**
workspace, and opens the request's review there, GitLab merge requests and
GitHub pull requests alike. The worktree checks out the request's head,
detached, at once or only when you browse its files (a setting); nothing is
built. If it has local changes you are asked: keep them as a WIP commit on
a `review/<number>` branch, or discard them; leaving it as it is changes
nothing. Your clone is found among your workspaces' checkouts by its
remote, on the default connection first (the review worktree and its
workspace go there), then on the others; with none, the inbox asks where it
is and remembers it (Reviews' settings list and forget those, and can forget a project's
review worktree: its next review makes a new one, the old one stays for
you to remove). While the
default connection is down, a project's first review waits for it. In the
Workspaces sidebar a review workspace has a pull request mark, and its
second line shows the request checked out (`!12846 pitch: ...`) rather
than a detached commit, whatever you named it. A new
review workspace goes into the Workspaces tree where the project's
setting says (a path such as `gst > reviews`, matched by name and made
when missing), else into a "Reviews" group under the clone's workspace,
else into a top-level "Reviews" group; one you moved is never moved again. Heads of the inbox's
requests are fetched in the background, so switching is just a checkout.
Each request keeps its own review, with its place and drafts. A request's
review state goes a few days (a setting) after it is merged or closed; the
worktree stays. The command menu finds a request by number or title.

Each review workspace has one Claude, and each request its own Claude
session. **Review with Claude** (a request's details) starts or resumes
the request's session there and asks it to review through the review pane:
it reads the request and leaves its threads in the review, where you
answer them; its threads stay Roamgate notes, never forge comments. **Ask
Claude** (`c` in the list) takes you to the request's session. Claude
starts there in the mode the claude start setting says; in conversation
mode, switching request moves the pane's conversation to the other
session through conversation mode itself, never by exiting it. Opening
another request's review resumes that request's session, after the
checkout; a Claude in the middle of a turn is never stopped: you switch
when it is done, or leave it on its request. A Claude you started there
yourself is left alone. Nothing starts Claude or asks it to review but
your click.

In a request's review your comments are drafts on the forge: GitLab draft
notes, or comments of your pending GitHub review (its overall comment is
the pending review's body). Editing or deleting one there changes the
forge draft, and drafts written on the forge show up in the review. The
review's head shows **N drafts on GitLab** (or GitHub), a link to the
request: you submit your review there; Roamgate has no submit button and
never publishes anything. Claude's threads stay Roamgate notes until you
choose **Make it mine** on one: its text becomes your draft on the forge
(Claude's review comment is then yours, its discussion resolved).

**Suggested** is picked by Claude in the background, rarely and in
batches: among the followed projects' open requests that are not yours, it
picks the few you would want, from your own history (what you committed
to in your clones lately, your unmerged branches), the requests you
reviewed and with whom, your hints, and your feedback: `x` (not
interested) and `+` (more like this) are remembered and given to it as
precedent. It only filters; it never reviews or comments. Only requests
updated in the last 30 days (a setting) are considered, and a request is
ranked again only when its head or title changes. Turn it off in the
settings.

**Chat** (or `a` in the inbox) talks with the reviews agent: ask "anything
new on GES or the RTP stack?", "find MRs touching validate" or "why did you
suggest !12967?". It answers from your inbox, your suggestions and why each
was picked, your history in your clones, your hints and feedback, and
read-only searches on the forges, and shows what it looked at under **Work
performed**. Asked to, it suggests a request, records your x / +, changes
your hints, or opens a request's review; it never comments, drafts or
approves anything on a forge. It can also arrange your list: "put aisuneko's
MRs at the top" moves just those to the top of their section (Pinned, For
you and Suggested stay separate lists; pinning puts one above all), and
"sort the suggestions by score", "after !123" and add, remove or restore
requests work the same. A toast says what moved ("Claude moved 3 requests to
the top") with Undo (`u`), on every device that shows the panel. In the chat `i` (or Enter) goes to the message
box and Escape back to the inbox; questions sent while it answers wait their
turn; **New chat** starts over. With the voice companion, say "ask the
reviews agent..." (or just ask about requests to review): its answer is
told on the call and kept in its chat.

The inbox only reads: one GraphQL query per host every 5 minutes while it is
shown (15 otherwise), through the same per-host budget as the forge chips.
Its settings (gear) hold the hosts, the followed projects, when the review
worktree follows the selected request, how long a closed request's review
is kept, and hints for the suggestions.

## Diff Viewer

- Compare **Working tree**, **Against branch**, or **Last step** (the latest
  completed agent turn; not proof of which agent made the change).
  Branch comparisons detect the recorded repository default (including `master`
  and custom names), and let you choose a comparison branch per repository.
  **Automatic** takes the newer of the local default branch and its remote
  counterpart: `origin/main` when the local `main` is behind it, the local
  one when it is ahead (unless it is checked out), and when they diverged
  the one whose merge-base with the branch is newest. **Against** and
  **Compare against** name the base chosen. Option+R and an agent's review
  use the same base; when it moves (a stale `main` caught up, say) the
  branch's review follows it with its comments. A comment under a branch
  picked in Compare against goes to that base's own review.
  Inspection uses local refs only and never fetches from a remote.
- Side-by-side or unified view, search, syntax highlighting, and image previews.
  Generated and very large files start collapsed.
- Stage, unstage, mark resolved, discard, or delete from file/folder menus.
  Destructive actions require confirmation and are rejected if the file changed.

## Mobile and PWA

- **Configuration > Appearance > Layout** selects Automatic, Mobile, or Desktop
  (`?layout=mobile|desktop|auto` overrides it).
- Agent panes have a **Chat** button immediately to the right of **Direct**
  in the bottom bar. It opens Agent History for reading and replying in a
  conversation, without adding a row above the content. Chat is the default
  history view; a saved timeline preference is still respected.
- Mobile agent sessions initially open in Chat. Each agent pane keeps its
  own Chat or Terminal choice, remembered on this browser across switching
  sessions and reloading; a pane never switched opens in Chat.
  Shell panes open in Terminal.
- The bottom bar holds **Message…**, **Direct**, **Chat** (for agent panes), **Workspaces**, **Tabs** (with the workspace's
  tab count, red when another agent needs you) and **⋮**, a menu of views and tools: Chat, Terminal,
  Files, Changes, Commits, Threads, Ranger, and Workspaces.
  **Workspaces** sits beside **Tabs**, for switching workspaces in one tap;
  **Tabs** shows only while the workspace has more than one tab or pane
  (**New tab** is in **⋮**).
- The phone's workspace list opens on the recent ones, most recent first,
  as the switcher lists them, so the previous one is the second row; **All**
  shows the whole tree. It opens again on the list it showed last in that
  browser. Its search matches as the pane switcher's does
  (workspace, tab, directory or agent name, across connections): while it
  holds text, the matching workspaces replace the list.
- Mobile hides the top tab strip. Use **Tabs** in the bottom bar to switch,
  create, or close tabs. Tabs with multiple panes list their panes underneath;
  select a pane to open it directly, including across tabs. The current pane is
  highlighted, without a separate pane-switching toolbar above the terminal.
- Touch scrolls without opening the keyboard. Long-press selects text for
  **Copy**, **Add comment**, or link actions.
- Floating terminal shortcuts (a `2×8` grid plus side buttons) are customizable
  under **Configuration > Behavior > Mobile terminal shortcuts** and can be
  dragged to either edge.
- **Message…** is the editable draft in the bottom bar, with IME,
  dictation, images, and multiline input. Tapping it raises the keyboard and
  reveals **Attachment**, **Keyboard shortcuts**, and **Commands**, in that
  order. Tools expand above the same field, without a separate Composer dock.
  **Insert** adds text without submitting it; **Send** submits it with the
  agent's submit key (Enter by default). The terminal button beside Message
  activates **Direct** (keys go straight to the terminal).
  File and image uploads in Direct paste their paths into the terminal without
  Enter; in Message they insert into the draft. If the original Direct target
  changes during an upload, its paths stay in that pane's draft with a warning.
  Several files (or a chat's images) upload three at a time, keep the order
  they were picked in, and show "Uploading 3/8" over a thin bar; a chat shows
  each image's thumbnail once it is up. A file that fails is named in the
  error and the others are kept. A chat message takes at most 20 images, said
  as soon as more are picked.
  Message is the agent chats' message box with Vim keys while **Vim keys**
  is on (on unless turned off): insert mode first, an
  **Esc** button for the phone keyboard's missing key, `:w` sends; Insert,
  Send, Direct, Commands, uploads and drops work as in the plain box.
  While editing a multiline draft (including visual wraps), Message expands
  and temporarily hides Direct, Chat, Tabs, and **⋮**. Leaving the field restores
  the single-line preview and navigation; tapping Message resumes editing.
  Drafts stay in the field when collapsed. Sends, scrolling, and shortcut
  actions leave a dismissed keyboard closed.
  Files and Workspaces keep only the bottom input/navigation row. Ranger Chat
  uses that input for Ranger; its History, Tasks, and Settings keep navigation
  without terminal input. Returning to Terminal restores the tools and
  shortcuts as left, without changing the draft/caret or reopening the keyboard.
  Ordinary Tabs and **⋮** popups keep the underlying page's input-tool visibility.
- The phone's Back gesture or button closes Tabs or **⋮**, then the visible input
  tools or a mobile view such as Workspaces, Files, Changes or Ranger, one per
  press, before leaving the page. Hidden input tools do not intercept a view's Back.
- **Agent terminals** beside Message appears only in ordinary shell terminals
  on mobile, not existing agent or pad terminals. Selecting an agent sends its
  launch command to the current terminal and presses Enter. Start from an empty
  shell prompt and Message draft. A failed send retains the command in Message.
  Use the pencil beside any agent to edit its command, including arguments or a custom
  executable, even when its default command is not detected on the server.
  Commands are saved in this browser per connection and agent; **Reset** restores
  the detected command. Agent status reporting uses its existing Herdr integration.
- **Agent submit keys**: **Configuration > Integrations** sets each agent's
  **Submit key** (Enter, Shift+Enter, Alt+Enter, Ctrl+Enter or
  Cmd/Super+Enter), the key composer and chat messages to it end with,
  kept in this browser. Shells and other agents keep Enter. A modified key
  only submits if the agent binds it (oh-my-pi: `super+enter` to
  `tui.input.submit`).
- The **Commands** button in the input toolbar offers slash commands for
  Claude Code, Codex, Pi, Kimi Code, Grok Build, and Antigravity CLI.
- Install as a PWA for an app-style window; see
  [installation steps](README.md#install-as-a-pwa). **A PWA is not offline
  access**: Roamgate must stay reachable.
- **Configuration > Instance > Title suffix** names each server (for example
  `Roamgate · Home`); see [instance naming](docs/DEPLOYMENT.md#pwa-instance-names).

## Remote, Multi-Client, and Operations

- Save local and SSH connection profiles; each browser selects independently
  and reopens the connection it was last on, or the default if it is gone.
  Linux/macOS bridges can reach Unix or Windows SSH hosts. See
  [connection setup](docs/DEPLOYMENT.md#multiple-and-remote-herdr-connections).
- Task notifications for input-required and completed agents, delivered by
  [Web Push](docs/DEPLOYMENT.md#web-push-notifications) even with the page
  closed. Delivery is best-effort.
- Themes, accents, interface scale (80–150%), terminal font, font size, and
  terminal color themes. Preferences sync across tabs in the same browser.
- A black background option turns the dark theme pure black with neutral
  greys, and the default dark terminal with it; with the default accent,
  highlights are grey too.
- Run as a [user service](docs/DEPLOYMENT.md#run-as-a-user-service) with
  checksum-verified updates, and probe `/health` or `/healthz`.
- An open page reloads itself when the server serves another frontend build:
  checked when it reconnects or comes back to the foreground, every five
  minutes, and when voice chat fails. Message box drafts (attached images
  included) come back after it. It waits for uploads and submissions to finish,
  a pause in typing, and a pause in a voice call (the call goes on); an open
  dialog closes with it once the page has been left alone two minutes, and
  text typed elsewhere holds it until cleared. While it waits, a notice says
  why and offers to reload now.
- An opt-in [activity log](docs/activity.md) records which workspace had your
  attention on each device, agent states, idle time and recording gaps, never
  terminal contents. Turn it on in
  [settings](docs/DEPLOYMENT.md#activity-log).
- **Activity** (one entry in the command menu and the application menu, or
  `Option+A` / `Alt+A`, Zen mode included) opens the activity timeline, a day of
  that log: a lane for you, coloured per workspace (Herdr's TUI focus hatched,
  only where no browser or phone had your attention), idle time hatched grey
  and disconnects in red, then a lane per workspace with its agents' working
  (green) and blocked (red) stretches. Hover or tap a band for the workspace,
  times, duration and source. Below, a table totals attended, working and
  blocked time per workspace; click a workspace to go to it. Step through days
  with the arrows or **Today**; today refreshes every minute. Drag across the
  hours to zoom to them, or zoom around the pointer with Ctrl/Cmd + wheel or a
  pinch; zoomed, drag the lanes (or scroll sideways) to pan, and the ticks go
  down to 5 minutes. **Work hours** fits your first to last attention, **Full
  day** shows it all, **Reset** goes back; the timeline and the Hours strip each
  keep their zoom while it is open, across Workspaces, Subjects and Hours. **Subjects**
  gathers the workspaces under their [subjects](docs/activity.md#subjects)
  (groups of the Workspaces tree, else folders under `activity.subject_roots`)
  and colours them per subject. With a
  [time-report provider](docs/time-report.md), the table's **Project** column
  says where each workspace's (or subject's) time goes, split between several projects if need be; click it to correct.
- **Hours** (the timeline's **Hours** tab, with a
  [time-report provider](docs/time-report.md); searching the command menu for
  "hours" opens it there) shows a day's time
  to report as one line per project and task type: the time to report
  (worked time rounded up to whole 15 minutes, as `h:mm`), whether it is
  pending, accepted or submitted, and the day's total; time still waiting for
  an answer is a line of its own. **Accept** on a line accepts its proposed
  blocks. A line opens (click, Enter, or `za`) on its blocks: questions
  answered in place (the model's guess first; every answer is recorded,
  **Remember** makes it stick), blocks to accept, edit, split, delete or
  explain. **Timeline** opens the provider's cleaned timeline with the blocks
  over it, and the gaps to claim. Submitting is a
  click only: **Preview submit** (off while questions are open) shows exactly
  what would be written, then a confirmation with **I checked these entries**
  sends it. The full view works on a phone.
  `roamgate activity` prints the same totals in a terminal
  ([command line](docs/activity.md#command-line)).
- [Command-line tools](docs/DEPLOYMENT.md#command-line-management) such as
  `roamgate doctor`, `url --qr`, `config`, `auth`, and `connections`.

**Normal runtime requires login, including on loopback, and login grants full
terminal/file access.** Read [Security](./SECURITY.md#trust-model) before
sharing access.

## Keyboard Shortcuts

On desktop, press `Cmd+Shift+K` (`Ctrl+Alt+Shift+K` on Windows/Linux) or choose
**Menu > Shortcut cheat sheet** for a filterable overview. Edit bindings under
**Menu > Configuration > Behavior > Keyboard shortcuts** (up to three per
action, with JSON import/export).

App shortcuts also work from a message box (an agent chat's composer or its
Vim box, a terminal's composer, a review comment) whenever the key edits no
text there: `Cmd+K`, `Option+A` or `Option+F` do, typing, moving, deleting,
copying and undoing keys stay the box's.

Presets live on the Roamgate server, so every browser you open shares them and
a change reaches the others at once; each browser keeps a copy so bindings work
before the connection is up. A preset records the platform it was written for
and is skipped, with a note, on a browser that does not match.

| Action                                                                | macOS / iOS             | Windows / Linux / Android               |
| --------------------------------------------------------------------- | ----------------------- | --------------------------------------- |
| Command menu                                                          | `Cmd+K`                 | `Ctrl+Alt+K`                            |
| Shortcut cheat sheet (desktop)                                        | `Cmd+Shift+K`           | `Ctrl+Alt+Shift+K`                      |
| Sidebar                                                               | `Cmd+B`                 | `Ctrl+Alt+B`                            |
| Workspace Inspector                                                   | `Cmd+Shift+B`           | `Ctrl+Alt+Shift+B`                      |
| Expand / restore Inspector (desktop)                                  | `Cmd+Option+Enter`      | `Ctrl+Alt+Shift+Enter`                  |
| Workspace threads                                                     | `Cmd+Option+A`          | `Ctrl+Alt+A`                            |
| Ranger                                                                | `Cmd+Option+Shift+A`    | `Ctrl+Alt+Shift+A`                      |
| Call the voice companion                                              | `Cmd+Option+V`          | `Ctrl+Alt+V`                            |
| Ask the companion in writing, without a call                          | `Cmd+Option+Shift+V`    | `Ctrl+Alt+Shift+V`                      |
| Activity timeline                                                     | `Option+A`              | `Alt+A`                                 |
| Reviews inbox                                                         | `Option+M`              | `Alt+M`                                 |
| Zen mode (desktop)                                                    | `Cmd+Shift+Z`           | `Ctrl+Alt+Z`                            |
| Recent pane switcher                                                  | `Ctrl+Tab`              | `Ctrl+Alt+J`                            |
| Search panes                                                          | `Alt+K`                 | `Alt+K`                                 |
| Show / hide the Space's overlay tab                                   | `Option+F`              | `Alt+F`                                 |
| Maximise / restore the overlay tab                                    | `Option+Shift+F`        | `Alt+Shift+F`                           |
| Focus terminal input (desktop)                                        | ``Ctrl+` ``             | ``Ctrl+` ``                             |
| Create / close tab or pane                                            | `Cmd+T` / `Cmd+W`       | `Ctrl+Alt+T` / `Ctrl+Alt+W`             |
| Previous / next tab                                                   | `Cmd+Option+Left/Right` | `Alt+Shift+Left/Right`                  |
| Focus neighboring pane                                                | `Cmd+Ctrl+Arrow`        | `Ctrl+Shift+Arrow`                      |
| Move pane (swap with neighbor)                                        | `Cmd+Ctrl+Shift+Arrow`  | `Ctrl+Alt+Shift+Arrow`                  |
| Split right / down                                                    | `Cmd+D` / `Cmd+Shift+D` | `Ctrl+Alt+D` / `Ctrl+Alt+Shift+D`       |
| Zoom / restore pane                                                   | `Cmd+Shift+Enter`       | `Ctrl+Alt+Enter`                        |
| Claude pane's background tasks                                        | `Cmd+Ctrl+T`            | `Ctrl+Alt+Shift+M`                      |
| Move what a conversation's turn runs to the background (chat)         | `Ctrl+B`                | `Ctrl+B`                                |
| Suspend a conversation to its shell (chat; `fg` resumes it)           | `Ctrl+Z`                | `Ctrl+Z` (box empty or Vim normal mode) |
| Numbered tab                                                          | `Ctrl+1…9`              | `Ctrl+Alt+1…9`                          |
| Numbered command menu action                                          | `Option+1…9`            | `Alt+1…9`                               |
| Workspaces                                                            | `Ctrl+Shift+W`          | `Ctrl+Alt+O`                            |
| File Explorer                                                         | `Cmd+Shift+E`           | `Ctrl+Alt+E`                            |
| Diff Viewer                                                           | `Ctrl+Shift+G`          | `Ctrl+Alt+G`                            |
| Review of this branch (open / close)                                  | `Option+R`              | `Ctrl+Alt+R`                            |
| Reviews in progress                                                   | `Option+Shift+R`        | `Ctrl+Alt+Shift+R`                      |
| Agent history                                                         | `Cmd+Shift+H`           | `Ctrl+Alt+H`                            |
| Search raw preview / diff                                             | `Cmd+F`                 | `Ctrl+F`                                |
| Send composer / add review comment / pre-fill agent (focused surface) | `Cmd+Enter`             | `Ctrl+Enter`                            |
| Copy the comments to send (in Threads)                                | `Cmd+Shift+C`           | `Ctrl+Shift+C`                          |
| Copy terminal selection                                               | `Cmd+C`                 | `Ctrl+Shift+C` / `Ctrl+Insert`          |
| Terminal paste                                                        | `Cmd+V`                 | `Ctrl+V` (also `Ctrl+Shift+V` on Linux) |
| Open terminal links / file paths                                      | `Cmd+Click`             | `Ctrl+Click`                            |

On Linux/Android, new tab is `Ctrl+Alt+Shift+T`, split right is
`Ctrl+Alt+Shift+D`, and split down is `Ctrl+Alt+Shift+S`, avoiding
desktop-reserved keys. Browsers and OSes may intercept some shortcuts; rebind
them or use the menus. Plain `Ctrl+C` always goes to the terminal.
