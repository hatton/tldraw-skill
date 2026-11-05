// The board page: tldraw, the file's contents, saving back to the file, the scripts Claude sends,
// and the comment box that sends a comment on the selection to the Claude session.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as TL from "tldraw";
import {
  Tldraw, createShapeId, toRichText, parseTldrawJsonFile, serializeTldrawJson, loadSnapshot,
  renderPlaintextFromRichText, useValue,
} from "tldraw";
import { getAssetUrls } from "@tldraw/assets/selfHosted";
import "tldraw/tldraw.css";

const TOKEN = document.querySelector("meta[name=board-token]").content;const assetUrls = getAssetUrls({ baseUrl: "/assets" });

function api(path, init = {}) {
  return fetch(path, { ...init, headers: { ...init.headers, "X-Board-Token": TOKEN } });
}
const postJson = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// While the page loads the file's contents into the editor, that change is not saved back.
let loading = false;

async function loadFromServer(editor) {
  const res = await api("/api/doc");
  if (res.status === 204) return false;
  const parsed = parseTldrawJsonFile({ json: await res.text(), schema: editor.store.schema });
  if (!parsed.ok) throw new Error(`the file is not a tldraw file tldraw can read: ${JSON.stringify(parsed.error)}`);
  loading = true;
  try {
    loadSnapshot(editor.store, parsed.value.getStoreSnapshot());
  } finally {
    loading = false;
  }
  return true;
}

async function save(editor) {
  await api("/api/doc", { method: "PUT", body: await serializeTldrawJson(editor) });
}

const shapeId = (id) => (id.startsWith("shape:") ? id : createShapeId(id));
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const plain = (editor, richText) => (richText ? renderPlaintextFromRichText(editor, richText) : undefined);

/** One shape as Claude reads it: its id, kind, place, size, text and style, and an arrow's ends. */
function describe(editor, shape) {
  const b = editor.getShapePageBounds(shape);
  const p = shape.props;
  const out = defined({
    id: shape.id,
    type: shape.type === "geo" ? p.geo : shape.type,
    text: plain(editor, p.richText) || undefined,
    x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h),
    color: p.color, fill: p.fill, dash: p.dash,
    parent: shape.parentId.startsWith("shape:") ? shape.parentId : undefined,
  });
  if (shape.type === "arrow") {
    for (const binding of editor.getBindingsFromShape(shape, "arrow")) out[binding.props.terminal === "start" ? "from" : "to"] = binding.toId;
    out.heads = `${p.arrowheadStart}-${p.arrowheadEnd}`;
  }
  return out;
}

/** Rich text with an optional bold first line, `title`, above `text`, whose lines are paragraphs. */
function richText(title, text) {
  const para = (line, bold) => (line ? { type: "paragraph", content: [{ type: "text", text: line, ...(bold ? { marks: [{ type: "bold" }] } : {}) }] } : { type: "paragraph" });
  const lines = text === undefined || text === "" ? [] : text.split("\n");
  return { type: "doc", content: [...(title ? [para(title, true)] : []), ...lines.map((l) => para(l, false))] };
}
const richTextOf = (o) => (o.title === undefined && o.text === undefined ? undefined : richText(o.title, o.text));

/** The helpers a script gets as `b`. A shape's id is Claude's own name for it ("server"), or a
 * shape id from the list ("shape:..."), so that shapes the user drew can be changed too. */
function helpers(editor) {
  const geoProps = (o) => defined({
    geo: o.geo, w: o.w, h: o.h, color: o.color, fill: o.fill, dash: o.dash, size: o.size, font: o.font,
    align: o.align, verticalAlign: o.verticalAlign, labelColor: o.labelColor,
    richText: richTextOf(o),
  });
  const textProps = (o) => defined({
    color: o.color, size: o.size, font: o.font, textAlign: o.align, w: o.w,
    autoSize: o.w === undefined ? undefined : false,
    richText: richTextOf(o),
  });
  const upsert = (id, type, o, props, defaults) => {
    const existing = editor.getShape(shapeId(id));
    if (existing) editor.updateShape(defined({ id: existing.id, type, x: o.x, y: o.y, props }));
    else editor.createShape({ id: shapeId(id), type, x: o.x ?? 0, y: o.y ?? 0, props: { ...defaults, ...props } });
    return shapeId(id);
  };
  return {
    box: (id, o = {}) => upsert(id, "geo", o, geoProps(o), { geo: "rectangle", w: 200, h: 100, size: "s", font: "sans", dash: "solid" }),
    text: (id, o = {}) => upsert(id, "text", o, textProps(o), { size: "s", font: "sans" }),
    arrow(id, from, to, o = {}) {
      const start = editor.getShapePageBounds(shapeId(from));
      const end = editor.getShapePageBounds(shapeId(to));
      if (!start) throw new Error(`there is no shape ${from}`);
      if (!end) throw new Error(`there is no shape ${to}`);
      const aid = shapeId(id);
      if (editor.getShape(aid)) editor.deleteShapes([aid]);
      editor.createShape({
        id: aid, type: "arrow", x: start.center.x, y: start.center.y,
        props: defined({
          start: { x: 0, y: 0 }, end: { x: end.center.x - start.center.x, y: end.center.y - start.center.y },
          richText: richText(o.title, o.text ?? ""), arrowheadStart: o.start ?? "none", arrowheadEnd: o.end ?? "arrow",
          dash: o.dash ?? "solid", color: o.color, bend: o.bend, kind: o.kind, size: o.size ?? "s",
          font: o.font ?? "sans", labelColor: o.labelColor,
        }),
      });
      const bind = (terminal, target, anchor) => ({
        type: "arrow", fromId: aid, toId: shapeId(target),
        props: { terminal, normalizedAnchor: anchor ?? { x: 0.5, y: 0.5 }, isExact: false, isPrecise: !!anchor, snap: "none" },
      });
      editor.createBindings([bind("start", from, o.fromAnchor), bind("end", to, o.toAnchor)]);
      return aid;
    },
    remove: (...ids) => editor.deleteShapes(ids.map(shapeId)),
    clear: () => editor.deleteShapes([...editor.getCurrentPageShapeIds()]),
    richText,
    /** Highlights every line of a shape's text that matches one of the patterns. */
    mark(id, ...patterns) {
      const shape = editor.getShape(shapeId(id));
      if (!shape?.props.richText) throw new Error(`${id} has no text`);
      const tests = patterns.map((p) => (p instanceof RegExp ? p : new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));
      let marked = 0;
      const doc = structuredClone(shape.props.richText);
      for (const para of doc.content ?? []) {
        const line = (para.content ?? []).map((n) => n.text ?? "").join("");
        if (!line || !tests.some((t) => t.test(line))) continue;
        marked++;
        for (const node of para.content) {
          if (node.type !== "text" || node.marks?.some((m) => m.type === "highlight")) continue;
          node.marks = [...(node.marks ?? []), { type: "highlight" }];
        }
      }
      editor.updateShape({ id: shape.id, type: shape.type, props: { richText: doc } });
      return marked;
    },
    list: () => editor.getCurrentPageShapesSorted().map((s) => describe(editor, s)),
    fit: () => editor.zoomToFit({ animation: { duration: 200 } }),
  };
}

const AsyncFunction = (async () => {}).constructor;

/** Runs a script Claude sent, as one undo step, and returns what it returned. */
async function runScript(editor, code) {
  editor.markHistoryStoppingPoint("claude");
  const value = await new AsyncFunction("editor", "tl", "b", code)(editor, TL, helpers(editor));
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** A setting kept in this browser for this board; storage can be missing, so a failure is ignored. */
function remembered(key, fallback) {
  try {
    const value = localStorage.getItem(`board-${key}`);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}
function remember(key, value) {
  try { localStorage.setItem(`board-${key}`, JSON.stringify(value)); } catch {}
}

function CommentBox({ editor, thread }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const logRef = useRef(null);
  const selected = useValue("selected", () => (editor ? editor.getSelectedShapes() : []), [editor]);
  const names = selected.map((s) => plain(editor, s.props.richText) || s.type).map((n) => (n.length > 30 ? `${n.slice(0, 30)}…` : n));
  const target = selected.length ? names.join(", ") : "the whole board";
  // Only the conversation about the current selection shows; the rest comes back with its selection.
  const key = (ids) => [...ids].sort().join(" ");
  const shown = thread.filter((m) => key(m.on ?? []) === key(selected.map((x) => x.id)));

  // Where the box sits and whether it is open, remembered in this browser.
  const [place, setPlace] = useState(() => remembered("place", { x: Math.max(8, window.innerWidth / 2 - 220), y: 8 }));
  const [open, setOpenState] = useState(() => remembered("open", true));
  const [seenReplies, setSeenReplies] = useState(0);
  const boxRef = useRef(null);
  const dragged = useRef(false);
  const setOpen = (value) => { setOpenState(value); remember("open", value); };

  function startDrag(e) {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, left: place.x, top: place.y };
    dragged.current = false;
    let last = place;
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragged.current = true;
      const w = boxRef.current?.offsetWidth ?? 100;
      last = { x: Math.min(Math.max(0, start.left + dx), window.innerWidth - w), y: Math.min(Math.max(0, start.top + dy), window.innerHeight - 30) };
      setPlace(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      remember("place", last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    if (open) setSeenReplies(thread.filter((m) => m.kind === "reply").length);
  }, [thread, open, shown.length]);

  async function send() {
    if (!text.trim() || !editor) return;
    setSending(true);
    try {
      await postJson("/api/comment", { text: text.trim(), shapes: selected.map((s) => describe(editor, s)) });
      setText("");
    } finally {
      setSending(false);
    }
  }

  const frame = {
    position: "fixed", left: place.x, top: place.y, zIndex: 1000,
    background: "white", border: "1px solid #ccc", borderRadius: 8, boxShadow: "0 2px 8px rgba(0,0,0,.12)",
    font: "13px system-ui, sans-serif",
  };
  const unread = thread.filter((m) => m.kind === "reply").length > seenReplies;

  if (!open) {
    return (
      <button ref={boxRef} style={{ ...frame, padding: "4px 10px", cursor: "pointer" }} onPointerDown={startDrag} onClick={() => !dragged.current && setOpen(true)}>
        Comment{unread ? " (new reply)" : ""}
      </button>
    );
  }

  return (
    <div ref={boxRef} style={{ ...frame, width: 440, padding: "0 8px 8px" }}>
      <div onPointerDown={startDrag} style={{ display: "flex", alignItems: "center", cursor: "move", padding: "4px 0", color: "#666", userSelect: "none" }}>
        <span style={{ flex: 1 }}>Comments to Claude (drag to move)</span>
        <button onClick={() => setOpen(false)} onPointerDown={(e) => e.stopPropagation()} title="Shrink to a tab" style={{ font: "inherit", padding: "0 8px" }}>–</button>
      </div>
      {shown.length > 0 && (
        <div ref={logRef} style={{ maxHeight: 160, overflowY: "auto", marginBottom: 6 }}>
          {shown.map((m) => (
            <div key={m.n} style={{ margin: "4px 0", color: m.kind === "reply" ? "#1d5c96" : "#222" }}>
              <b>{m.kind === "reply" ? "Claude" : "You"}:</b> {m.text}
            </div>
          ))}
        </div>
      )}
      <div style={{ color: "#666", marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        Comment on {target}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <textarea
          value={text} rows={2} placeholder="Goes to the Claude session. Ctrl+Enter sends."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); }}
          style={{ flex: 1, resize: "vertical", font: "inherit", padding: 4 }}
        />
        <button onClick={send} disabled={sending || !text.trim()} style={{ font: "inherit", padding: "0 12px" }}>Send</button>
      </div>
    </div>
  );
}

function App() {
  const [editor, setEditor] = useState(null);
  const [thread, setThread] = useState([]);

  useEffect(() => {
    if (!editor) return;
    let timer;
    const stop = editor.store.listen(() => {
      if (loading) return;
      clearTimeout(timer);
      timer = setTimeout(() => save(editor), 400);
    }, { scope: "document" });

    loadFromServer(editor).then((existed) => {
      if (existed) editor.zoomToFit();
      else save(editor);
    });
    api("/api/thread").then((r) => r.json()).then(setThread);

    const events = new EventSource(`/api/events?token=${TOKEN}`);
    events.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "reload") loadFromServer(editor);
      else if (msg.type === "refresh") location.reload();
      else if (msg.type === "thread") setThread(msg.thread);
      else if (msg.type === "run") {
        try {
          postJson("/api/result", { id: msg.id, ok: true, value: await runScript(editor, msg.code) });
        } catch (error) {
          postJson("/api/result", { id: msg.id, ok: false, error: String(error?.stack ?? error) });
        }
      }
    };
    return () => { stop(); events.close(); clearTimeout(timer); };
  }, [editor]);

  return (
    <>
      <div style={{ position: "fixed", inset: 0 }}>
        <Tldraw assetUrls={assetUrls} onMount={setEditor} />
      </div>
      <CommentBox editor={editor} thread={thread} />
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
