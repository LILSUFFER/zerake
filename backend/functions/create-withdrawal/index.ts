// Supabase Edge Function: a player asks to cash out chips (TRC20, BEP20 or TON).
// The request is checked here, saved as "pending", and every manager is alerted in Telegram.
// A manager then confirms in ClubGG that the chips came back and pays the USDT.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const fid = (v: unknown) => { const d = String(v ?? "").replace(/\D/g, ""); return d.length > 4 ? d.replace(/(\d{4})(?=\d)/g, "$1-") : String(v ?? ""); };   // 33833619 -> 3383-3619

const ALLOWED = ["https://zerake.com", "https://www.zerake.com"];
const ADDRESS: Record<string, RegExp> = {
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  BEP20: /^0x[0-9a-fA-F]{40}$/,
  TON: /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/,
  GRAM: /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/,
};

// ---- helpers (pure functions, unit-tested) ----
/** "50", "50.5", "50,25" -> "50.500000" style string with at most 2 decimals, or null. */
function parseAmount(input: unknown): string | null {
  const s = String(input ?? "").trim().replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return `${BigInt(i)}.${f.padEnd(2, "0")}0000`;
}
/** Fee in USDT, rounded up to the cent: fixed part + percent of the cash out. */
function calcFee(chips: string, fixed: number, pct: number): string {
  const cents = Math.ceil(Math.round((fixed + Number(chips) * pct / 100) * 1e6) / 1e4);
  return (cents / 100).toFixed(2);
}
function checkAddress(network: string, address: string): boolean {
  return !!ADDRESS[network] && ADDRESS[network].test(address);
}
// ---- end helpers ----

function cors(o: string | null): Record<string, string> {
  const a = o && ALLOWED.includes(o) ? o : ALLOWED[0];
  return {
    "Access-Control-Allow-Origin": a,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}

/** GRAM price in USD from public exchange tickers (the first one that answers sensibly). */
async function gramPrice(): Promise<number> {
  const tries: Array<[string, (d: any) => unknown]> = [   // deno-lint-ignore no-explicit-any
    ["https://api.binance.com/api/v3/ticker/price?symbol=GRAMUSDT", (d) => d.price],
    ["https://www.okx.com/api/v5/market/ticker?instId=GRAM-USDT", (d) => d.data?.[0]?.last],
    ["https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd", (d) => d["the-open-network"]?.usd],
  ];
  for (const [url, pick] of tries) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const p = Number(pick(await r.json()));
      if (p > 0.05 && p < 1000) return p;
    } catch { /* next */ }
  }
  throw new Error("no GRAM price");
}

const out = (b: unknown, s: number, h: Record<string, string>) => {
  if (s >= 400) console.warn("rejected:", s, JSON.stringify(b));
  return new Response(JSON.stringify(b), { status: s, headers: h });
};

Deno.serve(async (req: Request) => {
  const h = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return out({ error: "method" }, 405, h);

  const url = Deno.env.get("SUPABASE_URL")!;
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return out({ error: "no session" }, 401, h);
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false } });
  const { data: u, error: ue } = await asUser.auth.getUser(token);
  if (ue || !u?.user) return out({ error: "no session" }, 401, h);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return out({ error: "bad json" }, 400, h); }
  const network = String(body.network ?? "");
  const address = String(body.address ?? "").trim();
  if (!ADDRESS[network]) return out({ error: "bad network" }, 400, h);
  if (!checkAddress(network, address)) return out({ error: "bad address" }, 400, h);
  const amount = parseAmount(body.amount);
  if (!amount) return out({ error: "bad amount" }, 400, h);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const cfg = (await admin.from("chain_config").select("enabled,min_withdraw,max_withdraw,explorer_tx,wd_fee_fixed,wd_fee_pct").eq("network", network).maybeSingle()).data;
  if (!cfg || !cfg.enabled) return out({ error: "network disabled" }, 503, h);
  if (Number(amount) < Number(cfg.min_withdraw)) return out({ error: "below minimum", min: cfg.min_withdraw }, 400, h);
  if (Number(amount) > Number(cfg.max_withdraw)) return out({ error: "above maximum", max: cfg.max_withdraw }, 400, h);

  const profile = (await admin.from("profiles").select("gg_id").eq("user_id", u.user.id).maybeSingle()).data;
  if (!profile?.gg_id) return out({ error: "no clubgg id" }, 400, h);

  // A player cannot pile up requests: at most 3 waiting at once.
  const pending = await admin.from("withdrawals").select("id", { count: "exact", head: true }).eq("user_id", u.user.id).eq("status", "pending");
  if ((pending.count ?? 0) >= 3) return out({ error: "too many pending" }, 429, h);

  // The player cashes out "amount" in chips; the network fee is kept and the rest is sent.
  const fee = calcFee(amount, Number(cfg.wd_fee_fixed ?? 0), Number(cfg.wd_fee_pct ?? 0));
  const net = (Math.round(Number(amount) * 100) - Math.round(Number(fee) * 100)) / 100;
  if (net < 1) return out({ error: "below fee", fee }, 400, h);
  // GRAM: paid by a manager in GRAM at the rate of this moment (shown on the card).
  let rate: number | null = null, coin: string | null = null;
  if (network === "GRAM") {
    try { rate = await gramPrice(); } catch { return out({ error: "no price, try again" }, 503, h); }
    coin = (Math.floor(net / rate * 10000) / 10000).toFixed(4);
  }
  const ins = await admin.from("withdrawals").insert({ user_id: u.user.id, network, address, chips: amount, fee, amount: net.toFixed(2), rate, coin_amount: coin }).select("id,op_id").single();
  if (ins.error) { console.error("withdrawal insert:", ins.error.message); return out({ error: "save failed" }, 500, h); }

  // Alert every manager (the queue button opens the Mini App on the managers' tab).
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (botToken) {
    const { data: staff } = await admin.from("staff").select("telegram_id");
    const text = `💸 Cash out: ${Number(amount)} in chips (${network})\nOperation: ${ins.data.op_id}\nClubGG ID: ${fid(profile.gg_id)}\nPayout: ${net} USDT${coin ? ` = ${coin} GRAM (1 GRAM = $${rate})` : ""} (fee ${Number(fee)})\nTo: ${address}\nTake it and remove ${Number(amount)} in chips from this ID in ClubGG.`;
    for (const s of staff ?? []) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: s.telegram_id, text, disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [[{ text: "Open the queue", web_app: { url: "https://zerake.com/app/?tab=admin" } }]] } }),
      }).catch(() => {});
    }
  }
  return out({ ok: true, id: ins.data.id, op_id: ins.data.op_id, fee: Number(fee), payout: net, coin_amount: coin }, 200, h);
});
