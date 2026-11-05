---
name: tldraw
description: Open a tldraw diagram that the user and Claude edit together, kept in a .tldr file in the current worktree and served by a local Node server; the user's comments on the selected shapes come to this session. Use for `/tldraw <name>`, or when the user wants to draw or change a diagram with you in tldraw.
---

# tldraw board

`board.mjs` beside this file runs everything: `node ~/.claude/skills/tldraw/board.mjs <command> <file>`. Below, `board` means that command.

The page owns the file while it is open: it saves the board to the `.tldr` file 0.4 s after every change, by the user or by you. So change the board only through `board run`, never by writing the file. A change to the file from outside, such as a git checkout, reloads the board in the page.

## Open

1. **The file:** `/tldraw foo` means `foo.tldr` in the current working directory. A path, or a name with an extension, is used as given.
2. **`board open <file>`.** On the first run it installs tldraw and builds the page (about a minute). It starts the board's server, opens the page in the default browser unless a page is already connected, and prints `Created` or `Opened`, the file and the URL. Give the user the URL.
3. **Wait for comments:** start `board wait <file>` with `run_in_background`. The page has a comment box at the top; the user selects shapes, writes, and sends. `wait` then prints their comment and the shapes they had selected, and exits, which notifies you. Act on the comment, answer it with `board reply <file> "<text>"`, which shows under their comment on the page, and start `wait` again. Keep exactly one `wait` running while the board is open.

## Read

`board list <file>` prints one JSON line per shape: `id`, `type` (`rectangle`, `ellipse`, `arrow`, `text`, ...), `text`, `x`, `y`, `w`, `h`, `color`, `fill`, `dash`, and for an arrow its `from`, `to` and `heads`. The user moves and edits shapes too, so list the board again before every change and keep their positions unless they asked for a new layout.

## Change

Write a script to a file in the scratchpad and run `board run <file> <script>`. The script is the body of an async function with:

- `b`, the helpers below;
- `editor`, tldraw's `Editor`, for anything the helpers don't cover;
- `tl`, the whole `tldraw` module (`toRichText`, `createShapeId`, ...).

One run is one undo step for the user. Whatever the script returns is printed as JSON. A thrown error comes back with its stack.

| Helper | Does |
|---|---|
| `b.box(id, {x, y, w, h, title, text, color, fill, dash, geo, size, font, align, verticalAlign})` | Creates the box, or changes only the given fields of an existing one. `title` is a bold first line; `text` may hold `\n`. |
| `b.text(id, {x, y, title, text, w, color, size, font, align})` | A free text label. |
| `b.mark(id, ...patterns)` | Highlights each line of a shape's text that contains one of the strings (or matches a RegExp), and returns how many lines it marked. |
| `b.richText(title, text)` | The rich text the helpers build, for setting `props.richText` yourself with `editor.updateShape`. |
| `b.arrow(id, from, to, {text, start, end, dash, color, bend, fromAnchor, toAnchor})` | Replaces any arrow `id` with one bound to both shapes. `start`/`end` are heads (`none`, `arrow`, ...; default `none`/`arrow`). An anchor such as `{x: 1, y: 0.5}` is a point on the shape, 0 to 1 across and down; without one the arrow aims at the centre, so give anchors when several arrows meet one shape. |
| `b.remove(...ids)`, `b.clear()` | Deletes shapes; `clear` empties the page. |
| `b.list()`, `b.fit()` | What `board list` prints; zooms the page to show everything. |

An `id` is your own name for a shape (`"server"`) or a shape id from `list` (`"shape:..."`), which is how you change shapes the user drew. New boxes and arrows use tldraw's small sans font and solid lines unless you say otherwise.

Style values: `color` is `black grey light-violet violet blue light-blue yellow orange green light-green light-red red white`; `fill` is `none semi solid pattern fill`; `dash` is `draw solid dashed dotted`; `size` is `s m l xl`; `geo` is `rectangle ellipse diamond cloud ...`.

Text in a shape grows the shape downwards, so leave room below boxes that hold more than two lines.

### Text styles

A shape's text is one size and one color, but parts of it can be styled. Give a box a `title` so its name stands apart from the lines below it. tldraw's text marks are `bold`, `italic`, `strike`, `code`, `link` and `highlight`; the user can apply them from the text toolbar. To style part of a line yourself, write the shape's `richText` as TipTap JSON, one paragraph per line:

```js
{ type: "doc", content: [
  { type: "paragraph", content: [{ type: "text", text: "Name", marks: [{ type: "bold" }] }] },
  { type: "paragraph", content: [{ type: "text", text: "plain, then " }, { type: "text", text: "code", marks: [{ type: "code" }] }] },
  { type: "paragraph" },
] }
```

An empty paragraph is a blank line.

## Look

To see the board, export it from the page and render the SVG:

```js
return (await editor.getSvgString([...editor.getCurrentPageShapeIds()], { background: true })).svg;
```

Write the printed string (it is JSON-quoted) to a `.svg` in the scratchpad, render it with headless Chrome (`--screenshot`), and read the PNG. Headless Chrome pointed at the board's own URL never finishes loading, because the page holds an open connection to the server.

## Finish

`board stop <file>` stops the server; it also stops by itself after two hours with no page open. The `.tldr` file stays, and tldraw.com and tldraw's VS Code extension open it too.

## Changing this skill

After editing `app.jsx`, `board refresh <file>` rebuilds the page and reloads every open page. After editing `server.mjs`, `board stop` then `board open`; the server keeps its port and token when the port is free, so an open page reconnects.
