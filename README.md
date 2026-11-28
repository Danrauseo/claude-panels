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

The app is built and signed on your own Mac, so macOS opens it without warnings. The first build makes a "Claude Panels Signing" certificate on your Mac, and macOS asks for your password once to trust it. You can also make it yourself with `npm run create-cert`.

The certificate matters because macOS remembers the permissions you give the app, such as "Claude Panels would like to access data from other apps", by its certificate. Without one, every update counts as a new app and macOS asks again. If you cancel the password prompt, or set `CLAUDE_PANELS_NO_CERT=1`, the app gets a basic (ad-hoc) signature instead.

macOS asks about data from other apps when something running in a terminal, such as Claude Code or your shell, reads another app's files. Click Allow if you want those reads to work.

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
| ⌘B | Move the selected terminal to the background, or open a background session as a panel again |
| ⌘J | Show or hide the list of sessions running in the background |
| ⌘W | Close the selected terminal |
| ⌘1 to ⌘9 | Jump to a terminal, or in the stack view open a harness. For a background session, this shows it in the drawer |
| ⌘L | Put the last panel at the bottom or on the side when an odd number are open |
| ⌘E | Switch the selected terminal between the friendly view and the terminal |
| @ | At the start of a word in Claude, list your other terminals to mention |
| ⌘, | Settings |
| ⌘/ | A window listing every shortcut. ⌘? works too |
| Shift+Enter | New line in Claude |

## Starting Claude in a harness

A harness is a saved folder with a short name. Each new terminal opens with a text box.

- Type `/` to see your harnesses, then pick one with the arrow keys and press Enter. For example `/notes` starts Claude in your notes folder.
- Type `/add notes` and press Enter to choose a folder and save it as `/notes`.
- `/browse` opens a folder chooser and `/home` starts in your home folder.
- You can also paste a folder path, or pick a recent folder.

Claude uses the CLAUDE.md and settings it finds in the folder you start it in. You can also add and remove harnesses on the Harnesses page of Settings. Under the table it lists your recent folders that are not harnesses yet, each with an **Add** button that saves it as a harness named after the folder.

### Model and advisor

Settings is split into pages: Harnesses, Files, Sessions and Display. The Harnesses page is a table. Its first row, **Default**, sets the model and advisor for your sessions, and each harness has a row below it. The advisor is a stronger model that Claude can consult at key moments, the same as Claude Code's `/advisor` command. For example, you can run sessions on Sonnet or Haiku with Opus as the advisor.

- Each harness row has its own **Model** and **Advisor** menus and a **Code Mode** box. **Default** in a menu uses the choice in the Default row. Changes on this page are saved straight away.
- In the Default row, **Claude Code's** leaves the choice to Claude Code. The advisor can also be **Off**, which turns it off even if Claude Code's own settings turn it on.
- A session's harness is the one it was started in, or else the saved harness its folder is in. A session in no harness uses the defaults.
- The app applies these when it starts or resumes a session, so a resumed session uses the harness's current choice. Inside a session, `/model` and `/advisor` still change them for that session.

**An advisor run by the app.** Claude Code has no advisor in some places, for example on Google Vertex. For those, choose an advisor that is *run by the app*, listed under **Run by the app, for Vertex**, such as **Opus (app)**. It works like Anthropic's advisor tool:

- Claude gets an `ask_advisor` tool, and its instructions say when to use it: before substantive work, when it is stuck or thinking of changing approach, and before it says a task is finished.
- When Claude calls it, the app starts a separate Claude on the advisor model. That Claude reads the session's whole conversation so far, including the tools it ran and their results, and writes back short advice. It has no tools, nothing it writes is shown to you, and it is not saved.
- It runs in the session's folder with your own Claude Code settings, so it signs in the same way as the session, for example through Vertex.
- A call usually takes under a minute, and it is billed like any other use of that model. Very long conversations are shortened to the first message and the most recent part.
- Claude Code's own advisor is turned off for these sessions, so Claude does not get advice twice.

### Code Mode

Each harness row on the Harnesses page of Settings has a **Code Mode** box. When it is ticked, new sessions in that harness start with Claude Code's experimental Code Mode. In Code Mode, Claude can write a short piece of code that calls several tools and works with their results, instead of calling one tool at a time. Those terminals show **Code Mode** in their top bar.

- A session that started with Code Mode can only be resumed with Code Mode. The app remembers which sessions started with it, so ⌘R, ⌘K and the stack view resume each session the way it started, even if you change the box later.
- Changing the box does not change sessions that are already open.
- Code Mode needs Claude Code 2.1.323 or newer. It is experimental, and it does not work with Remote Control.

## What each terminal shows

Each terminal's top bar shows its shortcut (⌘1 to ⌘9), a light, its harness and what the session is about. Buttons to fill the window and to close the terminal appear when you move the mouse over a terminal:

- **The light** is green while Claude is working, orange when it is waiting for you, and grey once the session has ended.
- **The harness** is shown in its own colour. Each harness always gets the same colour, so you can tell at a glance which one a terminal is in. The terminal you are using has a blue outline, and the others have dimmer top bars.
- **Subagents.** When Claude starts subagents, a small spinning label shows how many are working, for example "2 subagents". Hover over it to see what each one is doing and how long it has been running. It goes away when they finish.
- **What it is about** comes from a name you set with `/rename`. Otherwise the app asks Claude's smallest model, Haiku, for a short title after your first message, and refreshes it at most every 15 minutes as you give new requests. This costs a tiny amount per session. You can turn it off in Settings. (Claude Code writes its own titles only for sessions without a name, and the app names each session after its panel so that `@2` works.)
- A name you set with `/rename` also becomes the name other sessions use to reach that terminal.

The line at the bottom of the window counts your terminals, how many are working, how many are waiting for you, and how many need your approval.

## Approving from the terminal you are using

When a terminal you are not looking at stops to ask for your approval, for example to run a command, a small card appears at the bottom right of the terminal you are using. It shows which terminal is asking, what it wants to do, and its choices as buttons. The same happens when Claude asks you a multiple choice question. Choices that need you to type, such as "Type something", take you to that terminal. Click a choice to answer it without leaving your terminal, or click "Go to it" to switch to that terminal. The card goes away once the question is answered.

Claude often asks for approval in a plain sentence at the end of its reply, such as "Shall I go ahead?", and those cannot appear as cards. So the app tells every session it starts to ask for approvals, confirmations and choices with Claude Code's question tool instead, including the confirmations a folder's own CLAUDE.md asks for. Questions that need a written answer still go in the reply. The app adds this when each session starts and does not change any CLAUDE.md file.

In a small terminal, Claude Code may scroll some choices out of sight. The card then shows the choices it can see and says that the rest are in the terminal.

Only you can answer these. Claude in one terminal cannot approve anything for another.

## Terminals that open terminals

Claude in one terminal can open a new terminal when part of its work belongs in another harness or folder, or when a separate piece of work can run alongside its own. It uses the app's `open_terminal` tool, after checking where it can run with `list_harnesses`. The new terminal starts Claude in that harness, and its first message is the task, starting with which terminal asked for it. When it has finished, it sends the terminal that opened it a short report.

Claude can also open terminals and wait for all of them. It opens each one with `wait` set to true, and then calls `wait_for_report` with their numbers. Each new session hands in its report with the `report_back` tool instead of sending a message, and `wait_for_report` returns all the reports together when every terminal has finished. It also returns if a terminal ends or closes without reporting, or after 30 minutes (Claude can ask for up to two hours), and Claude can call it again to keep waiting. While it waits, a terminal that needs you still shows its approval card, and its row in the Background list says **Reported back** once it has handed in its report. In Code Mode, Claude can open the terminals and wait for them from one piece of code.

By default the new session runs in the background, so it does not take a panel. It appears in the Background list on the right of the window, under the terminal that opened it. Claude can ask for a normal panel instead, when you will want to watch the new session or type into it. A panel opened this way does not change what you are looking at, and a small notice at the top right says which terminal opened it, with a **Go to it** button.

## Background sessions

A background session is a normal Claude Code terminal that keeps running without a panel on screen. Sessions that Claude opens with `open_terminal` start in the background, and you can move any terminal there yourself with ⌘B or the button in its top bar.

- **The Background list** on the right of the window is drawn as a tree. The panel that opened sessions is at the top of its branch, the sessions it opened hang under it, and the subagents each one is running hang under that session. Each session shows its light, its harness and what it is doing: working, waiting for you, needs your approval, or ended. New sessions and subagents grow out of the row above them, and when one finishes it moves back up into that row. A terminal on screen that is running subagents is listed too, with its subagents under it, so you can see them without moving it to the background. The list opens when the first background session starts or a terminal starts running subagents, and it closes when none are left. ⌘J or the **Background** button at the top shows or hides it.
- **Looking at one.** Click a session in the list, or press its number, to show its terminal in a drawer over your panels. You can read it and type into it there. Click the arrow to hide the drawer again.
- **Open as panel** in the drawer, or ⌘B, gives the session a panel of its own again.
- **Questions.** When a background session asks for your approval, the card appears in the panel you are using, as it does for any other terminal.
- Background sessions are saved with your other terminals, so ⌘R brings them back in the background.

## Jobs

A **job** is one piece of work, done by terminals that one terminal (the owner) has opened. One owner can run several jobs at the same time. Each job has its own card in the Background list, with its own sessions listed under it. The card shows the job's name, whether it is closed or open, which terminal owns it, and how its sessions are getting on.

- **Which job a terminal joins.** When Claude opens a terminal with `open_terminal`, it gives a job name. Terminals with the same job name go in the same job, and a new name starts a new job. With no name, the terminal joins the job the owner used last.
- **Naming it.** The owner's Claude can rename a job with the `set_job` tool. Until then it takes the owner's title.
- **Shared sessions.** A session can be in more than one job. This happens when a terminal from another job gives it work by sending it a message, or when the owner's Claude adds it to a second job with `set_job`. A shared session is listed under each of its jobs, with a **Shared** label. Hold the mouse over the label to see which other jobs use it.
- **Closed or open.** A job is closed to begin with. In a closed job, any other terminal that tries to message one of its sessions, or read or search its conversation, has to wait for you. The job's card shows what it wants, with **Allow** and **Deny**. If you allow a message, the session also joins the sender's job. The owner and the job's own sessions never need to ask. Click **Closed** or **Open** on the card to change it, or the owner's Claude can change it with `set_job`.
- **Wrap up.** When every session that the job would close has finished, the **Wrap up** button turns green. Clicking it closes the job's sessions one at a time from the bottom of the tree upwards, and then the job's card goes. A session that another job also uses stays open and only leaves this job, and the notice says which ones were kept. The owner's own panel stays open. The conversations are kept, so ⌘K can find and resume them. If some sessions are still working, the app asks you first. The owner's Claude can also wrap a job up with `wrap_up_job`, giving the job's name, but only once its sessions have finished.
- A job also ends when its owner closes or its last session closes.

The check before messaging works through a Claude Code hook that the app adds when it starts each session. It only applies to sessions started by Claude Panels.

There are limits so terminals cannot keep opening each other:

- A terminal opened this way cannot open more terminals.
- At most 4 terminals can be opened this way in any ten minutes.
- No more are opened once 12 terminals are open.

## Dragging in files

Drop files onto a terminal to add their paths to what you are typing, the same as ⌘U. Drop a folder onto a new, empty terminal to start Claude in that folder.

## Finding a terminal or resuming a past session

⌘K lists your open terminals first, searchable by what they are about, their harness or their folder. Each row starts with its harness name in that harness's colour. Choosing one takes you to it. Below them it lists every Claude Code session saved on this computer, newest first. Type to search by title, message or folder. Press Enter to resume the session in a panel. This runs `claude --resume` in that session's folder.

## Stack view

⌘S shows one card for each harness that has a terminal open. Each card lists up to three of that harness's most recent sessions. A green dot means the session is open now, and the line under it says what Claude is doing:

- "Running" and the command or tool Claude is running at that moment
- "Thinking…" while Claude is writing a reply
- "Waiting for you" when Claude has finished its turn
- any commands Claude left running in the background

Click a card or press ⌘1 to ⌘9 to show only that harness's terminals. Press ⌘S again to show all terminals. Clicking a session without a green dot resumes it.

## Using one terminal's session from another

Each terminal keeps its number while it is open, and its Claude session is named after it, for example `2-wrap`. In any terminal, type `@` at the start of a word and the app shows a short list of your other open terminals, with their harness and what they are about. Keep typing to narrow it, pick one with the arrow keys and Enter. Enter only adds the name, so press Enter again when you want to send the message. Press Esc to close the list and use Claude Code's own `@` list for files instead. Then say what you want, and Claude picks how to get it:

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

- **Suggested experts.** After your first message in a new terminal, the app checks the CVs itself. If a past session in the same folder clearly matches what you asked, a small "Expert:" label appears in the top bar. Click it to tell Claude to use that session, or click × to dismiss it.

⌘K shows each session's CV summary and searches the CVs, and the stack view shows a session's CV when you hover over it. Turn CVs off in Settings.

## Friendly view

Each harness row on the Harnesses page of Settings has a **Friendly** box. Sessions in a harness with it ticked open in the friendly view, a plainer way to see the same live session for people who find the terminal daunting. It is off unless you tick it, and ⌘E switches any terminal between the friendly view and the terminal.

- **The conversation.** Your messages and Claude's replies are shown as ordinary text in the app's own fonts, with headings, lists and code laid out.
- **What Claude is doing.** Each tool Claude uses becomes one plain line, such as "Reading a file", "Searching the files", "Running a command" or "Using Gmail", with a short detail beside it, such as the file's name or Claude's own description of the command. The step that is running pulses. Finished steps fold into one line, such as "Read 3 files and ran a command". Click it to see each step.
- **Typing.** Type in the box at the bottom and press Return to send, or Shift+Return for a new line. **Stop** (or Esc) stops Claude, the same as Esc in the terminal.
- **Approvals and questions** appear as the same cards as before, over the friendly view. A choice that needs typing, or **Go to it**, shows the terminal.
- **Screens only the terminal has.** Some things never reach the saved conversation, such as signing in, "Press Enter to continue" or a menu such as `/model`. When the terminal shows something other than its usual input box, a card shows the bottom of the screen as plain text, with buttons for Enter, the arrow keys and Esc, a button to open any link on it, and a way to open the terminal. Text you send from the box at the bottom, such as a sign-in code, goes to the terminal as usual.
- **Notes.** Slash commands you send and what they print, errors from Claude Code such as an expired login, and when you stopped Claude show as short notes in the conversation.
- **Waiting for a reply.** Three pulsing dots sit where Claude's reply will appear. While Claude writes, the reply shows faintly under them as the terminal draws it, until the saved conversation catches up and the finished reply takes its place.
- **Explain terms** works here too, with the same underlines and tooltips.

The friendly view is built from the file Claude Code saves each session in, which the app reads twice a second and only from where it last stopped, so it costs very little. The terminal keeps running underneath and stops drawing while it is hidden. Claude Code saves a reply once it is written, which is why the reply in progress is read from the terminal's screen instead. ⌘E shows the terminal itself at any time.

## Explain terms

Each harness row on the Harnesses page of Settings has an **Explain** box. It is for harnesses where Claude does work you don't fully follow yet, such as a codebase when you are not a software engineer. It is off unless you tick it, and a harness without it works exactly as before.

- **The glossary.** In a harness with Explain ticked, Claude adds the words that structure the work to a glossary for that folder as it uses them: the work's own names for its parts (in a codebase, its files, modules, services and data), the ideas it relies on, parts of a programming language's syntax, and ways of working such as a pull request. Each term gets a one-line summary and a short plain explanation of what it does in this work in particular. Claude adds terms with the app's `add_terms` tool, and is told which terms are already there so it keeps using the same words. A glossary belongs to the repository, so sessions in its subfolders share it.
- **Hover to explain.** Glossary terms are underlined in the terminal with a dotted line. Hold the mouse over one and a tooltip explains it. Move into the tooltip to use its buttons, and press Esc to close it.
- **Learning.** The tooltip and the underline change as you learn a word. A new term has a bright underline and the full explanation. Once you have looked at it, the underline dims. After three looks it is faint, and the tooltip shows the one-line summary first, with **Explain again** for the rest. Click **I know this** and the underline goes. A look is counted at most once a minute.
- **The Glossary page** of Settings lists every term by folder, newest to you first, with how well you know each. You can mark a term as known or not, or remove one that is wrong or not worth explaining.

The glossary is stored in `~/Library/Application Support/Claude Panels/glossary.json` and what you have learned in `codex.json` next to it. The underline is added to what the terminal shows, so it never changes Claude's saved conversation or what you copy. A word written before it joined the glossary is not underlined, but holding the mouse over it still explains it.

## Simple

**Settings > Simple** has settings that make Claude Code's screen plainer for people who are new to it. Each one can be turned on by itself. Most use Claude Code's own settings, so they change what Claude Code shows inside the terminal.

- **Hide tips.** No tips under the spinner while Claude works.
- **Say "Working".** The spinner says "Working" instead of words such as "Pondering". The animation stays.
- **Hide reply times.** No "Cooked for 1m 2s" line after each reply.
- **Plain status line.** A line at the bottom shows the folder, the model and that Esc stops Claude. It replaces any status line in your own Claude Code settings.
- **Hide the ⎿ symbol.** Claude Code puts ⎿ before each tool result. The app shows a space instead.
- **Hide thinking.** Claude's thinking summaries do not show in the conversation.
- **No answer comparisons.** Claude Code does not show two answers and ask which is better. Claude Code marks this setting as internal, so it may change.
- **Plain-language replies.** Claude is asked to write in plain, everyday language, to say what it is about to do and why, and to explain each approval in plain words.
- **Code Mode follows each harness.** Code Mode is turned off unless the harness has its Code Mode box ticked, even if your own Claude Code settings turn it on. This also removes the Code Mode notice at the top of each session. A session keeps the Code Mode it started with when it is resumed.
- **Welcome line.** A line shown when a session starts. Claude Code shows it under a heading with your organisation's name.

They apply to sessions that start or resume after you save.

## Colours and font

The app uses the colours of claude.ai: warm dark greys, cream text and orange highlights, in the terminals and around them. To go back to the earlier blue colours, choose **Blue** under **Settings > Display > Colours**. The change applies straight away.

The app sets the terminal's background, its text colour and its 16 standard colours. Claude Code chooses its own layout and most of its own colours, so those look the same in either setting.

**Settings > Display > Font** sets the terminal font, with a preview. Three free fonts come with the app: JetBrains Mono (the default), Geist Mono and IBM Plex Mono. The list also shows fixed-width fonts installed on your Mac. SF Mono comes inside Apple's Terminal app, so it only appears in the list once you install it in Font Book. **Line spacing** and **Letter spacing** give the text more room.

The bundled fonts are under the SIL Open Font License. Their licences are in `renderer/fonts`.

Claude Code draws everything inside the terminal, including how it describes each tool it uses, such as "Reading 1 file…". The app cannot change that text.

## Copying text

In Claude Code's full-screen display (its default for many people), Claude Code does the selecting itself. Drag over text and it is copied when you let go of the mouse. Drag past the top or bottom of the panel and Claude Code scrolls and keeps selecting, so you can copy text longer than the panel. Other ways to copy:

- **⌘⇧C** copies Claude's whole last reply, read from the saved session, however long it is.
- **Hold Option and drag** to select text in the terminal itself, then press ⌘C. This only reaches what is on screen.
- **Settings > Use Claude Code's classic display** keeps the whole conversation in the terminal for ordinary scrolling and selecting, without the full-screen extras.

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
