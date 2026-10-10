// Supabase Edge Function: finds incoming USDT payments (TRC20, BEP20, TON) and records them once.
// A payment is matched to a deposit request by receiving address + exact amount (unique tail);
// on TON the request number written in the transfer comment also works.
// It only READS the blockchains and WRITES to the database: it holds no key that can move money.
//
// Optional settings (Secrets): TRONGRID_API_KEY, TONCENTER_API_KEY (raise the free rate limits),
// TELEGRAM_BOT_TOKEN (already set; used for staff and player messages).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const fid = (v: unknown) => { const d = String(v ?? "").replace(/\D/g, ""); return d.length > 4 ? d.replace(/(\d{4})(?=\d)/g, "$1-") : String(v ?? ""); };   // 33833619 -> 3383-3619

// ---- helpers (pure functions, unit-tested) ----
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Integer token amount in base units -> decimal string with 6 places, no rounding errors. */
function toAmount(raw: string, decimals: number): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, 6).padEnd(6, "0");
  return `${whole}.${frac}`;
}
/** "250.2233" and "250.223300" and 250.2233 must compare equal. */
function normAmount(s: string | number): string {
  const [i, f = ""] = String(s).split(".");
  return (i.replace(/^0+(?=\d)/, "") || "0") + "." + f.padEnd(6, "0").slice(0, 6);
}
function padTopic(addr: string): string {
  return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function topicToAddr(topic: string): string {
  return "0x" + topic.slice(-40);
}
const hexOf = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
/** TON address, friendly ("EQ..", "UQ..") or raw ("0:abc.."), -> raw "0:ABC.." in upper case. */
function tonToRaw(addr: string): string {
  const a = addr.trim();
  const m = a.match(/^(-?\d+):([0-9a-fA-F]{64})$/);
  if (m) return `${m[1]}:${m[2].toUpperCase()}`;
  const bin = atob(a.replace(/-/g, "+").replace(/_/g, "/"));
  if (bin.length !== 36) throw new Error("bad TON address");
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const wc = bytes[1] > 127 ? bytes[1] - 256 : bytes[1];
  return `${wc}:${hexOf(bytes.slice(2, 34)).toUpperCase()}`;
}
/** TON transaction hash: base64 -> lower-case hex (the form explorers use). */
function b64ToHex(b64: string): string {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  return hexOf(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
/** One comparable form per network (case rules differ). */
const CHAIN_OF: Record<string, string> = { TRC20: "TRON", BEP20: "BSC", TON: "TON", GRAM: "TON" };
function normAddr(network: string, a: string): string {
  if (network === "BEP20") return a.toLowerCase();
  if (network === "TON" || network === "GRAM") { try { return tonToRaw(a); } catch { return a; } }
  return a;
}
interface Found { tx_hash: string; to: string; from: string; amount: string; comment?: string; }
interface Req { id: number; user_id: string; address: string; amount: string; status: string; request_no: string; base_amount?: string; rate?: string; }

function parseEvmLogs(logs: Array<{ transactionHash: string; topics: string[]; data: string }>, decimals: number): Found[] {
  return logs
    .filter((l) => l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && l.topics.length === 3)
    .map((l) => ({
      tx_hash: l.transactionHash.toLowerCase(),
      from: topicToAddr(l.topics[1]),
      to: topicToAddr(l.topics[2]),
      amount: toAmount(BigInt(l.data).toString(), decimals),
    }));
}
/** TronGrid list -> payments. Only real Transfer events to this address (it also lists Approvals!). */
function parseTronList(items: Array<Record<string, unknown>>, address: string, contract: string): Found[] {
  return items
    .filter((x) => x.type === "Transfer" && x.to === address &&
      (x.token_info as { address?: string } | undefined)?.address === contract)
    .map((x) => ({
      tx_hash: String(x.transaction_id),
      from: String(x.from),
      to: address,
      amount: toAmount(String(x.value), Number((x.token_info as { decimals: number }).decimals)),
    }));
}
/** toncenter jetton transfers -> payments to our wallet, USDT only, never failed ones. */
function parseTonTransfers(items: Array<Record<string, unknown>>, ownerRaw: string | Set<string>, masterRaw: string, decimals: number): Found[] {
  const owners = typeof ownerRaw === "string" ? new Set([ownerRaw.toUpperCase()]) : ownerRaw, master = masterRaw.toUpperCase();
  return items
    .filter((x) => !x.transaction_aborted && owners.has(String(x.destination).toUpperCase()) && String(x.jetton_master).toUpperCase() === master)
    .map((x) => {
      const p = x.decoded_forward_payload as { "@type"?: string; comment?: string } | null | undefined;
      return {
        tx_hash: b64ToHex(String(x.transaction_hash)),
        from: String(x.source).toUpperCase(),
        to: String(x.destination).toUpperCase(),
        amount: toAmount(String(x.amount), decimals),
        comment: p && p["@type"] === "text_comment" ? String(p.comment ?? "").trim() : undefined,
      };
    });
}
/** Plain GRAM transfers into the club wallet (toncenter v3 transactions). */
function parseTonNative(items: Array<Record<string, any>>, ownerRaw: string | Set<string>): Found[] {   // deno-lint-ignore no-explicit-any
  const owners = typeof ownerRaw === "string" ? new Set([ownerRaw.toUpperCase()]) : ownerRaw;
  return items
    // a new (not yet active) wallet shows incoming money as "aborted", yet credits it: count what was really credited, unless it bounced back
    .filter((t) => t.in_msg && t.in_msg.source && BigInt(t.description?.credit_ph?.credit ?? 0) > 0n && !t.description?.bounce && owners.has(String(t.in_msg.destination ?? t.account).toUpperCase()))
    .map((t) => {
      const d = t.in_msg.message_content?.decoded;
      return {
        tx_hash: b64ToHex(String(t.hash)),
        from: String(t.in_msg.source).toUpperCase(),
        to: String(t.in_msg.destination ?? t.account).toUpperCase(),
        amount: toAmount(String(t.description?.credit_ph?.credit ?? t.in_msg.value), 9),
        comment: d && d.type === "text_comment" ? String(d.comment ?? "").trim() : undefined,
      };
    });
}
/** The request this payment belongs to: same address and exact amount (a still-open one wins over an expired one).
 *  If nothing matches by amount, a transfer comment equal to a request number also identifies it. */
function matchRequest(f: Found, reqs: Req[], network: string): Req | undefined {
  const to = normAddr(network, f.to);
  const same = reqs.filter((r) => normAddr(network, r.address) === to && normAmount(r.amount) === normAmount(f.amount));
  const byAmount = same.find((r) => r.status === "open") ?? same.find((r) => r.status === "expired");
  if (byAmount) return byAmount;
  if (f.comment) return reqs.find((r) => r.request_no === f.comment && (r.status === "open" || r.status === "expired"));
  return undefined;
}
// ---- end helpers ----


// ---- player messages (Telegram HTML) ----
const EXPLORER_NAME: Record<string, string> = { TRC20: "Tronscan", BEP20: "BscScan", TON: "Tonviewer", GRAM: "Tonviewer" };
const EXPLORER_URL: Record<string, string> = { TRC20: "https://tronscan.org/#/transaction/", BEP20: "https://bscscan.com/tx/", TON: "https://tonviewer.com/transaction/", GRAM: "https://tonviewer.com/transaction/" };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as Record<string, string>)[c]);
const fmtId = (v: unknown) => { const d = String(v ?? "").replace(/\D/g, ""); return d.length > 4 ? d.replace(/(\d{4})(?=\d)/g, "$1-") : String(v ?? ""); };
const num = (v: unknown) => String(Number(v));
function txLinks(net: string, hashes: string[]): string {
  return hashes.filter(Boolean).map((h, i) => `🔗 <a href="${EXPLORER_URL[net] ?? ""}${esc(h.trim())}">Открыть перевод в ${EXPLORER_NAME[net] ?? "обозревателе"}${hashes.length > 1 ? ` (${i + 1})` : ""}</a>`).join("\n");
}

function msgDepositReceived(d: Record<string, unknown>, net: string, gg: unknown): string {
  const paid = d.coin_amount ? `${num(d.coin_amount)} GRAM (≈ $${num(d.amount)})` : `${num(d.amount)} USDT`;
  return [
    `✅ <b>Платёж получен</b> · <i>Payment received</i>`, ``,
    `🧾 Операция: <code>${esc(d.op_id)}</code>`,
    `💵 Сумма: <b>${paid}</b> · ${esc(net)}`,
    txLinks(net, [String(d.tx_hash ?? "")]),
    ``, `⏳ Менеджер уже отправляет фишки на ваш ID <b>${fmtId(gg)}</b>.`,
  ].join("\n");
}
function msgChipsSent(d: Record<string, unknown>, gg: unknown): string {
  return [
    `🎰 <b>Фишки отправлены</b> · <i>Chips sent</i>`, ``,
    `🧾 Операция: <code>${esc(d.op_id)}</code>`,
    `🎰 Фишки: <b>${Math.floor(Number(d.amount) * 100) / 100}</b> → ID <b>${fmtId(gg)}</b>`,
    ``, `Удачной игры за столами!`,
  ].join("\n");
}

/** GRAM price in USD from public exchange tickers. */
async function gramPrice(): Promise<number> {
  const tries: Array<[string, (d: any) => unknown]> = [   // deno-lint-ignore no-explicit-any
    ["https://api.binance.com/api/v3/ticker/price?symbol=GRAMUSDT", (d) => d.price],
    ["https://www.okx.com/api/v5/market/ticker?instId=GRAM-USDT", (d) => d.data?.[0]?.last],
    ["https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd", (d) => d["the-open-network"]?.usd],
  ];
  for (const [url, pick] of tries) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); if (!r.ok) continue; const p = Number(pick(await r.json())); if (p > 0.05 && p < 1000) return p; } catch { /* next */ }
  }
  throw new Error("no GRAM price");
}

const ok = (b: unknown) => new Response(JSON.stringify(b), { headers: { "Content-Type": "application/json" } });

async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const d = await r.json();
  if (d.error) throw new Error(`${method}: ${d.error.message}`);
  return d.result;
}

Deno.serve(async () => {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const summary: Record<string, unknown> = {};

  async function send(chatId: number, text: string, withQueueButton = false, html = false) {
    if (!botToken) return;
    const markup = withQueueButton ? { inline_keyboard: [[{ text: "Open the queue", web_app: { url: "https://zerake.com/app/?tab=admin" } }]] } : undefined;
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, reply_markup: markup, parse_mode: html ? "HTML" : undefined }),
    }).catch(() => {});
  }
  async function alertStaff(text: string, withQueueButton = false) {
    const { data: staff } = await admin.from("staff").select("telegram_id");
    for (const s of staff ?? []) await send(s.telegram_id, text, withQueueButton);
  }
  async function notifyUser(userId: string, text: string) {
    const u = await admin.auth.admin.getUserById(userId);
    const tid = u.data?.user?.user_metadata?.telegram_id;
    if (tid) await send(Number(tid), text, false, true);
  }

  // Housekeeping for every network: open -> expired after the window, expired -> closed after 24 h.
  const nowIso = new Date().toISOString();
  await admin.from("deposit_requests").update({ status: "expired" }).eq("status", "open").lt("expires_at", nowIso);
  await admin.from("deposit_requests").update({ status: "closed" }).eq("status", "expired").lt("expires_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());

  /** Record payments once, link them to requests, credit pool addresses, alert staff and the player. */
  // deno-lint-ignore no-explicit-any
  async function processPersonal(c: Record<string, any>, found: Found[], owners: Map<string, string>) {
    if (!found.length) return { found: 0, credited: 0 };
    const kd = await admin.from("deposits").select("tx_hash").eq("network", c.network).in("tx_hash", found.map((f) => f.tx_hash));
    const known = new Set((kd.data ?? []).map((r) => r.tx_hash));
    found = found.filter((f) => !known.has(f.tx_hash));
    let price = 0;
    if (c.network === "GRAM" && found.length) price = await gramPrice();
    let credited = 0;
    for (const f of found) {
      const uid = owners.get(f.to); if (!uid) continue;
      const usd = c.network === "GRAM" ? Math.floor(Number(f.amount) * price * 100) / 100 : Number(f.amount);
      const bw = (await admin.from("player_wallets").select("address").eq("user_id", uid).eq("chain", "TON").maybeSingle()).data;
      const fromBound = !!bw && normAddr("TON", bw.address) === normAddr("TON", f.from);
      const ins = await admin.from("deposits").upsert({
        user_id: uid, network: c.network, tx_hash: f.tx_hash, from_address: f.from, to_address: f.to, request_id: null,
        amount: usd.toFixed(6), coin_amount: c.network === "GRAM" ? f.amount : null, from_bound: fromBound,
        status: usd >= Number(c.min_deposit) * (c.network === "GRAM" ? 0.97 : 1) ? "received" : "below_min",   // GRAM: 3% for the rate moving
      }, { onConflict: "network,tx_hash", ignoreDuplicates: true }).select("op_id,tx_hash,user_id,amount,coin_amount,status,from_bound,from_address");
      if (ins.error) throw new Error("save: " + ins.error.message);
      const d = ins.data?.[0]; if (!d) continue;
      credited++;
      const p = await admin.from("profiles").select("gg_id").eq("user_id", uid).maybeSingle();
      if (d.status === "received") {
        await notifyUser(uid, msgDepositReceived(d, c.network, p.data?.gg_id));
        await alertStaff(`💰 Top up chips: ${Math.floor(Number(d.amount) * 100) / 100} USDT\nOperation: ${d.op_id}\nClubGG ID: ${p.data?.gg_id ? fid(p.data.gg_id) : "NOT SET"}\nPaid: ${d.coin_amount ? Number(d.coin_amount) + " GRAM" : Number(d.amount) + " USDT"} (${c.network}) to the player's own address\nSend the chips in ClubGG, then take it and mark it as sent.${d.from_bound === false ? `\n⚠️ NOT from the player's bound wallet (from ${d.from_address}). Check before sending chips.` : ""}\n${c.explorer_tx}${d.tx_hash}`, true);
      } else {
        await notifyUser(uid, `⚠️ Получено ${d.coin_amount ? Number(d.coin_amount) + " GRAM" : Number(d.amount) + " USDT"} — меньше минимума ($${Number(c.min_deposit)}). Напишите в поддержку.`);
        await alertStaff(`⚠️ Below the minimum: ${Number(d.amount)} USD (${c.network}) from ClubGG ID ${p.data?.gg_id ? fid(p.data.gg_id) : "NOT SET"} (${d.op_id}). Handle by hand.`);
      }
    }
    return { found: found.length, credited };
  }

  async function processFound(c: Record<string, any>, found: Found[], reqs: Req[]) {
    // The overlap window shows payments we already recorded: those are not "unidentified".
    if (found.length) {
      const kd = await admin.from("deposits").select("tx_hash").eq("network", c.network).in("tx_hash", found.map((f) => f.tx_hash));
      const known = new Set((kd.data ?? []).map((r) => r.tx_hash));
      found = found.filter((f) => !known.has(f.tx_hash));
    }
    const rows: Record<string, unknown>[] = [];
    const orphans: Record<string, unknown>[] = [];
    const reqByTx = new Map<string, Req>();
    for (const f of found) {
      const req = matchRequest(f, reqs, c.network);
      if (req) {
        reqByTx.set(f.tx_hash, req);
        let usd = f.amount, coin: string | null = null;
        if (c.network === "GRAM") {
          const paid = Number(f.amount), want = Number(req.amount), base = Number(req.base_amount ?? 0);
          usd = (paid >= want * 0.995 ? base : Math.floor(paid / want * base * 100) / 100).toFixed(6);
          coin = f.amount;
        }
        const bw = (await admin.from("player_wallets").select("address").eq("user_id", req.user_id).eq("chain", CHAIN_OF[c.network]).maybeSingle()).data;
        const fromBound = !!bw && normAddr(c.network, bw.address) === normAddr(c.network, f.from);
        rows.push({
          from_bound: fromBound,
          user_id: req.user_id, network: c.network, tx_hash: f.tx_hash, from_address: f.from, to_address: f.to, request_id: req.id,
          amount: usd, coin_amount: coin, status: Number(usd) >= Number(c.min_deposit) ? "received" : "below_min",
        });
      } else {
        orphans.push({ network: c.network, tx_hash: f.tx_hash, address: f.to, from_address: f.from, amount: f.amount });
      }
    }
    let created: Array<{ from_bound: boolean | null; from_address: string; op_id: string; tx_hash: string; user_id: string; amount: string; coin_amount: string | null; status: string; to_address: string; request_id: number }> = [];
    if (rows.length) {
      const ins = await admin.from("deposits").upsert(rows, { onConflict: "network,tx_hash", ignoreDuplicates: true }).select("op_id,tx_hash,user_id,amount,coin_amount,status,to_address,request_id,from_bound,from_address");
      if (ins.error) throw new Error("save: " + ins.error.message);
      created = ins.data ?? [];
    }
    for (const d of created) {
      await admin.from("deposit_requests").update({ status: "paid", tx_hash: d.tx_hash }).eq("id", d.request_id);
      if (c.network !== "TON" && c.network !== "GRAM") await admin.rpc("pool_credit", { p_network: c.network, p_address: d.to_address, p_amount: d.amount });
    }
    for (const d of created.filter((x) => x.status === "received")) {
      const req = reqByTx.get(d.tx_hash)!;
      const p = await admin.from("profiles").select("gg_id").eq("user_id", d.user_id).maybeSingle();
      await notifyUser(d.user_id, msgDepositReceived(d, c.network, p.data?.gg_id));

      await alertStaff(`💰 Top up chips: ${Number(req.base_amount ?? d.amount)} USDT\nOperation: ${d.op_id}\nClubGG ID: ${p.data?.gg_id ? fid(p.data.gg_id) : "NOT SET"}\nPaid: ${d.coin_amount ? Number(d.coin_amount) + " GRAM" : d.amount + " USDT"} (${c.network}) · request ${req.request_no}${req.status === "expired" ? " · paid after the 30 minutes" : ""}\nSend the chips in ClubGG, then take it and mark it as sent.${d.from_bound === false ? `\n⚠️ NOT from the player's bound wallet (from ${d.from_address}). Check before sending chips.` : ""}\n${c.explorer_tx}${d.tx_hash}`, true);
    }
    let orphanNew = 0;
    if (orphans.length) {
      const oi = await admin.from("unmatched_deposits").upsert(orphans, { onConflict: "network,tx_hash", ignoreDuplicates: true }).select("tx_hash,address,amount,from_address");
      for (const o of oi.data ?? []) {
        orphanNew++;
        await alertStaff(`⚠️ Unidentified payment ${Number(o.amount)} ${c.network === "GRAM" ? "GRAM" : "USDT"} (${c.network})\nTo: ${o.address}\nFrom: ${o.from_address}\nNo matching request. Check it by hand.\n${c.explorer_tx}${o.tx_hash}`);
      }
    }
    return { found: found.length, credited: created.length, unmatched: orphanNew };
  }

  const { data: chains } = await admin.from("chain_config").select("*").eq("enabled", true);
  for (const c of chains ?? []) {
    try {
      const st = await admin.from("scan_state").select("cursor").eq("network", c.network).maybeSingle();
      const cursor = Number(st.data?.cursor ?? 0);
      const rq = await admin.from("deposit_requests").select("id,user_id,address,amount,status,request_no,base_amount,rate").eq("network", c.network).in("status", ["open", "expired"]);
      const reqs = (rq.data ?? []) as Req[];
      let found: Found[] = [];
      let newCursor = cursor;
      let scanned = 0;

      if (c.network === "TRC20") {
        const recv = await admin.from("address_pool").select("address").eq("network", "TRC20").eq("status", "receiving");
        const addrs = new Set<string>([...reqs.map((r) => r.address), ...(recv.data ?? []).map((r) => r.address)]);
        if (addrs.size === 0) { summary[c.network] = "no addresses"; continue; }
        scanned = addrs.size;
        // 15-minute overlap so late confirmations are not missed (payments are recorded once anyway).
        const sinceMs = cursor ? cursor - 15 * 60 * 1000 : Date.now() - 60 * 60 * 1000;
        const headers: Record<string, string> = {};
        const key = Deno.env.get("TRONGRID_API_KEY"); if (key) headers["TRON-PRO-API-KEY"] = key;
        for (const addr of addrs) {
          const u = `${c.rpc_url}/v1/accounts/${addr}/transactions/trc20?only_to=true&only_confirmed=true&limit=200&contract_address=${c.usdt_contract}&min_timestamp=${sinceMs}`;
          const r = await fetch(u, { headers });
          if (!r.ok) throw new Error(`trongrid ${r.status}`);
          found = found.concat(parseTronList((await r.json()).data ?? [], addr, c.usdt_contract));
          await new Promise((res) => setTimeout(res, 150));
        }
        newCursor = Date.now();
      } else if (c.network === "BEP20") {
        const recv = await admin.from("address_pool").select("address").eq("network", "BEP20").eq("status", "receiving");
        const addrs = [...new Set<string>([...reqs.map((r) => r.address), ...(recv.data ?? []).map((r) => r.address)].map((a) => a.toLowerCase()))];
        if (addrs.length === 0) { summary[c.network] = "no addresses"; continue; }
        scanned = addrs.length;
        const latest = parseInt(await rpc(c.rpc_url, "eth_blockNumber", []), 16);
        const safe = latest - c.confirmations;
        let from = cursor ? cursor + 1 : Math.max(0, safe - 600);   // first run: about the last 30 minutes
        if (cursor && from < safe - 9000) from = safe - 9000;       // never ask for a huge range
        const to = Math.min(safe, from + 1999);
        if (to >= from) {
          for (let i = 0; i < addrs.length; i += 50) {
            const logs = await rpc(c.rpc_url, "eth_getLogs", [{
              fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: c.usdt_contract,
              topics: [TRANSFER_TOPIC, null, addrs.slice(i, i + 50).map(padTopic)],
            }]);
            found = found.concat(parseEvmLogs(logs, c.decimals));
          }
          newCursor = to;
        }
      } else if (c.network === "TON") {
        if (!c.receive_address) { summary[c.network] = "no wallet address set"; continue; }
        scanned = 1;
        const owner = tonToRaw(c.receive_address).toUpperCase();
        const pw = (await admin.from("ton_deposit_wallets").select("user_id,raw")).data ?? [];
        const personal = new Map(pw.map((x) => [String(x.raw).toUpperCase(), x.user_id]));
        const all = new Set([owner, ...personal.keys()]);
        scanned = all.size;
        const sinceS = cursor ? Math.floor(cursor / 1000) - 900 : Math.floor(Date.now() / 1000) - 3600;
        const headers: Record<string, string> = {};
        const key = Deno.env.get("TONCENTER_API_KEY"); if (key) headers["X-API-Key"] = key;
        const list = [...all];
        for (let i = 0; i < list.length; i += 100) {
          const q = new URLSearchParams({ direction: "in", jetton_master: c.usdt_contract, start_utime: String(sinceS), limit: "500", sort: "desc" });
          for (const a of list.slice(i, i + 100)) q.append("owner_address", a);
          const r = await fetch(`${c.rpc_url}/api/v3/jetton/transfers?${q}`, { headers });
          if (!r.ok) throw new Error(`toncenter ${r.status}`);
          found = found.concat(parseTonTransfers((await r.json()).jetton_transfers ?? [], all, c.usdt_contract, c.decimals));
          if (!key) await new Promise((res) => setTimeout(res, 1100));
        }
        found = found.filter((f) => !all.has(f.from));            // moves between club addresses (sweeps) are not deposits
        const pers = await processPersonal(c, found.filter((f) => personal.has(f.to)), personal);
        found = found.filter((f) => f.to === owner);
        summary[c.network + "_personal"] = pers;
        newCursor = Date.now();
      } else if (c.network === "GRAM") {
        if (!c.receive_address) { summary[c.network] = "no wallet address set"; continue; }
        scanned = 1;
        const owner = tonToRaw(c.receive_address).toUpperCase();
        const pw = (await admin.from("ton_deposit_wallets").select("user_id,raw")).data ?? [];
        const personal = new Map(pw.map((x) => [String(x.raw).toUpperCase(), x.user_id]));
        const all = new Set([owner, ...personal.keys()]);
        scanned = all.size;
        const sinceS = cursor ? Math.floor(cursor / 1000) - 900 : Math.floor(Date.now() / 1000) - 3600;
        const headers: Record<string, string> = {};
        const key = Deno.env.get("TONCENTER_API_KEY"); if (key) headers["X-API-Key"] = key;
        const list = [...all];
        for (let i = 0; i < list.length; i += 100) {
          if (!key) await new Promise((res) => setTimeout(res, 1100));          // toncenter free plan: 1 request per second
          const q = new URLSearchParams({ start_utime: String(sinceS), limit: "500", sort: "desc" });
          for (const a of list.slice(i, i + 100)) q.append("account", a);
          const r = await fetch(`${c.rpc_url}/api/v3/transactions?${q}`, { headers });
          if (!r.ok) throw new Error(`toncenter ${r.status}`);
          found = found.concat(parseTonNative((await r.json()).transactions ?? [], all));
        }
        found = found.filter((f) => !all.has(f.from));            // sweeps and fee top-ups between club addresses
        found = found.filter((f) => Number(f.amount) >= 0.2);   // dust (jetton notifications, bounces) is not a deposit
        const pers = await processPersonal(c, found.filter((f) => personal.has(f.to)), personal);
        found = found.filter((f) => f.to === owner);
        summary[c.network + "_personal"] = pers;
        newCursor = Date.now();
      }

      const res = await processFound(c, found, reqs);
      await admin.from("scan_state").upsert({ network: c.network, cursor: newCursor, updated_at: new Date().toISOString() });
      summary[c.network] = { scanned, ...res };
    } catch (e) {
      console.error("scan", c.network, String(e));
      summary[c.network] = "error: " + String(e);
    }
  }
  return ok(summary);
});
