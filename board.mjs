// Claude's side of a tldraw board.
//   node board.mjs open  <file>            builds the page if needed, starts the board's server, opens it
//   node board.mjs list  <file>            prints every shape on the board, one JSON line each
//   node board.mjs run   <file> <script>   runs a script in the open page (see SKILL.md)
//   node board.mjs wait  <file>            waits for the user's next comments and prints them
//   node board.mjs reply <file> <text>     shows a reply under the user's comments on the page
//   node board.mjs refresh <file>          rebuilds the page after a change to app.jsx and reloads it
//   node board.mjs stop  <file>
// <file> is a path; ".tldr" is added when it has no extension.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [command, fileArg, ...rest] = process.argv.slice(2);
if (!command || !fileArg) {
  console.error("usage: node board.mjs <open|list|run|wait|reply|refresh|stop> <file> [script or text]");
  process.exit(2);
}
const file = path.resolve(path.extname(fileArg) ? fileArg : `${fileArg}.tldr`);
const stateFile = path.join(here, ".state", `${crypto.createHash("sha1").update(file.toLowerCase()).digest("hex").slice(0, 16)}.json`);

/** Installs the packages and builds the page when they are missing or older than app.jsx. */
async function ensureBuilt() {
  if (!fs.existsSync(path.join(here, "node_modules", "tldraw"))) {
    console.log("Installing tldraw (about a minute, once)...");
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: here, stdio: "inherit", shell: process.platform === "win32" });
  }
  const out = path.join(here, "dist", "app.js");
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(path.join(here, "app.jsx")).mtimeMs) return;
  const { build } = await import("esbuild");
  await build({
    entryPoints: [path.join(here, "app.jsx")],
    bundle: true, minify: true, format: "iife", jsx: "automatic",
    outdir: path.join(here, "dist"), entryNames: "app",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
}

/** The running server for this file, or null. */
async function findServer() {
  if (!fs.existsSync(stateFile)) return null;
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/api/ping`, { headers: { "X-Board-Token": state.token } });
    if (res.ok) return { ...state, ...(await res.json()) };
  } catch {}
  return null;
}

async function server() {
  const s = await findServer();
  if (!s) throw new Error(`the board for ${file} isn't running; run \`node board.mjs open ${file}\``);
  return s;
}

function call(s, route, body, method = "POST") {
  return fetch(`http://127.0.0.1:${s.port}${route}`, {
    method,
    headers: { "X-Board-Token": s.token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function run(code) {
  const res = await call(await server(), "/api/run", { code });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error);
  return result.value;
}

function openBrowser(url) {
  if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

async function open() {
  await ensureBuilt();
  let s = await findServer();
  if (!s) {
    spawn(process.execPath, [path.join(here, "server.mjs"), file, stateFile], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    for (let i = 0; i < 50 && !s; i++) {
      await new Promise((r) => setTimeout(r, 200));
      s = await findServer();
    }
    if (!s) throw new Error("the board's server didn't start");
    // A page left open from the board's last run reconnects by itself within a few seconds.
    for (let i = 0; i < 25 && !s.pages; i++) {
      await new Promise((r) => setTimeout(r, 200));
      s = await findServer();
    }
  }
  const url = `http://127.0.0.1:${s.port}/`;
  if (!s.pages) openBrowser(url);
  // Give the page a moment to connect, so a script sent right after this finds it.
  for (let i = 0; i < 50 && !(await findServer()).pages; i++) await new Promise((r) => setTimeout(r, 200));
  const existed = fs.existsSync(file);
  console.log(`${existed ? "Opened" : "Created"} ${file}\n${url}${(await findServer()).pages ? "" : "\n(the page hasn't connected yet)"}`);
}

async function wait() {
  const s = await server();
  for (;;) {
    const res = await call(s, "/api/next-comment", undefined, "GET");
    if (res.status === 204) continue;
    if (!res.ok) throw new Error(`waiting for comments failed: ${res.status}`);
    for (const c of await res.json()) {
      console.log(`Comment from the user: ${c.text}`);
      if (!c.shapes.length) console.log("On: the whole board (nothing selected)");
      for (const shape of c.shapes) console.log(`On: ${JSON.stringify(shape)}`);
    }
    return;
  }
}

try {
  if (command === "open") await open();
  else if (command === "list") for (const shape of await run("return b.list()")) console.log(JSON.stringify(shape));
  else if (command === "run") {
    const code = fs.readFileSync(rest[0] === "-" ? 0 : rest[0], "utf8");
    const value = await run(code);
    if (value !== null) console.log(JSON.stringify(value, null, 1));
  } else if (command === "wait") await wait();
  else if (command === "reply") await call(await server(), "/api/reply", { text: rest.join(" ") });
  else if (command === "refresh") {
    await ensureBuilt();
    await call(await server(), "/api/refresh", {});
  }
  else if (command === "stop") {
    const s = await findServer();
    if (s) await call(s, "/api/stop", {});
    console.log(s ? "stopped" : "it wasn't running");
  } else throw new Error(`unknown command ${command}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
