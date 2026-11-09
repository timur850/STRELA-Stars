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
