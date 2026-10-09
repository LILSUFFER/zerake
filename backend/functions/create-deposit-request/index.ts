// Supabase Edge Function: creates a deposit request for the signed-in player (TRC20, BEP20 or TON).
// The player gets: a request number, an address, and an EXACT amount (their amount plus a small
// unique tail). The tail identifies the payment, so one address can serve many players.
//   TRC20 / BEP20: an address from the pool; it receives until it holds the "full" amount, then the next one.
//   TON: the club wallet; the request number can also be written in the transfer comment.
//
// Settings (Secrets): XPUB_TRON, XPUB_EVM (public keys). This service never holds a key that can move money.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HDNodeWallet } from "https://esm.sh/ethers@6.13.4";

const ALLOWED = ["https://zerake.com", "https://www.zerake.com"];
const NETWORKS = ["TRC20", "BEP20", "TON", "GRAM"];
const CHAIN_OF: Record<string, string> = { TRC20: "TRON", BEP20: "BSC", TON: "TON", GRAM: "TON" };

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// ---- helpers (pure functions, unit-tested) ----
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 26-character request number: time part + random part, like "01M4GX8D4FP0B0TX2FPKA7X30Q". */
function makeRequestNo(nowMs: number, rnd: Uint8Array): string {
  let t = "", n = BigInt(nowMs);
  for (let i = 0; i < 10; i++) { t = CROCKFORD[Number(n % 32n)] + t; n /= 32n; }
  let r = "";
  for (let i = 0; i < 16; i++) r += CROCKFORD[rnd[i] % 32];
  return t + r;
}
/** Unique tail between 0.000101 and 0.099999 USDT (never more than ten cents on top). */
function makeTail(rnd: number): string {
  const n = 101 + (rnd % 99899);
  return (n / 1_000_000).toFixed(6);
}
/** base + tail as an exact 6-place decimal string (no floating-point drift). */
function addTail(base: string, tail: string): string {
  const [bi, bf = ""] = base.split(".");
  const cents = BigInt(bi) * 1_000_000n + BigInt(bf.padEnd(6, "0").slice(0, 6));
  const t = BigInt(tail.replace(".", "").replace(/^0+(?=\d)/, ""));
  const v = cents + t;
  return `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`;
}
/** Player input like "50", "50.5", "50,25" -> normalised string with at most 2 decimals, or null. */
function parseBase(input: unknown): string | null {
  const s = String(input ?? "").trim().replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return `${BigInt(i)}.${f.padEnd(2, "0")}0000`;
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
const out = (b: unknown, s: number, h: Record<string, string>) => new Response(JSON.stringify(b), { status: s, headers: h });

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
async function sha256(b: Uint8Array): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest("SHA-256", b)); }
async function deriveAddress(network: string, xpub: string, index: number): Promise<string> {
  // deno-lint-ignore no-explicit-any
  const node: any = HDNodeWallet.fromExtendedKey(xpub).deriveChild(0).deriveChild(index);
  if (network === "BEP20") return node.address;               // checksummed 0x address
  const body = new Uint8Array(21);                              // TRON: 0x41 + the same 20 bytes, base58check
  body[0] = 0x41;
  for (let i = 0; i < 20; i++) body[i + 1] = parseInt(node.address.slice(2 + i * 2, 4 + i * 2), 16);
  const check = (await sha256(await sha256(body))).subarray(0, 4);
  const full = new Uint8Array(25); full.set(body); full.set(check, 21);
  return base58(full);
}


// ---- GasFree (TRON transfers without TRX; the fee is paid in USDT) ----
const GASFREE_API = "https://open.gasfree.io";
const GASFREE_PREFIX = "/tron";
async function gasfree(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {   // deno-lint-ignore no-explicit-any
  const key = Deno.env.get("GASFREE_API_KEY"), secret = Deno.env.get("GASFREE_API_SECRET");
  if (!key || !secret) throw new Error("GasFree keys are not set");
  const ts = Math.floor(Date.now() / 1000);
  const full = GASFREE_PREFIX + path;
  const mac = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", mac, new TextEncoder().encode(method + full + ts)))));
  const r = await fetch(GASFREE_API + full, {
    method, headers: { "Content-Type": "application/json", Timestamp: String(ts), Authorization: `ApiKey ${key}:${sig}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (d.code !== 200) throw new Error(`gasfree ${path}: ${d.reason ?? r.status} ${d.message ?? ""}`.trim());
  return d.data;
}
const gasfreeOn = () => !!(Deno.env.get("GASFREE_API_KEY") && Deno.env.get("GASFREE_API_SECRET"));


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

const COLS = "request_no,address,amount,base_amount,expires_at,status,network,rate";

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
  const network = String(body.network ?? "TRC20");
  if (!NETWORKS.includes(network)) return out({ error: "bad network" }, 400, h);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const cfg = (await admin.from("chain_config").select("enabled,min_deposit,max_deposit,request_ttl_min,receive_address").eq("network", network).maybeSingle()).data;
  if (!cfg) return out({ error: "not configured" }, 500, h);

  // The player's own newest live request on this network is returned instead of making a new one every time.
  const live = await admin.from("deposit_requests").select(COLS)
    .eq("user_id", u.user.id).eq("network", network).eq("status", "open").gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (body.check === true) return out({ request: live.data ?? null }, 200, h);          // read-only: "do I have one?"
  if (body.cancel === true) {                       // the player cancels the open request (a late payment is still found)
    if (live.data) await admin.from("deposit_requests").update({ status: "expired", expires_at: new Date().toISOString() }).eq("request_no", live.data.request_no).eq("status", "open");
    return out({ ok: true }, 200, h);
  }
  if (!cfg.enabled) return out({ error: "network disabled" }, 503, h);
  // The player must bind their own wallet for this chain before the first deposit (cash outs go only there).
  const bound = (await admin.from("player_wallets").select("address").eq("user_id", u.user.id).eq("chain", CHAIN_OF[network]).maybeSingle()).data;
  if (!bound) return out({ error: "bind wallet" }, 400, h);
  if (live.data && body.fresh !== true) return out({ request: live.data, existing: true }, 200, h);
  if (live.data) await admin.from("deposit_requests").update({ status: "expired", expires_at: new Date().toISOString() }).eq("request_no", live.data.request_no);

  const base = parseBase(body.amount);
  if (!base) return out({ error: "bad amount" }, 400, h);
  if (Number(base) < Number(cfg.min_deposit)) return out({ error: "below minimum", min: cfg.min_deposit }, 400, h);
  if (Number(base) > Number(cfg.max_deposit)) return out({ error: "above maximum", max: cfg.max_deposit }, 400, h);

  // Where should the player pay?
  let address: string | undefined;
  if (network === "TON" || network === "GRAM") {
    address = cfg.receive_address ?? undefined;
    if (!address) return out({ error: "not configured" }, 500, h);
  } else {
    // TRC20 with GasFree: players pay to the GasFree address of a pool key, so payouts need no TRX.
    const kind = network === "TRC20" && gasfreeOn() ? "gasfree" : "eoa";
    const pick = () => admin.from("address_pool").select("address").eq("network", network).eq("status", "receiving").eq("kind", kind).order("derivation_index").limit(1).maybeSingle();
    address = (await pick()).data?.address;
    if (!address) {
      const rawKey = Deno.env.get(network === "TRC20" ? "XPUB_TRON" : "XPUB_EVM") ?? "";
      const xpub = rawKey.match(/xpub[1-9A-HJ-NP-Za-km-z]{100,}/)?.[0];
      if (!xpub) return out({ error: "not configured" }, 500, h);
      const idx = await admin.rpc("next_pool_index");
      if (idx.error || idx.data == null) { console.error("pool index:", idx.error?.message); return out({ error: "pool failed" }, 500, h); }
      let fresh: string;
      try { fresh = await deriveAddress(network, xpub, Number(idx.data)); } catch (e) { console.error("derive:", String(e)); return out({ error: "derive failed" }, 500, h); }
      let row: Record<string, unknown> = { network, derivation_index: Number(idx.data), address: fresh, eoa_address: fresh, kind };
      if (kind === "gasfree") {
        try { row = { ...row, address: (await gasfree("GET", `/api/v1/address/${fresh}`)).gasFreeAddress }; }
        catch (e) { console.error("gasfree address:", String(e)); return out({ error: "pool failed" }, 500, h); }
        if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(row.address))) return out({ error: "pool failed" }, 500, h);
      }
      const ins = await admin.from("address_pool").insert(row);
      if (ins.error) console.error("pool insert:", ins.error.message);
      address = (await pick()).data?.address;
      if (!address) return out({ error: "pool failed" }, 500, h);
    }
  }

  // GRAM: the player asked for chips in USD; lock the rate and ask for that much GRAM (rounded up to 0.0001).
  let payBase = base, rate: number | null = null;
  if (network === "GRAM") {
    try { rate = await gramPrice(); } catch { return out({ error: "no price, try again" }, 503, h); }
    payBase = (Math.ceil(Number(base) / rate * 10000) / 10000).toFixed(6);
  }
  // Add the unique tail; if that exact amount is taken on this address, try another tail.
  const expires = new Date(Date.now() + Number(cfg.request_ttl_min) * 60_000).toISOString();
  for (let attempt = 0; attempt < 25; attempt++) {
    const rnd = crypto.getRandomValues(new Uint32Array(1))[0];
    const amount = addTail(payBase, makeTail(rnd));
    const requestNo = makeRequestNo(Date.now(), crypto.getRandomValues(new Uint8Array(16)));
    const ins = await admin.from("deposit_requests").insert({
      request_no: requestNo, user_id: u.user.id, network, address,
      base_amount: base, amount, expires_at: expires, rate,
    }).select(COLS).single();
    if (!ins.error) return out({ request: ins.data }, 200, h);
    if (ins.error.code !== "23505") { console.error("request insert:", ins.error.message); return out({ error: "save failed" }, 500, h); }
  }
  return out({ error: "busy, try again" }, 503, h);
});
