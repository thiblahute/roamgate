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
- Desktop **Zen mode** hides app chrome so the terminal fills the window.
- Toggle **all connections** in the workspaces panel to list every ready
  connection's workspaces, each connection a group in a fixed order. Selecting a
  workspace or agent on another connection switches to it; drag, pins, and
  context menus stay with the connection you are on. A connection that stops
  answering keeps its last list and shows the error beside it.

When a pane on an SSH connection prints a `localhost` URL, clicking it offers to
**forward the port** over SSH (to the same port number when free) and opens the
forwarded address. **Forward a port** in the command menu does the same. The
connection switcher lists the ports your own processes listen on, on either
side, and forwards either way: a remote port brought here, or a local one exposed
to the remote so processes there, agents included, can reach it. Active forwards
are listed with a stop button. Forwards bind loopback only, close with their
connection, and are offered only when Roamgate runs on the machine you browse
from.

Each browser keeps its own workspace and tab selection on endpoint connections;
older (legacy) connections share navigation. Pane focus, layout, and terminal
sizes within a tab are always shared. See
[compatibility](docs/DEPLOYMENT.md#herdr-compatibility).

### Recent Pane Switcher

Switch between the 12 most recently focused panes across tabs and workspaces.
On macOS hold Ctrl and press Tab (Shift reverses); release the modifier or press
Enter to switch, Esc to cancel. Press K to switch to search mode.
Pressing the shortcut twice comes back to the pane it started from, whichever
connection that pane is on.

With **all connections** on in the workspaces panel, other connections' panes
follow yours, labelled with their connection: one per workspace here (the one
most recently used there), every pane in search. Selecting one switches to that
connection and focuses the pane. With the toggle off the switcher covers only
the connection you are on.

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
name/status. All terms must match, in any order. Enter switches; `Alt+K` or Esc
closes.

With **all connections** on, search covers every pane of every connection, so
typing a workspace, agent, or connection name finds it wherever it lives.

## Full Browser Terminal

- Server-rendered terminals with full keyboard input, IME, CJK punctuation, and
  multiline paste.
- Scroll with wheel, trackpad, touch, or page shortcuts. Mouse-aware apps
  receive clicks and drags; hold Option (macOS) or Shift to select text instead.
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
- The **PR/MR status** card in **Changes** and **Commits** shows the branch's
  GitHub pull request or GitLab merge request: state, checks, and reviews. It
  needs `gh` or `glab` authenticated on the checkout host and never changes
  anything remotely. If a refresh fails, it keeps the last known request marked
  **Last known**. A detached checkout resolves a request only while a branch
  rebase is in progress.

Inspector state is scoped to each checkout; see
[resource ownership](docs/ARCHITECTURE.md#workspace-resource-ownership).

## Agent Awareness and Session Inspection

- See recognized agents and their working/blocked/done/idle status in the
  sidebar, switcher, command menu, Agent panel, and notifications.
- Choose nested, **Separate**, or **Compact** agent views with optional
  attention-first ordering and grouping.
- **Agent History** shows the latest 200 conversation entries with search, a
  minimap, and tool details. The **Chat view** toggle reads them as
  conversation bubbles with rendered replies and collapsible tool-call blocks
  that follow new output, plus a message box that types into the agent's
  terminal and shares the pane's terminal composer draft. Paste images or use
  **Add images** to choose them on desktop or mobile; images show as `[Image #N]`
  with a thumbnail until you send. Enter sends and Shift+Enter adds a line; on
  touch keyboards Enter adds a line and the Send
  button sends. On phones the box replaces the terminal composer dock while
  the chat is open. Sending to a working agent queues the message (it shows as
  **Queued** in the conversation until the agent takes it); sending to a blocked agent or one in
  an unknown state first shows where the text will land and needs **Send
  anyway**. The timeline view adds User/Agent/Tool filters. Exports are always
  complete. **Session Inspector** adds metadata, a timeline, raw/ATIF
  transcripts, and export.
- An agent pane can show its conversation **as a chat** instead of its
  terminal, which keeps running underneath: the chat button in the pane's
  toolbar, Ctrl+Cmd+M (Ctrl+Alt+M elsewhere), or on a phone the chat button
  beside the tabs in the bottom bar (or **Chat view** in More options). The
  chat takes the whole pane, with one slim row for the agent's status,
  search, **Stop** (Esc) and the way back to the terminal; on a phone it
  stands for the top bar, which hides, and its message box sits in the bottom
  bar, taking the whole width on its own line while you write, above its
  buttons and the navigation. The message box has
  Vim keys with the review's `:vim` setting (insert mode first, `:w` sends;
  on touch screens an **Esc** button stands in for the missing key). While the agent works, its own word for
  it on its screen (Claude Code's "Sublimating… 1m 5s") shows above the box;
  when it is blocked, what it asks on its screen shows there, with its
  numbered choices as buttons.
  An agent pane opens as a chat as soon as its agent starts; **Open agents
  as a chat** in Configuration > Behavior turns that off. Each pane
  remembers the view it was switched to. With Roamgate's permission hook (see
  [Deployment](docs/DEPLOYMENT.md#permission-prompts)), what an agent asks
  leave to do shows in its chat, or as a card over its terminal, with
  **Allow**, **Always** (the terminal's don't-ask-again rules) and **Deny**,
  and its multiple-choice questions as a form (one choice, several, or one's
  own words), a sheet of its own on a phone; **In the terminal** hands either
  back, and the terminal asks anyway once the hook stops waiting.
  With [voice chat](docs/DEPLOYMENT.md#voice-chat) set up, the microphone
  beside the message box talks hands-free: speak, and what you said is sent
  once you pause; the agent's answer is read aloud (its prose, not code or
  tables), in its language (English, French, Spanish...), then it listens
  again; speaking up while it reads stops the reading and is heard. It
  listens while the agent works too: each further message said is sent,
  queued behind the others, and the answer read is the one to the last.
  The agent's messages are read as it works, each once it is complete, so
  progress is heard; at the end, only what was not read yet is. A
  pause of 2.5 s sends what was said, or a tap at once. Only a tap, or
  saying just "stop" ("arrête", "para"...), ends
  it (while it waits, or listens before anything was said); a tap while it
  reads stops the reading and listens. It keeps listening through silence,
  waits while the agent asks something on screen, and reconnects on its
  own. Only one thing reads aloud at a time, and on a phone other apps'
  music or podcasts pause while voice chat is on.
  Its mute button, beside it while voice chat is on, stops listening without
  ending it: replies are still read, and what was being said when it was
  pressed is sent, as a tap would.
  With a speaker model set up, the first voice heard in a voice chat (its
  first two seconds of speech) is the one listened to; other people talking
  nearby are left out.
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
  asks which one. A question about another session ("what is IGA-184 up
  to?") is answered aloud with a short summary of its conversation, without
  switching, as is one about work it owns (its merge request, CI, branch).
  A question about the sessions in general ("what did I work on today?")
  gets a short summary across the recently active ones. Talk about
  Roamgate itself goes to the session working on
  Roamgate. A question or errand about nothing in your sessions (the news,
  a WhatsApp message) goes to the session in your errands folder, without
  switching; its answer is read and shown when it comes. Talk to someone
  else in the room is held as above. What the
  router says (a switch, its question, a summary) also shows in its own
  card above the message box, labelled Roamgate, never in the conversation
  with the agent.
  Voice chat follows you between workspaces (sidebar, Find workspace,
  shortcuts, the phone's switcher): the workspace you go to shows its agent's
  chat (the pane on screen when it is an agent, else its most recently used
  one) and the conversation goes on there; what was held stays with the
  pane it was said to, and only one voice chat listens at a time. A
  workspace with no agent is not switched to: Roamgate says so and asks
  whether to move anyway; "yes" or Move switches and turns voice off for
  the keyboard, anything else or Stay keeps voice where it was, and the
  answer is never sent to the agent.
  What is heard shows above the message box as it is said (with Parakeet,
  updated about every second).
  Replies are read a little faster than the voice's own pace (1.2x); the
  speed button on the voice card steps through 1x, 1.1x, 1.2x, 1.3x and
  1.5x, from the sentence playing on, and every browser keeps it.
  The sentence being read is highlighted. What is said goes to the agent
  marked `[Voice]`, with the sentence it cut short when it interrupted the
  reading, so the agent knows it talks live and what was heard; the chat
  shows that as a label on the message.
  Any of the agent's messages can also be read aloud on its own (its speaker
  button, beside Copy); starting voice chat while one is read lets it play
  on, until you talk over it.
  A message queued in a Claude chat can be taken back before the agent
  reads it (the cross beside **Queued**) or into the box to edit (the
  pencil); Up in the empty box takes the whole queue back to edit, as in
  Claude Code's prompt. The others stay queued, in order.
  A Claude chat's top row says what its session is about: the name given
  with /rename, else the title Claude Code wrote for it.
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
- **Menu > Configuration > Integrations** installs, updates, or removes Herdr's
  bundled agent integrations (not the agents themselves). See
  [version lookup](docs/ARCHITECTURE.md#agent-integrations).

Session inspection supports **Codex, Claude, Kimi, Grok Build, Pi, Muse Code,
and Antigravity CLI**. Transcripts must be readable by the bridge. Over SSH,
Roamgate reads the session path Herdr reports, or finds a Claude, Codex or Pi
transcript by its ID on the remote host; it never searches local files for a
remote pane. Muse needs session logging enabled (no `--no-session-log`).
See [History synchronization](docs/HISTORY.md).

## Ranger

Ranger is an **experimental** assistant that answers questions about your
workspaces and can manage them. Open it from the topbar, the mobile **⋮** menu,
or its shortcut.

- **Setup:** connect a model provider in **Settings** (or pick Claude Code,
  which uses the bridge's `claude` sign-in) and choose which
  workspaces Ranger may access (none by default). See
  [model setup](docs/DEPLOYMENT.md#ranger-model-connection).
- **Ask:** Ranger reads workspace status, agent history, diffs, and terminal
  output, and cites its sources. Type **@** to point it at a workspace or agent.
  When the model shares its reasoning, a collapsible **Thinking** section shows
  it above the reply.
- **Steer or queue:** while Ranger answers, **Enter** (or **Steer**) adds your
  message to the current answer after its next step, and **Alt+Enter**
  (**Option+Enter** on macOS, or **Queue**) sends it once the answer finishes.
  Waiting messages show above the message box, where you can edit or remove
  queued ones. After **Stop** they wait until you choose **Send next**.
- **Go to:** asked to go to or open a workspace or agent session, Ranger shows
  it in the browser you asked from, switching connection when needed.
- **Act:** Ranger can create workspaces, worktrees, tabs, and splits, and start,
  prompt, or close agents and panes. You confirm each action unless
  **High-permission mode** is on. Closing never deletes files or history.
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
  images, PDFs, and audio up to 25 MiB.
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
code changes under an open review it says so; `R` (or **Reload**) reads it
again, and comments follow their code or show as outdated.

- Comment a line with `c` (to the agent while **Comments → Agent** is on,
  else a review comment) or `C` (always a discussion with the agent working
  on the code). A message to the agent or a GitLab reply leaves only when
  you send it (`Cmd+Enter`, Save, `:w`); Esc or moving away keeps it unsent
  until you reopen it. `t` hides every comment until you show them again, click a
  marked line, or the agent answers; each review opens with them shown.
  **Conversations** (`T`, `:conversations`) lists every thread of the
  review, in any commit and resolved ones too, open ones first and then
  the latest message, and goes to the one you pick; a thread whose commit
  a rebase took out of the review opens in that commit, as long as git
  keeps it. Resolved ones show as one line until unfolded. A click selects
  a thread; `j`/`k` move, Enter or `o` goes, Space folds, `r` resolves or
  reopens, `R` (or `a`, or **Reply**) answers right there, and Esc or `q` closes.
  `/` searches them all (file, author or words), where arrows select,
  Enter goes and Esc returns to the list.
  A long message is read in parts (paragraphs, list items, each code
  line): `n`/`N` select it whole, `j`/`k` step into its parts, and `c` or
  the `+` in a part's margin
  comments on that part, as does **Comment** on words selected with the
  mouse. Each such comment is its own thread, drawn under the part it
  quotes and given to the agent with the quote. `za` folds any thread,
  resolved or not, and unfolds it again; `gl` goes to the last message of
  the thread selected or on the line.
  Comments are Markdown; paste or drop a screenshot into one and it is
  kept with the review, shown in the comment, and given to the agent as
  a file path it can read. Comments follow their code through rebases and
  show as outdated once it is gone. Discussion comments reach the agent as
  you write them; with **Hold** (`:hold`) they wait until **Send** (`:send`)
  hands them over in one go. `e` rewrites your last message; the
  agent hears about the change, and can rewrite its own answers too.
  While the agent works on a thread, the thread says so with what it is
  doing and for how long, until it answers there.
- `gf` (or a file's **Open**) opens the file at the cursor line in the
  file preview, as the checkout has it now; the review steps aside until
  Option+R. The preview moves with Vim keys too (`j`/`k`, `gg`/`G`, `/`,
  Ctrl-d/u...) unless `:vim` turned them off, and `:files` (or its button
  beside refresh) hides the file tree next to it, until shown again.
- Vim keys throughout: counts, `gg`/`G`, Ctrl-d/u/f/b, `{`/`}` hunks, `]`/`[`
  files, word motions, `*`/`#` and `/`/`?` search, `:` commands, `zo`/`zO`/`zR`
  to show more context. Comments are written in a Vim editor (`:vim` toggles);
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
- `v` marks the file reviewed, as in tuicr: it folds to its header and the
  file list ticks it, until `v` again or its diff changes (a rebase or new
  changes elsewhere keep it). `r` resolves the
  thread on the line (or the selected message's), and reopens a resolved
  one; on a line without a thread it marks the file reviewed too.
  Resolved threads fold.
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
- The bottom bar holds **Message…**, **Direct**, **Tabs** (with the workspace's
  tab count, red when another agent needs you) and **⋮**, a menu of views and tools: Terminal, Files,
  Changes, Commits, Annotations, History, Ranger, and Workspaces.
  **Workspaces** sits beside **Tabs**, for switching workspaces in one tap.
- The phone's workspace list opens on the recent ones, most recent first,
  as the switcher lists them, so the previous one is the second row; **All**
  shows the whole tree. Its search matches as the pane switcher's does
  (workspace, tab, directory or agent name, across connections): while it
  holds text, the matching workspaces replace the list.
- Touch scrolls without opening the keyboard. Long-press selects text for
  **Copy**, **Add comment**, or link actions.
- Floating terminal shortcuts (a `2×8` grid plus side buttons) are customizable
  under **Configuration > Behavior > Mobile terminal shortcuts** and can be
  dragged to either edge.
- **Message…** is the editable draft in the bottom bar, with IME,
  dictation, images, and multiline input. Tapping it raises the keyboard and
  reveals **Attachment**, **Keyboard shortcuts**, and **Commands**, in that
  order. Tools expand above the same field, without a separate Composer dock.
  **Insert** adds text without Enter; **Send** adds Enter. The terminal button
  beside Message activates **Direct** (keys go straight to the terminal).
  File and image uploads in Direct paste their paths into the terminal without
  Enter; in Message they insert into the draft. If the original Direct target
  changes during an upload, its paths stay in that pane's draft with a warning.
  While editing a multiline draft (including visual wraps), Message expands
  and temporarily hides Direct, Tabs, and **⋮**. Leaving the field restores
  the single-line preview and navigation; tapping Message resumes editing.
  Drafts stay in the field when collapsed. Sends, scrolling, and shortcut
  actions leave a dismissed keyboard closed.
  Secondary pages (including Ranger settings, Files, and Workspaces) keep only
  the bottom input/navigation row. Returning to Terminal restores the tools and
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
- The **Commands** button in the input toolbar offers slash commands for
  Claude Code, Codex, Pi, Kimi Code, Grok Build, and Antigravity CLI.
- Install as a PWA for an app-style window; see
  [installation steps](README.md#install-as-a-pwa). **A PWA is not offline
  access**: Roamgate must stay reachable.
- **Configuration > Instance > Title suffix** names each server (for example
  `Roamgate · Home`); see [instance naming](docs/DEPLOYMENT.md#pwa-instance-names).

## Remote, Multi-Client, and Operations

- Save local and SSH connection profiles; each browser selects independently.
  Linux/macOS bridges can reach Unix or Windows SSH hosts. See
  [connection setup](docs/DEPLOYMENT.md#multiple-and-remote-herdr-connections).
- Task notifications for input-required and completed agents, delivered by
  [Web Push](docs/DEPLOYMENT.md#web-push-notifications) even with the page
  closed. Delivery is best-effort.
- Themes, accents, interface scale (80–150%), terminal font, font size, and
  terminal color themes. Preferences sync across tabs in the same browser.
- Run as a [user service](docs/DEPLOYMENT.md#run-as-a-user-service) with
  checksum-verified updates, and probe `/health` or `/healthz`.
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

Presets live on the Roamgate server, so every browser you open shares them and
a change reaches the others at once; each browser keeps a copy so bindings work
before the connection is up. A preset records the platform it was written for
and is skipped, with a note, on a browser that does not match.

| Action | macOS / iOS | Windows / Linux / Android |
| --- | --- | --- |
| Command menu | `Cmd+K` | `Ctrl+Alt+K` |
| Shortcut cheat sheet (desktop) | `Cmd+Shift+K` | `Ctrl+Alt+Shift+K` |
| Sidebar | `Cmd+B` | `Ctrl+Alt+B` |
| Workspace Inspector | `Cmd+Shift+B` | `Ctrl+Alt+Shift+B` |
| Expand / restore Inspector (desktop) | `Cmd+Option+Enter` | `Ctrl+Alt+Shift+Enter` |
| Annotations | `Cmd+Option+A` | `Ctrl+Alt+A` |
| Ranger | `Cmd+Option+Shift+A` | `Ctrl+Alt+Shift+A` |
| Zen mode (desktop) | `Cmd+Shift+Z` | `Ctrl+Alt+Z` |
| Recent pane switcher | `Ctrl+Tab` | `Ctrl+Alt+J` |
| Search panes | `Alt+K` | `Alt+K` |
| Focus terminal input (desktop) | ``Ctrl+` `` | ``Ctrl+` `` |
| Create / close tab or pane | `Cmd+T` / `Cmd+W` | `Ctrl+Alt+T` / `Ctrl+Alt+W` |
| Previous / next tab | `Cmd+Option+Left/Right` | `Alt+Shift+Left/Right` |
| Focus neighboring pane | `Cmd+Ctrl+Arrow` | `Ctrl+Shift+Arrow` |
| Move pane (swap with neighbor) | `Cmd+Ctrl+Shift+Arrow` | `Ctrl+Alt+Shift+Arrow` |
| Split right / down | `Cmd+D` / `Cmd+Shift+D` | `Ctrl+Alt+D` / `Ctrl+Alt+Shift+D` |
| Zoom / restore pane | `Cmd+Shift+Enter` | `Ctrl+Alt+Enter` |
| Claude pane's background tasks | `Cmd+Ctrl+T` | `Ctrl+Alt+Shift+M` |
| Numbered tab | `Ctrl+1…9` | `Ctrl+Alt+1…9` |
| Numbered command menu action | `Option+1…9` | `Alt+1…9` |
| Workspaces | `Ctrl+Shift+W` | `Ctrl+Alt+O` |
| File Explorer | `Cmd+Shift+E` | `Ctrl+Alt+E` |
| Diff Viewer | `Ctrl+Shift+G` | `Ctrl+Alt+G` |
| Agent history | `Cmd+Shift+H` | `Ctrl+Alt+H` |
| Search raw preview / diff | `Cmd+F` | `Ctrl+F` |
| Send composer / add review comment / pre-fill agent (focused surface) | `Cmd+Enter` | `Ctrl+Enter` |
| Copy review feedback (in Annotations) | `Cmd+Shift+C` | `Ctrl+Shift+C` |
| Copy terminal selection | `Cmd+C` | `Ctrl+Shift+C` / `Ctrl+Insert` |
| Terminal paste | `Cmd+V` | `Ctrl+V` (also `Ctrl+Shift+V` on Linux) |
| Open terminal links / file paths | `Cmd+Click` | `Ctrl+Click` |

On Linux/Android, new tab is `Ctrl+Alt+Shift+T`, split right is
`Ctrl+Alt+Shift+D`, and split down is `Ctrl+Alt+Shift+S`, avoiding
desktop-reserved keys. Browsers and OSes may intercept some shortcuts; rebind
them or use the menus. Plain `Ctrl+C` always goes to the terminal.
