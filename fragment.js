// Покупка звёзд на fragment.com от имени твоего аккаунта (KYC пройден, TON-кошелёк привязан).
// Нужны куки fragment.com (stel_ssid, stel_dt, stel_token, stel_ton_token) — вставляются в админке.
import { parseBoc, commentCell } from "./ton.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export class Fragment {
  constructor(cookies) { this.cookies = String(cookies || "").trim(); this.hash = ""; }
  async init() {
    if (!this.cookies) throw new Error("не вставлены куки Fragment");
    const r = await fetch("https://fragment.com/stars/buy", { headers: { cookie: this.cookies, "user-agent": UA, accept: "text/html" } });
    const html = await r.text();
    const m = html.match(/api\?hash=([0-9a-f]+)/);
    if (!m) throw new Error("Fragment не открылся (HTTP " + r.status + ") — обнови куки");
    this.hash = m[1];
    this.logged = /stel_ton_token|tm-header-ton|Disconnect|logout/i.test(html) || html.includes('"ton_account"');
  }
  async api(params) {
    if (!this.hash) await this.init();
    const r = await fetch("https://fragment.com/api?hash=" + this.hash, {
      method: "POST",
      headers: { cookie: this.cookies, "user-agent": UA, "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest", origin: "https://fragment.com", referer: "https://fragment.com/stars/buy", accept: "application/json, text/javascript, */*; q=0.01" },
      body: new URLSearchParams(params).toString() });
    const t = await r.text(); let j;
    try { j = JSON.parse(t); } catch { throw new Error("Fragment ответил не JSON (HTTP " + r.status + ")"); }
    if (j.error) throw new Error("Fragment: " + j.error);
    return j;
  }
  async recipient(username, qty) {
    const j = await this.api({ query: String(username).replace(/^@/, ""), quantity: String(qty || ""), method: "searchStarsRecipient" });
    if (!j.found || !j.found.recipient) throw new Error("на Fragment нет такого пользователя");
    return { recipient: j.found.recipient, name: String(j.found.name || "").replace(/<[^>]+>/g, "") };
  }
  // → { to, amount (нанотоны), payload Cell, reqId }
  async buy(username, qty, wallet) {
    const { recipient } = await this.recipient(username, qty);
    const init = await this.api({ recipient, quantity: String(qty), method: "initBuyStarsRequest" });
    if (!init.req_id) throw new Error("Fragment не создал заявку");
    const link = await this.api({
      transaction: "1", id: init.req_id, show_sender: "0", method: "getBuyStarsLink",
      account: JSON.stringify({ address: wallet.raw, chain: "-239", walletStateInit: wallet.stateInit, publicKey: wallet.pub }),
      device: JSON.stringify({ platform: "iphone", appName: "Tonkeeper", appVersion: "5.0.14", maxProtocolVersion: 2,
        features: ["SendTransaction", { name: "SendTransaction", maxMessages: 4 }] }) });
    const tx = link.transaction, m = tx && tx.messages && tx.messages[0];
    if (!m) throw new Error("Fragment не выдал транзакцию" + (link.need_verify ? " — нужно пройти KYC" : ""));
    if (tx.messages.length !== 1) throw new Error("Fragment вернул " + tx.messages.length + " сообщения — не отправляю");
    let payload = null;
    if (m.payload) { try { payload = parseBoc(m.payload); } catch { payload = commentCell(String(m.payload)); } }
    return { to: m.address, amount: BigInt(m.amount), payload, reqId: init.req_id };
  }
}

// ---------- вход в Fragment прямо из админки (без копирования кук) ----------
// 1) кошелёк бота подтверждает владение (TON Connect ton_proof) → кука stel_ton_token
// 2) вход через Telegram: ссылка t.me/oauth?startapp=… → владелец жмёт «Подтвердить» в Telegram → кука stel_token
const OAUTH = "https://oauth.telegram.org";
const OAUTH_Q = new URLSearchParams({ client_id: "5444323279", origin: "https://fragment.com", return_to: "https://fragment.com/",
  scope: "openid profile telegram:bot_access", redirect_uri: "https://fragment.com/", response_type: "post_message" }).toString();
const DEVICE = { platform: "android", appName: "Tonkeeper", appVersion: "26.07.1", maxProtocolVersion: 2,
  features: ["SendTransaction", { name: "SignData", types: ["text", "binary", "cell"] }, { name: "SendTransaction", maxMessages: 255 }] };

// простая «банка» кук: { name: value }
export function takeCookies(jar, res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : (res.headers.get("set-cookie") || "").split(/,(?=\s*[A-Za-z0-9_]+=)/);
  for (const c of list) { const m = String(c).match(/^\s*([^=;\s]+)=([^;]*)/); if (!m) continue;
    if (m[2] === "" || m[2] === "deleted" || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) delete jar[m[1]]; else jar[m[1]] = m[2]; }
  return jar;
}
export const cookieStr = jar => Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
function embedded(text, marker) {
  const i = text.indexOf(marker); if (i < 0) return null;
  let s = text.slice(i + marker.length).trimStart(), depth = 0, str = false, esc = false;
  for (let j = 0; j < s.length; j++) { const ch = s[j];
    if (str) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') str = false; continue; }
    if (ch === '"') str = true; else if (ch === "{") depth++; else if (ch === "}" && --depth === 0) { try { return JSON.parse(s.slice(0, j + 1)); } catch { return null; } } }
  return null;
}
async function fpage(jar) {
  const r = await fetch("https://fragment.com/", { headers: { cookie: cookieStr(jar), "user-agent": UA, accept: "text/html", referer: "https://fragment.com/" }, redirect: "manual" });
  takeCookies(jar, r); const html = (await r.text()).replace(/\\\//g, "/");
  const h = html.match(/\/api\?hash=([0-9a-fA-F]+)/); if (!h) throw new Error("Fragment не открылся (HTTP " + r.status + ")");
  return { html, hash: h[1] };
}
async function fapi(jar, hash, params) {
  const r = await fetch("https://fragment.com/api?hash=" + hash, { method: "POST", redirect: "manual",
    headers: { cookie: cookieStr(jar), "user-agent": UA, "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest",
      origin: "https://fragment.com", referer: "https://fragment.com/", "x-aj-referer": "https://fragment.com/", accept: "application/json, text/javascript, */*; q=0.01" },
    body: new URLSearchParams(params).toString() });
  takeCookies(jar, r); const t = await r.text(); let j;
  try { j = JSON.parse(t); } catch { throw new Error(params.method + ": Fragment ответил не JSON (HTTP " + r.status + ")"); }
  if (j.error) throw new Error("Fragment: " + j.error);
  return j;
}
// подпись ton_proof (TON Connect) для домена fragment.com
export async function tonProof({ raw, pub, stateInit, key }, payload, now = Math.floor(Date.now() / 1000)) {
  const enc = new TextEncoder(), [wc, h] = raw.split(":"), dom = enc.encode("fragment.com"), pl = enc.encode(payload);
  const m = new Uint8Array(18 + 4 + 32 + 4 + dom.length + 8 + pl.length); const dv = new DataView(m.buffer); let o = 0;
  m.set(enc.encode("ton-proof-item-v2/"), o); o += 18;
  dv.setInt32(o, Number(wc), false); o += 4;
  m.set(h.match(/../g).map(x => parseInt(x, 16)), o); o += 32;
  dv.setUint32(o, dom.length, true); o += 4; m.set(dom, o); o += dom.length;
  dv.setBigUint64(o, BigInt(now), true); o += 8; m.set(pl, o);
  const sha = async b => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  const inner = await sha(m), pre = new Uint8Array(2 + 11 + 32); pre.set([0xff, 0xff]); pre.set(enc.encode("ton-connect"), 2); pre.set(inner, 13);
  const sig = await key.sign(await sha(pre));
  return { account: { address: raw, chain: "-239", publicKey: pub, walletStateInit: stateInit },
    proof: { timestamp: now, domain: { lengthBytes: dom.length, value: "fragment.com" }, payload, signature: btoa(String.fromCharCode(...sig)) } };
}
// шаг 1: кошелёк + старт входа через Telegram → { state, link | done }
export async function loginStart(wallet) {
  const jar = { stel_dt: "-180" };
  const { html, hash } = await fpage(jar);
  const wi = embedded(html, "Wallet.init(");
  if (!wi || !wi.ton_proof) throw new Error("Fragment не выдал ton_proof — сайт поменялся, напиши разработчику");
  const { account, proof } = await tonProof(wallet, wi.ton_proof);
  await fapi(jar, hash, { method: "checkTonProofAuth", account: JSON.stringify(account), device: JSON.stringify(DEVICE), proof: JSON.stringify(proof) });
  if (!jar.stel_ton_token) throw new Error("Fragment не принял кошелёк (нет stel_ton_token)");
  const state = { jar, hash, ojar: {}, at: Date.now() };
  if (jar.stel_token) return { state, done: true };   // этот кошелёк уже привязан к аккаунту — Telegram не нужен
  const r = await fetch(`${OAUTH}/auth/auth?${OAUTH_Q}&quick_auth=new`, { headers: { "user-agent": UA, accept: "text/html" } });
  takeCookies(state.ojar, r);
  const m = (await r.text()).match(/setToken\(['"]([^'"]+)['"]\)/);
  if (!m) throw new Error("Telegram не выдал ссылку для входа");
  state.qtoken = m[1];
  return { state, link: "https://t.me/oauth?startapp=" + m[1] };
}
// шаг 2: опрос — подтвердил ли владелец вход в Telegram → { status, link?, cookies? }
export async function loginPoll(state) {
  const r = await fetch(`${OAUTH}/auth/login?${OAUTH_Q}&qtoken=${encodeURIComponent(state.qtoken)}`, { method: "POST",
    headers: { cookie: cookieStr(state.ojar), "user-agent": UA, origin: OAUTH, referer: `${OAUTH}/auth/auth?${OAUTH_Q}`, "x-requested-with": "XMLHttpRequest", "content-type": "application/x-www-form-urlencoded" }, body: "" });
  takeCookies(state.ojar, r);
  let j; try { j = await r.json(); } catch { throw new Error("Telegram ответил не JSON (HTTP " + r.status + ")"); }
  const st = j && j.status;
  if (st === "refresh") { state.qtoken = String(j.qtoken || state.qtoken); return { status: "wait", link: "https://t.me/oauth?startapp=" + state.qtoken }; }
  if (st === "expired" || st === "declined" || st === "cancelled") return { status: st };
  if (st !== "confirmed") return { status: "wait" };
  const p = await fetch(`${OAUTH}/auth/push?${OAUTH_Q}`, { headers: { cookie: cookieStr(state.ojar), "user-agent": UA, referer: `${OAUTH}/auth/auth?${OAUTH_Q}` } });
  takeCookies(state.ojar, p);
  const t = (await p.text()).match(/tgAuthResult=([A-Za-z0-9_-]+)/);
  if (!t) throw new Error("Telegram не вернул результат входа");
  await fapi(state.jar, state.hash, { method: "logIn", auth: t[1] });
  if (!state.jar.stel_token) throw new Error("Fragment не выдал stel_token после входа");
  return { status: "done" };
}
export const loginCookies = jar => cookieStr({ stel_ssid: jar.stel_ssid, stel_dt: jar.stel_dt || "-180", stel_token: jar.stel_token, stel_ton_token: jar.stel_ton_token });
