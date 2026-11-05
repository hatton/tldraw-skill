// Serves one .tldr file's board on 127.0.0.1, started by board.mjs:
//   node server.mjs <file.tldr> <state file>
// The page saves the board to the file. Claude's scripts reach the page through /api/run, and
// the user's comments reach Claude through /api/next-comment. Every /api call needs the token that
// this server writes to the state file and puts in the page.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [file, stateFile] = process.argv.slice(2).map((p) => path.resolve(p));
// The token and port carry over from the board's last run, so a page left open reconnects.
let saved = {};
try { saved = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
const token = saved.token ?? crypto.randomBytes(24).toString("hex");
const assetsDir = path.join(here, "node_modules", "@tldraw", "assets");
// After this long with no page open, the server stops by itself.
const IDLE_MS = 2 * 60 * 60 * 1000;

let lastWritten = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
const pages = new Set();
const runs = new Map();
const thread = [];
let delivered = 0;
let waiters = [];
let idleSince = Date.now();
let port;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png" };

function reply(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function broadcast(message) {
  for (const page of pages) page.write(`data: ${JSON.stringify(message)}\n\n`);
}

function serveFile(res, fullPath, root) {
  if (!fullPath.startsWith(root + path.sep) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return reply(res, 404, { error: "not found" });
  reply(res, 200, fs.readFileSync(fullPath), TYPES[path.extname(fullPath)] ?? "application/octet-stream");
}

function page() {
  const title = path.basename(file).replace(/[<&"]/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="board-token" content="${token}"><title>${title}</title><link rel="stylesheet" href="/app.css">
<style>html,body{margin:0;height:100%;overflow:hidden}</style></head>
<body><div id="root"></div><script src="/app.js"></script></body></html>`;
}

/** Hands undelivered comments to a waiting `board.mjs wait`, if there are any and it is waiting. */
function deliver() {
  const comments = thread.filter((m) => m.kind === "comment" && m.n > delivered);
  if (!comments.length || !waiters.length) return;
  delivered = comments.at(-1).n;
  for (const w of waiters) { clearTimeout(w.timer); reply(w.res, 200, comments); }
  waiters = [];
}

const server = http.createServer(async (req, res) => {
  // A web page elsewhere can't reach this server under another host name (DNS rebinding).
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return reply(res, 421, { error: "wrong host" });
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const p = url.pathname;
  if (req.method === "GET" && p === "/") return reply(res, 200, page(), "text/html");
  if (req.method === "GET" && (p === "/app.js" || p === "/app.css")) return serveFile(res, path.join(here, "dist", p.slice(1)), path.join(here, "dist"));
  if (req.method === "GET" && p.startsWith("/assets/")) return serveFile(res, path.join(assetsDir, decodeURIComponent(p.slice(8))), assetsDir);
  if (!p.startsWith("/api/")) return reply(res, 404, { error: "not found" });

  if (req.headers["x-board-token"] !== token && url.searchParams.get("token") !== token) return reply(res, 401, { error: "no token" });
  const route = `${req.method} ${p}`;

  if (route === "GET /api/ping") return reply(res, 200, { file, pages: pages.size });
  if (route === "GET /api/doc") return lastWritten === null ? reply(res, 204, "") : reply(res, 200, lastWritten, "application/json");
  if (route === "PUT /api/doc") {
    const body = await readBody(req);
    if (body !== lastWritten) {
      fs.writeFileSync(`${file}.tmp`, body);
      fs.renameSync(`${file}.tmp`, file);
      lastWritten = body;
    }
    return reply(res, 200, { saved: true });
  }
  if (route === "GET /api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": open\n\n");
    pages.add(res);
    req.on("close", () => { pages.delete(res); if (!pages.size) idleSince = Date.now(); });
    return;
  }
  if (route === "POST /api/run") {
    if (!pages.size) return reply(res, 409, { error: "the board isn't open in a browser; run `board.mjs open` first" });
    const { code } = JSON.parse(await readBody(req));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { runs.delete(id); reply(res, 504, { error: "the page didn't answer within 60 seconds" }); }, 60000);
    runs.set(id, { res, timer });
    return broadcast({ type: "run", id, code });
  }
  if (route === "POST /api/result") {
    const result = JSON.parse(await readBody(req));
    const run = runs.get(result.id);
    if (run) {
      runs.delete(result.id);
      clearTimeout(run.timer);
      reply(run.res, result.ok ? 200 : 422, result);
    }
    return reply(res, 200, {});
  }
  if (route === "GET /api/thread") return reply(res, 200, thread);
  if (route === "POST /api/comment") {
    const { text, shapes } = JSON.parse(await readBody(req));
    // `on` names the shapes a message is about, so the page shows only the messages about its selection.
    thread.push({ n: thread.length + 1, kind: "comment", at: new Date().toISOString(), text, shapes, on: shapes.map((x) => x.id) });
    broadcast({ type: "thread", thread });
    deliver();
    return reply(res, 200, {});
  }
  if (route === "POST /api/reply") {
    const { text } = JSON.parse(await readBody(req));
    const last = thread.findLast((m) => m.kind === "comment");
    thread.push({ n: thread.length + 1, kind: "reply", at: new Date().toISOString(), text, on: last ? last.on : [] });
    broadcast({ type: "thread", thread });
    return reply(res, 200, {});
  }
  if (route === "GET /api/next-comment") {
    const waiter = { res, timer: setTimeout(() => { waiters = waiters.filter((w) => w !== waiter); reply(res, 204, ""); }, 50000) };
    waiters.push(waiter);
    return deliver();
  }
  if (route === "POST /api/refresh") {
    broadcast({ type: "refresh" });
    return reply(res, 200, {});
  }
  if (route === "POST /api/stop") {
    reply(res, 200, { stopping: true });
    return shutDown();
  }
  reply(res, 404, { error: `no route ${route}` });
});

function shutDown() {
  process.exit(0);
}

// A change to the file from outside the page, such as a git checkout, reloads the page's board.
fs.watchFile(file, { interval: 1000 }, () => {
  if (!fs.existsSync(file)) return;
  const now = fs.readFileSync(file, "utf8");
  if (now === lastWritten) return;
  lastWritten = now;
  broadcast({ type: "reload" });
});

setInterval(() => { if (!pages.size && Date.now() - idleSince > IDLE_MS) shutDown(); }, 60000).unref();
setInterval(() => broadcast({ type: "ping" }), 25000).unref();
process.on("SIGTERM", shutDown);
process.on("SIGINT", shutDown);

let preferredPort = saved.port ?? 0;
server.on("error", (error) => {
  if (error.code !== "EADDRINUSE" || !preferredPort) throw error;
  preferredPort = 0;
  server.listen(0, "127.0.0.1");
});
server.on("listening", () => {
  port = server.address().port;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ port, token, pid: process.pid, file }));
});
server.listen(preferredPort, "127.0.0.1");
