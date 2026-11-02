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
  When a view with its own header fills the top of the screen (the review, a
  pane's chat), those two buttons sit at the end of that header instead of
  hanging over it.
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
  are restored per connection and checkout.
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
  that follow new output, plus a message box that types into the agent's
  terminal and shares the pane's terminal composer draft. Paste images or use
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
  waits on a question, with **Show the question** and **Dismiss it**.
  With [voice chat](docs/DEPLOYMENT.md#voice-chat) set up, the microphone
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
  sent and it listens again. Only one thing reads aloud at a time, and on a phone other apps'
  music or podcasts pause while voice chat is on.
  Its mute button, on the call bar, stops listening without
  ending it: replies are still read, and what was being said when it was
  pressed is sent, as a tap would.
  With a speaker model set up, the first voice heard in a voice chat (its
  first two seconds of speech) is the one listened to; other people talking
  nearby are left out. With recordings of your voice set up
  (`speaker_reference`), yours is the one listened to from the start, even
  when music, a reply or someone else is heard first, and in each language
  you recorded.
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
  1.5x, from the sentence playing on, and every browser keeps it.
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
  chat stops the conversation as a job of the pane's shell, as Ctrl+Z
  stops a program there: the pane shows its terminal with the shell's
  prompt (no Claude runs; the session is saved), a line over it says what
  stopped, and `fg` typed there (or the line's **fg** button) brings the
  conversation back as it was, in the chat. Ctrl+Z never takes undo from a
  message box: it stops the conversation only with the box empty, in Vim's
  normal mode, or on a Mac (where undo is Cmd+Z); `:suspend` (`:sus`,
  `:stop`) in the Vim box and **Stop to the shell** in the chat's header (on
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
  `/compact`, `/clear`, `/cost`, `/context` and `/rewind` work, and other
  terminal-only commands are refused. A message starting with `!` runs as a
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
  that started one links to it. In the sheet, `j`/`k` (or arrows) move,
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
- Preview text with highlighting and search, Markdown (with Mermaid diagrams),
  static HTML (workspace CSS/images/fonts; scripts blocked; 512 KiB limit),
  images, PDFs, and audio up to 25 MiB. Browsers without a native PDF viewer
  use a responsive three-page window with previous/next navigation.
- Upload by drag and drop, download files or folders (`.tar.gz`), copy paths,
  create folders, move files by dragging, and delete with confirmation. All of
  this works over SSH (moves need `python3` on the remote host).
- With [host file reveal](docs/DEPLOYMENT.md#host-file-reveal) enabled, local
  loopback clients can open files in the host's Finder/File Explorer.
- Drag a file into a terminal or the composer to insert its path.

## Review Annotations

Open **Annotations** independently of the Inspector.

1. Comment on diff lines, source lines, rendered Markdown, or selected terminal
   text.
2. Edit and reorder comments, then copy them or pre-fill an agent's input.
   **Pre-fill never submits**; review and press Enter yourself.

Drafts stay in this browser and re-anchor to changed files on refresh.

## Review

Option+R (Ctrl+Alt+R elsewhere), **Review** in the tab bar, or on a phone **Review** in the ⋮ More options sheet, opens a review of
the focused workspace's branch against its default branch, over the
terminals. Option+Shift+R lists the reviews in progress, the ones with new
commits or discussions waiting on you first. Closing a review only hides
it: Option+R brings it back exactly as you left it (view, place, folds,
drafts), and a workspace's other repositories keep theirs too. On a phone,
Back closes it too, and the header scrolls with Close kept in reach. When the
code changes under an open review it says so; `R`, `gr`, `:e` (or **Reload**) reads it
again, and comments follow their code or show as outdated.

- Comment a line with `c` (to the agent while **Comments → Agent** is on,
  else a review comment) or `C` (always a discussion with the agent working
  on the code). A message to the agent or a GitLab reply leaves only when
  you send it (`Cmd+Enter`, Save, `:w`); Esc or moving away keeps it unsent
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
  From the chat's message box, Up on its first line (or `k` there in
  Vim's normal mode, or Alt+Up) goes up into the conversation: `j`/`k` step through the
  parts of Claude's messages and the threads under them, `gg`/`G` to the
  first or last, `zz`/`zt`/`zb` place the one you are on, `c` or Enter
  comments on a part or answers a thread, `r` resolves, `za` folds, `dd`
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
  end): it is found by its time and the words it quotes. Open threads on
  messages not shown are counted beside the chip ("2 on messages not
  shown") and listed in the panel.
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
  there until **GitLab draft (N)** sends them; you submit the review on
  GitLab. **Local** goes back to the local review; each keeps its own place.
  Replies to discussions post publicly. Security merge requests are never
  shared with agents.
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

## Diff Viewer

- Compare **Working tree**, **Against branch**, or **Last step** (the latest
  completed agent turn; not proof of which agent made the change).
  Branch comparisons detect the recorded repository default (including `master`
  and custom names), and let you choose a comparison branch per repository.
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
  Files, Changes, Commits, Annotations, Ranger, and Workspaces.
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
- An open page reloads itself when the server it reconnects to, or comes back
  to, serves another frontend build. It waits for editable fields to be cleared,
  dialogs to close, and pending uploads and message submissions to finish.
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
| Annotations                                                           | `Cmd+Option+A`          | `Ctrl+Alt+A`                            |
| Ranger                                                                | `Cmd+Option+Shift+A`    | `Ctrl+Alt+Shift+A`                      |
| Activity timeline                                                     | `Option+A`              | `Alt+A`                                 |
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
| Stop a conversation to its pane's shell (chat; `fg` there resumes it) | `Ctrl+Z`                | `Ctrl+Z` (box empty or Vim normal mode) |
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
| Copy review feedback (in Annotations)                                 | `Cmd+Shift+C`           | `Ctrl+Shift+C`                          |
| Copy terminal selection                                               | `Cmd+C`                 | `Ctrl+Shift+C` / `Ctrl+Insert`          |
| Terminal paste                                                        | `Cmd+V`                 | `Ctrl+V` (also `Ctrl+Shift+V` on Linux) |
| Open terminal links / file paths                                      | `Cmd+Click`             | `Ctrl+Click`                            |

On Linux/Android, new tab is `Ctrl+Alt+Shift+T`, split right is
`Ctrl+Alt+Shift+D`, and split down is `Ctrl+Alt+Shift+S`, avoiding
desktop-reserved keys. Browsers and OSes may intercept some shortcuts; rebind
them or use the menus. Plain `Ctrl+C` always goes to the terminal.
