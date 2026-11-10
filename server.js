// Запуск STRELA STARS на своём VPS (Node 20+), без Cloudflare Workers.
// HTTPS для мини-аппа: если в .env нет PUBLIC_URL, поднимается бесплатный Cloudflare Tunnel (cloudflared)
// и бот сам перепривязывается к новому адресу при каждом запуске.
import { register } from "node:module";
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

register("data:text/javascript," + encodeURIComponent(`
export async function load(url, ctx, next) {
  if (url.endsWith(".html")) { const fs = await import("node:fs");
    return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(fs.readFileSync(new URL(url), "utf8")) }; }
  return next(url, ctx);
}`));

const DIR = path.dirname(fileURLToPath(import.meta.url));
const env = {};
try {
  for (const line of fs.readFileSync(path.join(DIR, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { console.log("Нет файла .env — скопируй .env.example в .env и заполни"); process.exit(1); }
for (const k of ["BOT_TOKEN", "WALLET_MNEMONIC", "TONCENTER_KEY", "WALLET_ADDRESS"]) if (process.env[k]) env[k] = process.env[k];
if (!env.BOT_TOKEN) { console.log("В .env не задан BOT_TOKEN"); process.exit(1); }
const PORT = Number(env.PORT || 8787);

// ---- хранилище (вместо Durable Object): файл data/db.json ----
const DATA = path.join(DIR, "data"); fs.mkdirSync(DATA, { recursive: true });
const DB = path.join(DATA, "db.json");
class FileStorage {
  constructor() {
    this.m = new Map(); this.al = null; this.timer = null;
    try { this.m = new Map(Object.entries(JSON.parse(fs.readFileSync(DB, "utf8")))); } catch {}
  }
  flush() {   // пишем сразу и атомарно — состояние отправки TON не должно теряться
    fs.writeFileSync(DB + ".tmp", JSON.stringify(Object.fromEntries(this.m)));
    fs.renameSync(DB + ".tmp", DB);
  }
  async get(k) {
    if (Array.isArray(k)) { const r = new Map(); for (const x of k) if (this.m.has(x)) r.set(x, structuredClone(this.m.get(x))); return r; }
    return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined;
  }
  async put(k, v) { this.m.set(k, structuredClone(v)); this.flush(); }
  async delete(k) { const keys = Array.isArray(k) ? k : [k]; for (const x of keys) this.m.delete(x); this.flush(); }
  async getAlarm() { return this.al; }
  async setAlarm(t) {
    this.al = t; clearTimeout(this.timer);
    this.timer = setTimeout(async () => { this.al = null; try { await store.alarm(); } catch (e) { console.log("alarm", e); } }, Math.max(0, t - Date.now()));
  }
}

const { default: worker, Store } = await import("./worker.js");
const store = new Store({ storage: new FileStorage() }, env);
env.STORE = { idFromName: () => 1, get: () => store };

let ORIGIN = (env.PUBLIC_URL || "").replace(/\/+$/, "");

http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = await worker.fetch(new Request((ORIGIN || "http://localhost:" + PORT) + req.url, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body }), env);
    const out = Object.fromEntries(r.headers);
    let buf = Buffer.from(await r.arrayBuffer());
    // сжатие: страница ~100 КБ → ~20 КБ, через туннель грузится в разы быстрее
    if (buf.length > 1024 && /gzip/.test(req.headers["accept-encoding"] || "") && /text|json|javascript/.test(out["content-type"] || "")) {
      buf = zlib.gzipSync(buf); out["content-encoding"] = "gzip"; out["vary"] = "accept-encoding";
    }
    out["content-length"] = String(buf.length);
    res.writeHead(r.status, out);
    res.end(buf);
  } catch (e) { console.log("http", e); res.writeHead(500); res.end("error"); }
}).listen(PORT, "127.0.0.1", () => console.log("STRELA STARS слушает порт " + PORT));

setInterval(() => store.fetch(new Request("https://do/tick", { method: "POST" })).catch(e => console.log("tick", e)), 60000);

async function link(origin) {
  ORIGIN = origin;
  // адрес trycloudflare появляется в DNS не сразу — Telegram может отказать в вебхуке, тогда пробуем ещё
  for (let i = 1; ; i++) {
    const r = await store.fetch(new Request(origin + "/setup"));
    const t = await r.text();
    if (r.ok && t.startsWith("✅")) { console.log(t + "\nМини-апп: " + origin + "/"); break; }
    if (ORIGIN !== origin) return;   // туннель уже сменился
    console.log(`Вебхук не встал (попытка ${i}): ${t}`);
    if (i >= 20) { console.log("Не удалось привязать вебхук — проверь BOT_TOKEN в .env"); return; }
    await new Promise(r => setTimeout(r, 10000));
  }
  // вебхук Монобанка тоже переезжает на новый адрес
  const sec = (await store.s.get("sec")) || {};
  if (sec.monoToken) {
    const key = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("mono" + env.BOT_TOKEN)))).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
    const m = await fetch("https://api.monobank.ua/personal/webhook", { method: "POST", headers: { "X-Token": sec.monoToken, "content-type": "application/json" }, body: JSON.stringify({ webHookUrl: origin + "/mono/" + key }) }).catch(e => ({ status: String(e) }));
    console.log("Вебхук Монобанка:", m.status === 200 ? "ок" : m.status);
  }
}

process.on("unhandledRejection", e => console.log("ошибка:", e && e.message || e));
if (ORIGIN) link(ORIGIN).catch(e => console.log("link", e));
else {
  const bin = env.CLOUDFLARED || "cloudflared";
  const start = () => {
    const p = spawn(bin, ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:" + PORT], { stdio: ["ignore", "pipe", "pipe"] });
    let found = false;
    const onData = d => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !found) { found = true; setTimeout(() => link(m[0]).catch(e => console.log("link", e)), 4000); }
    };
    p.stdout.on("data", onData); p.stderr.on("data", onData);
    p.on("exit", c => { console.log("cloudflared упал (" + c + "), перезапуск через 10 сек"); setTimeout(start, 10000); });
    p.on("error", e => console.log("Не найден cloudflared — запусти install.sh или впиши PUBLIC_URL в .env", e.message));
  };
  start();
}
