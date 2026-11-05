# tldraw skill for Claude Code

Draw a diagram together with Claude Code in [tldraw](https://tldraw.dev). Type `/tldraw architecture` and a tldraw
board opens in your browser, saved as `architecture.tldr` in the current folder. You and Claude both edit it: you
drag, draw and type as usual, and Claude adds and changes boxes, arrows and text from the session. To say something
about part of the diagram, select it and write in the comment box at the top of the page; the comment goes to the
Claude session, and Claude's reply appears under it.

## Install

You need [Claude Code](https://claude.com/claude-code), Node.js 18 or later, and git.

Clone this repository into your personal skills folder, under the name `tldraw`:

```sh
git clone https://github.com/hatton/tldraw-skill ~/.claude/skills/tldraw
```

On Windows, in PowerShell:

```powershell
git clone https://github.com/hatton/tldraw-skill "$HOME\.claude\skills\tldraw"
```

Start a new Claude Code session so that it finds the skill. The first board you open installs tldraw and builds the
page, which takes about a minute.

To update it later, run `git pull` in that folder. The next board you open rebuilds the page if it changed.

## Use

- `/tldraw <name>` opens `<name>.tldr` in the current folder, creating it if it doesn't exist. A path works too.
- Ask Claude for changes in the session ("add a box for the database below the API, with an arrow to it"), or
  comment on the board.
- Each change Claude makes is one undo step on the board.
- The board saves to the `.tldr` file as you work. tldraw.com and tldraw's VS Code extension open the same file.
- To stop, ask Claude to close the board. The server also stops by itself two hours after the page is closed.

## How it works

- `board.mjs` is Claude's command-line tool: it starts the board's server, sends Claude's scripts to the page, lists
  the shapes on the board, and waits for your comments. `SKILL.md` tells Claude how to use it.
- `server.mjs` serves one board on `127.0.0.1`. It is reachable only from your machine, answers only under its own
  address, and every request needs a random token that only the page and `board.mjs` know.
- `app.jsx` is the page: the tldraw editor, saving to the file, running Claude's scripts, and the comment box.
  Claude's scripts run in that page with tldraw's editor API, so they can change the board but not your files.

## tldraw's license

This skill installs the [tldraw SDK](https://www.npmjs.com/package/tldraw) from npm, under tldraw's own license.
The SDK runs without a license key on `localhost` and `127.0.0.1`, which is where this skill serves the board.

## License

MIT, for the code in this repository. See [LICENSE](LICENSE).
