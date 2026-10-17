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

Quit the app first. Your terminals come back with ⌘R afterwards.

```bash
git pull && npm install && npm run install-app
```

For quick testing without installing, run `npm start`.

## Shortcuts

| Shortcut | What it does |
| --- | --- |
| ⌘N | New terminal |
| ⌘K | Search past Claude sessions and resume one |
| ⌘↓ | Show the sessions this terminal mentioned with @, one at a time, full window |
| ⌘⇧↓ | Show this terminal and every session it mentioned side by side, hiding the others. Press it again, or ⌘↑, to show all terminals |
| ⌘← ⌘→ | Move between those mentioned sessions |
| ⌘↑ | Go back to the terminal you started from, or from the group view to all terminals |
| ⌘S | Stack view of open harnesses. Press it again to show all terminals |
| ⌘R | Resume the terminals you had open when the app last closed |
| ⌘O | Choose a folder for a new terminal |
| ⌘U | Choose files and add their paths to the selected terminal |
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

## Resuming a past session

⌘K lists every Claude Code session saved on this computer, newest first. Type to search by title, message or folder. Press Enter to resume the session in a panel. This runs `claude --resume` in that session's folder.

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
