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
import { COUNTRIES } from "./countries.js";
import * as F from "./fragment.js";

const NAME = CONFIG.NAME || "STRELA STARS";
const enc = new TextEncoder();
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const what = o => o.kind === "premium" ? `👑 Premium на ${o.months} мес.` : o.kind === "number" ? `📱 Номер (${(COUNTRIES[o.cc] || [o.cc])[0]}${o.sp === "clean" ? ", без спамблока" : o.sp === "spam" ? ", со спамблоком" : ""})` : `${o.qty} ⭐`;
const dst = o => o.kind === "number" ? "Telegram" : o.dest === "case" ? "баланс " + ((CONFIG.CASE && CONFIG.CASE.name) || "казино") : "@" + o.to;
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
  rates: { uah: 0, rub: 0, usd: 0 },         // цена 1 ★ в каждой валюте — ставится в админке (если автокурс выключен)
  auto: { on: true, markup: 5, usdPerStar: 0.015 },
  premium: { on: true, usd: { 3: 11.99, 6: 15.99, 12: 28.99 } },   // себестоимость подарка Premium на Fragment в $ (уточняется после покупки)   // автокурс: цена = себестоимость на Fragment по курсу TON + наценка %
  min: 50, max: 10000,
  on: { mono: true, cp: true, ru: false },
  mono: { card: "", holder: "", account: "0" },
  ru: { details: "", checkers: [] },
  maxTonPerStar: 0.02,                        // защита: дороже этого за 1 ★ бот не купит
  ttl: 30,                                    // минут на оплату
  notifyUnmatched: true,
  num: { on: false, markup: 30, cur: "rub", countries: ["BR", "US", "EG", "BD", "MM", "UZ", "ID", "IN", "CO", "CA", "CL", "GB", "KE", "UA", "RU", "KZ", "PL"] },   // номера с LZT Market
};

// номер телефона из ответа LZT (формат ответа у разных категорий немного отличается — смотрим во всех типичных местах)
function pickPhone(j) {
  const it = (j && j.item) || {}, ld = it.loginData || (j && j.loginData) || {};
  for (const v of [ld.login, it.login, j && j.login, it.telegram_phone, it.phone, j && j.telegram_phone, ld.raw]) {
    const d = String(v ?? "").replace(/[\s()+-]/g, "");
    if (/^\d{7,15}$/.test(d)) return "+" + d;
  }
  return "";
}
// код входа из ответа LZT: ищем 4–8 цифр в полях со словом code; если их несколько — берём самый свежий
function pickCode(j) {
  const found = [];
  const walk = (x, d) => {
    if (d > 4 || x == null) return;
    if (Array.isArray(x)) return x.forEach(v => walk(v, d + 1));
    if (typeof x !== "object") return;
    for (const [k, v] of Object.entries(x)) {
      if (/code/i.test(k) && (typeof v === "string" || typeof v === "number") && /^\d{4,8}$/.test(String(v)))
        found.push({ code: String(v), at: Date.parse(x.date || x.created_at || "") || 0 });
      else walk(v, d + 1);
    }
  };
  walk(j, 0);
  found.sort((a, b) => b.at - a.at);
  return found[0] ? found[0].code : "";
}

let HTML_TAG = "";
const METHOD = { mono: "Монобанк", cp: "CryptoBot", ru: "Карта РФ" };
const CUR = { mono: "₴", cp: "$", ru: "₽" };
const NUMCUR = { rub: "₽", uah: "₴", usd: "$" };
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
  constructor(state, env) {
    // при вставке с телефона в секрет часто попадает пробел/перенос — убираем
    for (const k of ["BOT_TOKEN", "WALLET_MNEMONIC", "WALLET_ADDRESS", "TONCENTER_KEY"]) if (typeof env[k] === "string") env[k] = env[k].trim();
    this.state = state; this.s = state.storage; this.env = env; this.busy = false; this.mbusy = false; this.tc = new T.Toncenter(env.TONCENTER_KEY); }

  // ---------- общие ----------
  async tg(method, params) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
      return await r.json();
    } catch (e) { console.log("tg", method, e.message); return { ok: false, description: e.message }; }
  }
  async settings() { return merge(structuredClone(DEF), (await this.s.get("settings")) || {}); }
  async sec() { return (await this.s.get("sec")) || {}; }

  // ---------- автокурс ----------
  // курс TON к $, ₴, ₽ — обновляется не чаще раза в 15 секунд (при каждом открытии магазина/заказе и по таймеру)
  // курсы: $ → ₴ и ₽ (для цены звезды — Fragment продаёт звёзды в долларах) и TON → $ (для справки и учёта реальной цены)
  // обновляются раз в 15 секунд; если источник ответил ошибкой — пауза минуту, чтобы не долбить его
  async fx(force) {
    let f = this._fx || await this.s.get("fx") || {};
    if (!force && f.at && Date.now() - f.at < 15000) return (this._fx = f);
    const errs = [], now = Date.now();
    const get = async (url, pick) => {
      const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; StrelaStars/1.0)" } });
      if (!r.ok) throw new Error(String(r.status)); return pick(await r.json());
    };
    const first = async list => { for (const [n, fn] of list) { try { const v = await fn(); if (v && Object.values(v).every(x => x > 0 && isFinite(x))) return { v, n }; throw new Error("пусто"); } catch (e) { errs.push(n + ": " + e.message); } } return null; };
    // $ → ₴, ₽ (меняется медленно — хватает раз в 10 минут)
    if (!f.fiat || now - (f.fiatAt || 0) > 10 * 60e3) {
      const r = await first([
        ["er-api", () => get("https://open.er-api.com/v6/latest/USD", j => ({ uah: +j.rates.UAH, rub: +j.rates.RUB }))],
        ["jsdelivr", () => get("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json", j => ({ uah: +j.usd.uah, rub: +j.usd.rub }))],
        ["currency-api", () => get("https://latest.currency-api.pages.dev/v1/currencies/usd.json", j => ({ uah: +j.usd.uah, rub: +j.usd.rub }))],
      ]);
      if (r) { f.fiat = r.v; f.fiatAt = now; f.fiatSrc = r.n; }
    }
    // TON → $ (не обязателен для цены)
    if (now - (f.tonFailAt || 0) > 60e3) {
      const r = await first([
        ["ston.fi", () => get("https://api.ston.fi/v1/assets/EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c", j => ({ usd: +j.asset.dex_usd_price }))],
        ["tonapi", () => get("https://tonapi.io/v2/rates?tokens=ton&currencies=usd", j => ({ usd: +j.rates.TON.prices.USD }))],
        ["binance", () => get("https://api.binance.com/api/v3/ticker/price?symbol=TONUSDT", j => ({ usd: +j.price }))],
        ["coingecko", () => get("https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd", j => ({ usd: +j["the-open-network"].usd }))],
      ]);
      if (r) { f.tonUsd = r.v.usd; f.tonSrc = r.n; f.tonFailAt = 0; } else f.tonFailAt = now;
    }
    if (f.fiat && f.tonUsd) f.ton = { usd: f.tonUsd, uah: f.tonUsd * f.fiat.uah, rub: f.tonUsd * f.fiat.rub };
    f.src = [f.tonSrc, f.fiatSrc].filter(Boolean).join(" + ");
    f.at = now; f.err = errs.length && !f.fiat ? errs.join("; ").slice(0, 300) : "";
    this._fxErr = f.err; if (errs.length) console.log("fx", errs.join("; "));
    await this.s.put("fx", f); return (this._fx = f);
  }
  // цены Premium (3/6/12 мес) в ₴ / $ / ₽: себестоимость на Fragment + наценка, по курсу доллара
  async premRates(st) {
    const f = await this.fx(), learned = (await this.s.get("premUsd")) || {}, out = {};
    for (const m of [3, 6, 12]) {
      const usd = (learned[m] || st.premium.usd[m]) * (1 + st.auto.markup / 100);
      out[m] = f && f.fiat ? { usd: Math.ceil(usd * 100) / 100, uah: Math.ceil(usd * f.fiat.uah), rub: Math.ceil(usd * f.fiat.rub) } : { usd: 0, uah: 0, rub: 0 };
    }
    return out;
  }
  // цена 1 ★ в ₴ / $ / ₽ с учётом автокурса
  async curRates(st) {
    if (!st.auto.on) return st.rates;
    const f = await this.fx(); if (!f || !f.fiat) return { uah: 0, usd: 0, rub: 0 };
    const usd = ((await this.s.get("starUsd")) || st.auto.usdPerStar) * (1 + st.auto.markup / 100);   // себестоимость $ за 1 ★ + наценка
    const k = c => f.fiat[c];
    return { usd: Math.ceil(usd * 1e5) / 1e5, uah: Math.ceil(usd * k("uah") * 1e4) / 1e4, rub: Math.ceil(usd * k("rub") * 1e3) / 1e3 };
  }
  async botName() {
    let n = await this.s.get("botname");
    if (!n) { const me = await this.tg("getMe", {}); if (me.ok) { n = me.result.username; await this.s.put("botname", n); } }
    return n || "";
  }
  // включено ли в @BotFather «главное приложение» (тогда ссылка t.me/бот?startapp=… сразу открывает мини-апп)
  async mainApp() {
    const c = await this.s.get("mainapp"); if (c && Date.now() - c.t < (c.v ? 600e3 : 60e3)) return c.v;   // «выключено» перепроверяем каждую минуту
    const me = await this.tg("getMe", {}); const v = !!(me.ok && me.result.has_main_web_app);
    await this.s.put("mainapp", { t: Date.now(), v }); return v;
  }
  caseOn() { return !!(CONFIG.CASE && CONFIG.CASE.url); }
  // зачисление на баланс казино (идемпотентно: повтор того же заказа не зачислит дважды)
  async caseCredit(o) {
    const r = await fetch(CONFIG.CASE.url.replace(/\/$/, "") + "/ext/credit", { method: "POST",
      headers: { "content-type": "application/json", "x-ext-key": String(this.env.CASE_KEY || "").trim() },
      body: JSON.stringify({ id: "stars:" + o.id, uid: String(o.uid), name: o.uname || "", a: o.qty, from: NAME }) });
    const j = await r.json().catch(() => ({ ok: false, err: "казино ответило HTTP " + r.status }));
    const mine = String(this.env.CASE_KEY || "").trim().length;
    if (!j.ok) throw new Error(j.err === "no key" ? "в казино (воркер strela) не задан секрет EXT_KEY или он короче 16 символов — добавь его и сделай Deploy"
      : j.err === "bad key" ? `ключ не совпадает: в STRELA STARS CASE_KEY из ${mine} символов${j.len ? `, в казино EXT_KEY из ${j.len}` : ""} — вставь в оба одинаковый` : (j.err || "ошибка казино"));
    return j;
  }
  isOwner(u) { return !!u && CONFIG.OWNERS.some(o => low(o) === low(u.username) || String(o) === String(u.id)); }
  async isChecker(u, st) { st = st || await this.settings(); return !!u && st.ru.checkers.some(o => low(o) === low(u.username) || String(o) === String(u.id)); }
  async seen(u) { if (u && u.id && !(this._since || (this._since = new Set())).has(u.id)) { this._since.add(u.id); if (!(await this.s.get("since:" + u.id))) await this.s.put("since:" + u.id, Date.now()); }
    if (u && u.username && u.id) { const k = "seen:" + low(u.username); if ((await this.s.get(k)) !== u.id) await this.s.put(k, u.id); } }
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
    const v = { id: o.id, rv: o.rv || 0, to: o.to, dest: o.dest || "", kind: o.kind || "", months: o.months || 0, qty: o.qty, method: o.method, price: o.price, cur: CUR[o.method], status: o.status, statusText: STATUS[o.status], created: o.created, doneAt: o.doneAt, pay: o.pay, expires: o.expires,
      cc: o.cc || "", sp: o.sp || "", cname: o.cc ? (COUNTRIES[o.cc] || [""])[0] : "", phone: o.kind === "number" && o.status === "done" && o.num ? o.num.phone : "" };
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
      if (p === "/ext/verify") {   // казино проверяет заявку на зачисление: только оплаченные заказы «в казино»
        const o = await this.getO(Number(url.searchParams.get("id")));
        const ok = !!(o && o.dest === "case" && ["paid", "check", "done"].includes(o.status));
        return new Response(JSON.stringify(ok ? { ok: true, uid: String(o.uid), qty: o.qty } : { ok: false }), { headers: { "content-type": "application/json" } });
      }
      if (p === "/botname") return new Response(JSON.stringify({ bot: await this.botName(), case: this.caseOn(), app: await this.mainApp() }), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
      if (p.startsWith("/api/") && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const u = await checkInitData(body.initData || "", this.env.BOT_TOKEN);
        if (!u || !u.id) return json({ ok: false, err: body.initData ? "Подпись Telegram не сошлась: BOT_TOKEN в Cloudflare от другого бота. Проверь токен и открой /setup" : "Открой магазин через бота" }, 401);
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
    const cs = m.text && m.text.match(/^\/start\s+case_(mono|ru|cp)_(\d{1,7})$/);
    if (cs && this.caseOn()) {
      const st = await this.settings(), q = Math.min(st.max, Math.max(st.min, +cs[2])), mn = { mono: "картой UA (Монобанк)", ru: "картой РФ", cp: "через CryptoBot" }[cs[1]];
      return this.tg("sendMessage", { chat_id: m.chat.id, parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: `💳 Оплатить ${q} ⭐`, web_app: { url: `${origin}/?dest=case&m=${cs[1]}&q=${q}` } }]] },
        text: `🎰 <b>Пополнение ${esc(CONFIG.CASE.name)}</b>\n\n${q} ⭐ ${mn}. После оплаты звёзды сами придут на твой баланс в ${esc(CONFIG.CASE.name)}.\n\nЖми кнопку 👇` });
    }
    if (m.text && m.text.startsWith("/start")) {
      return this.tg("sendMessage", { chat_id: m.chat.id, parse_mode: "HTML", reply_markup: kb,
        text: `⭐ <b>${NAME}</b>\n\nTelegram Stars на любой юзернейм — без KYC и автоматически.\n\nЖми кнопку ниже 👇` });
    }
    if (m.text && m.text.startsWith("/id")) {
      return this.tg("sendMessage", { chat_id: m.chat.id, parse_mode: "HTML",
        text: `Твой ID: <code>${m.from.id}</code>\nЮзернейм: ${m.from.username ? "@" + esc(m.from.username) : "нет"}\nАдмин: ${this.isOwner(m.from) ? "✅ да" : "❌ нет — впиши ID в config.js → OWNERS"}` });
    }
    if (m.text && !m.text.startsWith("/")) {
      const pend = await this.s.get("rvp:" + m.from.id);
      if (pend && Date.now() - pend.at < 24 * 3600e3) {
        await this.s.delete("rvp:" + m.from.id);
        const r = await this.review(m.from, pend.id, 0, m.text);
        if (r.ok) return this.tg("sendMessage", { chat_id: m.chat.id, text: "💜 Отзыв опубликован, спасибо!", reply_markup: kb });
      }
    }
    if (m.photo || m.document) {
      const ids = (await this.s.get("u:" + m.from.id)) || [];
      let o = null;
      for (const id of ids.slice().reverse()) { const x = await this.getO(id); if (x && x.method === "ru" && (x.status === "new" || x.status === "expired")) { o = x; break; } }
      if (!o) return this.tg("sendMessage", { chat_id: m.chat.id, text: "Нет заказа с оплатой картой РФ, который ждёт подтверждения. Создай заказ в магазине 👇", reply_markup: kb });
      const st = await this.settings();
      const chk = await this.idsOf(st.ru.checkers.length ? st.ru.checkers : CONFIG.OWNERS);
      const cap = `🧾 Заказ #${o.id} — карта РФ\n${what(o)} → ${dst(o)}\nСумма: ${o.price} ₽\nОт: ${o.uname || o.uid} (id ${o.uid})`;
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
  // ---------- отзывы (только настоящие: оставить может лишь покупатель выполненного заказа) ----------
  async review(u, orderId, stars, text) {
    const o = await this.getO(orderId);
    if (!o || o.uid !== u.id) return { ok: false, err: "Это не твой заказ" };
    if (o.status !== "done") return { ok: false, err: "Отзыв можно оставить после выдачи звёзд" };
    const k = "rv:" + o.id, old = await this.s.get(k);
    const rv = old || { id: o.id, uid: u.id, name: u.username || u.first_name || "", qty: o.qty, kind: o.kind || "", months: o.months || 0, dest: o.dest || "", stars: 5, text: "", at: Date.now() };
    if (stars) { if (!(stars >= 1 && stars <= 5)) return { ok: false, err: "Оценка 1–5" }; rv.stars = Math.round(stars); }
    else if (!old) return { ok: false, err: "Сначала поставь оценку" };
    if (typeof text === "string") rv.text = text.replace(/\s+/g, " ").trim().slice(0, 300);
    rv.at = rv.at || Date.now(); await this.s.put(k, rv);
    if (o.rv !== rv.stars) { o.rv = rv.stars; await this.putO(o); }
    const list = (await this.s.get("reviews")) || [];
    if (!list.includes(o.id)) { list.unshift(o.id); if (list.length > 500) list.length = 500; await this.s.put("reviews", list); }
    const agg = (await this.s.get("rvAgg")) || { n: 0, sum: 0, clients: 0 };
    if (!old) { agg.n++; agg.sum += rv.stars; if (!(await this.s.get("rvu:" + u.id))) { agg.clients++; await this.s.put("rvu:" + u.id, 1); } }
    else if (stars) agg.sum += rv.stars - old.stars;
    await this.s.put("rvAgg", agg);
    if (!old || text) await this.notifyOwners(`💬 Отзыв к заказу #${o.id}: ${"⭐".repeat(rv.stars)}${rv.text ? "\n" + esc(rv.text) : ""}\nот ${esc(o.uname || String(o.uid))}`);
    return { ok: true, review: rv };
  }
  async reviewsPublic(limit = 40) {
    const agg = (await this.s.get("rvAgg")) || { n: 0, sum: 0, clients: 0 }, ids = ((await this.s.get("reviews")) || []).slice(0, limit * 2);
    const m = ids.length ? await this.s.get(ids.map(i => "rv:" + i)) : new Map(), out = [];
    const mask = n => { n = String(n || ""); return n.length <= 3 ? n.slice(0, 1) + "***" : n.slice(0, 2) + "***" + n.slice(-2); };
    for (const i of ids) { const r = m.get("rv:" + i); if (r && !r.hidden) out.push({ id: r.id, stars: r.stars, text: r.text, qty: r.qty, kind: r.kind || "", months: r.months || 0, dest: r.dest, at: r.at, name: mask(r.name) }); if (out.length >= limit) break; }
    return { avg: agg.n ? Math.round(agg.sum / agg.n * 10) / 10 : 0, n: agg.n, clients: agg.clients, list: out };
  }
  async onCallback(q) {
    const [kind, act, id] = String(q.data || "").split(":");
    if (kind === "rv") {
      const r = await this.review(q.from, Number(id), Number(act));
      await this.tg("answerCallbackQuery", { callback_query_id: q.id, text: r.ok ? "Спасибо за оценку!" : r.err, show_alert: !r.ok });
      if (r.ok && q.message) {
        await this.tg("editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: "⭐".repeat(Number(act)) + " — спасибо!", callback_data: "noop" }]] } });
        await this.s.put("rvp:" + q.from.id, { id: Number(id), at: Date.now() });
        await this.tg("sendMessage", { chat_id: q.message.chat.id, text: "✍️ Напиши пару слов о покупке одним сообщением — добавим к отзыву. Или просто ничего не пиши 🙂" });
      }
      return;
    }
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
    await this.tg("sendMessage", { chat_id: o.uid, text: o.kind === "number" ? `💳 Оплата заказа #${o.id} получена. Подбираем номер…` : `💳 Оплата заказа #${o.id} получена. Отправляем ${what(o)} на ${dst(o)}…` });
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
      // счёт выбираем сами по номеру карты (если в настройках «основной», а карта — другая: белая/чёрная/ФОП)
      let acc = st.mono.account || "0";
      if (acc === "0" && st.mono.card) {
        let auto = await this.s.get("monoAccAuto");
        const card = String(st.mono.card).replace(/\D/g, "");
        if (!auto || auto.card !== card) {
          const ci = await this.mono("/personal/client-info");
          const a = (ci.accounts || []).find(a => (a.maskedPan || []).some(m => { const d = m.replace(/\D/g, ""); return d.length >= 10 && card.startsWith(d.slice(0, 6)) && card.endsWith(d.slice(-4)); }));
          auto = { card, id: a ? a.id : "0", title: a ? (a.maskedPan || [])[0] + " (" + a.type + ")" : "карта не найдена среди счетов — проверяется основной" };
          await this.s.put("monoAccAuto", auto);
          await this.s.put("monoLast", Date.now()); await this.wake(61000); return;   // у банка лимит: 1 запрос в минуту
        }
        acc = auto.id || "0";
      }
      let items;
      try { items = await this.mono(`/personal/statement/${encodeURIComponent(acc)}/${from}`); }
      catch (e) { await this.s.put("monoStat", { at: Date.now(), err: "Монобанк: " + e.message }); throw e; }
      let matched = 0, inc = 0;
      const list = Array.isArray(items) ? items : [];
      for (const it of list) { if (it.amount > 0) inc++; }
      await this.s.put("monoStat", { at: Date.now(), acc, n: list.length, inc, last: list.filter(i => i.amount > 0).slice(0, 3).map(i => (i.amount / 100).toFixed(2)) });
      for (const it of list) {
        if (!(it.amount > 0) || (it.currencyCode && it.currencyCode !== 980)) continue;
        const uk = "used:" + it.id; if (await this.s.get(uk)) continue;
        const o = orders.find(x => (x.status === "new" || x.status === "expired") && x.kop === it.amount && it.time * 1000 >= x.created - 120000);
        if (o) { await this.s.put(uk, o.id); o.monoId = it.id; await this.markPaid(o, "Монобанк"); matched++; continue; }
        await this.s.put(uk, "-");
        if (st.notifyUnmatched && it.time * 1000 > since)
          await this.notifyOwners(`💸 На моно пришло ${(it.amount / 100).toFixed(2)} ₴ без подходящего заказа${it.description ? "\n" + esc(it.description) : ""}${it.comment ? "\n💬 " + esc(it.comment) : ""}\nЕсли это оплата — подтверди заказ вручную в админке.`);
      }
    } catch (e) { console.log("mono", e.message); }
    finally { this.mbusy = false; }
  }

  // ---------- номера (LZT Market) ----------
  async lzt(path, opt = {}) {
    const token = (await this.sec()).lztToken; if (!token) throw new Error("не задан токен LZT Market");
    const r = await fetch("https://prod-api.lzt.market" + path, { method: opt.method || "GET", headers: { authorization: "Bearer " + token, accept: "application/json" } });
    const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch {}
    if (!r.ok) throw Object.assign(new Error("LZT: " + (j.errors ? [].concat(j.errors).join(", ") : r.status === 429 ? "слишком часто, подожди" : "HTTP " + r.status)), { status: r.status });
    return j;
  }
  // самые дешёвые номера страны на лолзе (цены — в валюте счёта на лолзе)
  // sp: "clean" — только без спамблока (spam=no), "spam" — только со спамблоком (spam=yes), иначе — любые
  async numList(cc, sp) {
    const q = sp === "clean" ? "&spam=no" : sp === "spam" ? "&spam=yes" : "";
    const j = await this.lzt(`/telegram?country%5B%5D=${encodeURIComponent(cc)}&order_by=price_to_up${q}`);
    const arr = Array.isArray(j.items) ? j.items : [];
    // спамблок: ищем в номере поле со словом spam (true/1/yes — есть, false/0/no — нет); если поля нет — null (неизвестно)
    const spam = i => { for (const k of Object.keys(i)) if (/spam/i.test(k)) { const v = i[k];
      if (v === true || v === 1 || v === "1" || /^(yes|true)$/i.test(String(v))) return true;
      if (v === false || v === 0 || v === "0" || /^(no|false)$/i.test(String(v))) return false; } return null; };
    const items = arr.filter(i => i && i.canBuyItem !== false).map(i => ({ id: i.item_id, price: Number(i.price), sp: sp === "clean" ? false : sp === "spam" ? true : spam(i) })).filter(i => i.id && i.price > 0);
    return { total: Number(j.totalItems) || items.length, items };
  }
  // обновляет наличие по несколько стран за раз (у лолза лимит запросов), самые старые — первыми
  async numRefresh(st, max = 3, force = false) {
    if (!st.num.on || this._nr || !(await this.sec()).lztToken) return;
    this._nr = true;
    try {
      const cat = (await this.s.get("numcat")) || {}; let n = 0;
      const age = cc => cat[cc] && cat[cc].nc != null ? cat[cc].at || 0 : 0;   // без nc — данные старого формата, обновить в первую очередь
      const order = st.num.countries.slice().sort((a, b) => age(a) - age(b));
      for (const cc of order) {
        if (n >= max) break;
        if (!force && cat[cc] && cat[cc].nc != null && Date.now() - cat[cc].at < 10 * 60e3) continue;
        n++;
        try {
          // два запроса к лолзу: без спамблока и со спамблоком — так фильтр работает всегда
          const cl = await this.numList(cc, "clean"), sb = await this.numList(cc, "spam");
          const all = cl.items.concat(sb.items).sort((a, b) => a.price - b.price);
          cat[cc] = { at: Date.now(), n: cl.total + sb.total, nc: cl.total, ns: sb.total, items: all.slice(0, 5), clean: cl.items.slice(0, 5), spam: sb.items.slice(0, 5), known: true };
        }
        catch (e) { cat[cc] = Object.assign(cat[cc] || { n: 0, items: [] }, { at: Date.now(), err: e.message }); if (e.status === 429) break; }
      }
      await this.s.put("numcat", cat);
    } finally { this._nr = false; }
  }
  // цена для покупателя в ₴ / $ / ₽: цена на лолзе по курсу + наценка
  numRetail(st, raw, f) {
    const cur = st.num.cur, k = cur === "usd" ? 1 : f && f.fiat && f.fiat[cur];
    if (!k || !f || !f.fiat) return null;
    const usd = raw / k * (1 + st.num.markup / 100);
    return { usd: Math.ceil(usd * 100) / 100, uah: Math.ceil(usd * f.fiat.uah), rub: Math.ceil(usd * f.fiat.rub) };
  }
  async numCatalog(st) {
    if (!st.num.on || !(await this.sec()).lztToken) return [];
    await this.numRefresh(st, 1);
    const cat = (await this.s.get("numcat")) || {}, f = await this.fx(), out = [];
    for (const cc of st.num.countries) {
      const c = cat[cc], meta = COUNTRIES[cc]; if (!c || !meta) continue;
      const top = c.items[0], price = top ? this.numRetail(st, top.price, f) : null;
      const pc = c.clean && c.clean[0] ? this.numRetail(st, c.clean[0].price, f) : null, ps = c.spam && c.spam[0] ? this.numRetail(st, c.spam[0].price, f) : null;
      out.push({ cc, name: meta[0], dial: meta[1], n: top ? c.n : 0, nc: c.nc, ns: c.ns, price, pc, ps, known: !!c.known });
    }
    return out;
  }
  async numQuote(st, cc, kind = "any") {
    if (!st.num.on || !(await this.sec()).lztToken) return { ok: false, err: "Номера сейчас недоступны" };
    if (!COUNTRIES[cc] || !st.num.countries.includes(cc)) return { ok: false, err: "Эта страна недоступна" };
    const c = ((await this.s.get("numcat")) || {})[cc];
    if (!c || !c.items.length || Date.now() - c.at > 30 * 60e3) return { ok: false, err: "Сейчас нет в наличии — загляни позже" };
    const pool = kind === "clean" ? c.clean || [] : kind === "spam" ? c.spam || [] : c.items;
    if (!pool.length) return { ok: false, err: kind === "clean" ? "Номеров без спамблока сейчас нет" : "Номеров со спамблоком сейчас нет" };
    const price = this.numRetail(st, pool[0].price, await this.fx());
    if (!price) return { ok: false, err: "Курс валют ещё загружается — попробуй через минуту" };
    const raw = pool[0].price;
    return { ok: true, cc, kind, raw, maxRaw: raw * (1 + Math.min(st.num.markup, 15) / 100), price };   // дороже этого лимита бот номер не купит
  }
  // покупка номера на лолзе после оплаты. Перед покупкой ставим «отправляется»: даже при сбое номер не купится дважды
  async deliverNum(o) {
    o.status = "sending"; o.err = ""; o.sendAt = Date.now(); await this.putO(o);
    const stop = async (msg, hold) => {
      o.status = "check"; o.err = msg; await this.putO(o); await this.closeO(o);
      await this.notifyOwners(`⚠️ Заказ #${o.id} (${what(o)}): ${esc(msg)}${hold ? "" : "\nНажми «Повторить» в админке, когда исправишь."}`);
      await this.tg("sendMessage", { chat_id: o.uid, text: `⏳ Заказ #${o.id}: номер подбирается дольше обычного. Мы уже занимаемся этим — если что, напиши ${CONFIG.SUPPORT}` });
    };
    const retry = async msg => {   // ничего не куплено — можно безопасно повторить
      o.tries = (o.tries || 0) + 1; o.err = msg;
      if (o.tries >= 5) return stop(msg);
      o.status = "paid"; await this.putO(o); await this.wake(30000);
    };
    let list;
    try { list = await this.numList(o.cc, o.sp); } catch (e) { return retry(e.message); }
    const cand = list.items.filter(i => i.price <= o.maxRaw + 1e-9 && (o.sp === "clean" ? i.sp === false : o.sp === "spam" ? i.sp === true : true)).slice(0, 3);
    if (!cand.length) return retry(`нет номеров ${o.cc} по цене до ${o.maxRaw.toFixed(2)} — дорогие или закончились`);
    let last = "";
    for (const it of cand) {
      let r;
      try { r = await this.lzt(`/${it.id}/fast-buy?price=${encodeURIComponent(it.price)}`, { method: "POST" }); }
      catch (e) {
        if (e.status >= 400 && e.status < 500) { last = e.message; continue; }   // лолз точно отказал — пробуем следующий
        return stop(`неизвестно, купился ли номер (item ${it.id}): ${e.message}. Проверь «Мои покупки» на lzt.market, чтобы не купить дважды`, true);
      }
      let phone = pickPhone(r);
      if (!phone) { try { phone = pickPhone(await this.lzt(`/${it.id}`)); } catch {} }
      o.num = { item: it.id, phone, raw: it.price };
      if (!phone) return stop(`номер куплен (item ${it.id}), но телефон не прочитался — открой его на lzt.market и выдай вручную`, true);
      return this.finishNum(o);
    }
    return retry(last || "не удалось купить");
  }
  async finishNum(o) {
    o.status = "done"; o.doneAt = Date.now(); o.err = ""; await this.putO(o); await this.closeO(o);
    const k = { mono: "uah", cp: "usd", ru: "rub" }[o.method], st = await this.settings();
    const s = (await this.s.get("stats")) || { orders: 0, stars: 0, uah: 0, usd: 0, rub: 0, ton: 0 };
    s.orders++; s.nums = (s.nums || 0) + 1; s[k] += Number(o.price); s.numRaw = (s.numRaw || 0) + o.num.raw; s.numCur = st.num.cur;
    await this.s.put("stats", s);
    const us = (await this.s.get("us:" + o.uid)) || { orders: 0, stars: 0, uah: 0, usd: 0, rub: 0, gifts: 0, first: Date.now() };
    us.orders++; us[k] += Number(o.price); us.last = Date.now(); await this.s.put("us:" + o.uid, us);
    if (o.method === "ru") { const d = (await this.s.get("ruDebt")) || { orders: 0, stars: 0, rub: 0, ton: 0, since: Date.now() }; d.orders++; d.rub += Number(o.price); await this.s.put("ruDebt", d); }
    const origin = await this.s.get("origin");
    await this.tg("sendMessage", { chat_id: o.uid, parse_mode: "HTML",
      text: `✅ Номер готов!\n\n📱 <code>${esc(o.num.phone)}</code>\n\nОткрой Telegram → «Войти» → введи этот номер. Когда Telegram отправит код, нажми кнопку ниже — код придёт в магазин.`,
      reply_markup: { inline_keyboard: [[{ text: "🔑 Получить код", web_app: { url: `${origin}/?order=${o.id}` } }]] } });
  }
  async numCode(u, b) {
    const o = await this.getO(Number(b.id));
    if (!o || o.uid !== u.id || o.kind !== "number" || o.status !== "done" || !o.num) return { ok: false, err: "Заказ не найден" };
    if (Date.now() - o.doneAt > 72 * 3600e3) return { ok: false, err: "Срок получения кода вышел — напиши в поддержку " + CONFIG.SUPPORT };
    if ((o.codeTries || 0) >= 60) return { ok: false, err: "Слишком много попыток — напиши в поддержку " + CONFIG.SUPPORT };
    if (Date.now() - (o.codeAt || 0) < 4000) return { ok: true, code: "", wait: true };
    o.codeAt = Date.now(); o.codeTries = (o.codeTries || 0) + 1; await this.putO(o);
    let code = "";
    try { code = pickCode(await this.lzt(`/${o.num.item}/telegram-login-code`)); }
    catch (e) { return { ok: false, err: e.message }; }
    if (code && !o.rvAsked) {   // код пришёл — покупка состоялась, просим оценку (один раз)
      o.rvAsked = true; await this.putO(o);
      await this.tg("sendMessage", { chat_id: o.uid, text: `✅ Рады, что всё получилось! Оцени, пожалуйста, покупку в ${NAME} — отзыв увидят другие покупатели:`,
        reply_markup: { inline_keyboard: [[1, 2, 3, 4, 5].map(n => ({ text: n + "⭐", callback_data: `rv:${n}:${o.id}` }))] } });
    }
    return { ok: true, code };
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
    let want;
    try { want = (await this.tc.getNum(T.rawAddr(T.parseAddr(addrS)), "get_public_key")).toString(16).padStart(64, "0"); }
    catch { throw new Error("кошелёк не активирован — закинь на него немного TON и отправь с него любую транзакцию (например, 0.01 TON самому себе)"); }
    for (const c of await T.keyCandidates(this.env.WALLET_MNEMONIC)) if (T.hex(c.key.publicKey) === want) return (this._key = c.key);
    throw new Error("сид-фраза не от этого кошелька (проверь WALLET_ADDRESS)");
  }
  async walletCheck() {
    const w = { ok: false, at: Date.now() };
    try {
      const addrS = CONFIG.WALLET_ADDRESS || this.env.WALLET_ADDRESS;
      if (!addrS) throw new Error("впиши WALLET_ADDRESS в config.js");
      const a = T.parseAddr(addrS); w.raw = T.rawAddr(a); w.address = T.friendly(a, false);
      const info = await this.tc.info(w.raw);
      w.balance = String(info.balance || 0);
      if (info.state !== "active") throw new Error(`кошелёк не активирован (баланс ${(Number(w.balance) / 1e9).toFixed(2)} TON) — закинь на него TON и отправь с него любую транзакцию, например 0.01 TON самому себе`);
      const key = await this.key(); w.pub = T.hex(key.publicKey);
      const code = T.parseBoc(info.code), data = T.parseBoc(info.data);
      w.version = T.CODE_HASH[T.hex(await code.hash())];
      if (!w.version) throw new Error("неизвестный тип кошелька (нужен v4r2 или W5)");
      const pub = await this.tc.getNum(w.raw, "get_public_key");
      if (pub.toString(16).padStart(64, "0") !== w.pub) throw new Error("сид-фраза не от этого кошелька");
      try { w.walletId = Number(await this.tc.getNum(w.raw, "get_subwallet_id")); }
      catch { w.walletId = w.version === "v5r1" ? 2147483409 : 698983191; }
      // stateInit для TON Connect — исходный (seqno = 0), из него получается адрес; текущие data после переводов уже другие
      let si = T.stateInitCell(code, T.initialData(w.version, w.walletId, key.publicKey));
      if (T.hex(await si.hash()) !== T.hex(a.hash)) { si = T.stateInitCell(code, data); if (T.hex(await si.hash()) !== T.hex(a.hash)) throw new Error("адрес не совпадает с кодом кошелька"); }
      w.stateInit = T.b64e(T.serializeBoc(si));
      w.ok = true;
    } catch (e) { w.err = e.message; }
    await this.s.put("wallet", w); return w;
  }
  async fragSave(jar) {
    const sec = await this.sec(); sec.cookies = F.loginCookies(jar); await this.s.put("sec", sec);
    return { ok: true, done: true, msg: "Вошёл в Fragment ✅ Куки сохранены" };
  }
  async wallet() { const w = await this.s.get("wallet"); return w && w.ok && Date.now() - w.at < 6 * 3600e3 ? w : this.walletCheck(); }

  async deliver() {
    if (this.busy) return; this.busy = true;
    try {
      // заказы «на баланс казино»: без Fragment и TON — просто зачисляем
      for (const o of (await this.openOrders()).filter(o => o.status === "paid" && o.dest === "case")) {
        try { await this.caseCredit(o); await this.finish(o, { amount: 0 }); }
        catch (e) { o.tries = (o.tries || 0) + 1; o.err = "казино: " + e.message;
          if (o.tries >= 5) { o.status = "check"; await this.closeO(o); await this.notifyOwners(`⚠️ Заказ #${o.id} (${what(o)} → ${dst(o)}) не зачислился: ${esc(e.message)}`); }
          await this.putO(o); await this.wake(30000); }
      }
      for (const o of (await this.openOrders()).filter(o => o.kind === "number")) {
        if (o.status === "paid") await this.deliverNum(o);
        else if (o.status === "sending" && Date.now() - (o.sendAt || 0) > 3 * 60e3) {   // завис посреди покупки — не повторяем, чтобы не купить дважды
          o.status = "check"; o.err = "покупка номера зависла — проверь «Мои покупки» на lzt.market"; await this.putO(o); await this.closeO(o);
          await this.notifyOwners(`⚠️ Заказ #${o.id} (${what(o)}): ${o.err}`);
        }
      }
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
          if (o.status === "check") { await this.closeO(o); await this.notifyOwners(`⚠️ Заказ #${o.id} (${what(o)} → ${dst(o)}) не удалось отправить 3 раза. Проверь кошелёк и нажми «Повторить» в админке.`); }
        } else { await this.wake(10000); return; }
      }
      const paid = (await this.openOrders()).filter(o => o.status === "paid" && o.dest !== "case" && o.kind !== "number").sort((a, b) => a.paidAt - b.paidAt);
      const o = paid[0]; if (!o) return;
      const sec = await this.sec(), st = await this.settings();
      const stop = async msg => {
        if (o.err !== msg) { o.err = msg; await this.putO(o); await this.notifyOwners(`⛔ Выдача остановлена: ${esc(msg)}\nВ очереди заказов: ${paid.length}`); }
        await this.wake(60000);
      };
      const w = await this.wallet();
      if (!w.ok) return stop("кошелёк: " + w.err);
      if (!sec.cookies) return stop("не вставлены куки Fragment");
      let q; const frag = new Fragment(sec.cookies);
      try { q = o.kind === "premium" ? await frag.buy(o.to, o.months, w, "premium") : await frag.buy(o.to, o.qty, w); }
      catch (e) {
        if (frag.changed) { sec.cookies = frag.cookies; await this.s.put("sec", sec); }
        if (/access denied|unauthorized|session|not logged/i.test(e.message)) return stop(e.message + " — вход в Fragment слетел или не завершён: Админ → 💎 Кошелёк → «Войти в Fragment через Telegram»");
        if (/куки|не открылся|KYC|verify|login|auth/i.test(e.message)) return stop(e.message);
        o.tries = (o.tries || 0) + 1; o.err = e.message;
        if (o.tries >= 3 || /нет такого пользователя/.test(e.message)) { o.status = "check"; await this.closeO(o); await this.notifyOwners(`⚠️ Заказ #${o.id} (${what(o)} → @${esc(o.to)}): ${esc(e.message)}`); }
        await this.putO(o); await this.wake(20000); return;
      }
      if (o.kind === "premium" ? await (async () => { const f = await this.fx(); return f && f.tonUsd && Number(q.amount) / 1e9 * f.tonUsd > st.premium.usd[o.months] * 1.6; })() : Number(q.amount) / 1e9 / o.qty > st.maxTonPerStar) {
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
      try { await frag.confirm(q.confirm, tr.boc); } catch (e) { console.log("fragment confirm", e.message); }
      if (frag.changed) { sec.cookies = frag.cookies; await this.s.put("sec", sec); }
      await this.wake(12000);
    } catch (e) { console.log("deliver", e.stack || e); await this.wake(30000); }
    finally { this.busy = false; }
  }
  async finish(o, inf) {
    o.status = "done"; o.doneAt = Date.now(); o.ton = inf.amount; o.err = ""; await this.putO(o); await this.closeO(o);
    const s = (await this.s.get("stats")) || { orders: 0, stars: 0, uah: 0, usd: 0, rub: 0, ton: 0 };
    s.orders++; s.stars += o.qty; s.ton += Number(inf.amount) / 1e9;
    if (o.kind === "premium") try { const f = await this.fx(); if (f && f.tonUsd && inf.amount) { const v = Number(inf.amount) / 1e9 * f.tonUsd, pu = (await this.s.get("premUsd")) || {}; if (v > 3 && v < 80) { pu[o.months] = Math.round(v * 100) / 100; await this.s.put("premUsd", pu); } } } catch {}
    try { const f = await this.fx(); if (f && f.tonUsd && o.qty) { const v = Number(inf.amount) / 1e9 * f.tonUsd / o.qty; if (v > 0.005 && v < 0.05) await this.s.put("starUsd", v); } } catch {}   // реальная цена звезды на Fragment
    s[{ mono: "uah", cp: "usd", ru: "rub" }[o.method]] += Number(o.price);
    await this.s.put("stats", s);
    const us = (await this.s.get("us:" + o.uid)) || { orders: 0, stars: 0, uah: 0, usd: 0, rub: 0, gifts: 0, first: Date.now() };
    us.orders++; us.stars += o.qty; us[{ mono: "uah", cp: "usd", ru: "rub" }[o.method]] += Number(o.price); us.last = Date.now();
    if (o.dest !== "case" && o.uname && low(o.to) !== low(o.uname)) us.gifts++;   // звёзды кому-то другому — подарок
    us.max = Math.max(us.max || 0, o.qty);
    await this.s.put("us:" + o.uid, us);
    if (o.method === "ru") {
      const d = (await this.s.get("ruDebt")) || { orders: 0, stars: 0, rub: 0, ton: 0, since: Date.now() };
      d.orders++; d.stars += o.qty; d.rub += Number(o.price); d.ton += Number(inf.amount) / 1e9; await this.s.put("ruDebt", d);
    }
    await this.tg("sendMessage", { chat_id: o.uid, text: `✅ Готово! ${what(o)} отправлены на ${dst(o)}.\nСпасибо за покупку в ${NAME}!\n\nОцени, пожалуйста, покупку — отзыв увидят другие покупатели:`,
      reply_markup: { inline_keyboard: [[1, 2, 3, 4, 5].map(n => ({ text: n + "⭐", callback_data: `rv:${n}:${o.id}` }))] } });
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
    else if (monoW.length) await this.s.put("monoStat", { at: Date.now(), err: "Не задан токен Монобанка — оплаты не проверяются" });
    const cpW = orders.filter(o => o.method === "cp" && o.status === "new" && o.inv);
    if (cpW.length && sec.cpToken) {
      try { const r = await this.cp("getInvoices", { invoice_ids: cpW.map(o => o.inv).join(",") });
        for (const inv of r.items || []) await this.cpPaid(inv); } catch (e) { console.log("cp", e.message); }
    }
    try { await this.numRefresh(st, 3); } catch (e) { console.log("num", e.message); }
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
        shop: await (async () => { const R = await this.curRates(st); return { rates: R, auto: st.auto.on, case: this.caseOn() ? CONFIG.CASE.name : "", premium: st.premium.on ? await this.premRates(st) : null, min: st.min, max: st.max, on: { mono: st.on.mono && R.uah > 0, cp: st.on.cp && R.usd > 0, ru: st.on.ru && R.rub > 0 }, ttl: st.ttl, num: st.num.on && !!(await this.sec()).lztToken }; })(),
        orders: ids.map(i => m.get("o:" + i)).filter(Boolean).map(o => this.view(o)) };
    }
    if (act === "reviews") return { ok: true, ...(await this.reviewsPublic()) };
    if (act === "review") { const r = await this.review(u, Number(b.id), Number(b.stars) || 0, typeof b.text === "string" ? b.text : undefined); return r.ok ? { ok: true } : r; }
    if (act === "profile") {
      const us = (await this.s.get("us:" + u.id)) || { orders: 0, stars: 0, uah: 0, usd: 0, rub: 0, gifts: 0 };
      const ids = (await this.s.get("u:" + u.id)) || [], m = ids.length ? await this.s.get(ids.map(i => "o:" + i)) : new Map();
      const open = [...m.values()].filter(o => o && ["new", "paid", "sending", "check"].includes(o.status)).length;
      return { ok: true, stats: us, open, since: (await this.s.get("since:" + u.id)) || us.first || Date.now() };
    }
    if (act === "rates") {   // мини-апп обновляет цену каждые 15 секунд
      const R = await this.curRates(st);
      return { ok: true, rates: R, premium: st.premium.on ? await this.premRates(st) : null, on: { mono: st.on.mono && R.uah > 0, cp: st.on.cp && R.usd > 0, ru: st.on.ru && R.rub > 0 } };
    }
    if (act === "recipient") {
      const to = low(b.to); if (!/^[a-z0-9_]{4,32}$/.test(to)) return { ok: false, err: "Неверный юзернейм" };
      const sec = await this.sec(); if (!sec.cookies) return { ok: true, name: "" };
      try { const r = await new Fragment(sec.cookies).recipient(to); return { ok: true, name: r.name }; }
      catch (e) { return /нет такого/.test(e.message) ? { ok: false, err: "Пользователь @" + to + " не найден" } : { ok: true, name: "" }; }
    }
    if (act === "numbers") return { ok: true, list: await this.numCatalog(st) };
    if (act === "numcode") return this.numCode(u, b);
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
    const prem = b.kind === "premium", num = b.kind === "number", months = Math.floor(Number(b.months));
    if (prem && !(st.premium.on && [3, 6, 12].includes(months))) return { ok: false, err: "Premium: выбери 3, 6 или 12 месяцев" };
    const toCase = !prem && !num && b.dest === "case", qty = prem ? 0 : num ? 1 : Math.floor(Number(b.qty)), method = String(b.method || "");
    if (toCase && !this.caseOn()) return { ok: false, err: "Пополнение казино сейчас выключено" };
    const to = num ? "" : toCase ? low(CONFIG.CASE.name).replace(/[^a-z0-9_]/g, "_") : low(b.to);
    if (!toCase && !num && !/^[a-z0-9_]{4,32}$/.test(to)) return { ok: false, err: "Укажи юзернейм получателя" };
    if (!prem && !num && !(qty >= st.min && qty <= st.max)) return { ok: false, err: `Количество: от ${st.min} до ${st.max} ⭐` };
    const cur = { mono: "uah", cp: "usd", ru: "rub" }[method];
    let quote = null;
    if (num) { quote = await this.numQuote(st, String(b.cc || "").toUpperCase(), ["clean", "spam"].includes(b.spam) ? b.spam : "any"); if (!quote.ok) return quote; }
    const R = await this.curRates(st), rate = num ? 1 : R[cur];
    const total = num ? quote.price[cur] : prem ? (await this.premRates(st))[months][cur] : qty * rate;   // итоговая сумма заказа
    if (!st.on[method] || !(rate > 0) || !(total > 0)) return { ok: false, err: "Этот способ оплаты сейчас выключен" };
    const recent = ((await this.s.get("u:" + u.id)) || []).slice(-5), rm = recent.length ? await this.s.get(recent.map(i => "o:" + i)) : new Map();
    if ([...rm.values()].filter(o => o && o.status === "new").length >= 3) return { ok: false, err: "У тебя уже 3 неоплаченных заказа — оплати или отмени их" };
    const id = ((await this.s.get("seq")) || 1000) + 1; await this.s.put("seq", id);
    const now = Date.now();
    const o = { id, uid: u.id, uname: u.username ? "@" + u.username : (u.first_name || ""), to, ...(toCase ? { dest: "case" } : {}), ...(prem ? { kind: "premium", months } : {}), ...(num ? { kind: "number", cc: quote.cc, sp: quote.kind === "any" ? "" : quote.kind, raw: quote.raw, maxRaw: quote.maxRaw } : {}), qty, method, status: "new", created: now, expires: now + st.ttl * 60000 * (method === "ru" ? 4 : 1) };
    if (method === "mono") {
      if (!st.mono.card) return { ok: false, err: "Оплата Монобанком ещё не настроена" };
      const base = Math.ceil(total) * 100;
      const taken = new Set((await this.openOrders()).filter(x => x.method === "mono" && (x.status === "new" || x.status === "expired")).map(x => x.kop));
      let kop = 0; const start = 1 + Math.floor(Math.random() * 98);
      for (let i = 0; i < 99 && !kop; i++) { const k = base + 1 + ((start + i) % 99); if (!taken.has(k)) kop = k; }
      if (!kop) return { ok: false, err: "Слишком много заказов на эту сумму, попробуй другое количество" };
      o.kop = kop; o.price = (kop / 100).toFixed(2); o.pay = { card: st.mono.card, holder: st.mono.holder };
    } else if (method === "cp") {
      o.price = (Math.ceil(total * 100) / 100).toFixed(2);
      const bot = await this.botName();
      const inv = await this.cp("createInvoice", { currency_type: "fiat", fiat: "USD", amount: o.price, accepted_assets: "USDT,TON",
        description: num ? `Номер Telegram (${(COUNTRIES[quote.cc] || [quote.cc])[0]}) — ${NAME}` : `${prem ? "Telegram Premium на " + months + " мес." : qty + " ⭐"} для @${to} — ${NAME}`, payload: String(id), expires_in: st.ttl * 60, allow_comments: false,
        ...(bot ? { paid_btn_name: "openBot", paid_btn_url: "https://t.me/" + bot } : {}) });
      o.inv = inv.invoice_id; o.pay = { url: inv.mini_app_invoice_url || inv.bot_invoice_url };
    } else if (method === "ru") {
      if (!st.ru.details) return { ok: false, err: "Реквизиты карты РФ ещё не заданы" };
      o.price = String(Math.ceil(total)); o.pay = { details: st.ru.details };
    }
    await this.putO(o);
    const ids = await this.open(); ids.push(id); await this.setOpen(ids);
    const mine = (await this.s.get("u:" + u.id)) || []; mine.push(id); await this.s.put("u:" + u.id, mine.slice(-30));
    const rec = (await this.s.get("recent")) || []; rec.push(id); await this.s.put("recent", rec.slice(-300));
    if (method === "mono") await this.wake(62000);
    if (method === "ru") {
      const chk = await this.idsOf(st.ru.checkers.length ? st.ru.checkers : CONFIG.OWNERS);
      for (const c of chk) await this.tg("sendMessage", { chat_id: c, text: `🆕 Заказ #${id} — карта РФ: ${what(o)}${num ? "" : " → @" + to}, ${o.price} ₽. Жду скрин от покупателя.` });
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
        flags: { lztToken: !!sec.lztToken, monoToken: !!sec.monoToken, cpToken: !!sec.cpToken, cookies: !!sec.cookies, mnemonic: !!this.env.WALLET_MNEMONIC, walletAddr: CONFIG.WALLET_ADDRESS || this.env.WALLET_ADDRESS || "", monoHook: !!(await this.s.get("monoHook")) },
        monoStat: await this.s.get("monoStat"), monoAcc: await this.s.get("monoAccAuto"),
        fragLink: await (async () => { const f = await this.s.get("fraglogin"); return f && f.qtoken && Date.now() - f.at < 5 * 60e3 ? "https://t.me/oauth?startapp=" + f.qtoken : ""; })(),
        prem: await this.premRates(st), premUsd: await this.s.get("premUsd"),
        fx: await this.fx(), fxErr: this._fxErr || "", live: await this.curRates(st), starUsd: await this.s.get("starUsd"),
        wallet: await this.s.get("wallet"), stats: await this.s.get("stats"), debt: await this.s.get("ruDebt"),
        queue: (await this.openOrders()).filter(o => o.status === "paid" || o.status === "sending").length,
        numRows: await (async () => { const cat = (await this.s.get("numcat")) || {}; return st.num.countries.filter(cc => COUNTRIES[cc]).map(cc => ({ cc, name: COUNTRIES[cc][0], n: cat[cc] ? cat[cc].n : null, raw: cat[cc] && cat[cc].items[0] ? cat[cc].items[0].price : null, at: cat[cc] ? cat[cc].at : 0, err: cat[cc] ? cat[cc].err || "" : "" })); })(),
        orders: await listOrders(() => true) };
    }
    if (act === "set") {
      const p = b.patch || {};
      if (p.rates) for (const k of ["uah", "rub", "usd"]) if (p.rates[k] !== undefined) st.rates[k] = Math.max(0, Number(p.rates[k]) || 0);
      if (p.premium) { if (p.premium.on !== undefined) st.premium.on = !!p.premium.on;
        for (const m of [3, 6, 12]) if (p.premium.usd && +p.premium.usd[m] > 0) st.premium.usd[m] = Math.min(100, +p.premium.usd[m]); }
      if (p.auto) { if (p.auto.on !== undefined) st.auto.on = !!p.auto.on;
        if (p.auto.markup !== undefined) st.auto.markup = Math.min(500, Math.max(0, Number(p.auto.markup) || 0));
        if (p.auto.usdPerStar !== undefined) st.auto.usdPerStar = Math.min(0.05, Math.max(0.005, Number(p.auto.usdPerStar) || DEF.auto.usdPerStar)); }
      if (p.min !== undefined) st.min = Math.max(50, Math.floor(Number(p.min)) || 50);
      if (p.max !== undefined) st.max = Math.min(1000000, Math.max(st.min, Math.floor(Number(p.max)) || st.min));
      if (p.on) for (const k of ["mono", "cp", "ru"]) if (p.on[k] !== undefined) st.on[k] = !!p.on[k];
      if (p.mono) for (const k of ["card", "holder", "account"]) if (typeof p.mono[k] === "string") st.mono[k] = p.mono[k].trim().slice(0, 100);
      if (p.ru) { if (typeof p.ru.details === "string") st.ru.details = p.ru.details.slice(0, 500);
        if (Array.isArray(p.ru.checkers)) st.ru.checkers = p.ru.checkers.map(x => String(x).replace(/^@/, "").trim()).filter(Boolean).slice(0, 10); }
      if (p.maxTonPerStar !== undefined) st.maxTonPerStar = Math.max(0.001, Number(p.maxTonPerStar) || DEF.maxTonPerStar);
      if (p.ttl !== undefined) st.ttl = Math.min(180, Math.max(10, Math.floor(Number(p.ttl)) || 30));
      if (p.notifyUnmatched !== undefined) st.notifyUnmatched = !!p.notifyUnmatched;
      if (p.num) {
        if (p.num.on !== undefined) st.num.on = !!p.num.on;
        if (p.num.markup !== undefined) st.num.markup = Math.min(500, Math.max(0, Number(p.num.markup) || 0));
        if (["rub", "uah", "usd"].includes(p.num.cur)) st.num.cur = p.num.cur;
        if (typeof p.num.countries === "string") st.num.countries = [...new Set(p.num.countries.toUpperCase().split(/[^A-Z]+/).filter(c => COUNTRIES[c]))].slice(0, 60);
      }
      await this.s.put("settings", st);
      const s = b.secrets || {}, sec = await this.sec();
      if (typeof s.cpToken === "string" && s.cpToken.trim()) {
        sec.cpToken = s.cpToken.trim();
        try { await this.s.put("sec", sec); await this.cp("getMe"); } catch (e) { delete sec.cpToken; await this.s.put("sec", sec); return { ok: false, err: e.message }; }
      }
      if (typeof s.lztToken === "string" && s.lztToken.trim()) {
        sec.lztToken = s.lztToken.trim();
        try { await this.s.put("sec", sec); await this.lzt("/me"); } catch (e) { delete sec.lztToken; await this.s.put("sec", sec); return { ok: false, err: e.message }; }
      }
      if (typeof s.monoToken === "string" && s.monoToken.trim()) { sec.monoToken = s.monoToken.trim(); await this.s.put("monoSince", Date.now()); await this.s.delete("monoHook"); }
      if (typeof s.cookies === "string" && s.cookies.trim()) sec.cookies = s.cookies.trim().replace(/^cookie:\s*/i, "");
      for (const k of ["cpToken", "monoToken", "cookies", "lztToken"]) if (s[k] === "-") delete sec[k];
      await this.s.put("sec", sec);
      return { ok: true };
    }
    if (act === "num_probe") {   // диагностика: какие поля реально отдаёт лолз (чтобы проверить фильтр страны и спамблок)
      try {
        const cc = String(b.cc || "UA").toUpperCase().slice(0, 2), j = await this.lzt(`/telegram?country%5B%5D=${encodeURIComponent(cc)}&order_by=price_to_up`);
        const items = Array.isArray(j.items) ? j.items : [], first = items[0] || {}, pick = {};
        for (const k of Object.keys(first)) if (/spam|country|phone|premium|price|origin|title|item_id|state/i.test(k)) pick[k] = typeof first[k] === "object" ? JSON.stringify(first[k]).slice(0, 80) : String(first[k]).slice(0, 80);
        const seen = {}; for (const i of items) for (const k of Object.keys(i)) if (/country|spam/i.test(k)) { const key = k + "=" + String(i[k]).slice(0, 30); seen[key] = (seen[key] || 0) + 1; }
        let nc = "?", ns = "?";
        try { nc = (await this.numList(cc, "clean")).total; ns = (await this.numList(cc, "spam")).total; } catch (e) { nc = ns = e.message; }
        return { ok: true, cc, total: j.totalItems, count: items.length, nc, ns, keys: Object.keys(first).join(", "), sample: pick, seen };
      } catch (e) { return { ok: false, err: e.message }; }
    }
    if (act === "num_check") {
      try {
        const me = await this.lzt("/me"), u = me.user || me;
        await this.numRefresh(st, 4, true);
        return { ok: true, name: u.username || u.user_id || "", balance: u.balance, hold: u.hold };
      } catch (e) { return { ok: false, err: e.message }; }
    }
    if (act === "wallet_check") return { ok: true, wallet: await this.walletCheck() };
    if (act === "frag_login") {   // вход в Fragment без копирования кук
      const w = await this.wallet(); if (!w.ok) return { ok: false, err: "Сначала кошелёк: " + w.err };
      try {
        const r = await F.loginStart({ raw: w.raw, pub: w.pub, stateInit: w.stateInit, key: await this.key() });
        if (r.done) return this.fragSave(r.state.jar);
        await this.s.put("fraglogin", r.state);
        return { ok: true, link: r.link };
      } catch (e) { return { ok: false, err: e.message }; }
    }
    if (act === "frag_poll") {
      const state = await this.s.get("fraglogin"); if (!state || Date.now() - state.at > 5 * 60e3) return { ok: false, err: "Время входа вышло — нажми «Войти» ещё раз" };
      try {
        const r = await F.loginPoll(state);
        if (r.status === "done") { await this.s.delete("fraglogin"); return this.fragSave(state.jar); }
        await this.s.put("fraglogin", state);
        if (r.status !== "wait") { await this.s.delete("fraglogin"); return { ok: false, err: r.status === "declined" ? "Вход отклонён в Telegram" : "Время входа вышло — нажми «Войти» ещё раз" }; }
        return { ok: true, wait: true, link: r.link };
      } catch (e) { await this.s.delete("fraglogin"); return { ok: false, err: e.message }; }
    }
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
    if (act === "review_hide") {
      const r = await this.s.get("rv:" + Number(b.id)); if (!r) return { ok: false, err: "Нет отзыва" };
      r.hidden = !!b.hide; await this.s.put("rv:" + r.id, r);
      const agg = (await this.s.get("rvAgg")) || { n: 0, sum: 0, clients: 0 };
      agg.n += b.hide ? -1 : 1; agg.sum += (b.hide ? -1 : 1) * r.stars; await this.s.put("rvAgg", agg);
      return { ok: true };
    }
    if (act === "reviews_admin") {
      const ids = ((await this.s.get("reviews")) || []).slice(0, 100), m = ids.length ? await this.s.get(ids.map(i => "rv:" + i)) : new Map();
      return { ok: true, list: ids.map(i => m.get("rv:" + i)).filter(Boolean) };
    }
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
        await this.tg("sendMessage", { chat_id: o.uid, text: `✅ Заказ #${o.id} выполнен: ${what(o)} на ${dst(o)}.` });
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
