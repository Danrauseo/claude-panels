# Claude Panels

A small Mac app that runs several Claude Code sessions side by side in one window.

## Installing it

The easiest way is to let Claude Code do it. Open Terminal, start `claude`, and paste:

```text
Install Claude Panels for me by following https://github.com/Danrauseo/claude-panels/blob/main/INSTALL.md
```

Claude checks your Mac, downloads the code, builds the app for your Mac's chip, signs it on your Mac, and puts it in your Applications folder. [INSTALL.md](INSTALL.md) has the steps it follows, and you can run them yourself too.

You need macOS 13 or newer, Node.js 18 or newer, Apple's command line tools, and Claude Code. Claude Code 2.1.232 or newer is needed for `@` between sessions.

### Signing

The app is built and signed on your own Mac, so macOS opens it without warnings. `npm run create-cert` makes a "Claude Panels Signing" certificate on your Mac, and macOS asks for your password once to trust it. Without a certificate, the app gets a basic (ad-hoc) signature, which also works on that Mac.

To sign with a certificate you already have, put its name in `build/signing-identity.local` or in the `CLAUDE_PANELS_SIGNING_IDENTITY` environment variable.

The app is not notarized by Apple, so a copy built on one Mac and sent to another will be blocked there. Each person should build their own copy.

### Updating

New versions are published as [GitHub releases](https://github.com/Danrauseo/claude-panels/releases). The app checks for a newer release when it starts and every six hours, and you can check yourself with **Claude Panels > Check for Updates**. When there is one, an **Update to v…** button appears in the top bar. Click it to see the release notes. The app then downloads that version, rebuilds and signs itself, and restarts with your terminals back where they were. This takes a few minutes.

The app updates from the folder you downloaded it to, so keep that folder. If you have changed files in it, the update stops rather than overwrite your changes.

Copies installed before release updates were added need one manual update. Quit the app, then run this in the folder you downloaded it to:

```bash
git pull && npm install && npm run install-app
```

For quick testing without installing, run `npm start`.

### Publishing a new version

Commit and push your changes, then run one of these. Each one bumps the version, tags it, pushes it and publishes a GitHub release with the changes since the last release as its notes. It needs the GitHub CLI (`gh`) signed in.

```bash
npm run release            # 0.1.0 -> 0.1.1, for fixes
npm run release -- minor   # 0.1.4 -> 0.2.0, for new features
npm run release -- major   # 0.9.0 -> 1.0.0
```

Add `--notes notes.md` to use your own release notes.

## Shortcuts

| Shortcut | What it does |
| --- | --- |
| ⌘N | New terminal |
| ⌘K | Find an open terminal or a past session. Open terminals are listed first, and choosing one takes you to it |
| ⌘↓ | Show the sessions this terminal mentioned with @, one at a time, full window |
| ⌘⇧↓ | Show this terminal and every session it mentioned side by side, hiding the others. Press it again, or ⌘↑, to show all terminals |
| ⌘← ⌘→ | Move between those mentioned sessions |
| ⌘↑ | Go back to the terminal you started from, or from the group view to all terminals |
| ⌘S | Stack view of open harnesses. Press it again to show all terminals |
| ⌘R | Resume the terminals you had open when the app last closed |
| ⌘O | Choose a folder for a new terminal |
| ⌘⇧C | Copy Claude's whole last reply, however long |
| ⌥ drag | Select text in the terminal for ⌘C, even while Claude Code is using the mouse |
| ⌘U | Choose files and add their paths to the selected terminal. You can also drag files onto a terminal |
| ⌘F | Make the selected terminal fill the window. Press it again to show all terminals. While one fills the window, ⌘1 to ⌘9 switch which one |
| ⌘W | Close the selected terminal |
| ⌘1 to ⌘9 | Jump to a terminal, or in the stack view open a harness |
| ⌘L | Put the last panel at the bottom or on the side when an odd number are open |
| ⌘, | Settings, which also lists these shortcuts |
| Shift+Enter | New line in Claude |

## Starting Claude in a harness

A harness is a saved folder with a short name. Each new terminal opens with a text box.

- Type `/` to see your harnesses, then pick one with the arrow keys and press Enter. For example `/notes` starts Claude in your notes folder.
- Type `/add notes` and press Enter to choose a folder and save it as `/notes`.
- `/browse` opens a folder chooser and `/home` starts in your home folder.
- You can also paste a folder path, or pick a recent folder.

Claude uses the CLAUDE.md and settings it finds in the folder you start it in. You can also add and remove harnesses in Settings.

## What each terminal shows

Each terminal's top bar shows its number, a light, its harness and what the session is about:

- **The light** is green while Claude is working, orange when it is waiting for you, and grey once the session has ended.
- **What it is about** comes from a name you set with `/rename`. Otherwise the app asks Claude's smallest model, Haiku, for a short title after your first message, and refreshes it at most every 15 minutes as you give new requests. This costs a tiny amount per session. You can turn it off in Settings. (Claude Code writes its own titles only for sessions without a name, and the app names each session after its panel so that `@2` works.)
- A name you set with `/rename` also becomes the name other sessions use to reach that terminal.

## Dragging in files

Drop files onto a terminal to add their paths to what you are typing, the same as ⌘U. Drop a folder onto a new, empty terminal to start Claude in that folder.

## Finding a terminal or resuming a past session

⌘K lists your open terminals first, searchable by what they are about, their harness or their folder. Choosing one takes you to it. Below them it lists every Claude Code session saved on this computer, newest first. Type to search by title, message or folder. Press Enter to resume the session in a panel. This runs `claude --resume` in that session's folder.

## Stack view

⌘S shows one card for each harness that has a terminal open. Each card lists up to three of that harness's most recent sessions. A green dot means the session is open now, and the line under it says what Claude is doing:

- "Running" and the command or tool Claude is running at that moment
- "Thinking…" while Claude is writing a reply
- "Waiting for you" when Claude has finished its turn
- any commands Claude left running in the background

Click a card or press ⌘1 to ⌘9 to show only that harness's terminals. Press ⌘S again to show all terminals. Clicking a session without a green dot resumes it.

## Using one terminal's session from another

Each terminal keeps its number while it is open, and its Claude session is named after it, for example `2-wrap`. In any terminal, type `@2` and Claude Code offers `@2-wrap` from its own list of your sessions. Then say what you want, and Claude picks how to get it:

- **Ask or tell that session something**: Claude sends it a message. The other session answers from what it knows, and the reply arrives as a `› Message from @2-wrap: …` line. This uses Claude Code's built-in messaging between sessions, so the other session takes a turn to answer.
- **Find specific details**: Claude searches that session's saved conversation with the app's `search_session` tool. This does not interrupt the other session.
- **Bring in everything**: Claude reads the whole conversation with the app's `read_session` tool. Long conversations are saved to a file that Claude reads in full.

The app gives each Claude session these tools through a small tool server named `panels`, and adds a short instruction telling Claude when to use each one.

### Moving between mentioned sessions

When a session mentions other terminals, whether you typed `@2-wrap` or Claude messaged, searched or read another session, those terminals appear as small labels in the session's top bar. Each label has a light: green when that session is working, orange when it is waiting for you, and grey when it has ended.

Press ⌘⇧↓ to see that terminal and all the sessions it mentioned side by side, with every other terminal hidden. ⌘↑ or ⌘⇧↓ again shows all terminals. If you're already looking at one mentioned session, ⌘⇧↓ widens the view to the whole group around the terminal you started from.

Press ⌘↓ in that terminal to show the first mentioned session full window. ⌘← and ⌘→ move between the mentioned sessions, and ⌘↑ goes back to the terminal you started from. The terminal you press ⌘↓ in is always the starting point, so pressing ⌘↓ again inside a mentioned session goes one level further, and ⌘↑ steps back one level at a time. Clicking a label does the same as ⌘↓ and goes straight to that session.

## Expert sessions

A session that has worked on something for a while knows a lot about it. The app keeps a short CV for each session so new sessions can use that knowledge instead of working it all out again.

- **CVs.** Once a session has had 5 of your messages, the app asks Haiku for a short CV of it: a one-line summary, what it worked on, the files and systems it knows, the decisions it made and what it left unfinished. The CV is rewritten after every 10 more messages and after the session is compacted. Sessions from the last 90 days whose folder still exists get CVs. A separate background process writes them, so the terminals never slow down. They are stored in `~/Library/Application Support/Claude Panels/cvs.json`.
- **Finding an expert.** When a session starts a substantial task, it calls the `find_expert` tool, which searches the CVs and returns up to three good matches. By default it only looks at sessions in the same folder, or whose CV mentions that folder. It looks everywhere only if nothing matches.
- **Using an expert, cheapest first.** Claude reads the expert's CV, then the files it names (to see how they are now), then searches its conversation. It only asks the expert directly when it needs its judgement, such as why something was chosen. If the expert is open in a terminal, Claude messages it. If it is closed, `ask_expert` asks a temporary copy of its conversation, so the original is left unchanged.
- **Cost check.** Asking a session means reading its whole conversation. If it was used in the last hour, most of that is still in Claude's cache and cheap. If it is large and has not been used recently, `ask_expert` stops and tells Claude to check with you first.

⌘K shows each session's CV summary and searches the CVs, and the stack view shows a session's CV when you hover over it. Turn CVs off in Settings.

## Copying text

Claude Code's full-screen display (its default for many people) draws the conversation itself and only keeps what is on screen in the terminal. Text that has scrolled out of a panel can't be selected, and dragging selects inside Claude Code rather than in the terminal. Three ways around that:

- **⌘⇧C** copies Claude's whole last reply, read from the saved session, however long it is.
- **Hold Option and drag** to select text in the terminal itself, then press ⌘C.
- **Settings > Use Claude Code's classic display** keeps the whole conversation in the terminal, so you can scroll and drag to copy anything. It applies to terminals opened after you save.

## Resuming after a restart

The app remembers which terminals are open and which Claude session each one is running. Next time you open the app, press ⌘R to bring them all back where you left off. A terminal where you never sent a message starts a fresh session in the same folder.

## Layouts

One terminal fills the window and two sit side by side. With an odd number of terminals, the others are laid out evenly and the last one either fills a full-width row at the bottom or a full-height column on the side. ⌘L switches between the two. Even numbers are arranged in a grid.

## Opening files Claude creates

Settings has three choices for what happens when Claude creates a file:

1. Open it straight away. Claude runs `open` on the file.
2. Give me a link. Claude ends its reply with `file:///` links, and clicking a link opens the file.
3. Do nothing extra.

The app does not edit any CLAUDE.md file. It passes the instruction to Claude with `--append-system-prompt` when each session starts, so it only applies inside this app.

Settings are stored in `~/Library/Application Support/Claude Panels/settings.json`.
