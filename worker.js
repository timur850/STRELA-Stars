// STRELA STARS — магазин Telegram Stars: бот + мини-апп на Cloudflare Workers (бесплатно, 24/7).
// Оплата: Монобанк (личный API, автопроверка по уникальной сумме), CryptoBot (авто), карта РФ (проверяющий подтверждает скрин).
// Выдача: бот сам покупает звёзды на Fragment со своего TON-кошелька и отправляет на юзернейм покупателя.
//
// Секреты Cloudflare (Settings → Variables and Secrets → тип Secret):
//   BOT_TOKEN        — токен бота
//   WALLET_MNEMONIC  — 24 слова кошелька, с которого покупаются звёзды (отдельный кошелёк только под бота!)
//   TONCENTER_KEY    — (необязательно) ключ toncenter.com, чтобы не упираться в лимит
import { CONFIG } from "./config.js";
import HTML from "./index.html";
import * as T from "./ton.js";
import { Fragment } from "./fragment.js";

const NAME = CONFIG.NAME || "STRELA STARS";
const enc = new TextEncoder();
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const low = s => String(s || "").replace(/^@/, "").trim().toLowerCase();
const esc = s => String(s ?? "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
const sha = async s => T.hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, typeof data === "string" ? enc.encode(data) : data));
}
async function checkInitData(initData, token) {
  try {
    const p = new URLSearchParams(initData); const got = p.get("hash"); if (!got) return null;
    p.delete("hash");
    const dcs = [...p.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join("\n");
    if (T.hex(await hmac(await hmac("WebAppData", token), dcs)) !== got) return null;
    if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 7 * 86400) return null;
    return JSON.parse(p.get("user") || "{}");
  } catch { return null; }
}

const DEF = {
  rates: { uah: 0, rub: 0, usd: 0 },         // цена 1 ★ в каждой валюте — ставится в админке
  min: 50, max: 10000,
  on: { mono: true, cp: true, ru: false },
  mono: { card: "", holder: "", account: "0" },
  ru: { details: "", checkers: [] },
  maxTonPerStar: 0.02,                        // защита: дороже этого за 1 ★ бот не купит
  ttl: 30,                                    // минут на оплату
  notifyUnmatched: true,
};
let HTML_TAG = "";
const METHOD = { mono: "Монобанк", cp: "CryptoBot", ru: "Карта РФ" };
const CUR = { mono: "₴", cp: "$", ru: "₽" };
const STATUS = { new: "ждёт оплаты", paid: "оплачен, в очереди", sending: "отправляется", done: "выполнен", check: "нужна проверка", expired: "время вышло", canceled: "отменён", rejected: "отклонён" };
const merge = (a, b) => { for (const k of Object.keys(b || {})) a[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) ? merge(Object.assign({}, a[k]), b[k]) : b[k]; return a; };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      // ETag: повторное открытие мини-аппа не качает страницу заново (ответ 304)
      HTML_TAG = HTML_TAG || '"' + (await sha(HTML)).slice(0, 16) + '"';
      const h = { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", etag: HTML_TAG };
      if (req.headers.get("if-none-match") === HTML_TAG) return new Response(null, { status: 304, headers: h });
      return new Response(HTML, { headers: h });
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return env.STORE.get(env.STORE.idFromName("main")).fetch(req);
  },
  async scheduled(ev, env, ctx) {
    ctx.waitUntil(env.STORE.get(env.STORE.idFromName("main")).fetch("https://do/tick", { method: "POST" }));
  },
};

export class Store {
  constructor(state, env) { this.state = state; this.s = state.storage; this.env = env; this.busy = false; this.mbusy = false; this.tc = new T.Toncenter(env.TONCENTER_KEY); }

  // ---------- общие ----------
  async tg(method, params) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
      return await r.json();
    } catch (e) { console.log("tg", method, e.message); return { ok: false, description: e.message }; }
  }
  async settings() { return merge(structuredClone(DEF), (await this.s.get("settings")) || {}); }
  async sec() { return (await this.s.get("sec")) || {}; }
  async botName() {
    let n = await this.s.get("botname");
    if (!n) { const me = await this.tg("getMe", {}); if (me.ok) { n = me.result.username; await this.s.put("botname", n); } }
    return n || "";
  }
  isOwner(u) { return !!u && CONFIG.OWNERS.some(o => low(o) === low(u.username) || String(o) === String(u.id)); }
  async isChecker(u, st) { st = st || await this.settings(); return !!u && st.ru.checkers.some(o => low(o) === low(u.username) || String(o) === String(u.id)); }
  async seen(u) { if (u && u.username && u.id) { const k = "seen:" + low(u.username); if ((await this.s.get(k)) !== u.id) await this.s.put(k, u.id); } }
  async idsOf(list) {
    const out = new Set();
    for (const x of list) { if (/^\d+$/.test(String(x))) out.add(Number(x)); else { const id = await this.s.get("seen:" + low(x)); if (id) out.add(id); } }
    return [...out];
  }
  async notifyOwners(text, extra) { for (const id of await this.idsOf(CONFIG.OWNERS)) await this.tg("sendMessage", { chat_id: id, text, parse_mode: "HTML", ...(extra || {}) }); }
  async getO(id) { return this.s.get("o:" + id); }
  async putO(o) { await this.s.put("o:" + o.id, o); }
  async open() { return (await this.s.get("open")) || []; }
  async setOpen(ids) { await this.s.put("open", ids); }
  async closeO(o) { const ids = await this.open(); const i = ids.indexOf(o.id); if (i >= 0) { ids.splice(i, 1); await this.setOpen(ids); } }
  async many(ids) {   // storage.get берёт максимум 128 ключей за раз
    const out = [];
    for (let i = 0; i < ids.length; i += 128) { const part = ids.slice(i, i + 128), m = await this.s.get(part.map(x => "o:" + x)); for (const x of part) { const o = m.get("o:" + x); if (o) out.push(o); } }
    return out;
  }
  async openOrders() { return this.many(await this.open()); }
  async wake(ms = 1000) { const cur = await this.s.getAlarm(); const at = Date.now() + ms; if (!cur || cur > at) await this.s.setAlarm(at); }
  view(o, full) {
    const v = { id: o.id, to: o.to, qty: o.qty, method: o.method, price: o.price, cur: CUR[o.method], status: o.status, statusText: STATUS[o.status], created: o.created, doneAt: o.doneAt, pay: o.pay, expires: o.expires };
    if (full) Object.assign(v, { uid: o.uid, uname: o.uname, err: o.err, by: o.by, ton: o.ton, tries: o.tries, paidAt: o.paidAt, shot: o.shot });
    return v;
  }

  // ---------- вход ----------
  async fetch(req) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (p === "/tick") { await this.tick(); return json({ ok: true }); }
      if (p === "/setup") return this.setup(url.origin);
      if (p === "/tg") {
        if (req.headers.get("x-telegram-bot-api-secret-token") !== (await sha("tg" + this.env.BOT_TOKEN)).slice(0, 40)) return new Response("no", { status: 403 });
        const upd = await req.json(); await this.onUpdate(upd); return new Response("ok");
      }
      if (p.startsWith("/mono/")) {
        if (p.slice(6) !== (await sha("mono" + this.env.BOT_TOKEN)).slice(0, 32)) return new Response("no", { status: 403 });
        // тело не используем: по сигналу сами сверяем выписку через API банка
        if (req.method === "POST") { const last = (await this.s.get("monoLast")) || 0; await this.wake(Math.max(500, last + 61000 - Date.now())); }
        return new Response("ok");
      }
      if (p === "/cp") return this.onCryptoPay(req);
      if (p.startsWith("/api/") && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const u = await checkInitData(body.initData || "", this.env.BOT_TOKEN);
        if (!u || !u.id) return json({ ok: false, err: "Открой магазин через бота" }, 401);
        await this.seen(u);
        return json(await this.api(p.slice(5), u, body));
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.log("ERR", p, e && e.stack || e);
      return json({ ok: false, err: String(e && e.message || e) }, 500);
    }
  }
  async alarm() { await this.tick(); }

  async setup(origin) {
    if (!this.env.BOT_TOKEN) return new Response("Нет секрета BOT_TOKEN в Cloudflare", { status: 500 });
    await this.s.put("origin", origin);
    const r = await this.tg("setWebhook", { url: origin + "/tg", secret_token: (await sha("tg" + this.env.BOT_TOKEN)).slice(0, 40), allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
    await this.tg("setChatMenuButton", { menu_button: { type: "web_app", text: "⭐ Купить", web_app: { url: origin + "/" } } });
    await this.s.delete("botname"); const n = await this.botName();
    return new Response(r.ok ? `✅ Бот @${n} подключён. Открой его в Telegram и нажми /start` : "Ошибка: " + JSON.stringify(r), { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  // ---------- бот ----------
  async onUpdate(upd) {
    const origin = await this.s.get("origin");
    if (upd.callback_query) return this.onCallback(upd.callback_query);
    const m = upd.message; if (!m || !m.from || m.chat.type !== "private") return;
    await this.seen(m.from);
    const kb = { inline_keyboard: [[{ text: "⭐ Купить звёзды", web_app: { url: origin + "/" } }]] };
    if (m.text && m.text.startsWith("/start")) {
      return this.tg("sendMessage", { chat_id: m.chat.id, parse_mode: "HTML", reply_markup: kb,
        text: `⭐ <b>${NAME}</b>\n\nTelegram Stars на любой юзернейм — без KYC и автоматически.\n\nЖми кнопку ниже 👇` });
    }
    if (m.text && m.text.startsWith("/id")) {
      return this.tg("sendMessage", { chat_id: m.chat.id, parse_mode: "HTML",
        text: `Твой ID: <code>${m.from.id}</code>\nЮзернейм: ${m.from.username ? "@" + esc(m.from.username) : "нет"}\nАдмин: ${this.isOwner(m.from) ? "✅ да" : "❌ нет — впиши ID в config.js → OWNERS"}` });
    }
    if (m.photo || m.document) {
      const ids = (await this.s.get("u:" + m.from.id)) || [];
      let o = null;
      for (const id of ids.slice().reverse()) { const x = await this.getO(id); if (x && x.method === "ru" && (x.status === "new" || x.status === "expired")) { o = x; break; } }
      if (!o) return this.tg("sendMessage", { chat_id: m.chat.id, text: "Нет заказа с оплатой картой РФ, который ждёт подтверждения. Создай заказ в магазине 👇", reply_markup: kb });
      const st = await this.settings();
      const chk = await this.idsOf(st.ru.checkers.length ? st.ru.checkers : CONFIG.OWNERS);
      const cap = `🧾 Заказ #${o.id} — карта РФ\n${o.qty} ⭐ → @${o.to}\nСумма: ${o.price} ₽\nОт: ${o.uname || o.uid} (id ${o.uid})`;
      const rm = { inline_keyboard: [[{ text: "✅ Подтвердить", callback_data: "ru:ok:" + o.id }, { text: "❌ Отклонить", callback_data: "ru:no:" + o.id }]] };
      let sent = 0;
      for (const id of chk) {
        const r = m.photo ? await this.tg("sendPhoto", { chat_id: id, photo: m.photo[m.photo.length - 1].file_id, caption: cap, reply_markup: rm })
          : await this.tg("sendDocument", { chat_id: id, document: m.document.file_id, caption: cap, reply_markup: rm });
        if (r.ok) sent++;
      }
      o.shot = true; await this.putO(o);
      return this.tg("sendMessage", { chat_id: m.chat.id, text: sent ? "📨 Скрин отправлен на проверку. Как только оплату подтвердят, звёзды уйдут автоматически." : "Проверяющий пока недоступен — напиши в поддержку " + CONFIG.SUPPORT });
    }
    return this.tg("sendMessage", { chat_id: m.chat.id, text: "Открой магазин кнопкой ниже 👇", reply_markup: kb });
  }
  async onCallback(q) {
    const [kind, act, id] = String(q.data || "").split(":");
    if (kind !== "ru") return;
    await this.seen(q.from);
    const st = await this.settings();
    if (!this.isOwner(q.from) && !(await this.isChecker(q.from, st))) return this.tg("answerCallbackQuery", { callback_query_id: q.id, text: "Нет доступа", show_alert: true });
    const r = await this.ruDecide(Number(id), act === "ok", q.from);
    await this.tg("answerCallbackQuery", { callback_query_id: q.id, text: r.ok ? (act === "ok" ? "Подтверждено ✅" : "Отклонено ❌") : r.err, show_alert: !r.ok });
    if (r.ok && q.message) await this.tg("editMessageCaption", { chat_id: q.message.chat.id, message_id: q.message.message_id,
      caption: (q.message.caption || "") + `\n\n${act === "ok" ? "✅ Подтвердил" : "❌ Отклонил"} @${q.from.username || q.from.id}` });
  }
  async ruDecide(id, ok, who) {
    const o = await this.getO(id);
    if (!o || o.method !== "ru") return { ok: false, err: "Заказ не найден" };
    if (o.status !== "new" && o.status !== "expired") return { ok: false, err: "Заказ уже " + STATUS[o.status] };
    const by = "@" + (who.username || who.id);
    if (ok) await this.markPaid(o, by);
    else {
      o.status = "rejected"; o.by = by; await this.putO(o); await this.closeO(o);
      await this.tg("sendMessage", { chat_id: o.uid, text: `❌ Оплата по заказу #${o.id} не подтверждена. Если это ошибка — напиши в поддержку ${CONFIG.SUPPORT}` });
    }
    return { ok: true };
  }

  // ---------- оплата ----------
  async markPaid(o, by) {
    if (o.status !== "new" && o.status !== "expired") return;
    o.status = "paid"; o.paidAt = Date.now(); o.by = by; o.tries = 0; await this.putO(o);
    const ids = await this.open(); if (!ids.includes(o.id)) { ids.push(o.id); await this.setOpen(ids); }
    await this.tg("sendMessage", { chat_id: o.uid, text: `💳 Оплата заказа #${o.id} получена. Отправляем ${o.qty} ⭐ на @${o.to}…` });
    await this.wake(500);
  }
  async cp(method, params) {
    const token = (await this.sec()).cpToken; if (!token) throw new Error("не задан токен CryptoBot");
    const host = token.startsWith("test") ? "testnet-pay.crypt.bot" : "pay.crypt.bot";
    const r = await fetch(`https://${host}/api/${method}`, { method: "POST", headers: { "Crypto-Pay-API-Token": token, "content-type": "application/json" }, body: JSON.stringify(params || {}) });
    const j = await r.json().catch(() => ({ ok: false }));
    if (!j.ok) throw new Error("CryptoBot: " + ((j.error && (j.error.name || j.error.code)) || "ошибка"));
    return j.result;
  }
  async onCryptoPay(req) {
    const raw = await req.text(), token = (await this.sec()).cpToken;
    if (!token) return new Response("no", { status: 403 });
    const key = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(token)));
    if (T.hex(await hmac(key, raw)) !== (req.headers.get("crypto-pay-api-signature") || "")) return new Response("bad sig", { status: 401 });
    const u = JSON.parse(raw);
    if (u.update_type === "invoice_paid") await this.cpPaid(u.payload);
    return new Response("ok");
  }
  async cpPaid(inv) {
    if (!inv || inv.status !== "paid") return;
    const o = await this.getO(Number(inv.payload));
    if (!o || o.method !== "cp" || String(o.inv) !== String(inv.invoice_id)) return;
    if (Number(inv.amount) + 1e-9 < Number(o.price)) return;
    await this.markPaid(o, "CryptoBot");
  }
  async mono(path, opt = {}) {
    const token = (await this.sec()).monoToken; if (!token) throw new Error("не задан токен Монобанка");
    const r = await fetch("https://api.monobank.ua" + path, { method: opt.body ? "POST" : "GET", headers: { "X-Token": token, "content-type": "application/json" }, body: opt.body ? JSON.stringify(opt.body) : undefined });
    if (r.status === 429) throw new Error("Монобанк: подожди минуту (лимит 1 запрос в минуту)");
    const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch {}
    if (!r.ok) throw new Error("Монобанк: " + (j.errorDescription || r.status));
    return j;
  }
  async monoCheck(orders) {
    if (this.mbusy) return; this.mbusy = true;
    try {
      const last = (await this.s.get("monoLast")) || 0;
      if (Date.now() - last < 61000) { await this.wake(last + 61000 - Date.now()); return; }
      await this.s.put("monoLast", Date.now());
      const st = await this.settings(), since = (await this.s.get("monoSince")) || Date.now();
      const from = Math.floor(Math.max(Math.min(...orders.map(o => o.created)) - 180000, Date.now() - 6 * 3600e3) / 1000);
      const items = await this.mono(`/personal/statement/${encodeURIComponent(st.mono.account || "0")}/${from}`);
      for (const it of Array.isArray(items) ? items : []) {
        if (!(it.amount > 0) || (it.currencyCode && it.currencyCode !== 980)) continue;
        const uk = "used:" + it.id; if (await this.s.get(uk)) continue;
        const o = orders.find(x => (x.status === "new" || x.status === "expired") && x.kop === it.amount && it.time * 1000 >= x.created - 120000);
        if (o) { await this.s.put(uk, o.id); o.monoId = it.id; await this.markPaid(o, "Монобанк"); continue; }
        await this.s.put(uk, "-");
        if (st.notifyUnmatched && it.time * 1000 > since)
          await this.notifyOwners(`💸 На моно пришло ${(it.amount / 100).toFixed(2)} ₴ без подходящего заказа${it.description ? "\n" + esc(it.description) : ""}${it.comment ? "\n💬 " + esc(it.comment) : ""}\nЕсли это оплата — подтверди заказ вручную в админке.`);
      }
    } catch (e) { console.log("mono", e.message); }
    finally { this.mbusy = false; }
  }

  // ---------- кошелёк и выдача ----------
  async key() {
    if (this._key) return this._key;
    if (!this.env.WALLET_MNEMONIC) throw new Error("нет секрета WALLET_MNEMONIC в Cloudflare");
    const words = String(this.env.WALLET_MNEMONIC).trim().split(/\s+/).length;
    if (words === 24) return (this._key = await T.keyFromMnemonic(this.env.WALLET_MNEMONIC));
    // 12 слов: пробуем все способы и берём тот, чей ключ совпадает с ключом кошелька в сети
    const addrS = CONFIG.WALLET_ADDRESS || this.env.WALLET_ADDRESS;
    if (!addrS) throw new Error("впиши WALLET_ADDRESS");
    const want = (await this.tc.getNum(T.rawAddr(T.parseAddr(addrS)), "get_public_key")).toString(16).padStart(64, "0");
    for (const c of await T.keyCandidates(this.env.WALLET_MNEMONIC)) if (T.hex(c.key.publicKey) === want) return (this._key = c.key);
    throw new Error("сид-фраза не от этого кошелька (проверь WALLET_ADDRESS)");
  }
  async walletCheck() {
    const w = { ok: false, at: Date.now() };
    try {
      const addrS = CONFIG.WALLET_ADDRESS || this.env.WALLET_ADDRESS;
      if (!addrS) throw new Error("впиши WALLET_ADDRESS в config.js");
      const a = T.parseAddr(addrS); w.raw = T.rawAddr(a); w.address = T.friendly(a, false);
      const key = await this.key(); w.pub = T.hex(key.publicKey);
      const info = await this.tc.info(w.raw);
      w.balance = String(info.balance || 0);
      if (info.state !== "active") throw new Error("кошелёк не активирован — отправь с него хотя бы одну транзакцию");
      const code = T.parseBoc(info.code), data = T.parseBoc(info.data);
      w.version = T.CODE_HASH[T.hex(await code.hash())];
      if (!w.version) throw new Error("неизвестный тип кошелька (нужен v4r2 или W5)");
      const si = T.stateInitCell(code, data);
      if (T.hex(await si.hash()) !== T.hex(a.hash)) throw new Error("адрес не совпадает с кодом кошелька");
      const pub = await this.tc.getNum(w.raw, "get_public_key");
      if (pub.toString(16).padStart(64, "0") !== w.pub) throw new Error("сид-фраза не от этого кошелька");
      try { w.walletId = Number(await this.tc.getNum(w.raw, "get_subwallet_id")); }
      catch { w.walletId = w.version === "v5r1" ? 2147483409 : 698983191; }
      w.stateInit = T.b64e(T.serializeBoc(si));
      w.ok = true;
    } catch (e) { w.err = e.message; }
    await this.s.put("wallet", w); return w;
  }
  async wallet() { const w = await this.s.get("wallet"); return w && w.ok && Date.now() - w.at < 6 * 3600e3 ? w : this.walletCheck(); }

  async deliver() {
    if (this.busy) return; this.busy = true;
    try {
      const inf = await this.s.get("inflight");
      if (inf) {
        const w = await this.s.get("wallet"), o = await this.getO(inf.id);
        const seq = Number(await this.tc.getNum(w.raw, "seqno"));
        if (seq > inf.seqno) {
          let found = false;
          try { const txs = await this.tc.call(`getTransactions?address=${encodeURIComponent(w.raw)}&limit=20`);
            const want = T.b64e(T.unhex(inf.hash)); found = txs.some(t => t.in_msg && (t.in_msg.hash === want || T.hex(T.b64d(t.in_msg.hash || "")) === inf.hash)); } catch {}
          await this.s.delete("inflight");
          if (found) await this.finish(o, inf);
          else { o.status = "check"; o.err = "seqno кошелька вырос, но транзакция заказа не найдена — проверь кошелёк"; await this.putO(o); await this.closeO(o);
            await this.notifyOwners(`⚠️ Заказ #${o.id}: ${o.err}`); }
        } else if (Date.now() > inf.validUntil * 1000 + 60000) {
          // срок транзакции истёк — она уже точно не пройдёт, можно повторить
          await this.s.delete("inflight");
          o.tries = (o.tries || 0) + 1; o.err = "транзакция не прошла";
          o.status = o.tries >= 3 ? "check" : "paid"; await this.putO(o);
          if (o.status === "check") { await this.closeO(o); await this.notifyOwners(`⚠️ Заказ #${o.id} (${o.qty} ⭐ → @${o.to}) не удалось отправить 3 раза. Проверь кошелёк и нажми «Повторить» в админке.`); }
        } else { await this.wake(10000); return; }
      }
      const paid = (await this.openOrders()).filter(o => o.status === "paid").sort((a, b) => a.paidAt - b.paidAt);
      const o = paid[0]; if (!o) return;
      const sec = await this.sec(), st = await this.settings();
      const stop = async msg => {
        if (o.err !== msg) { o.err = msg; await this.putO(o); await this.notifyOwners(`⛔ Выдача остановлена: ${esc(msg)}\nВ очереди заказов: ${paid.length}`); }
        await this.wake(60000);
      };
      const w = await this.wallet();
      if (!w.ok) return stop("кошелёк: " + w.err);
      if (!sec.cookies) return stop("не вставлены куки Fragment");
      let q;
      try { q = await new Fragment(sec.cookies).buy(o.to, o.qty, w); }
      catch (e) {
        if (/куки|не открылся|KYC|verify|login|auth/i.test(e.message)) return stop(e.message);
        o.tries = (o.tries || 0) + 1; o.err = e.message;
        if (o.tries >= 3 || /нет такого пользователя/.test(e.message)) { o.status = "check"; await this.closeO(o); await this.notifyOwners(`⚠️ Заказ #${o.id} (${o.qty} ⭐ → @${esc(o.to)}): ${esc(e.message)}`); }
        await this.putO(o); await this.wake(20000); return;
      }
      if (Number(q.amount) / 1e9 / o.qty > st.maxTonPerStar) {
        o.status = "check"; o.err = `Fragment просит ${(Number(q.amount) / 1e9).toFixed(4)} TON — дороже лимита ${st.maxTonPerStar} TON за ★`;
        await this.putO(o); await this.closeO(o); await this.notifyOwners(`⚠️ Заказ #${o.id}: ${o.err}`); return;
      }
      const info = await this.tc.info(w.raw);
      if (BigInt(info.balance || 0) < q.amount + 50000000n) return stop(`мало TON на кошельке: нужно ${(Number(q.amount) / 1e9 + 0.05).toFixed(3)}, есть ${(Number(info.balance) / 1e9).toFixed(3)}`);
      const seqno = Number(await this.tc.getNum(w.raw, "seqno"));
      const to = T.parseAddr(q.to), validUntil = Math.floor(Date.now() / 1000) + 180;
      const tr = await T.buildTransfer({ version: w.version, walletId: w.walletId, seqno, wallet: T.parseAddr(w.raw), key: await this.key(),
        to, amount: q.amount, bounce: to.bounceable, payload: q.payload, validUntil });
      // сначала запоминаем отправку — так заказ не уйдёт дважды даже при сбое
      await this.s.put("inflight", { id: o.id, seqno, validUntil, hash: tr.hash, amount: String(q.amount) });
      o.status = "sending"; o.err = ""; await this.putO(o);
      try { await this.tc.send(tr.boc); } catch (e) { o.err = e.message; await this.putO(o); }
      await this.wake(12000);
    } catch (e) { console.log("deliver", e.stack || e); await this.wake(30000); }
    finally { this.busy = false; }
  }
  async finish(o, inf) {
    o.status = "done"; o.doneAt = Date.now(); o.ton = inf.amount; o.err = ""; await this.putO(o); await this.closeO(o);
    const s = (await this.s.get("stats")) || { orders: 0, stars: 0, uah: 0, usd: 0, rub: 0, ton: 0 };
    s.orders++; s.stars += o.qty; s.ton += Number(inf.amount) / 1e9;
    s[{ mono: "uah", cp: "usd", ru: "rub" }[o.method]] += Number(o.price);
    await this.s.put("stats", s);
    if (o.method === "ru") {
      const d = (await this.s.get("ruDebt")) || { orders: 0, stars: 0, rub: 0, ton: 0, since: Date.now() };
      d.orders++; d.stars += o.qty; d.rub += Number(o.price); d.ton += Number(inf.amount) / 1e9; await this.s.put("ruDebt", d);
    }
    await this.tg("sendMessage", { chat_id: o.uid, text: `✅ Готово! ${o.qty} ⭐ отправлены на @${o.to}.\nСпасибо за покупку в ${NAME}!` });
  }

  // ---------- периодическая работа ----------
  async tick() {
    const st = await this.settings(), now = Date.now();
    let orders = await this.openOrders(), changed = false;
    for (const o of orders) {
      if (o.status === "new" && now > o.expires) { o.status = "expired"; await this.putO(o); }
      if (o.status === "expired" && now - o.created > 6 * 3600e3) { await this.closeO(o); changed = true; }
    }
    if (changed) orders = await this.openOrders();
    const sec = await this.sec();
    const monoW = orders.filter(o => o.method === "mono" && (o.status === "new" || o.status === "expired"));
    if (monoW.length && sec.monoToken) await this.monoCheck(monoW);
    const cpW = orders.filter(o => o.method === "cp" && o.status === "new" && o.inv);
    if (cpW.length && sec.cpToken) {
      try { const r = await this.cp("getInvoices", { invoice_ids: cpW.map(o => o.inv).join(",") });
        for (const inv of r.items || []) await this.cpPaid(inv); } catch (e) { console.log("cp", e.message); }
    }
    await this.deliver();
    orders = await this.openOrders();
    if (orders.some(o => o.status === "paid" || o.status === "sending")) await this.wake(15000);
    else if (orders.some(o => o.method === "mono" && o.status === "new")) await this.wake(62000);
  }

  // ---------- API мини-аппа ----------
  async api(act, u, b) {
    const st = await this.settings(), owner = this.isOwner(u), checker = !owner && await this.isChecker(u, st);
    if (act === "init") {
      const ids = ((await this.s.get("u:" + u.id)) || []).slice(-20).reverse();
      const m = ids.length ? await this.s.get(ids.map(i => "o:" + i)) : new Map();
      return { ok: true, name: NAME, support: CONFIG.SUPPORT, bot: await this.botName(), role: owner ? "owner" : checker ? "checker" : "",
        me: { id: u.id, username: u.username || "", first: u.first_name || "" },
        shop: { rates: st.rates, min: st.min, max: st.max, on: { mono: st.on.mono && st.rates.uah > 0, cp: st.on.cp && st.rates.usd > 0, ru: st.on.ru && st.rates.rub > 0 }, ttl: st.ttl },
        orders: ids.map(i => m.get("o:" + i)).filter(Boolean).map(o => this.view(o)) };
    }
    if (act === "recipient") {
      const to = low(b.to); if (!/^[a-z0-9_]{4,32}$/.test(to)) return { ok: false, err: "Неверный юзернейм" };
      const sec = await this.sec(); if (!sec.cookies) return { ok: true, name: "" };
      try { const r = await new Fragment(sec.cookies).recipient(to); return { ok: true, name: r.name }; }
      catch (e) { return /нет такого/.test(e.message) ? { ok: false, err: "Пользователь @" + to + " не найден" } : { ok: true, name: "" }; }
    }
    if (act === "create") return this.create(u, b, st);
    if (act === "order") {
      const o = await this.getO(Number(b.id));
      if (!o || (o.uid !== u.id && !owner && !(checker && o.method === "ru"))) return { ok: false, err: "Заказ не найден" };
      return { ok: true, order: this.view(o, owner || checker) };
    }
    if (act === "cancel") {
      const o = await this.getO(Number(b.id));
      if (!o || o.uid !== u.id || o.status !== "new") return { ok: false, err: "Этот заказ нельзя отменить" };
      o.status = "canceled"; await this.putO(o); await this.closeO(o); return { ok: true, order: this.view(o) };
    }
    if (!owner && !checker) return { ok: false, err: "Нет доступа" };
    return this.admin(act, u, b, st, owner);
  }
  async create(u, b, st) {
    const to = low(b.to), qty = Math.floor(Number(b.qty)), method = String(b.method || "");
    if (!/^[a-z0-9_]{4,32}$/.test(to)) return { ok: false, err: "Укажи юзернейм получателя" };
    if (!(qty >= st.min && qty <= st.max)) return { ok: false, err: `Количество: от ${st.min} до ${st.max} ⭐` };
    const rate = { mono: st.rates.uah, cp: st.rates.usd, ru: st.rates.rub }[method];
    if (!st.on[method] || !(rate > 0)) return { ok: false, err: "Этот способ оплаты сейчас выключен" };
    const recent = ((await this.s.get("u:" + u.id)) || []).slice(-5), rm = recent.length ? await this.s.get(recent.map(i => "o:" + i)) : new Map();
    if ([...rm.values()].filter(o => o && o.status === "new").length >= 3) return { ok: false, err: "У тебя уже 3 неоплаченных заказа — оплати или отмени их" };
    const id = ((await this.s.get("seq")) || 1000) + 1; await this.s.put("seq", id);
    const now = Date.now();
    const o = { id, uid: u.id, uname: u.username ? "@" + u.username : (u.first_name || ""), to, qty, method, status: "new", created: now, expires: now + st.ttl * 60000 * (method === "ru" ? 4 : 1) };
    if (method === "mono") {
      if (!st.mono.card) return { ok: false, err: "Оплата Монобанком ещё не настроена" };
      const base = Math.ceil(qty * rate) * 100;
      const taken = new Set((await this.openOrders()).filter(x => x.method === "mono" && (x.status === "new" || x.status === "expired")).map(x => x.kop));
      let kop = 0; const start = 1 + Math.floor(Math.random() * 98);
      for (let i = 0; i < 99 && !kop; i++) { const k = base + 1 + ((start + i) % 99); if (!taken.has(k)) kop = k; }
      if (!kop) return { ok: false, err: "Слишком много заказов на эту сумму, попробуй другое количество" };
      o.kop = kop; o.price = (kop / 100).toFixed(2); o.pay = { card: st.mono.card, holder: st.mono.holder };
    } else if (method === "cp") {
      o.price = (Math.ceil(qty * rate * 100) / 100).toFixed(2);
      const bot = await this.botName();
      const inv = await this.cp("createInvoice", { currency_type: "fiat", fiat: "USD", amount: o.price, accepted_assets: "USDT,TON",
        description: `${qty} ⭐ для @${to} — ${NAME}`, payload: String(id), expires_in: st.ttl * 60, allow_comments: false,
        ...(bot ? { paid_btn_name: "openBot", paid_btn_url: "https://t.me/" + bot } : {}) });
      o.inv = inv.invoice_id; o.pay = { url: inv.mini_app_invoice_url || inv.bot_invoice_url };
    } else if (method === "ru") {
      if (!st.ru.details) return { ok: false, err: "Реквизиты карты РФ ещё не заданы" };
      o.price = String(Math.ceil(qty * rate)); o.pay = { details: st.ru.details };
    }
    await this.putO(o);
    const ids = await this.open(); ids.push(id); await this.setOpen(ids);
    const mine = (await this.s.get("u:" + u.id)) || []; mine.push(id); await this.s.put("u:" + u.id, mine.slice(-30));
    const rec = (await this.s.get("recent")) || []; rec.push(id); await this.s.put("recent", rec.slice(-300));
    if (method === "mono") await this.wake(62000);
    if (method === "ru") {
      const chk = await this.idsOf(st.ru.checkers.length ? st.ru.checkers : CONFIG.OWNERS);
      for (const c of chk) await this.tg("sendMessage", { chat_id: c, text: `🆕 Заказ #${id} — карта РФ: ${qty} ⭐ → @${to}, ${o.price} ₽. Жду скрин от покупателя.` });
    }
    return { ok: true, order: this.view(o) };
  }
  async admin(act, u, b, st, owner) {
    const origin = await this.s.get("origin");
    const listOrders = async (filter) => {
      const ids = ((await this.s.get("recent")) || []).slice().reverse();
      const m = ids.length ? await this.s.get(ids.slice(0, 128).map(i => "o:" + i)) : new Map();
      return ids.slice(0, 128).map(i => m.get("o:" + i)).filter(o => o && filter(o)).map(o => this.view(o, true));
    };
    if (!owner) {   // проверяющий карты РФ: только свои заказы и реквизиты
      if (act === "admin") return { ok: true, role: "checker", ru: { details: st.ru.details }, orders: await listOrders(o => o.method === "ru"), debt: await this.s.get("ruDebt") };
      if (act === "set" && b.ru && typeof b.ru.details === "string") { st.ru.details = b.ru.details.slice(0, 500); await this.s.put("settings", st); return { ok: true }; }
      if (act === "order_act" && (b.act === "paid" || b.act === "reject")) return this.ruDecide(Number(b.id), b.act === "paid", u);
      return { ok: false, err: "Нет доступа" };
    }
    if (act === "admin") {
      const sec = await this.sec();
      return { ok: true, role: "owner", settings: st, origin,
        flags: { monoToken: !!sec.monoToken, cpToken: !!sec.cpToken, cookies: !!sec.cookies, mnemonic: !!this.env.WALLET_MNEMONIC, walletAddr: CONFIG.WALLET_ADDRESS || this.env.WALLET_ADDRESS || "", monoHook: !!(await this.s.get("monoHook")) },
        wallet: await this.s.get("wallet"), stats: await this.s.get("stats"), debt: await this.s.get("ruDebt"),
        queue: (await this.openOrders()).filter(o => o.status === "paid" || o.status === "sending").length,
        orders: await listOrders(() => true) };
    }
    if (act === "set") {
      const p = b.patch || {};
      if (p.rates) for (const k of ["uah", "rub", "usd"]) if (p.rates[k] !== undefined) st.rates[k] = Math.max(0, Number(p.rates[k]) || 0);
      if (p.min !== undefined) st.min = Math.max(50, Math.floor(Number(p.min)) || 50);
      if (p.max !== undefined) st.max = Math.min(1000000, Math.max(st.min, Math.floor(Number(p.max)) || st.min));
      if (p.on) for (const k of ["mono", "cp", "ru"]) if (p.on[k] !== undefined) st.on[k] = !!p.on[k];
      if (p.mono) for (const k of ["card", "holder", "account"]) if (typeof p.mono[k] === "string") st.mono[k] = p.mono[k].trim().slice(0, 100);
      if (p.ru) { if (typeof p.ru.details === "string") st.ru.details = p.ru.details.slice(0, 500);
        if (Array.isArray(p.ru.checkers)) st.ru.checkers = p.ru.checkers.map(x => String(x).replace(/^@/, "").trim()).filter(Boolean).slice(0, 10); }
      if (p.maxTonPerStar !== undefined) st.maxTonPerStar = Math.max(0.001, Number(p.maxTonPerStar) || DEF.maxTonPerStar);
      if (p.ttl !== undefined) st.ttl = Math.min(180, Math.max(10, Math.floor(Number(p.ttl)) || 30));
      if (p.notifyUnmatched !== undefined) st.notifyUnmatched = !!p.notifyUnmatched;
      await this.s.put("settings", st);
      const s = b.secrets || {}, sec = await this.sec();
      if (typeof s.cpToken === "string" && s.cpToken.trim()) {
        sec.cpToken = s.cpToken.trim();
        try { await this.s.put("sec", sec); await this.cp("getMe"); } catch (e) { delete sec.cpToken; await this.s.put("sec", sec); return { ok: false, err: e.message }; }
      }
      if (typeof s.monoToken === "string" && s.monoToken.trim()) { sec.monoToken = s.monoToken.trim(); await this.s.put("monoSince", Date.now()); await this.s.delete("monoHook"); }
      if (typeof s.cookies === "string" && s.cookies.trim()) sec.cookies = s.cookies.trim().replace(/^cookie:\s*/i, "");
      for (const k of ["cpToken", "monoToken", "cookies"]) if (s[k] === "-") delete sec[k];
      await this.s.put("sec", sec);
      return { ok: true };
    }
    if (act === "wallet_check") return { ok: true, wallet: await this.walletCheck() };
    if (act === "frag_check") {
      const sec = await this.sec(); if (!sec.cookies) return { ok: false, err: "Сначала вставь куки" };
      try { const f = new Fragment(sec.cookies); const r = await f.recipient(u.username || "durov", 50); return { ok: true, msg: "Fragment работает ✅ (нашёл " + (r.name || "получателя") + ")" }; }
      catch (e) { return { ok: false, err: e.message }; }
    }
    if (act === "mono_accounts") {
      const ci = await this.mono("/personal/client-info");
      return { ok: true, name: ci.name, accounts: (ci.accounts || []).map(a => ({ id: a.id, title: (a.maskedPan || [])[0] || a.type, cur: a.currencyCode, balance: a.balance / 100 })),
        jars: (ci.jars || []).map(j => ({ id: j.id, title: "Банка: " + j.title, cur: j.currencyCode, balance: j.balance / 100 })) };
    }
    if (act === "mono_hook") {
      if (!origin) return { ok: false, err: "Сначала открой /setup" };
      await this.mono("/personal/webhook", { body: { webHookUrl: origin + "/mono/" + (await sha("mono" + this.env.BOT_TOKEN)).slice(0, 32) } });
      await this.s.put("monoHook", 1); return { ok: true };
    }
    if (act === "cp_hook") return { ok: true, url: origin + "/cp" };
    if (act === "order_act") {
      const o = await this.getO(Number(b.id)); if (!o) return { ok: false, err: "Заказ не найден" };
      const who = "@" + (u.username || u.id);
      if (b.act === "paid") { if (o.status !== "new" && o.status !== "expired") return { ok: false, err: "Заказ уже " + STATUS[o.status] }; await this.markPaid(o, who + " вручную"); }
      else if (b.act === "reject" && o.method === "ru") return this.ruDecide(o.id, false, u);
      else if (b.act === "retry") {
        if (o.status !== "check") return { ok: false, err: "Повторить можно только заказ «нужна проверка»" };
        o.status = "paid"; o.tries = 0; o.err = ""; o.paidAt = Date.now(); await this.putO(o);
        const ids = await this.open(); if (!ids.includes(o.id)) { ids.push(o.id); await this.setOpen(ids); } await this.wake(500);
      } else if (b.act === "done") {
        if (!["check", "paid"].includes(o.status)) return { ok: false, err: "Нельзя" };
        o.status = "done"; o.doneAt = Date.now(); o.by = (o.by || "") + ", выдан вручную " + who; await this.putO(o); await this.closeO(o);
        await this.tg("sendMessage", { chat_id: o.uid, text: `✅ Заказ #${o.id} выполнен: ${o.qty} ⭐ на @${o.to}.` });
      } else if (b.act === "cancel") {
        if (["done", "sending"].includes(o.status)) return { ok: false, err: "Нельзя" };
        o.status = "canceled"; await this.putO(o); await this.closeO(o);
      } else return { ok: false, err: "?" };
      return { ok: true, order: this.view(await this.getO(o.id), true) };
    }
    if (act === "debt_reset") { await this.s.put("ruDebt", { orders: 0, stars: 0, rub: 0, ton: 0, since: Date.now() }); return { ok: true }; }
    if (act === "kick") { await this.wake(200); return { ok: true }; }
    return { ok: false, err: "Неизвестное действие" };
  }
}
