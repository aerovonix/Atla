import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import { ipcMain, type BrowserWindow } from "electron";
import {
  checkLockout,
  codesMatch,
  generatePairingCode,
  registerFailure,
  registerSuccess,
  type DashRequest,
  type PairingState
} from "../shared/dashProtocol.js";

/**
 * The web dash: a small HTTP server so a phone on the same network can read
 * and drive chats.
 *
 * This is the only part of Atla that listens on a network, so the defaults are
 * the conservative ones: off until switched on, a fresh pairing code every
 * time it starts, tokens that die with the process, and a lockout that makes
 * guessing the code impractical.
 *
 * What it is NOT: encrypted. This is plain HTTP on a LAN, so anything on that
 * network can read the traffic. That is stated in the UI rather than papered
 * over, and it is the reason the transport is kept behind a seam — a tunnel
 * with TLS is the fix, and it should drop in here.
 */

interface Session {
  token: string;
  createdAt: number;
  lastSeen: number;
}

let server: http.Server | null = null;
let pairingCode = "";
let pairing: PairingState = { failures: 0, lockedUntil: 0 };
const sessions = new Map<string, Session>();
let targetWindow: BrowserWindow | null = null;
let boundPort = 0;

/** A session is only as good as the run that made it. */
const SESSION_TTL_MS = 12 * 60 * 60_000;

export function initWebDash(win: BrowserWindow) {
  targetWindow = win;
}

/** The LAN addresses this machine can actually be reached on. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const e of entries ?? []) {
      if (e.family === "IPv4" && !e.internal) out.push(e.address);
    }
  }
  return out;
}

function newToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function pruneSessions(now: number) {
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(token);
  }
}

function authed(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return false;
  pruneSessions(Date.now());
  const session = sessions.get(token);
  if (!session) return false;
  session.lastSeen = Date.now();
  return true;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // No caching and no framing: this page holds a session token.
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff"
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      // A remote shouldn't be able to make the desktop app allocate freely.
      if (body.length > 64_000) req.destroy();
    });
    req.on("end", () => resolve(body));
  });
}

/** Asks the renderer for data, since the store lives there. */
function askRenderer(request: DashRequest): Promise<unknown> {
  return new Promise((resolve) => {
    if (!targetWindow || targetWindow.isDestroyed()) return resolve(null);
    const id = crypto.randomBytes(8).toString("hex");
    const channel = `dash:reply:${id}`;
    const timer = setTimeout(() => {
      ipcMain.removeAllListeners(channel);
      resolve(null);
    }, 15_000);
    ipcMain.once(channel, (_e, payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    });
    targetWindow.webContents.send("dash:request", { id, request });
  });
}

export function dashStatus() {
  return {
    running: Boolean(server),
    port: boundPort,
    code: pairingCode,
    addresses: lanAddresses(),
    sessions: sessions.size
  };
}

export async function startWebDash(port: number): Promise<{ ok: boolean; error?: string }> {
  await stopWebDash();
  // A new code every start, so a code shared once doesn't outlive the session
  // it was shared for.
  pairingCode = generatePairingCode();
  pairing = { failures: 0, lockedUntil: 0 };
  sessions.clear();

  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      void handle(req, res);
    });
    srv.on("error", (err) => {
      server = null;
      resolve({ ok: false, error: err.message });
    });
    srv.listen(port, "0.0.0.0", () => {
      server = srv;
      boundPort = (srv.address() as { port: number }).port;
      resolve({ ok: true });
    });
  });
}

export async function stopWebDash(): Promise<void> {
  sessions.clear();
  pairingCode = "";
  const srv = server;
  server = null;
  boundPort = 0;
  if (!srv) return;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/" && req.method === "GET") {
    const html = PAGE;
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      // The page loads nothing external, so lock it to itself.
      "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    });
    res.end(html);
    return;
  }

  if (url.pathname === "/api/pair" && req.method === "POST") {
    const now = Date.now();
    const lock = checkLockout(pairing, now);
    if (lock.locked) {
      json(res, 429, { ok: false, error: `Too many attempts. Try again in ${Math.ceil(lock.retryInMs / 1000)}s.` });
      return;
    }
    const body = await readBody(req);
    let code = "";
    try {
      code = String((JSON.parse(body) as { code?: string }).code ?? "");
    } catch {
      code = "";
    }
    if (!pairingCode || !codesMatch(code, pairingCode)) {
      pairing = registerFailure(pairing, now);
      // The same message either way: saying "locked out" versus "wrong code"
      // tells an attacker whether they're being counted.
      json(res, 401, { ok: false, error: "That code didn't work." });
      return;
    }
    pairing = registerSuccess();
    const token = newToken();
    sessions.set(token, { token, createdAt: now, lastSeen: now });
    json(res, 200, { ok: true, token });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (!authed(req)) {
      json(res, 401, { ok: false, error: "Not paired." });
      return;
    }
    if (url.pathname === "/api/list" && req.method === "GET") {
      json(res, 200, { ok: true, data: await askRenderer({ type: "list" }) });
      return;
    }
    if (url.pathname === "/api/open" && req.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      json(res, 200, { ok: true, data: await askRenderer({ type: "open", conversationId: id }) });
      return;
    }
    if (url.pathname === "/api/send" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const { conversationId, text } = JSON.parse(body) as { conversationId?: string; text?: string };
        await askRenderer({ type: "send", conversationId: String(conversationId ?? ""), text: String(text ?? "") });
        json(res, 200, { ok: true });
      } catch {
        json(res, 400, { ok: false, error: "Bad request." });
      }
      return;
    }
  }

  json(res, 404, { ok: false, error: "Not found." });
}

export function registerWebDashIpc() {
  ipcMain.handle("dash:status", () => dashStatus());
  ipcMain.handle("dash:start", async (_e, port: number) => {
    const r = await startWebDash(Number(port) || 7717);
    return { ...r, ...dashStatus() };
  });
  ipcMain.handle("dash:stop", async () => {
    await stopWebDash();
    return dashStatus();
  });
}

/** The whole client, inlined — the server has no static assets to serve. */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Atla</title>
<style>
:root{color-scheme:dark;--bg:#151412;--panel:#1f1e1b;--line:#2a2825;--text:#ececec;--dim:#9b9791;--accent:#f27229}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:16px;padding-bottom:calc(16px + env(safe-area-inset-bottom))}
h1{font-size:20px;margin:0 0 4px}
p.sub{color:var(--dim);font-size:13px;margin:0 0 20px}
input,button,textarea{font:inherit}
input,textarea{width:100%;padding:11px 13px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:var(--text);outline:none}
button{padding:11px 18px;border-radius:999px;border:none;background:var(--accent);color:#1a0a02;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line)}
.row{display:flex;gap:8px;align-items:center;margin-top:12px}
.err{color:#ff7b72;font-size:13px;margin-top:10px}
.item{padding:13px;border:1px solid var(--line);border-radius:12px;margin-bottom:8px;cursor:pointer;background:var(--panel)}
.item h3{margin:0;font-size:15px;font-weight:600}
.item span{color:var(--dim);font-size:12px}
.msg{padding:11px 13px;border-radius:14px;margin-bottom:8px;white-space:pre-wrap;word-break:break-word}
.user{background:var(--panel);margin-left:15%}
.bot{border:1px solid var(--line)}
.bar{position:sticky;bottom:0;background:var(--bg);padding-top:10px;display:flex;gap:8px}
.hide{display:none}
</style></head><body><div class="wrap">
<div id="pair">
  <h1>Pair with Atla</h1>
  <p class="sub">Enter the code shown in Atla on your computer.</p>
  <input id="code" placeholder="XXXX-XXXX" autocomplete="off" autocapitalize="characters" inputmode="text"/>
  <div class="row"><button id="go">Pair</button></div>
  <div class="err hide" id="perr"></div>
</div>
<div id="list" class="hide"><h1>Chats</h1><p class="sub">Tap one to open it.</p><div id="items"></div></div>
<div id="chat" class="hide">
  <div class="row" style="margin:0 0 12px"><button class="ghost" id="back">Back</button><strong id="title"></strong></div>
  <div id="msgs"></div>
  <div class="bar"><input id="text" placeholder="Message Atla…"/><button id="send">Send</button></div>
</div>
</div><script>
var token=sessionStorage.getItem("atla_token")||"";
var current=null;
function $(id){return document.getElementById(id)}
function show(id){["pair","list","chat"].forEach(function(x){$(x).className=x===id?"":"hide"})}
function api(path,opts){
  opts=opts||{};opts.headers=Object.assign({"content-type":"application/json"},opts.headers||{});
  if(token)opts.headers.Authorization="Bearer "+token;
  return fetch(path,opts).then(function(r){return r.json()});
}
$("go").onclick=function(){
  api("/api/pair",{method:"POST",body:JSON.stringify({code:$("code").value})}).then(function(r){
    if(!r.ok){$("perr").className="err";$("perr").textContent=r.error;return}
    token=r.token;sessionStorage.setItem("atla_token",token);loadList();
  });
};
$("code").addEventListener("keydown",function(e){if(e.key==="Enter")$("go").click()});
function loadList(){
  api("/api/list").then(function(r){
    if(!r.ok){show("pair");return}
    var items=$("items");items.innerHTML="";
    (r.data||[]).forEach(function(c){
      var d=document.createElement("div");d.className="item";
      d.innerHTML="<h3></h3><span></span>";
      d.querySelector("h3").textContent=c.title;
      d.querySelector("span").textContent=c.messageCount+" messages";
      d.onclick=function(){open(c.id,c.title)};
      items.appendChild(d);
    });
    show("list");
  });
}
function open(id,title){
  current=id;$("title").textContent=title;show("chat");refresh();
}
function refresh(){
  if(!current)return;
  api("/api/open?id="+encodeURIComponent(current)).then(function(r){
    if(!r.ok)return;
    var box=$("msgs");box.innerHTML="";
    (r.data||[]).forEach(function(m){
      var d=document.createElement("div");
      d.className="msg "+(m.role==="user"?"user":"bot");
      d.textContent=m.content||(m.streaming?"…":"");
      box.appendChild(d);
    });
    window.scrollTo(0,document.body.scrollHeight);
  });
}
$("back").onclick=function(){current=null;loadList()};
$("send").onclick=function(){
  var t=$("text").value.trim();if(!t||!current)return;
  $("text").value="";
  api("/api/send",{method:"POST",body:JSON.stringify({conversationId:current,text:t})}).then(function(){setTimeout(refresh,300)});
};
$("text").addEventListener("keydown",function(e){if(e.key==="Enter")$("send").click()});
// Poll rather than stream: a phone that sleeps drops a socket silently, and a
// reconnecting EventSource is more moving parts than this needs.
setInterval(function(){if(current)refresh()},2000);
if(token)loadList();else show("pair");
</script></body></html>`;
