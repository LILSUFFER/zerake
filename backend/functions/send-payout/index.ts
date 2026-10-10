// Supabase Edge Function: pays a cash out automatically (TRC20, BEP20) once a manager has confirmed
// that the chips were taken from the player in ClubGG. Called only by admin-action (service key).
//
// Scheme (no sweeping, no separate payout wallet):
//   * USDT is sent straight from the pool addresses that received deposits. The smallest address that
//     covers the whole amount is used; if none does, several addresses pay parts (largest first).
//   * The club pays the network fee: a "gas" address (index 0 of the same seed) tops up TRX / BNB on the
//     paying address right before the transfer.
//   * TON network (USDT-TON and GRAM): paid from the club TON wallet (secret TON_MNEMONIC, 24 words);
//     its address must equal chain_config.receive_address. The fee is paid in GRAM from that wallet.
//   * Safety: one payout and a daily total are capped (chain_config.auto_max / auto_daily); above that the
//     request stays for a manager to pay by hand. If something fails after money was sent, the request is
//     left as "sending" for a human to check, so the same cash out can never be paid twice.
//
// Secrets: WALLET_MNEMONIC (the seed of the deposit addresses), optional TRONGRID_API_KEY.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HDNodeWallet, Mnemonic, JsonRpcProvider, Wallet, Contract, SigningKey, TypedDataEncoder, parseUnits, formatUnits } from "https://esm.sh/ethers@6.13.4";
import { TonClient, WalletContractV4, WalletContractV5R1, internal, Address, beginCell, toNano, SendMode } from "https://esm.sh/@ton/ton@15.1.0";
import { mnemonicToPrivateKey } from "https://esm.sh/@ton/crypto@3.3.0";


// ---- player messages (Telegram HTML) ----
const EXPLORER_NAME: Record<string, string> = { TRC20: "Tronscan", BEP20: "BscScan", TON: "Tonviewer", GRAM: "Tonviewer" };
const EXPLORER_URL: Record<string, string> = { TRC20: "https://tronscan.org/#/transaction/", BEP20: "https://bscscan.com/tx/", TON: "https://tonviewer.com/transaction/", GRAM: "https://tonviewer.com/transaction/" };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as Record<string, string>)[c]);
const fmtId = (v: unknown) => { const d = String(v ?? "").replace(/\D/g, ""); return d.length > 4 ? d.replace(/(\d{4})(?=\d)/g, "$1-") : String(v ?? ""); };
const num = (v: unknown) => String(Number(v));
function txLinks(net: string, hashes: string[]): string {
  return hashes.filter(Boolean).map((h, i) => `🔗 <a href="${EXPLORER_URL[net] ?? ""}${esc(h.trim())}">Открыть перевод в ${EXPLORER_NAME[net] ?? "обозревателе"}${hashes.length > 1 ? ` (${i + 1})` : ""}</a>`).join("\n");
}
function payAmount(w: Record<string, unknown>): string {
  return w.coin_amount ? `${num(w.coin_amount)} GRAM` : `${num(w.amount)} USDT`;
}
function msgCashoutDone(w: Record<string, unknown>, hashes: string[]): string {
  const fee = Number(w.fee ?? 0);
  return [
    `✅ <b>Вывод выполнен</b> · <i>Cash out completed</i>`, ``,
    `🧾 Операция: <code>${esc(w.op_id)}</code>`,
    `💵 Отправлено: <b>${payAmount(w)}</b> · ${esc(w.network)}`,
    `🎰 Фишки: ${num(w.chips ?? w.amount)}${fee ? ` · комиссия ${fee} USDT` : ""}`,
    `👛 Кошелёк: <code>${esc(w.address)}</code>`,
    hashes.length ? txLinks(String(w.network), hashes) : ``,
    ``, `Средства уже в пути. Спасибо, что играете в Zerake!`,
  ].filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n");
}
function msgCashoutApproved(w: Record<string, unknown>, gg: unknown): string {
  return [
    `🟡 <b>Вывод одобрен</b> · <i>Cash out approved</i>`, ``,
    `🧾 Операция: <code>${esc(w.op_id)}</code>`,
    `🎰 С ID <b>${fmtId(gg)}</b> списано фишек: ${num(w.chips ?? w.amount)}`,
    `💵 К выплате: <b>${payAmount(w)}</b> · ${esc(w.network)}`,
    ``, `Отправляем перевод. Как только он уйдёт, пришлём ссылку.`,
  ].join("\n");
}
function msgCashoutRejected(w: Record<string, unknown>, note: string): string {
  return [
    `❌ <b>Вывод отклонён</b> · <i>Cash out rejected</i>`, ``,
    `🧾 Операция: <code>${esc(w.op_id)}</code>`,
    `💵 Сумма: ${num(w.chips ?? w.amount)}`,
    note ? `📝 Причина: ${esc(note)}` : ``,
    ``, `Фишки с вашего ID не списаны. Если есть вопросы, напишите в поддержку.`,
  ].filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n");
}

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
/** TRON base58 address -> 0x + 20 bytes (how TIP-712 encodes an address). */
function tronToHex(addr: string): string {
  const raw = b58decode(addr);
  if (raw.length !== 25 || raw[0] !== 0x41) throw new Error("bad tron address");
  return "0x" + Array.from(raw.subarray(1, 21), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** GasFree transfer authorisation (TIP-712, mainnet), signed by the pool key; returns hex without 0x. */
function gasfreeSign(m: { token: string; serviceProvider: string; user: string; receiver: string; value: bigint; maxFee: bigint; deadline: number; nonce: number }, privateKey: string): string {
  const domain = { name: "GasFreeController", version: "V1.0.0", chainId: 728126428, verifyingContract: tronToHex("TFFAMQLZybALaLb4uxHA9RBE7pxhUAjF3U") };
  const types = { PermitTransfer: [
    { name: "token", type: "address" }, { name: "serviceProvider", type: "address" }, { name: "user", type: "address" },
    { name: "receiver", type: "address" }, { name: "value", type: "uint256" }, { name: "maxFee", type: "uint256" },
    { name: "deadline", type: "uint256" }, { name: "version", type: "uint256" }, { name: "nonce", type: "uint256" },
  ] };
  const digest = TypedDataEncoder.hash(domain, types, {
    token: tronToHex(m.token), serviceProvider: tronToHex(m.serviceProvider), user: tronToHex(m.user), receiver: tronToHex(m.receiver),
    value: m.value, maxFee: m.maxFee, deadline: m.deadline, version: 1, nonce: m.nonce,
  });
  const sig = new SigningKey(privateKey).sign(digest);
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


// ---- GasFree API (TRON transfers without TRX; the fee is paid in USDT) ----
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

async function usdtBalanceOf(addr: string, usdt: string): Promise<bigint> {
  const r = await tron("/wallet/triggerconstantcontract", { owner_address: addr, contract_address: usdt, function_selector: "balanceOf(address)", parameter: tronToHex(addr).slice(2).padStart(64, "0"), visible: true });
  const hex = r.constant_result?.[0];
  if (!hex) throw new Error("balance check failed");
  return BigInt("0x" + hex);
}
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

// deno-lint-ignore no-explicit-any
let admin: any, node: (coin: number, i: number) => HDNodeWallet, back: (reason: string) => Promise<Response>;

/** TRC20 payout through GasFree: sign one authorisation per paying address, submit, wait for the chain. */
// deno-lint-ignore no-explicit-any
async function payGasfree(w: any, cfg: any, need: bigint, pool: any[]): Promise<Response> {
  const traces: string[] = [];
  try {
    const provider = (await gasfree("GET", "/api/v1/config/provider/all")).providers?.[0];
    if (!provider) return await back("GasFree: no service provider");
    // what each GasFree address can pay: balance - pending - fee
    const bal: { address: string; index: number; units: bigint; eoa: string; fee: bigint; nonce: number }[] = [];
    for (const p of pool) {
      const eoa = await tronFromEvm(node(195, Number(p.derivation_index)).address);
      const info = await gasfree("GET", `/api/v1/address/${eoa}`);
      if (info.gasFreeAddress !== p.address) throw new Error("wallet key does not match the deposit addresses");
      const a = (info.assets ?? []).find((x: { tokenAddress: string }) => x.tokenAddress === cfg.usdt_contract);
      const fee = BigInt(a?.transferFee ?? 2_000_000) + (info.active ? 0n : BigInt(a?.activateFee ?? 2_000_000));
      const free = (await usdtBalanceOf(p.address, cfg.usdt_contract)) - BigInt(a?.frozen ?? 0) - fee;
      if (info.allowSubmit !== false && free > 0n) bal.push({ address: p.address, index: Number(p.derivation_index), units: free, eoa, fee, nonce: Number(info.nonce ?? 0) });
      await sleep(150);
    }
    const plan = planSources(bal, need);
    if (!plan) return await back("not enough USDT on the deposit addresses (after the GasFree fee)");
    for (const part of plan) {
      const src = bal.find((b) => b.address === part.address)!;
      const deadline = Math.floor(Date.now() / 1000) + Number(provider.config?.defaultDeadlineDuration ?? 180);
      const msg = { token: cfg.usdt_contract, serviceProvider: provider.address, user: src.eoa, receiver: w.address, value: part.units, maxFee: src.fee, deadline, nonce: src.nonce };
      const sig = gasfreeSign(msg, node(195, src.index).privateKey);
      const r = await gasfree("POST", "/api/v1/gasfree/submit", { ...msg, value: Number(part.units), maxFee: Number(src.fee), version: 1, sig });
      traces.push(r.id);
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 250);
    console.error("gasfree payout", w.id, msg);
    if (!traces.length) return await back("auto payout failed: " + msg);
    await admin.from("withdrawals").update({ note: "gf:" + traces.join(",") + " | stopped: " + msg }).eq("id", w.id);
    await alertStaff(admin, `⚠️ Auto payout #${w.id} stopped halfway (GasFree ${traces.join(", ")}). Error: ${msg}\nCheck it by hand.`);
    return out({ ok: false, reason: "stopped halfway, check by hand" });
  }
  await admin.from("withdrawals").update({ note: "gf:" + traces.join(",") }).eq("id", w.id);
  for (let i = 0; i < 12; i++) {                    // usually on chain within a minute
    await sleep(5000);
    const res = await finishGasfree({ ...w, note: "gf:" + traces.join(",") }, true);
    if (res) return res;
  }
  return out({ ok: true, pending: true, reason: "sent to GasFree, waiting for the chain" });
}

/** Look at the GasFree authorisations of a payout; mark it paid when all are on chain. */
// deno-lint-ignore no-explicit-any
async function finishGasfree(w: any, quiet = false): Promise<Response> {
  const traces = String(w.note).slice(3).split(" | ")[0].split(",").filter(Boolean);
  const hashes: string[] = [];
  for (const t of traces) {
    const s = await gasfree("GET", `/api/v1/gasfree/${t}`);
    if (s.state === "FAILED") {
      if (traces.length === 1) {
        await admin.from("withdrawals").update({ status: "approved", note: "GasFree transfer failed, nothing was sent" }).eq("id", w.id).eq("status", "sending");
        return out({ ok: false, reason: "GasFree transfer failed, nothing was sent" });
      }
      await alertStaff(admin, `⚠️ Auto payout #${w.id}: one GasFree part failed (${t}). Check it by hand.`);
      return out({ ok: false, reason: "one part failed, check by hand" });
    }
    if (s.state !== "SUCCEED" || !s.txnHash) return quiet ? (null as unknown as Response) : out({ ok: true, pending: true, reason: "still on its way" });
    hashes.push(s.txnHash);
  }
  await admin.from("withdrawals").update({ status: "paid", auto: true, tx_hash: hashes.join(","), note: null, handled_at: new Date().toISOString() }).eq("id", w.id).eq("status", "sending");
  const short = w.address.slice(0, 6) + "…" + w.address.slice(-6);
  await tell(admin, w.user_id, msgCashoutDone(w, hashes));
  return out({ ok: true, hashes });
}

/** USDT-TON or GRAM. No sweeping: the money is paid straight from the address that holds it — the club wallet or a
 *  player's personal deposit address (like TRC20): the smallest one that covers everything, else several (largest first).
 *  A personal address sending USDT gets ~0.07 GRAM for the fee from the club wallet first. Never pays twice. */
// deno-lint-ignore no-explicit-any
async function payTon(w: any, cfg: any): Promise<Response> {
  const words = (Deno.env.get("TON_MNEMONIC") ?? "").trim().split(/\s+/);
  if (words.length !== 24) return await back("auto payout is off for TON (no TON wallet key)");
  const hashes: string[] = [];
  let sent = false;
  try {
    const key = await mnemonicToPrivateKey(words);
    const clubAddr = Address.parse(cfg.receive_address);
    const club = [WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }), WalletContractV4.create({ workchain: 0, publicKey: key.publicKey })]
      .find((x) => x.address.equals(clubAddr));
    if (!club) return await back("the TON wallet key does not match the club wallet address");
    const apiKey = Deno.env.get("TONCENTER_API_KEY");
    const client = new TonClient({ endpoint: "https://toncenter.com/api/v2/jsonRPC", apiKey: apiKey || undefined });
    const pause = () => sleep(apiKey ? 120 : 1100);
    const isGram = w.network === "GRAM";
    const master = isGram ? null : Address.parse(cfg.usdt_contract);
    const to = Address.parse(w.address);
    const need = isGram ? toNano(String(w.coin_amount)) : BigInt(Math.round(Number(w.amount) * 1e6));

    // every place the money can come from: the club wallet and each personal deposit address
    // deno-lint-ignore no-explicit-any
    const wallets: { contract: any; index: number; club: boolean }[] = [{ contract: club, index: -1, club: true }];
    const pw = (await admin.from("ton_deposit_wallets").select("idx,address")).data ?? [];
    for (const p of pw) {
      const c = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey, walletId: 698983191 + 1000 + Number(p.idx) });
      if (c.address.equals(Address.parse(p.address))) wallets.push({ contract: c, index: Number(p.idx), club: false });
    }
    const jettonWallet = async (owner: Address) =>
      (await client.runMethod(master!, "get_wallet_address", [{ type: "slice", cell: beginCell().storeAddress(owner).endCell() }])).stack.readAddress();
    const bal: { address: string; index: number; units: bigint }[] = [];
    const gramOf = new Map<number, bigint>();
    for (const x of wallets) {
      const g = await client.getBalance(x.contract.address); await pause();
      gramOf.set(x.index, g);
      let units = 0n;
      if (isGram) units = g - (x.club ? toNano("0.1") : toNano("0.02"));       // keep something for the fee
      else { try { units = (await client.runMethod(await jettonWallet(x.contract.address), "get_wallet_data")).stack.readBigNumber(); } catch { units = 0n; } await pause(); }
      if (units > 0n) bal.push({ address: x.contract.address.toString(), index: x.index, units });
    }
    const plan = planSources(bal, need);
    if (!plan) return await back(isGram ? "not enough GRAM on the club addresses" : "not enough USDT on the club TON addresses");

    const clubC = client.open(club);
    // one transfer from `src` to `dest`; waits until the network confirms it
    // deno-lint-ignore no-explicit-any
    const transfer = async (src: { contract: any; index: number; club: boolean }, dest: Address, units: bigint, final: boolean) => {
      const c = client.open(src.contract);
      let msg;
      if (isGram) {
        msg = internal({ to: dest, value: units, bounce: false, body: final ? `Zerake ${w.op_id}` : "Zerake merge" });
      } else {
        if (!src.club && (await client.getBalance(src.contract.address)) < toNano("0.06")) {      // the club pays the fee for this address
          await pause();
          const s0 = await clubC.getSeqno(); await pause();
          await clubC.sendTransfer({ seqno: s0, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
            messages: [internal({ to: src.contract.address, value: toNano("0.07"), bounce: false, body: "Zerake fee" })] });
          let ok = false;
          for (let i = 0; i < 20 && !ok; i++) { await sleep(3000); try { ok = (await client.getBalance(src.contract.address)) >= toNano("0.06"); } catch { /* retry */ } }
          if (!ok) throw new Error("the fee top-up did not arrive");
        }
        await pause();
        const jw = await jettonWallet(src.contract.address); await pause();
        const body = beginCell()
          .storeUint(0xf8a7ea5, 32).storeUint(BigInt(w.id), 64).storeCoins(units)
          .storeAddress(dest).storeAddress(clubAddr).storeBit(0).storeCoins(final ? 1n : 0n)
          .storeBit(1).storeRef(beginCell().storeUint(0, 32).storeStringTail(final ? `Zerake ${w.op_id}` : "Zerake merge").endCell())
          .endCell();
        msg = internal({ to: jw, value: toNano("0.05"), bounce: true, body });
      }
      const seqno = await c.getSeqno().catch(() => 0); await pause();
      await c.sendTransfer({ seqno, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS, messages: [msg] });
      if (final) sent = true;
      let done = false;
      for (let i = 0; i < 20 && !done; i++) { await sleep(3000); try { done = (await c.getSeqno()) > seqno; } catch { /* retry */ } }
      if (!done) throw new Error("a transfer was not confirmed within a minute");
      if (!final) return;
      try {
        const h: Record<string, string> = {}; if (apiKey) h["X-API-Key"] = apiKey;
        const r = await fetch(`https://toncenter.com/api/v3/transactions?account=${encodeURIComponent(src.contract.address.toRawString())}&limit=1&sort=desc`, { headers: h });
        const t = (await r.json()).transactions?.[0];
        if (t?.hash) hashes.push(Array.from(Uint8Array.from(atob(String(t.hash).replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)), (b) => b.toString(16).padStart(2, "0")).join(""));
      } catch { /* the payout is done anyway */ }
    };

    // The player always gets ONE transfer: if the money sits on several addresses,
    // first merge it onto the address holding the most, then pay from there.
    const target = wallets.find((x) => x.index === plan[0].index)!;
    if (plan.length > 1) {
      for (const part of plan.slice(1)) await transfer(wallets.find((x) => x.index === part.index)!, target.contract.address, part.units, false);
      let ok = false;
      for (let i = 0; i < 30 && !ok; i++) {
        await sleep(3000);
        try {
          ok = isGram
            ? (await client.getBalance(target.contract.address)) - (target.club ? toNano("0.1") : toNano("0.02")) >= need
            : (await client.runMethod(await jettonWallet(target.contract.address), "get_wallet_data")).stack.readBigNumber() >= need;
        } catch { /* retry */ }
      }
      if (!ok) throw new Error("the merged money did not arrive on one address within 90 seconds");
    }
    await transfer(target, to, need, true);
    await admin.from("withdrawals").update({ status: "paid", auto: true, tx_hash: hashes.join(",") || null, note: null, handled_at: new Date().toISOString() }).eq("id", w.id);
    await tell(admin, w.user_id, msgCashoutDone(w, hashes));
    return out({ ok: true, hashes });
  } catch (e) {
    const m = String((e as Error)?.message ?? e).slice(0, 250);
    console.error("ton payout", w.id, m);
    if (!sent) return await back("auto payout failed: " + m);
    await admin.from("withdrawals").update({ note: "CHECK BY HAND (TON): " + (hashes.join(", ") || "sent") + " — " + m }).eq("id", w.id);
    await alertStaff(admin, `⚠️ TON payout #${w.id} (${w.op_id}) stopped after sending: ${m}\nCheck it by hand in Tonviewer.`);
    return out({ ok: false, reason: "sent, not confirmed: check by hand" });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return out({ error: "method" }, 405);
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if ((req.headers.get("authorization") ?? "") !== "Bearer " + serviceKey) return out({ error: "forbidden" }, 403);
  admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, { auth: { persistSession: false } });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return out({ error: "bad json" }, 400); }

  const phrase = (Deno.env.get("WALLET_MNEMONIC") ?? "").trim().replace(/\s+/g, " ");
  let mn: Mnemonic | null = null;
  try { if (phrase) mn = Mnemonic.fromPhrase(phrase); } catch { mn = null; }
  node = (coin: number, i: number) => HDNodeWallet.fromMnemonic(mn!, `m/44'/${coin}'/0'/0/${i}`);
  const cfgs = (await admin.from("chain_config").select("network,rpc_url,usdt_contract,decimals,auto_max,auto_daily,receive_address")).data ?? [];
  const cfgOf = (n: string) => cfgs.find((c) => c.network === n)!;

  // ---- wallet overview for the owner (gas addresses, balances) ----
  if (body.info === true) {
    if (!mn) return out({ ready: false });
    const res: Record<string, unknown> = { ready: true };
    try {
      const t = cfgOf("TRC20"); const ga = await tronFromEvm(node(195, GAS_INDEX).address);
      const g = await tronAccount(ga, t.usdt_contract);
      const pool = (await admin.from("address_pool").select("address").eq("network", "TRC20")).data ?? [];
      let total = 0n; for (const p of pool) { total += await usdtBalanceOf(p.address, t.usdt_contract); await sleep(120); }
      res.TRC20 = { gasfree: gasfreeOn(), gas_address: ga, gas_balance: formatUnits(g.trx, 6) + " TRX", pool_usdt: formatUnits(total, t.decimals) };
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
  const w = (await admin.from("withdrawals").select("id,op_id,user_id,amount,chips,fee,coin_amount,network,address,status,note").eq("id", id).maybeSingle()).data;
  if (w && w.status === "sending" && String(w.note ?? "").startsWith("gf:")) {
    try { return await finishGasfree(w); } catch (e) { return out({ ok: false, reason: String(e) }); }
  }
  if (!w || w.status !== "approved") return out({ ok: false, reason: "not ready" });
  back = async (reason: string) => {           // nothing was sent: hand it back to the managers
    await admin.from("withdrawals").update({ status: "approved", note: reason }).eq("id", id).eq("status", "sending");
    return out({ ok: false, reason });
  };
  const cfg = cfgOf(w.network);
  if (w.network === "TON" || w.network === "GRAM") {
    if (!cfg?.receive_address) return out({ ok: false, reason: "the club TON wallet is not set" });
    if (Number(w.amount) > Number(cfg.auto_max)) return out({ ok: false, reason: `over the auto limit (${Number(cfg.auto_max)} USDT), pay by hand` });
    const lockT = await admin.from("withdrawals").update({ status: "sending", note: null }).eq("id", id).eq("status", "approved").select("id");
    if ((lockT.data?.length ?? 0) !== 1) return out({ ok: false, reason: "already being paid" });
    return await payTon(w, cfg);
  }
  if (!mn) return out({ ok: false, reason: "auto payout is off (no wallet key)" });
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
  const pool = (await admin.from("address_pool").select("address,derivation_index,kind").eq("network", w.network)).data ?? [];
  const hashes: string[] = [];
  if (w.network === "TRC20" && gasfreeOn() && pool.some((p) => p.kind === "gasfree")) return await payGasfree(w, cfg, need, pool.filter((p) => p.kind === "gasfree"));
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
  await tell(admin, w.user_id, msgCashoutDone(w, hashes));
  return out({ ok: true, hashes });
});

async function tell(admin: ReturnType<typeof createClient>, userId: string, text: string) {
  const bot = Deno.env.get("TELEGRAM_BOT_TOKEN"); if (!bot) return;
  const tid = (await admin.auth.admin.getUserById(userId)).data?.user?.user_metadata?.telegram_id;
  if (!tid) return;
  await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(tid), text, parse_mode: "HTML", disable_web_page_preview: true }) }).catch(() => {});
}
async function alertStaff(admin: ReturnType<typeof createClient>, text: string) {
  const bot = Deno.env.get("TELEGRAM_BOT_TOKEN"); if (!bot) return;
  const { data } = await admin.from("staff").select("telegram_id");
  for (const s of data ?? []) await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: s.telegram_id, text, disable_web_page_preview: true }) }).catch(() => {});
}
