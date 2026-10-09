// Supabase Edge Function: the player's bound wallets and their emergency change.
//   status  -> bound wallets, a pending change (if any), whether a recovery code exists
//   bind    -> bind the wallet for a chain (once). The very first bind returns a recovery code, shown once.
//   change  -> recovery code + new address: the change takes effect after 48 hours (cash outs frozen meanwhile).
//              Returns a NEW recovery code (shown once) that replaces the old one when the change is done.
//   cancel  -> cancel a pending change (no code needed: it only makes things safer)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED = ["https://zerake.com", "https://www.zerake.com"];
const CHAINS: Record<string, RegExp> = {
  TRON: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  BSC: /^0x[0-9a-fA-F]{40}$/,
  TON: /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/,
};
const CHANGE_HOURS = 48;
const MAX_FAILED = 5;           // wrong codes per 24 hours

// ---- helpers ----
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function newCode(): string {
  const r = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(r, (b) => CROCKFORD[b % 32]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
function normCode(c: unknown): string {
  return String(c ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}
async function hashCode(userId: string, code: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("zerake-recovery:" + userId + ":" + normCode(code)));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** TON: one form for the same wallet (non-bounceable UQ…). */
function tonNormalize(a: string): string {
  const bin = atob(a.replace(/-/g, "+").replace(/_/g, "/"));
  if (bin.length !== 36) throw new Error("bad TON address");
  const b = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  b[0] = 0x51;
  let crc = 0;
  for (let i = 0; i < 34; i++) { crc ^= b[i] << 8; for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  b[34] = crc >> 8; b[35] = crc & 255;
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_");
}
function cleanAddress(chain: string, a: unknown): string | null {
  let s = String(a ?? "").trim();
  if (!CHAINS[chain]?.test(s)) return null;
  if (chain === "TON") { try { s = tonNormalize(s); } catch { return null; } }
  return s;
}
// ---- end helpers ----

function cors(o: string | null): Record<string, string> {
  const a = o && ALLOWED.includes(o) ? o : ALLOWED[0];
  return { "Access-Control-Allow-Origin": a, "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin", "Content-Type": "application/json" };
}
const out = (b: unknown, s: number, h: Record<string, string>) => new Response(JSON.stringify(b), { status: s, headers: h });

async function tellAll(admin: ReturnType<typeof createClient>, userId: string, playerText: string, staffText: string) {
  const bot = Deno.env.get("TELEGRAM_BOT_TOKEN"); if (!bot) return;
  const send = (chat: number, text: string) => fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  }).catch(() => {});
  const tid = (await admin.auth.admin.getUserById(userId)).data?.user?.user_metadata?.telegram_id;
  if (tid) await send(Number(tid), playerText);
  for (const s of (await admin.from("staff").select("telegram_id")).data ?? []) await send(Number(s.telegram_id), staffText);
}

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
  const uid = u.user.id;
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return out({ error: "bad json" }, 400, h); }
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const action = String(body.action ?? "status");

  await admin.rpc("apply_wallet_changes");          // anything that is due becomes real right now

  const state = async () => {
    const w = (await admin.from("player_wallets").select("chain,address").eq("user_id", uid)).data ?? [];
    const p = (await admin.from("wallet_changes").select("id,chain,old_address,new_address,method,effective_at,requested_at").eq("user_id", uid).eq("status", "pending").order("id")).data ?? [];
    const sec = (await admin.from("player_security").select("user_id").eq("user_id", uid).maybeSingle()).data;
    return { wallets: Object.fromEntries(w.map((x) => [x.chain, x.address])), pending: p, has_code: !!sec };
  };

  if (action === "status") return out(await state(), 200, h);

  if (action === "bind") {
    const chain = String(body.chain ?? "");
    const address = cleanAddress(chain, body.address);
    if (!address) return out({ error: "bad address" }, 400, h);
    const exists = (await admin.from("player_wallets").select("chain").eq("user_id", uid).eq("chain", chain).maybeSingle()).data;
    if (exists) return out({ error: "already bound" }, 409, h);
    const ins = await admin.from("player_wallets").insert({ user_id: uid, chain, address });
    if (ins.error) return out({ error: /duplicate|unique/i.test(ins.error.message) ? "wallet taken" : "save failed" }, 409, h);
    // the very first bind creates the recovery code
    let code: string | null = null;
    const sec = (await admin.from("player_security").select("user_id").eq("user_id", uid).maybeSingle()).data;
    if (!sec) { code = newCode(); await admin.from("player_security").insert({ user_id: uid, code_hash: await hashCode(uid, code) }); }
    return out({ ...(await state()), code }, 200, h);
  }

  if (action === "change") {
    const chain = String(body.chain ?? "");
    const address = cleanAddress(chain, body.address);
    if (!address) return out({ error: "bad address" }, 400, h);
    const cur = (await admin.from("player_wallets").select("address").eq("user_id", uid).eq("chain", chain).maybeSingle()).data;
    if (!cur) return out({ error: "nothing to change" }, 400, h);
    if (cur.address === address) return out({ error: "same address" }, 400, h);
    const pend = (await admin.from("wallet_changes").select("id").eq("user_id", uid).eq("status", "pending").limit(1)).data ?? [];
    if (pend.length) return out({ error: "change pending" }, 409, h);
    const taken = (await admin.from("player_wallets").select("user_id").eq("chain", chain).ilike("address", address).maybeSingle()).data;
    if (taken && taken.user_id !== uid) return out({ error: "wallet taken" }, 409, h);
    const sec = (await admin.from("player_security").select("code_hash,failed,failed_at").eq("user_id", uid).maybeSingle()).data;
    if (!sec) return out({ error: "no code" }, 400, h);
    const recent = sec.failed_at && Date.now() - new Date(sec.failed_at).getTime() < 24 * 3600 * 1000;
    if (recent && sec.failed >= MAX_FAILED) return out({ error: "too many attempts" }, 429, h);
    if ((await hashCode(uid, String(body.code ?? ""))) !== sec.code_hash) {
      await admin.from("player_security").update({ failed: (recent ? sec.failed : 0) + 1, failed_at: new Date().toISOString() }).eq("user_id", uid);
      return out({ error: "wrong code", left: MAX_FAILED - ((recent ? sec.failed : 0) + 1) }, 403, h);
    }
    const code = newCode();
    const effective = new Date(Date.now() + CHANGE_HOURS * 3600 * 1000).toISOString();
    await admin.from("wallet_changes").insert({ user_id: uid, chain, old_address: cur.address, new_address: address, method: "code", new_code_hash: await hashCode(uid, code), requested_by: "player", effective_at: effective });
    await admin.from("player_security").update({ failed: 0 }).eq("user_id", uid);
    const gg = (await admin.from("profiles").select("gg_id").eq("user_id", uid).maybeSingle()).data?.gg_id ?? "";
    await tellAll(admin, uid,
      `🔐 <b>Запрошена смена кошелька</b> · <i>Wallet change requested</i>\n\nСеть: ${chain}\nБыло: <code>${cur.address}</code>\nСтанет: <code>${address}</code>\nВступит в силу: через ${CHANGE_HOURS} ч.\n\nДо этого выводы заморожены. <b>Если это не вы</b> — откройте приложение и нажмите «Отменить смену».`,
      `🔐 Wallet change requested (with recovery code)\nClubGG ID: ${gg}\nChain: ${chain}\nFrom: ${cur.address}\nTo: ${address}\nTakes effect in ${CHANGE_HOURS} h. Cash outs are frozen for this player meanwhile.`);
    return out({ ...(await state()), code }, 200, h);
  }

  if (action === "newcode") {                      // after a change through support the old code is gone: make a new one
    const sec = (await admin.from("player_security").select("user_id").eq("user_id", uid).maybeSingle()).data;
    const w = (await admin.from("player_wallets").select("chain").eq("user_id", uid).limit(1)).data ?? [];
    if (sec || !w.length) return out({ error: "not allowed" }, 400, h);
    const code = newCode();
    await admin.from("player_security").insert({ user_id: uid, code_hash: await hashCode(uid, code) });
    return out({ ...(await state()), code }, 200, h);
  }

  if (action === "cancel") {
    const r = await admin.from("wallet_changes").update({ status: "cancelled", closed_at: new Date().toISOString() }).eq("user_id", uid).eq("status", "pending").select("chain,new_address");
    if ((r.data?.length ?? 0) > 0) {
      const gg = (await admin.from("profiles").select("gg_id").eq("user_id", uid).maybeSingle()).data?.gg_id ?? "";
      await tellAll(admin, uid, `✅ <b>Смена кошелька отменена</b> · <i>Wallet change cancelled</i>\n\nВаш кошелёк остался прежним.`, `✅ Wallet change cancelled by the player (ClubGG ID ${gg}).`);
    }
    return out(await state(), 200, h);
  }

  return out({ error: "unknown action" }, 400, h);
});
