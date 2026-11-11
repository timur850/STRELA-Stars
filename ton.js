// TON без сторонних библиотек: ячейки, BOC, ключ из сид-фразы, перевод с кошелька v4r2 / v5r1.
// Сид-фраза живёт только в секрете Cloudflare (WALLET_MNEMONIC) и никуда не отправляется.

const enc = new TextEncoder();
export const hex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
export const unhex = s => new Uint8Array(s.match(/../g).map(h => parseInt(h, 16)));
export function b64d(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  while (s.length % 4) s += "=";
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function b64e(b, url) {
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  s = btoa(s); return url ? s.replace(/\+/g, "-").replace(/\//g, "_") : s;
}
const sha256 = async b => new Uint8Array(await crypto.subtle.digest("SHA-256", b));

// ---------- ячейки ----------
export class Cell {
  constructor(bits = [], refs = []) { this.bits = bits; this.refs = refs; this._h = null; }
  depth() { return this.refs.length ? 1 + Math.max(...this.refs.map(r => r.depth())) : 0; }
  dataBytes() {
    const b = this.bits.slice(); if (b.length % 8) { b.push(1); while (b.length % 8) b.push(0); }
    const out = new Uint8Array(b.length / 8);
    for (let i = 0; i < b.length; i++) if (b[i]) out[i >> 3] |= 0x80 >> (i & 7);
    return out;
  }
  descriptors() { const n = this.bits.length; return [this.refs.length, Math.floor(n / 8) + Math.ceil(n / 8)]; }
  async hash() {
    if (this._h) return this._h;
    const parts = [Uint8Array.from(this.descriptors()), this.dataBytes()];
    for (const r of this.refs) { const d = r.depth(); parts.push(Uint8Array.from([d >> 8, d & 255])); }
    for (const r of this.refs) parts.push(await r.hash());
    const len = parts.reduce((a, p) => a + p.length, 0), buf = new Uint8Array(len);
    let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
    return (this._h = await sha256(buf));
  }
}
export class Builder {
  constructor() { this.bits = []; this.refs = []; }
  bit(v) { this.bits.push(v ? 1 : 0); return this; }
  uint(v, n) { v = BigInt(v); for (let i = n - 1; i >= 0; i--) this.bits.push(Number((v >> BigInt(i)) & 1n)); return this; }
  int(v, n) { v = BigInt(v); if (v < 0n) v += 1n << BigInt(n); return this.uint(v, n); }
  bytes(b) { for (const x of b) this.uint(x, 8); return this; }
  coins(v) { v = BigInt(v); if (v === 0n) return this.uint(0, 4); let l = 0; for (let t = v; t > 0n; t >>= 8n) l++; return this.uint(l, 4).uint(v, l * 8); }
  addr(a) { if (!a) return this.uint(0, 2); return this.uint(2, 2).uint(0, 1).int(a.wc, 8).bytes(a.hash); }
  ref(c) { this.refs.push(c); return this; }
  slice(c) { this.bits.push(...c.bits); this.refs.push(...c.refs); return this; }
  end() { if (this.bits.length > 1023 || this.refs.length > 4) throw new Error("cell overflow"); return new Cell(this.bits, this.refs); }
}
export const beginCell = () => new Builder();

// ---------- адреса ----------
function crc16(data) {
  let crc = 0;
  for (const b of data) { crc ^= b << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc;
}
export function parseAddr(s) {
  s = String(s || "").trim();
  const m = s.match(/^(-?\d+):([0-9a-fA-F]{64})$/);
  if (m) return { wc: Number(m[1]), hash: unhex(m[2].toLowerCase()), bounceable: true };
  const b = b64d(s);
  if (b.length !== 36) throw new Error("неверный TON-адрес");
  const c = crc16(b.slice(0, 34));
  if (b[34] !== (c >> 8) || b[35] !== (c & 255)) throw new Error("неверная контрольная сумма адреса");
  const tag = b[0] & 0x7f;   // 0x11 bounceable, 0x51 non-bounceable (+0x80 testnet)
  return { wc: b[1] === 0xff ? -1 : b[1], hash: b.slice(2, 34), bounceable: tag === 0x11 };
}
export const rawAddr = a => a.wc + ":" + hex(a.hash);
export function friendly(a, bounceable = false) {
  const b = new Uint8Array(36); b[0] = bounceable ? 0x11 : 0x51; b[1] = a.wc & 255; b.set(a.hash, 2);
  const c = crc16(b.slice(0, 34)); b[34] = c >> 8; b[35] = c & 255; return b64e(b, true);
}

// ---------- BOC ----------
function crc32c(data) {
  let crc = 0xffffffff;
  for (const b of data) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
export function parseBoc(input) {
  const d = typeof input === "string" ? b64d(input) : input;
  let p = 0; const rd = n => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + d[p++]; return v; };
  const magic = rd(4);
  if (magic !== 0xb5ee9c72) throw new Error("не BOC");
  const f = d[p++], hasIdx = f & 0x80, size = f & 7, offB = d[p++];
  const cells = rd(size), roots = rd(size); rd(size); rd(offB);
  const rootIdx = []; for (let i = 0; i < roots; i++) rootIdx.push(rd(size));
  if (hasIdx) p += cells * offB;
  const raw = [];
  for (let i = 0; i < cells; i++) {
    const d1 = d[p++], d2 = d[p++];
    if (d1 & 8) throw new Error("exotic-ячейки не поддерживаются");
    const nRefs = d1 & 7, len = Math.ceil(d2 / 2), data = d.slice(p, p + len); p += len;
    const bits = []; for (let k = 0; k < len * 8; k++) bits.push((data[k >> 3] >> (7 - (k & 7))) & 1);
    if (d2 & 1) { while (bits.length && bits[bits.length - 1] === 0) bits.pop(); bits.pop(); }
    const refs = []; for (let k = 0; k < nRefs; k++) refs.push(rd(size));
    raw.push({ bits, refs });
  }
  const built = new Array(cells);
  for (let i = cells - 1; i >= 0; i--) built[i] = new Cell(raw[i].bits, raw[i].refs.map(r => built[r]));
  return built[rootIdx[0]];
}
export function serializeBoc(root) {
  const list = []; const walk = c => { list.push(c); c.refs.forEach(walk); };
  walk(root);
  const idx = new Map(); list.forEach((c, i) => idx.set(c, i));   // дерево без общих ссылок — индексы родителей < детей
  // если одна ячейка встречается дважды, Map держит последний индекс — он больше индекса родителя
  const size = Math.max(1, Math.ceil(Math.log2(list.length + 1) / 8));
  const body = [];
  for (const c of list) {
    const [d1, d2] = c.descriptors(); body.push(d1, d2, ...c.dataBytes());
    for (const r of c.refs) { const v = idx.get(r); for (let k = size - 1; k >= 0; k--) body.push((v >> (8 * k)) & 255); }
  }
  const offB = Math.max(1, Math.ceil(Math.log2(body.length + 1) / 8));
  const out = [0xb5, 0xee, 0x9c, 0x72, 0x40 | size, offB];
  const w = (v, n) => { for (let k = n - 1; k >= 0; k--) out.push(Math.floor(v / 2 ** (8 * k)) & 255); };
  w(list.length, size); w(1, size); w(0, size); w(body.length, offB); w(0, size);
  out.push(...body);
  const c = crc32c(Uint8Array.from(out)); out.push(c & 255, (c >> 8) & 255, (c >> 16) & 255, (c >>> 24) & 255);
  return Uint8Array.from(out);
}

// ---------- ключи ----------
async function hmac512(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
// 12 (или 18) слов: такие фразы дают Trust Wallet, Bitget, MyTonWallet и др. — это BIP39 + путь m/44'/607'/0'.
// Возвращаем все варианты ключа; нужный выбирается по публичному ключу кошелька в сети.
export async function keyCandidates(words) {
  const phrase = String(words).trim().toLowerCase().split(/\s+/).join(" ");
  const n = phrase.split(" ").length;
  if (![12, 18, 24].includes(n)) throw new Error("сид-фраза должна быть из 12 или 24 слов, сейчас " + n);
  const out = [];
  const pb = await crypto.subtle.importKey("raw", enc.encode(phrase.normalize("NFKD")), "PBKDF2", false, ["deriveBits"]);
  const seed = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt: enc.encode("mnemonic"), iterations: 2048 }, pb, 512));
  for (const path of [[44, 607, 0], [44, 607, 0, 0, 0]]) out.push({ kind: "bip39 m/" + path.join("'/") + "'", key: await keyFromSeed(await slip10(seed, path)) });
  out.push({ kind: "ton", key: await tonNativeKey(phrase) });
  return out;
}
export async function slip10(seed, path) {
  let I = await hmac512(enc.encode("ed25519 seed"), seed);
  for (const i of path) {
    const d = new Uint8Array(37); d.set(I.slice(0, 32), 1);
    const x = (i | 0x80000000) >>> 0; d[33] = x >>> 24; d[34] = (x >>> 16) & 255; d[35] = (x >>> 8) & 255; d[36] = x & 255;
    I = await hmac512(I.slice(32), d);
  }
  return I.slice(0, 32);
}
export async function keyFromMnemonic(words) {
  const phrase = String(words).trim().toLowerCase().split(/\s+/).join(" ");
  if (phrase.split(" ").length !== 24) throw new Error("сид-фраза должна быть из 24 слов");
  return tonNativeKey(phrase);
}
async function tonNativeKey(phrase) {
  const entropy = await hmac512(enc.encode(phrase), new Uint8Array(0));
  const base = await crypto.subtle.importKey("raw", entropy, "PBKDF2", false, ["deriveBits"]);
  const seed = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt: enc.encode("TON default seed"), iterations: 100000 }, base, 512));
  return keyFromSeed(seed.slice(0, 32));
}
export async function keyFromSeed(seed32) {
  const pk8 = new Uint8Array(48); pk8.set(unhex("302e020100300506032b657004220420")); pk8.set(seed32, 16);
  let algo = { name: "Ed25519" }, priv;
  try { priv = await crypto.subtle.importKey("pkcs8", pk8, algo, true, ["sign"]); }
  catch { algo = { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }; priv = await crypto.subtle.importKey("pkcs8", pk8, algo, true, ["sign"]); }
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  return { publicKey: b64d(jwk.x), sign: async msg => new Uint8Array(await crypto.subtle.sign(algo, priv, msg)) };
}

// ---------- кошелёк ----------
export const CODE_HASH = {
  "feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0": "v4r2",
  "20834b7b72b112147e1b2fb457b84e74d1a30f04f737d4f62a668e9552d2b72f": "v5r1",
};
// исходные data кошелька (seqno = 0) — из них и кода получается адрес
export function initialData(version, walletId, pub) {
  if (version === "v4r2") return beginCell().uint(0, 32).uint(walletId, 32).bytes(pub).bit(0).end();
  if (version === "v5r1") return beginCell().bit(1).uint(0, 32).uint(walletId, 32).bytes(pub).bit(0).end();
  throw new Error("кошелёк " + version + " не поддерживается");
}
export const stateInitCell = (code, data) => beginCell().uint(0, 2).bit(1).bit(1).bit(0).ref(code).ref(data).end();

export function internalMsg({ to, amount, bounce, payload }) {
  const b = beginCell().uint(0, 1).bit(1).bit(bounce).bit(0).addr(null).addr(to)
    .coins(amount).bit(0).coins(0).coins(0).uint(0, 64).uint(0, 32).bit(0);
  if (payload) b.bit(1).ref(payload); else b.bit(0);
  return b.end();
}
// подписанный внешний перевод → BOC (base64) для sendBoc
export async function buildTransfer({ version, walletId, seqno, wallet, key, to, amount, bounce, payload, validUntil, mode = 3 }) {
  const msg = internalMsg({ to, amount, bounce, payload });
  let body;
  if (version === "v4r2") {
    const unsigned = beginCell().uint(walletId, 32).uint(validUntil, 32).uint(seqno, 32).uint(0, 8).uint(mode, 8).ref(msg).end();
    const sig = await key.sign(await unsigned.hash());
    body = beginCell().bytes(sig).slice(unsigned).end();
  } else if (version === "v5r1") {
    const outList = beginCell().uint(0x0ec3c86d, 32).uint(mode, 8).ref(new Cell()).ref(msg).end();
    const unsigned = beginCell().uint(0x7369676e, 32).uint(walletId, 32).uint(validUntil, 32).uint(seqno, 32)
      .bit(1).ref(outList).bit(0).end();
    const sig = await key.sign(await unsigned.hash());
    body = beginCell().slice(unsigned).bytes(sig).end();
  } else throw new Error("кошелёк " + version + " не поддерживается (нужен v4r2 или W5)");
  const ext = beginCell().uint(2, 2).addr(null).addr(wallet).coins(0).bit(0).bit(1).ref(body).end();
  return { boc: b64e(serializeBoc(ext)), hash: hex(await ext.hash()) };
}
export const commentCell = text => {
  const bytes = enc.encode(text); const chunks = [];
  for (let i = 0; i < bytes.length; i += 123) chunks.push(bytes.slice(i, i + 123));
  let tail = null;
  for (let i = chunks.length - 1; i >= 0; i--) {
    const b = beginCell(); if (i === 0) b.uint(0, 32); b.bytes(chunks[i]); if (tail) b.ref(tail); tail = b.end();
  }
  return tail || beginCell().uint(0, 32).end();
};

// ---------- toncenter ----------
export class Toncenter {
  // настоящий ключ toncenter — 64 hex-символа; заглушку вроде "0" игнорируем
  constructor(apiKey) { this.key = /^[0-9a-f]{64}$/i.test(String(apiKey || "").trim()) ? String(apiKey).trim() : ""; this.last = 0; }
  async call(path, opt = {}) {
    for (let i = 0; i < 4; i++) {
      const wait = this.last + (this.key ? 120 : 1100) - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.last = Date.now();
      const r = await fetch("https://toncenter.com/api/v2/" + path, {
        method: opt.body ? "POST" : "GET",
        headers: { "content-type": "application/json", ...(this.key ? { "X-API-Key": this.key } : {}) },
        body: opt.body ? JSON.stringify(opt.body) : undefined });
      if (r.status === 429) continue;
      const j = await r.json().catch(() => ({ ok: false, error: "HTTP " + r.status }));
      if (!j.ok) throw new Error("toncenter: " + (j.error || j.description || r.status));
      return j.result;
    }
    throw new Error("toncenter: слишком много запросов, добавь TONCENTER_KEY");
  }
  info(addr) { return this.call("getAddressInformation?address=" + encodeURIComponent(addr)); }
  async getNum(addr, method) {
    const r = await this.call("runGetMethod", { body: { address: addr, method, stack: [] } });
    if (r.exit_code !== 0 || !r.stack || !r.stack[0]) throw new Error(method + ": exit " + r.exit_code);
    return BigInt(r.stack[0][1]);
  }
  send(boc) { return this.call("sendBoc", { body: { boc } }); }
}
