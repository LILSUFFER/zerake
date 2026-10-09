// Supabase Edge Function: pays a cash out automatically (TRC20, BEP20) once a manager has confirmed
// that the chips were taken from the player in ClubGG. Called only by admin-action (service key).
//
// Scheme (no sweeping, no separate payout wallet):
//   * USDT is sent straight from the pool addresses that received deposits. The smallest address that
//     covers the whole amount is used; if none does, several addresses pay parts (largest first).
//   * The club pays the network fee: a "gas" address (index 0 of the same seed) tops up TRX / BNB on the
//     paying address right before the transfer.
//   * Safety: one payout and a daily total are capped (chain_config.auto_max / auto_daily); above that the
//     request stays for a manager to pay by hand. If something fails after money was sent, the request is
//     left as "sending" for a human to check, so the same cash out can never be paid twice.
//
// Secrets: WALLET_MNEMONIC (the seed of the deposit addresses), optional TRONGRID_API_KEY.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HDNodeWallet, Mnemonic, JsonRpcProvider, Wallet, Contract, SigningKey, parseUnits, formatUnits } from "https://esm.sh/ethers@6.13.4";

const TRON_API = "https://api.trongrid.io";
const GAS_INDEX = 0;
const TRX_KEEP = 30_000_000n;          // sun a paying TRON address must hold (≈30 TRX burns energy for one transfer)
const TRX_FEE_LIMIT = 60_000_000;      // never burn more than 60 TRX on one transfer
const BNB_KEEP = parseUnits("0.0003", 18);
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// ---- helpers (pure functions, unit-tested) ----
async function sha256(b: Uint8Array): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest("SHA-256", b)); }
function b58encode(bytes: Uint8Array): string {
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = ""; while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = "1" + s; else break; }
  return s;
}
function b58decode(s: string): Uint8Array {
  let n = 0n; for (const c of s) { const i = ALPHABET.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const out: number[] = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === "1") out.unshift(0); else break; }
  return new Uint8Array(out);
}
async function tronFromEvm(evm: string): Promise<string> {
  const body = new Uint8Array(21); body[0] = 0x41;
  for (let i = 0; i < 20; i++) body[i + 1] = parseInt(evm.slice(2 + i * 2, 4 + i * 2), 16);
  const check = (await sha256(await sha256(body))).subarray(0, 4);
  const full = new Uint8Array(25); full.set(body); full.set(check, 21);
  return b58encode(full);
}
/** ABI parameters of transfer(address,uint256) for a TRON recipient. */
function trc20Param(to: string, units: bigint): string {
  const raw = b58decode(to);                                   // 0x41 + 20 bytes + 4 check bytes
  if (raw.length !== 25 || raw[0] !== 0x41) throw new Error("bad tron address");
  const hex = Array.from(raw.subarray(1, 21), (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.padStart(64, "0") + units.toString(16).padStart(64, "0");
}
/** TRON signature: r + s + v (v = 27/28 as one byte), over the txID hash. */
function tronSign(txID: string, privateKey: string): string {
  const sig = new SigningKey(privateKey).sign("0x" + txID);
  return sig.r.slice(2) + sig.s.slice(2) + sig.v.toString(16).padStart(2, "0");
}
/** Choose paying addresses: the smallest one that covers everything, else largest first. */
function planSources(bal: { address: string; index: number; units: bigint }[], need: bigint): { address: string; index: number; units: bigint }[] | null {
  const have = bal.filter((b) => b.units > 0n);
  const single = have.filter((b) => b.units >= need).sort((a, b) => (a.units < b.units ? -1 : a.units > b.units ? 1 : 0))[0];
  if (single) return [{ ...single, units: need }];
  const parts: { address: string; index: number; units: bigint }[] = [];
  let left = need;
  for (const b of have.sort((a, b) => (a.units > b.units ? -1 : a.units < b.units ? 1 : 0))) {
    const take = b.units < left ? b.units : left;
    parts.push({ ...b, units: take }); left -= take;
    if (left === 0n) return parts;
  }
  return null;
}
// ---- end helpers ----

const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tronHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const k = Deno.env.get("TRONGRID_API_KEY"); if (k) h["TRON-PRO-API-KEY"] = k;
  return h;
}
async function tron(path: string, body?: unknown) {
  const r = await fetch(TRON_API + path, body === undefined ? { headers: tronHeaders() } : { method: "POST", headers: tronHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`trongrid ${r.status}`);
  return await r.json();
}
async function tronAccount(addr: string, usdt: string): Promise<{ trx: bigint; usdt: bigint }> {
  const d = await tron(`/v1/accounts/${addr}`);
  const a = d.data?.[0];
  if (!a) return { trx: 0n, usdt: 0n };
  const t = (a.trc20 ?? []).find((x: Record<string, string>) => usdt in x);
  return { trx: BigInt(a.balance ?? 0), usdt: BigInt(t ? t[usdt] : 0) };
}
async function tronBroadcast(tx: Record<string, unknown>, key: string): Promise<string> {
  if (!tx?.txID) throw new Error("could not build transfer: " + JSON.stringify(tx).slice(0, 200));
  tx.signature = [tronSign(String(tx.txID), key)];
  const r = await tron("/wallet/broadcasttransaction", tx);
  if (!r.result) {
    let msg = String(r.message ?? r.code ?? "rejected");
    try { msg = new TextDecoder().decode(Uint8Array.from(msg.match(/../g)!.map((x) => parseInt(x, 16)))); } catch { /* not hex */ }
    throw new Error("broadcast rejected: " + msg);
  }
  return String(tx.txID);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return out({ error: "method" }, 405);
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if ((req.headers.get("authorization") ?? "") !== "Bearer " + serviceKey) return out({ error: "forbidden" }, 403);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, { auth: { persistSession: false } });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return out({ error: "bad json" }, 400); }

  const phrase = (Deno.env.get("WALLET_MNEMONIC") ?? "").trim().replace(/\s+/g, " ");
  let mn: Mnemonic | null = null;
  try { if (phrase) mn = Mnemonic.fromPhrase(phrase); } catch { mn = null; }
  const node = (coin: number, i: number) => HDNodeWallet.fromMnemonic(mn!, `m/44'/${coin}'/0'/0/${i}`);
  const cfgs = (await admin.from("chain_config").select("network,rpc_url,usdt_contract,decimals,auto_max,auto_daily")).data ?? [];
  const cfgOf = (n: string) => cfgs.find((c) => c.network === n)!;

  // ---- wallet overview for the owner (gas addresses, balances) ----
  if (body.info === true) {
    if (!mn) return out({ ready: false });
    const res: Record<string, unknown> = { ready: true };
    try {
      const t = cfgOf("TRC20"); const ga = await tronFromEvm(node(195, GAS_INDEX).address);
      const g = await tronAccount(ga, t.usdt_contract);
      const pool = (await admin.from("address_pool").select("address").eq("network", "TRC20")).data ?? [];
      let total = 0n; for (const p of pool) { total += (await tronAccount(p.address, t.usdt_contract)).usdt; await sleep(120); }
      res.TRC20 = { gas_address: ga, gas_balance: formatUnits(g.trx, 6) + " TRX", pool_usdt: formatUnits(total, t.decimals) };
    } catch (e) { res.TRC20 = { error: String(e) }; }
    try {
      const b = cfgOf("BEP20"); const p = new JsonRpcProvider(b.rpc_url, 56, { staticNetwork: true });
      const ga = node(60, GAS_INDEX).address; const c = new Contract(b.usdt_contract, ERC20, p);
      const pool = (await admin.from("address_pool").select("address").eq("network", "BEP20")).data ?? [];
      let total = 0n; for (const x of pool) total += await c.balanceOf(x.address);
      res.BEP20 = { gas_address: ga, gas_balance: formatUnits(await p.getBalance(ga), 18) + " BNB", pool_usdt: formatUnits(total, b.decimals) };
    } catch (e) { res.BEP20 = { error: String(e) }; }
    return out(res);
  }

  // ---- pay one cash out ----
  const id = Number(body.id);
  if (!Number.isInteger(id)) return out({ error: "bad id" }, 400);
  const w = (await admin.from("withdrawals").select("id,user_id,amount,network,address,status").eq("id", id).maybeSingle()).data;
  if (!w || w.status !== "approved") return out({ ok: false, reason: "not ready" });
  const back = async (reason: string) => {           // nothing was sent: hand it back to the managers
    await admin.from("withdrawals").update({ status: "approved", note: reason }).eq("id", id).eq("status", "sending");
    return out({ ok: false, reason });
  };
  if (!mn) return out({ ok: false, reason: "auto payout is off (no wallet key)" });
  if (w.network === "TON") return out({ ok: false, reason: "TON is paid by hand" });
  const cfg = cfgOf(w.network);
  if (Number(w.amount) > Number(cfg.auto_max)) return out({ ok: false, reason: `over the auto limit (${Number(cfg.auto_max)} USDT), pay by hand` });
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const day = (await admin.from("withdrawals").select("amount").eq("auto", true).eq("status", "paid").gte("handled_at", since)).data ?? [];
  if (day.reduce((s, x) => s + Number(x.amount), 0) + Number(w.amount) > Number(cfg.auto_daily)) return out({ ok: false, reason: `daily auto limit (${Number(cfg.auto_daily)} USDT) reached, pay by hand` });

  // lock: only one run may ever pay this request
  const lock = await admin.from("withdrawals").update({ status: "sending", note: null }).eq("id", id).eq("status", "approved").select("id");
  if ((lock.data?.length ?? 0) !== 1) return out({ ok: false, reason: "already being paid" });

  const need = parseUnits(String(w.amount), cfg.decimals);
  if (w.network === "TRC20") {                     // the recipient's checksum must be right before any money moves
    const raw = b58decode(w.address);
    const chk = (await sha256(await sha256(raw.subarray(0, 21)))).subarray(0, 4);
    if (raw.length !== 25 || chk.some((b, i) => b !== raw[21 + i])) return await back("the player's address is not valid (checksum)");
  }
  const pool = (await admin.from("address_pool").select("address,derivation_index").eq("network", w.network)).data ?? [];
  const hashes: string[] = [];
  try {
    if (w.network === "TRC20") {
      const bal = [];
      for (const p of pool) { bal.push({ address: p.address, index: Number(p.derivation_index), units: (await tronAccount(p.address, cfg.usdt_contract)).usdt }); await sleep(120); }
      const plan = planSources(bal, need);
      if (!plan) return await back("not enough USDT on the deposit addresses");
      const gas = node(195, GAS_INDEX); const gasAddr = await tronFromEvm(gas.address);
      for (const part of plan) {
        const src = node(195, part.index);
        if ((await tronFromEvm(src.address)) !== part.address) throw new Error("wallet key does not match the deposit addresses");
        const acc = await tronAccount(part.address, cfg.usdt_contract);
        if (acc.trx < TRX_KEEP) {                    // top up the fee from the gas address
          const topup = await tron("/wallet/createtransaction", { owner_address: gasAddr, to_address: part.address, amount: Number(TRX_KEEP - acc.trx + 1_000_000n), visible: true });
          await tronBroadcast(topup, gas.privateKey);
          let ok = false;
          for (let i = 0; i < 15 && !ok; i++) { await sleep(3000); ok = (await tronAccount(part.address, cfg.usdt_contract)).trx >= TRX_KEEP; }
          if (!ok) throw new Error("fee top-up did not arrive");
        }
        const tx = await tron("/wallet/triggersmartcontract", {
          owner_address: part.address, contract_address: cfg.usdt_contract,
          function_selector: "transfer(address,uint256)", parameter: trc20Param(w.address, part.units), fee_limit: TRX_FEE_LIMIT, call_value: 0, visible: true,
        });
        hashes.push(await tronBroadcast(tx.transaction, src.privateKey));
      }
    } else {
      const provider = new JsonRpcProvider(cfg.rpc_url, 56, { staticNetwork: true });
      const reader = new Contract(cfg.usdt_contract, ERC20, provider);
      const bal = [];
      for (const p of pool) bal.push({ address: p.address, index: Number(p.derivation_index), units: await reader.balanceOf(p.address) as bigint });
      const plan = planSources(bal, need);
      if (!plan) return await back("not enough USDT on the deposit addresses");
      const gas = new Wallet(node(60, GAS_INDEX).privateKey, provider);
      for (const part of plan) {
        const src = new Wallet(node(60, part.index).privateKey, provider);
        if (src.address.toLowerCase() !== part.address.toLowerCase()) throw new Error("wallet key does not match the deposit addresses");
        const have = await provider.getBalance(src.address);
        if (have < BNB_KEEP) {
          const t = await gas.sendTransaction({ to: src.address, value: BNB_KEEP - have + parseUnits("0.0001", 18) });
          await t.wait(1);
        }
        // deno-lint-ignore no-explicit-any
        const t = await (new Contract(cfg.usdt_contract, ERC20, src) as any).transfer(w.address, part.units);
        hashes.push(t.hash);
        await t.wait(1);
      }
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 250);
    console.error("payout", id, msg);
    if (!hashes.length) return await back("auto payout failed: " + msg);
    // part of the money may be on its way: a human must check before anything else happens
    await admin.from("withdrawals").update({ note: `CHECK BY HAND. Sent: ${hashes.join(", ")}. Error: ${msg}`, tx_hash: hashes.join(",") }).eq("id", id);
    await alertStaff(admin, `⚠️ Auto payout #${id} stopped halfway. Sent: ${hashes.join(", ")}\nError: ${msg}\nCheck it by hand.`);
    return out({ ok: false, reason: "stopped halfway, check by hand", hashes });
  }

  await admin.from("withdrawals").update({ status: "paid", auto: true, tx_hash: hashes.join(","), handled_at: new Date().toISOString() }).eq("id", id);
  const short = w.address.slice(0, 6) + "…" + w.address.slice(-6);
  await tell(admin, w.user_id, `✅ Cash out sent: ${Number(w.amount)} USDT (${w.network}) to ${short}\nTransfer: ${hashes.join(", ")}\n\n✅ Вывод отправлен: ${Number(w.amount)} USDT (${w.network}) на ${short}\nПеревод: ${hashes.join(", ")}`);
  return out({ ok: true, hashes });
});

async function tell(admin: ReturnType<typeof createClient>, userId: string, text: string) {
  const bot = Deno.env.get("TELEGRAM_BOT_TOKEN"); if (!bot) return;
  const tid = (await admin.auth.admin.getUserById(userId)).data?.user?.user_metadata?.telegram_id;
  if (!tid) return;
  await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(tid), text, disable_web_page_preview: true }) }).catch(() => {});
}
async function alertStaff(admin: ReturnType<typeof createClient>, text: string) {
  const bot = Deno.env.get("TELEGRAM_BOT_TOKEN"); if (!bot) return;
  const { data } = await admin.from("staff").select("telegram_id");
  for (const s of data ?? []) await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: s.telegram_id, text, disable_web_page_preview: true }) }).catch(() => {});
}
