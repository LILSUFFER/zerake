// Supabase Edge Function: finds incoming USDT payments and records them once.
// TRC20: a payment is matched to a deposit request by pool address + exact amount (unique tail).
// BEP20: personal addresses (switched off in chain_config for now).
// It only READS the blockchain and WRITES to the database: it holds no key that can move money.
//
// Optional settings (Secrets): TRONGRID_API_KEY (raises the TronGrid rate limit),
// TELEGRAM_BOT_TOKEN (already set; used for staff alerts).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
interface Found { tx_hash: string; to: string; from: string; amount: string; }
interface Req { id: number; user_id: string; address: string; amount: string; status: string; request_no: string; }

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
/** The request this payment belongs to: same address and exact amount. A still-open one wins over an expired one. */
function matchRequest(f: Found, reqs: Req[]): Req | undefined {
  const same = reqs.filter((r) => r.address === f.to && normAmount(r.amount) === normAmount(f.amount));
  return same.find((r) => r.status === "open") ?? same.find((r) => r.status === "expired");
}
// ---- end helpers ----

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

  async function alertStaff(text: string) {
    if (!botToken) return;
    const { data: staff } = await admin.from("staff").select("telegram_id");
    for (const s of staff ?? []) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: s.telegram_id, text, disable_web_page_preview: true }),
      }).catch(() => {});
    }
  }

  const { data: chains } = await admin.from("chain_config").select("*").eq("enabled", true);
  for (const c of chains ?? []) {
    try {
      let found: Found[] = [];
      let newCursor = 0;
      let reqs: Req[] = [];

      const st = await admin.from("scan_state").select("cursor").eq("network", c.network).maybeSingle();
      let cursor = Number(st.data?.cursor ?? 0);

      if (c.network === "TRC20") {
        // Housekeeping: open -> expired after the window, expired -> closed after 24 h.
        const now = new Date();
        await admin.from("deposit_requests").update({ status: "expired" }).eq("network", "TRC20").eq("status", "open").lt("expires_at", now.toISOString());
        await admin.from("deposit_requests").update({ status: "closed" }).eq("network", "TRC20").eq("status", "expired").lt("expires_at", new Date(now.getTime() - 24 * 3600 * 1000).toISOString());

        const rq = await admin.from("deposit_requests").select("id,user_id,address,amount,status,request_no").eq("network", "TRC20").in("status", ["open", "expired"]);
        reqs = (rq.data ?? []) as Req[];
        const recv = await admin.from("trc_pool").select("address").eq("status", "receiving");
        const addrs = new Set<string>([...reqs.map((r) => r.address), ...(recv.data ?? []).map((r) => r.address)]);
        if (addrs.size === 0) { summary[c.network] = "no addresses"; continue; }

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

        const rows: Record<string, unknown>[] = [];
        const orphans: Record<string, unknown>[] = [];
        const reqByTx = new Map<string, Req>();
        for (const f of found) {
          const req = matchRequest(f, reqs);
          if (req) {
            reqByTx.set(f.tx_hash, req);
            rows.push({
              user_id: req.user_id, network: "TRC20", tx_hash: f.tx_hash, from_address: f.from, to_address: f.to, request_id: req.id,
              amount: f.amount, status: Number(f.amount) >= Number(c.min_deposit) ? "received" : "below_min",
            });
          } else {
            orphans.push({ network: "TRC20", tx_hash: f.tx_hash, address: f.to, from_address: f.from, amount: f.amount });
          }
        }

        let created: Array<{ tx_hash: string; user_id: string; amount: string; status: string; to_address: string; request_id: number }> = [];
        if (rows.length) {
          const ins = await admin.from("deposits").upsert(rows, { onConflict: "network,tx_hash", ignoreDuplicates: true }).select("tx_hash,user_id,amount,status,to_address,request_id");
          if (ins.error) throw new Error("save: " + ins.error.message);
          created = ins.data ?? [];
        }
        for (const d of created) {
          await admin.from("deposit_requests").update({ status: "paid", tx_hash: d.tx_hash }).eq("id", d.request_id);
          await admin.rpc("pool_credit", { p_address: d.to_address, p_amount: d.amount });
        }
        for (const d of created.filter((x) => x.status === "received")) {
          const req = reqByTx.get(d.tx_hash)!;
          const p = await admin.from("profiles").select("gg_id").eq("user_id", d.user_id).maybeSingle();
          await alertStaff(`💰 Deposit ${d.amount} USDT (TRC20)\nClubGG ID: ${p.data?.gg_id ?? "NOT SET"}\nRequest ${req.request_no}${req.status === "expired" ? " (paid after the 30 minutes)" : ""}\nSend the chips, then mark it in the Mini App.\n${c.explorer_tx}${d.tx_hash}`);
        }
        let orphanNew = 0;
        if (orphans.length) {
          const oi = await admin.from("unmatched_deposits").upsert(orphans, { onConflict: "network,tx_hash", ignoreDuplicates: true }).select("tx_hash,address,amount,from_address");
          for (const o of oi.data ?? []) {
            orphanNew++;
            await alertStaff(`⚠️ Unidentified payment ${o.amount} USDT (TRC20)\nTo: ${o.address}\nFrom: ${o.from_address}\nNo matching request. Check it by hand.\n${c.explorer_tx}${o.tx_hash}`);
          }
        }
        await admin.from("scan_state").upsert({ network: c.network, cursor: newCursor, updated_at: new Date().toISOString() });
        summary[c.network] = { scanned: addrs.size, found: found.length, credited: created.length, unmatched: orphanNew };
      } else {
        // BEP20: personal addresses.
        const { data: addrRows } = await admin.from("deposit_addresses").select("user_id,address").eq("network", c.network);
        const byAddr = new Map<string, string>((addrRows ?? []).map((r) => [r.address.toLowerCase(), r.user_id]));
        if (byAddr.size === 0) { summary[c.network] = "no addresses"; continue; }
        const latest = parseInt(await rpc(c.rpc_url, "eth_blockNumber", []), 16);
        const safe = latest - c.confirmations;
        if (!cursor) cursor = Math.max(0, safe - 200);
        const from = cursor + 1, to = Math.min(safe, from + 999);
        newCursor = cursor;
        if (to >= from) {
          const list = [...byAddr.keys()];
          for (let i = 0; i < list.length; i += 50) {
            const logs = await rpc(c.rpc_url, "eth_getLogs", [{
              fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: c.usdt_contract,
              topics: [TRANSFER_TOPIC, null, list.slice(i, i + 50).map(padTopic)],
            }]);
            found = found.concat(parseEvmLogs(logs, c.decimals));
          }
          newCursor = to;
        }
        const rows = found.map((f) => ({
          user_id: byAddr.get(f.to.toLowerCase())!, network: c.network, tx_hash: f.tx_hash, from_address: f.from, to_address: f.to, amount: f.amount,
          status: Number(f.amount) >= Number(c.min_deposit) ? "received" : "below_min",
        })).filter((r) => r.user_id);
        let created: Array<{ tx_hash: string; user_id: string; amount: string; status: string }> = [];
        if (rows.length) {
          const ins = await admin.from("deposits").upsert(rows, { onConflict: "network,tx_hash", ignoreDuplicates: true }).select("tx_hash,user_id,amount,status");
          if (ins.error) throw new Error("save: " + ins.error.message);
          created = ins.data ?? [];
        }
        for (const d of created.filter((x) => x.status === "received")) {
          const p = await admin.from("profiles").select("gg_id").eq("user_id", d.user_id).maybeSingle();
          await alertStaff(`💰 Deposit ${d.amount} USDT (${c.network})\nClubGG ID: ${p.data?.gg_id ?? "NOT SET"}\nSend the chips, then mark it in the Mini App.\n${c.explorer_tx}${d.tx_hash}`);
        }
        await admin.from("scan_state").upsert({ network: c.network, cursor: newCursor, updated_at: new Date().toISOString() });
        summary[c.network] = { scanned: byAddr.size, found: found.length, new: created.length };
      }
    } catch (e) {
      console.error("scan", c.network, String(e));
      summary[c.network] = "error: " + String(e);
    }
  }
  return ok(summary);
});
