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
function parseTonTransfers(items: Array<Record<string, unknown>>, ownerRaw: string, masterRaw: string, decimals: number): Found[] {
  const owner = ownerRaw.toUpperCase(), master = masterRaw.toUpperCase();
  return items
    .filter((x) => !x.transaction_aborted && String(x.destination).toUpperCase() === owner && String(x.jetton_master).toUpperCase() === master)
    .map((x) => {
      const p = x.decoded_forward_payload as { "@type"?: string; comment?: string } | null | undefined;
      return {
        tx_hash: b64ToHex(String(x.transaction_hash)),
        from: String(x.source),
        to: owner,
        amount: toAmount(String(x.amount), decimals),
        comment: p && p["@type"] === "text_comment" ? String(p.comment ?? "").trim() : undefined,
      };
    });
}
/** Plain GRAM transfers into the club wallet (toncenter v3 transactions). */
function parseTonNative(items: Array<Record<string, any>>, ownerRaw: string): Found[] {   // deno-lint-ignore no-explicit-any
  const owner = ownerRaw.toUpperCase();
  return items
    .filter((t) => t.in_msg && t.in_msg.source && BigInt(t.in_msg.value ?? 0) > 0n && !t.description?.aborted && String(t.in_msg.destination ?? t.account).toUpperCase() === owner)
    .map((t) => {
      const d = t.in_msg.message_content?.decoded;
      return {
        tx_hash: b64ToHex(String(t.hash)),
        from: String(t.in_msg.source),
        to: owner,
        amount: toAmount(String(t.in_msg.value), 9),
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
        rows.push({
          user_id: req.user_id, network: c.network, tx_hash: f.tx_hash, from_address: f.from, to_address: f.to, request_id: req.id,
          amount: usd, coin_amount: coin, status: Number(usd) >= Number(c.min_deposit) ? "received" : "below_min",
        });
      } else {
        orphans.push({ network: c.network, tx_hash: f.tx_hash, address: f.to, from_address: f.from, amount: f.amount });
      }
    }
    let created: Array<{ op_id: string; tx_hash: string; user_id: string; amount: string; coin_amount: string | null; status: string; to_address: string; request_id: number }> = [];
    if (rows.length) {
      const ins = await admin.from("deposits").upsert(rows, { onConflict: "network,tx_hash", ignoreDuplicates: true }).select("op_id,tx_hash,user_id,amount,coin_amount,status,to_address,request_id");
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

      await alertStaff(`💰 Top up chips: ${Number(req.base_amount ?? d.amount)} USDT\nOperation: ${d.op_id}\nClubGG ID: ${p.data?.gg_id ? fid(p.data.gg_id) : "NOT SET"}\nPaid: ${d.coin_amount ? Number(d.coin_amount) + " GRAM" : d.amount + " USDT"} (${c.network}) · request ${req.request_no}${req.status === "expired" ? " · paid after the 30 minutes" : ""}\nSend the chips in ClubGG, then take it and mark it as sent.\n${c.explorer_tx}${d.tx_hash}`, true);
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
        const owner = tonToRaw(c.receive_address);
        const sinceS = cursor ? Math.floor(cursor / 1000) - 900 : Math.floor(Date.now() / 1000) - 3600;
        const q = new URLSearchParams({ owner_address: owner, direction: "in", jetton_master: c.usdt_contract, start_utime: String(sinceS), limit: "100", sort: "desc" });
        const headers: Record<string, string> = {};
        const key = Deno.env.get("TONCENTER_API_KEY"); if (key) headers["X-API-Key"] = key;
        const r = await fetch(`${c.rpc_url}/api/v3/jetton/transfers?${q}`, { headers });
        if (!r.ok) throw new Error(`toncenter ${r.status}`);
        found = parseTonTransfers((await r.json()).jetton_transfers ?? [], owner, c.usdt_contract, c.decimals);
        newCursor = Date.now();
      } else if (c.network === "GRAM") {
        if (!c.receive_address) { summary[c.network] = "no wallet address set"; continue; }
        scanned = 1;
        const owner = tonToRaw(c.receive_address);
        const sinceS = cursor ? Math.floor(cursor / 1000) - 900 : Math.floor(Date.now() / 1000) - 3600;
        const q = new URLSearchParams({ account: owner, start_utime: String(sinceS), limit: "100", sort: "desc" });
        const headers: Record<string, string> = {};
        const key = Deno.env.get("TONCENTER_API_KEY"); if (key) headers["X-API-Key"] = key;
        await new Promise((res) => setTimeout(res, 1100));          // toncenter free plan: 1 request per second
        const r = await fetch(`${c.rpc_url}/api/v3/transactions?${q}`, { headers });
        if (!r.ok) throw new Error(`toncenter ${r.status}`);
        found = parseTonNative((await r.json()).transactions ?? [], owner);
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
