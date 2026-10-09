// Supabase Edge Function: the staff queue (owner and managers).
// Everything is checked on the server against the `staff` table; the Mini App only shows the buttons.
//   whoami       -> your role, or null
//   queue        -> deposits waiting for chips
//   done         -> last handled deposits
//   claim        -> take a deposit ("I am sending these chips"); release -> give it back
//   mark_sent    -> mark one deposit "chips sent" (only the person who took it, or the owner)
//   unmatched    -> payments no request matches;  resolve -> mark one as handled
//   staff_list / staff_add / staff_remove -> owner only
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const q = admin.from("deposits").select("id,amount,network,created_at,user_id,tx_hash,handled_at,handled_name,claimed_by,claimed_name,claimed_at");
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
        id: d.id, amount: d.amount, network: d.network, created_at: d.created_at, handled_at: d.handled_at, handled_name: d.handled_name,
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
    const r = await (role === "owner" ? q : q.or(`claimed_by.is.null,claimed_by.eq.${u.user.id}`)).select("id");
    if (r.error) { console.error("mark_sent:", r.error.message); return out({ error: "failed" }, 500, h); }
    return (r.data?.length ?? 0) === 1 ? out({ ok: true }, 200, h) : out({ error: "taken or already handled" }, 409, h);
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
