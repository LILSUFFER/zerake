// Supabase Edge Function: the staff queue (owner and managers).
// Everything is checked on the server against the `staff` table; the Mini App only shows the buttons.
//   whoami       -> your role, or null
//   queue        -> deposits waiting for chips
//   done         -> last handled deposits
//   claim        -> take a deposit ("I am sending these chips"); release -> give it back
//   mark_sent    -> mark one deposit "chips sent" (only the person who took it, or the owner)
//   wqueue / wdone / wclaim / wrelease / wpaid / wreject -> cash-out requests (same idea as deposits)
//   unmatched    -> payments no request matches;  resolve -> mark one as handled
//   staff_list / staff_add / staff_remove -> owner only
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";


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

const ALLOWED = ["https://zerake.com", "https://www.zerake.com"];
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

async function tell(admin: ReturnType<typeof createClient>, userId: string, text: string) {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!botToken) return;
  const pu = await admin.auth.admin.getUserById(userId);
  const tid = pu.data?.user?.user_metadata?.telegram_id;
  if (!tid) return;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(tid), text, parse_mode: "HTML", disable_web_page_preview: true }),
  }).catch(() => {});
}

async function callPayout(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const r = await fetch(Deno.env.get("SUPABASE_URL")! + "/functions/v1/send-payout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! },
      body: JSON.stringify(payload),
    });
    return await r.json();
  } catch (e) { return { ok: false, reason: "payout service unavailable: " + String(e) }; }
}
// Pay automatically; if it does not go through, keep the reason on the request so managers see it.
async function autoPay(id: number): Promise<Record<string, unknown>> {
  const r = await callPayout({ id });
  if (!r.ok && !r.pending && r.reason) {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    await admin.from("withdrawals").update({ note: String(r.reason).slice(0, 300) }).eq("id", id).eq("status", "approved");
  }
  return r;
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

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return out({ error: "bad json" }, 400, h); }
  const action = String(body.action ?? "");

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const tid = Number(u.user.user_metadata?.telegram_id);
  const me = tid ? (await admin.from("staff").select("role,username").eq("telegram_id", tid).maybeSingle()).data : null;
  const role = (me?.role as "owner" | "cashier" | undefined) ?? null;

  if (action === "whoami") return out({ role }, 200, h);
  if (!role) return out({ error: "not staff" }, 403, h);

  if (action === "queue" || action === "done") {
    const pending = action === "queue";
    const q = admin.from("deposits").select("id,op_id,amount,network,created_at,user_id,tx_hash,handled_at,handled_name,claimed_by,claimed_name,claimed_at");
    const { data: deps } = pending
      ? await q.eq("status", "received").order("created_at", { ascending: true }).limit(100)
      : await q.eq("status", "chips_sent").order("handled_at", { ascending: false }).limit(15);
    const rows = deps ?? [];
    const ids = [...new Set(rows.map((d) => d.user_id))];
    const prof = ids.length ? (await admin.from("profiles").select("user_id,gg_id").in("user_id", ids)).data ?? [] : [];
    const hashes = rows.map((d) => d.tx_hash);
    const reqs = hashes.length ? (await admin.from("deposit_requests").select("tx_hash,request_no,base_amount").in("tx_hash", hashes)).data ?? [] : [];
    const gg = new Map(prof.map((p) => [p.user_id, p.gg_id]));
    const rq = new Map(reqs.map((r) => [r.tx_hash, r]));
    const ex = (await admin.from("chain_config").select("network,explorer_tx")).data ?? [];
    return out({
      explorer: Object.fromEntries(ex.map((e) => [e.network, e.explorer_tx])),
      items: rows.map((d) => ({
        id: d.id, op_id: d.op_id, amount: d.amount, network: d.network, created_at: d.created_at, handled_at: d.handled_at, handled_name: d.handled_name,
        claimed_name: d.claimed_name, claimed_at: d.claimed_at, mine: d.claimed_by === u.user.id, tx_hash: d.tx_hash,
        gg_id: gg.get(d.user_id) ?? null, request_no: rq.get(d.tx_hash)?.request_no ?? null, base_amount: rq.get(d.tx_hash)?.base_amount ?? null,
      })),
    }, 200, h);
  }

  const myName = (me?.username ? "@" + me.username : String(u.user.user_metadata?.first_name ?? "manager"));
  const STALE_MIN = 15;   // a taken deposit that nobody finishes goes back to the pool after this long

  if (action === "claim") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return out({ error: "bad id" }, 400, h);
    const staleBefore = new Date(Date.now() - STALE_MIN * 60_000).toISOString();
    // Free, or already mine, or taken by someone who went quiet.
    const r = await admin.from("deposits").update({ claimed_by: u.user.id, claimed_name: myName, claimed_at: new Date().toISOString() })
      .eq("id", id).eq("status", "received").or(`claimed_by.is.null,claimed_by.eq.${u.user.id},claimed_at.lt.${staleBefore}`).select("id");
    if (r.error) { console.error("claim:", r.error.message); return out({ error: "failed" }, 500, h); }
    return (r.data?.length ?? 0) === 1 ? out({ ok: true }, 200, h) : out({ error: "taken" }, 409, h);
  }
  if (action === "release") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return out({ error: "bad id" }, 400, h);
    const q = admin.from("deposits").update({ claimed_by: null, claimed_name: null, claimed_at: null }).eq("id", id).eq("status", "received");
    await (role === "owner" ? q : q.eq("claimed_by", u.user.id));
    return out({ ok: true }, 200, h);
  }
  if (action === "mark_sent") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return out({ error: "bad id" }, 400, h);
    // Only the first press counts, and only by whoever took it (the owner may always finish a deposit).
    const q = admin.from("deposits").update({ status: "chips_sent", handled_by: u.user.id, handled_name: myName, handled_at: new Date().toISOString() })
      .eq("id", id).eq("status", "received");
    const r = await (role === "owner" ? q : q.or(`claimed_by.is.null,claimed_by.eq.${u.user.id}`)).select("id,op_id,user_id,amount,network,tx_hash");
    if (r.error) { console.error("mark_sent:", r.error.message); return out({ error: "failed" }, 500, h); }
    if ((r.data?.length ?? 0) !== 1) return out({ error: "taken or already handled" }, 409, h);
    // Tell the player the chips are on their way (works if they have started the bot).
    const owner = r.data![0];
    const gg = (await admin.from("profiles").select("gg_id").eq("user_id", owner.user_id).maybeSingle()).data?.gg_id ?? "";
    await tell(admin, owner.user_id, msgChipsSent(owner, gg));
    return out({ ok: true }, 200, h);
  }

  // ---- cash-out requests ----
  if (action === "wqueue" || action === "wdone") {
    const pending = action === "wqueue";
    const q = admin.from("withdrawals").select("id,op_id,amount,chips,fee,network,address,status,created_at,user_id,claimed_name,claimed_by,handled_name,handled_at,tx_hash,note,coin_amount,rate");
    const { data: ws } = pending
      ? await q.in("status", ["pending", "approved", "sending"]).order("created_at", { ascending: true }).limit(100)
      : await q.in("status", ["paid", "rejected"]).order("handled_at", { ascending: false }).limit(15);
    const rows = ws ?? [];
    const ids = [...new Set(rows.map((w) => w.user_id))];
    const prof = ids.length ? (await admin.from("profiles").select("user_id,gg_id").in("user_id", ids)).data ?? [] : [];
    const gg = new Map(prof.map((p) => [p.user_id, p.gg_id]));
    return out({
      items: rows.map((w) => ({
        id: w.id, op_id: w.op_id, amount: w.amount, chips: w.chips ?? w.amount, coin_amount: w.coin_amount, rate: w.rate, fee: w.fee ?? 0, network: w.network, address: w.address, status: w.status, created_at: w.created_at,
        handled_at: w.handled_at, handled_name: w.handled_name, claimed_name: w.claimed_name, mine: w.claimed_by === u.user.id,
        gg_id: gg.get(w.user_id) ?? null, tx_hash: w.tx_hash, note: w.note,
      })),
    }, 200, h);
  }
  if (action === "wclaim") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return out({ error: "bad id" }, 400, h);
    const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
    const r = await admin.from("withdrawals").update({ claimed_by: u.user.id, claimed_name: myName, claimed_at: new Date().toISOString() })
      .eq("id", id).eq("status", "pending").or(`claimed_by.is.null,claimed_by.eq.${u.user.id},claimed_at.lt.${staleBefore}`).select("id");
    if (r.error) { console.error("wclaim:", r.error.message); return out({ error: "failed" }, 500, h); }
    return (r.data?.length ?? 0) === 1 ? out({ ok: true }, 200, h) : out({ error: "taken" }, 409, h);
  }
  if (action === "wrelease") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return out({ error: "bad id" }, 400, h);
    const q = admin.from("withdrawals").update({ claimed_by: null, claimed_name: null, claimed_at: null }).eq("id", id).eq("status", "pending");
    await (role === "owner" ? q : q.eq("claimed_by", u.user.id));
    return out({ ok: true }, 200, h);
  }
  if (action === "wtaken") {
    // Stage 1: the manager took the chips in ClubGG and types the amount; it must equal what the player asked for.
    const id = Number(body.id);
    const typed = Number(String(body.amount ?? "").replace(",", "."));
    if (!Number.isInteger(id) || !Number.isFinite(typed)) return out({ error: "bad request" }, 400, h);
    const w0 = (await admin.from("withdrawals").select("amount,chips,status,claimed_by").eq("id", id).maybeSingle()).data;
    if (!w0 || w0.status !== "pending") return out({ error: "taken or already handled" }, 409, h);
    if (role !== "owner" && w0.claimed_by !== u.user.id) return out({ error: "taken or already handled" }, 409, h);
    if (Math.round(typed * 100) !== Math.round(Number(w0.chips ?? w0.amount) * 100)) return out({ error: "amount mismatch" }, 400, h);
    const r = await admin.from("withdrawals").update({ status: "approved", handled_by: u.user.id, handled_name: myName, handled_at: new Date().toISOString() })
      .eq("id", id).eq("status", "pending").select("op_id,user_id,amount,chips,fee,coin_amount,network,address");
    if (r.error || (r.data?.length ?? 0) !== 1) return out({ error: "taken or already handled" }, 409, h);
    const payout = await autoPay(id);
    if (!payout.ok) {
      const gg = (await admin.from("profiles").select("gg_id").eq("user_id", r.data![0].user_id).maybeSingle()).data?.gg_id ?? "";
      await tell(admin, r.data![0].user_id, msgCashoutApproved(r.data![0], gg));
    }
    return out({ ok: true, payout }, 200, h);
  }
  if (action === "wretry") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return out({ error: "bad id" }, 400, h);
    return out({ ok: true, payout: await autoPay(id) }, 200, h);
  }
  if (action === "wallet") {
    if (role !== "owner") return out({ error: "owner only" }, 403, h);
    return out(await callPayout({ info: true }), 200, h);
  }
  if (action === "wpaid" || action === "wreject") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return out({ error: "bad id" }, 400, h);
    const paid = action === "wpaid";
    const tx = String(body.tx_hash ?? "").trim().slice(0, 140);
    if (paid && tx && !/^[A-Za-z0-9+/=_:.-]{6,140}$/.test(tx)) return out({ error: "bad tx hash" }, 400, h);
    const note = String(body.note ?? "").trim().slice(0, 300);
    const q = admin.from("withdrawals").update({
      status: paid ? "paid" : "rejected", tx_hash: paid && tx ? tx : null, note: note || null,
      handled_by: u.user.id, handled_name: myName, handled_at: new Date().toISOString(),
    }).eq("id", id).in("status", paid ? ["approved", "sending"] : ["pending"]);   // pay only after the chips were taken
    // only the person who took it (or the owner) may finish it
    const r = await (role === "owner" ? q : q.or(`claimed_by.is.null,claimed_by.eq.${u.user.id}`)).select("id,op_id,user_id,amount,chips,fee,network,address,coin_amount");
    if (r.error) { console.error(action + ":", r.error.message); return out({ error: "failed" }, 500, h); }
    if ((r.data?.length ?? 0) !== 1) return out({ error: "taken or already handled" }, 409, h);
    const w = r.data![0];
    const short = w.address.length > 14 ? w.address.slice(0, 6) + "…" + w.address.slice(-6) : w.address;
    await tell(admin, w.user_id, paid ? msgCashoutDone(w, tx ? tx.split(",") : []) : msgCashoutRejected(w, note));
    return out({ ok: true }, 200, h);
  }

  // ---- operations log (every change of every deposit and cash out) ----
  if (action === "log") {
    const term = String(body.q ?? "").trim().replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
    let q = admin.from("ops_log").select("id,op_id,kind,event,status,actor_name,amount,row_data,changed,at").order("id", { ascending: false }).limit(150);
    if (term) {
      const digits = term.replace(/-/g, "");
      let users: string[] = [];
      if (/^\d{4,12}$/.test(digits)) users = ((await admin.from("profiles").select("user_id").eq("gg_id", digits)).data ?? []).map((p) => p.user_id);
      q = users.length ? q.or(`op_id.ilike.%${term}%,actor_id.in.(${users.join(",")})`) : q.ilike("op_id", `%${term}%`);
    }
    const { data: rows, error } = await q;
    if (error) { console.error("log:", error.message); return out({ error: "failed" }, 500, h); }
    const ids = [...new Set((rows ?? []).map((r) => r.row_data?.user_id).filter(Boolean))];
    const prof = ids.length ? (await admin.from("profiles").select("user_id,gg_id").in("user_id", ids)).data ?? [] : [];
    const gg = new Map(prof.map((p) => [p.user_id, p.gg_id]));
    return out({ items: (rows ?? []).map((r) => ({ ...r, gg_id: gg.get(r.row_data?.user_id) ?? null })) }, 200, h);
  }

  // ---- wallet change through support (the player lost the recovery code): owner only, 7 days ----
  if (action === "wallet_change") {
    if (role !== "owner") return out({ error: "owner only" }, 403, h);
    const chain = String(body.chain ?? "");
    const RE: Record<string, RegExp> = { TRON: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, BSC: /^0x[0-9a-fA-F]{40}$/, TON: /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/ };
    const address = String(body.address ?? "").trim();
    if (!RE[chain] || !RE[chain].test(address)) return out({ error: "bad address" }, 400, h);
    const gg = String(body.gg_id ?? "").replace(/\D/g, "");
    const prof = (await admin.from("profiles").select("user_id").eq("gg_id", gg)).data ?? [];
    if (prof.length !== 1) return out({ error: prof.length ? "several players" : "player not found" }, 404, h);
    const uid = prof[0].user_id;
    const cur = (await admin.from("player_wallets").select("address").eq("user_id", uid).eq("chain", chain).maybeSingle()).data;
    const pend = (await admin.from("wallet_changes").select("id").eq("user_id", uid).eq("status", "pending").limit(1)).data ?? [];
    if (pend.length) return out({ error: "change pending" }, 409, h);
    const effective = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    await admin.from("wallet_changes").insert({ user_id: uid, chain, old_address: cur?.address ?? null, new_address: address, method: "support", requested_by: myName, effective_at: effective });
    await tell(admin, uid, `🔐 <b>Смена кошелька через поддержку</b> · <i>Wallet change by support</i>\n\nСеть: ${esc(chain)}\nБыло: <code>${esc(cur?.address ?? "—")}</code>\nСтанет: <code>${esc(address)}</code>\nВступит в силу: через 7 дней.\n\nДо этого выводы заморожены. <b>Если вы об этом не просили</b> — откройте приложение и нажмите «Отменить смену».`);
    return out({ ok: true, effective_at: effective }, 200, h);
  }

  if (action === "unmatched") {
    const { data } = await admin.from("unmatched_deposits").select("id,network,tx_hash,address,from_address,amount,seen_at").eq("resolved", false).order("seen_at", { ascending: false }).limit(50);
    return out({ items: data ?? [] }, 200, h);
  }
  if (action === "resolve") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return out({ error: "bad id" }, 400, h);
    await admin.from("unmatched_deposits").update({ resolved: true }).eq("id", id);
    return out({ ok: true }, 200, h);
  }

  // Owner-only: managers.
  if (role !== "owner") return out({ error: "owner only" }, 403, h);
  if (action === "staff_list") {
    const { data } = await admin.from("staff").select("telegram_id,username,role").order("role", { ascending: true });
    return out({ items: data ?? [] }, 200, h);
  }
  if (action === "staff_add") {
    const uname = String(body.username ?? "").trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(uname)) return out({ error: "bad username" }, 400, h);
    const list = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const m = (list.data?.users ?? []).find((x) => String(x.user_metadata?.username ?? "").toLowerCase() === uname && x.user_metadata?.telegram_id);
    if (!m) return out({ error: "not found" }, 404, h);
    const ins = await admin.from("staff").upsert({ telegram_id: Number(m.user_metadata.telegram_id), username: m.user_metadata.username, role: "cashier" }, { onConflict: "telegram_id", ignoreDuplicates: true });
    if (ins.error) { console.error("staff_add:", ins.error.message); return out({ error: "failed" }, 500, h); }
    return out({ ok: true }, 200, h);
  }
  if (action === "staff_remove") {
    const t = Number(body.telegram_id);
    if (!t || t === tid) return out({ error: "cannot remove yourself" }, 400, h);
    await admin.from("staff").delete().eq("telegram_id", t).neq("role", "owner");
    return out({ ok: true }, 200, h);
  }
  return out({ error: "unknown action" }, 400, h);
});
