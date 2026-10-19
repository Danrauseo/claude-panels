# Installing Claude Panels with Claude Code

These are instructions for Claude Code to follow. To use them, open Terminal, start `claude`, and paste this:

```text
Install Claude Panels for me by following https://github.com/Danrauseo/claude-panels/blob/main/INSTALL.md
```

---

## Instructions for Claude

You are installing Claude Panels, a Mac app that runs several Claude Code sessions side by side. You build it on the user's own Mac and sign it there, so macOS opens it without warnings. Work through the steps in order. Tell the user in plain language what you are doing at each step, and keep it short.

Follow these rules throughout:

- Ask the user before installing any software.
- Never type, ask for, or handle the user's password. When macOS shows a password or permission window, tell the user what it is for and let them answer it themselves.
- If a step fails, read the error, try the fix listed under "If something goes wrong", and tell the user what happened.

### 1. Check this Mac

Run these and check the results:

| Check | Command | What you need |
| --- | --- | --- |
| macOS | `sw_vers -productVersion` | macOS 13 or newer |
| Chip | `uname -m` | `arm64` (Apple Silicon) or `x86_64` (Intel). Both work. |
| Claude Code | `claude --version` | 2.1.232 or newer. Older versions run the app, but `@` between sessions needs 2.1.232. If it is older, offer to run `claude update`. |
| Node.js | `node -v` | Version 18 or newer |
| Apple's command line tools | `xcode-select -p` | A folder path. An error means they are missing. |
| Git | `git --version` | Any version. Git comes with the command line tools. |

If Node.js is missing or too old, ask the user before installing it. If `brew` is available, use `brew install node`. Otherwise ask them to install the current LTS version from https://nodejs.org, then continue.

If the command line tools are missing, run `xcode-select --install`. A macOS window opens. Ask the user to click Install and to tell you when it has finished, because this can take several minutes.

### 2. Download the code

Ask the user where to keep the code. If they have no preference, use `~/claude-panels`.

```bash
git clone https://github.com/Danrauseo/claude-panels.git ~/claude-panels
cd ~/claude-panels
```

### 3. Install the parts the app needs

```bash
npm install
```

This also compiles the terminal library for the app, which needs the command line tools from step 1. It takes a minute or two.

### 4. Set up signing

Explain this choice to the user and ask which they want:

- **Recommended: make a signing certificate on this Mac.** Every build is then signed the same way, so macOS remembers the permissions the user gives the app, even after updates. macOS asks for their login password once.
- **Skip it.** The app still gets a basic signature and works on this Mac. The downside is that macOS may ask for permissions again after each update.

If they choose the certificate, run:

```bash
npm run create-cert
```

Before you run it, tell the user that a macOS window will ask for their login password to trust the certificate, and that they should enter it themselves. If the script reports that the certificate already exists, that is fine.

### 5. Build and install the app

```bash
npm run install-app
```

This builds the app for this Mac's chip, signs it, and copies it to `/Applications/Claude Panels.app`. It takes a few minutes.

If the first build shows a window saying `codesign wants to access key "Claude Panels Signing"`, tell the user to click **Always Allow**. They may need to enter their login password in that window.

If it says Claude Panels is open, ask the user to quit it, then run the command again.

### 6. Check it worked

```bash
codesign --verify --deep --strict "/Applications/Claude Panels.app" && echo "Signature OK"
codesign -dv "/Applications/Claude Panels.app" 2>&1 | grep -E "Authority|Signature"
open "/Applications/Claude Panels.app"
```

The second command should show `Authority=Claude Panels Signing`, or `Signature=adhoc` if they skipped the certificate.

### 7. Show the user how to start

Tell the user:

- To keep the app in the Dock, right-click its Dock icon and choose Options, then Keep in Dock.
- **⌘N** opens a new terminal. Type a folder path, or type `/add name` to save a folder as a harness. From then on, `/name` starts Claude there.
- **⌘K** finds an open terminal or a past Claude session.
- **⌘S** shows each open harness and what its sessions are doing.
- **⌘R** brings back the terminals that were open when the app last closed.
- **⌘U** adds file paths to the selected terminal. Dragging files onto a terminal does the same.
- In any terminal, typing `@2` lets Claude message, search or read the session in terminal 2.
- The README has the full list of shortcuts.

### Updating later

New versions are published as GitHub releases. The app checks for them by itself and shows an **Update to v…** button in its top bar when one is out. Clicking it shows the release notes, then downloads, rebuilds, reinstalls and restarts the app, and brings the terminals back.

To update by hand instead, quit Claude Panels first, then run:

```bash
cd ~/claude-panels && git pull && npm install && npm run install-app
```

Pressing ⌘R afterwards brings the terminals back. Keep the downloaded folder where it is, because the app updates itself from it.

### If something goes wrong

| Problem | Fix |
| --- | --- |
| `npm install` fails with `gyp` or compiler errors | The command line tools are missing or broken. Run `xcode-select --install`, then `npm install` again. |
| The build fails at signing with `errSecInternalComponent` | The keychain is locked, or the "Always Allow" window was missed. Ask the user to unlock their keychain or run the build again and answer the window. |
| The build fails at signing with a timestamp or network error | Apple's timestamp server did not answer. Wait a minute and run `npm run install-app` again. |
| `create-cert` says the certificate is not ready for signing | The trust step was cancelled. Run `npm run create-cert` again. |
| The app opens but terminals show `command not found: claude` | Claude Code is not on the login shell's PATH. Run `zsh -l -i -c 'command -v claude'` to check. You can also set the full path to `claude` in the app's Settings, under "Command used to start Claude". |
| Signing still fails | Skip the certificate. Remove it in Keychain Access if needed, then run `npm run install-app`. The app gets a basic signature instead. |
