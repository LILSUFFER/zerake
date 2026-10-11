// Supabase Edge Function: the support bot (webhook). Players write here; every message is passed to the staff
// in the staff bot with the player's ClubGG ID, and staff replies come back to the player from this bot.
// Setup (once): open https://<project>.supabase.co/functions/v1/support-bot?setup=1
// Secrets: SUPPORT_BOT_TOKEN, STAFF_BOT_TOKEN.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

async function secretFor(token: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("zerake-support:" + token)));
  return Array.from(h.subarray(0, 24), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function tg(token: string, method: string, body: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await r.json().catch(() => ({}));
}
// A photo or file sent to one bot cannot be sent by another bot by its id: download it and upload it again.
async function relayFile(fromToken: string, toToken: string, chat: number, fileId: string, kind: "photo" | "document", caption: string, extra: Record<string, unknown> = {}) {
  const f = await tg(fromToken, "getFile", { file_id: fileId });
  if (!f.ok) return null;
  const bin = await (await fetch(`https://api.telegram.org/file/bot${fromToken}/${f.result.file_path}`)).blob();
  const fd = new FormData();
  fd.append("chat_id", String(chat)); fd.append("caption", caption.slice(0, 1000)); fd.append("parse_mode", "HTML");
  for (const [k, v] of Object.entries(extra)) fd.append(k, typeof v === "string" ? v : JSON.stringify(v));
  fd.append(kind, bin, String(f.result.file_path).split("/").pop() || kind);
  const r = await fetch(`https://api.telegram.org/bot${toToken}/send${kind === "photo" ? "Photo" : "Document"}`, { method: "POST", body: fd });
  return await r.json().catch(() => null);
}
const esc = (v: unknown) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as Record<string, string>)[c]);
const fid = (v: unknown) => { const d = String(v ?? "").replace(/\D/g, ""); return d.length > 4 ? d.replace(/(\d{4})(?=\d)/g, "$1-") : String(v ?? ""); };

Deno.serve(async (req: Request) => {
  const token = Deno.env.get("SUPPORT_BOT_TOKEN");
  const staffToken = Deno.env.get("STAFF_BOT_TOKEN");
  if (!token) return new Response("no SUPPORT_BOT_TOKEN", { status: 500 });
  const url = new URL(req.url);

  if (req.method === "GET" && url.searchParams.get("setup") === "1") {
    const hook = `https://${url.host}/functions/v1/support-bot`;
    const a = await tg(token, "setWebhook", { url: hook, secret_token: await secretFor(token), allowed_updates: ["message"], drop_pending_updates: true });
    await tg(token, "setMyCommands", { commands: [{ command: "start", description: "Write to support" }] });
    await tg(token, "setMyCommands", { commands: [{ command: "start", description: "Написать в поддержку" }], language_code: "ru" });
    await tg(token, "setMyDescription", { description: "Zerake support. Write your question: a person from the team will answer here." });
    await tg(token, "setMyDescription", { description: "Поддержка Zerake. Напишите вопрос — вам ответит человек из команды прямо здесь.", language_code: "ru" });
    return new Response(JSON.stringify({ webhook: a.ok, info: a.description ?? null, staff_bot: !!staffToken }), { headers: { "Content-Type": "application/json" } });
  }
  if (req.method !== "POST") return new Response("ok");
  if (req.headers.get("x-telegram-bot-api-secret-token") !== await secretFor(token)) return new Response("forbidden", { status: 403 });

  const m = (await req.json().catch(() => ({}))).message;
  if (!m?.chat?.id || m.chat.type !== "private") return new Response("ok");
  const ru = !/^en/.test(String(m.from?.language_code ?? "ru"));
  const chat = Number(m.chat.id);

  if (m.text === "/start") {
    await tg(token, "sendMessage", { chat_id: chat, text: ru
      ? "👋 Это поддержка Zerake.\n\nНапишите ваш вопрос одним сообщением. Если вопрос про пополнение или снятие фишек, добавьте номер операции (DEP-… или WD-…) или скриншот. Вам ответит человек из команды прямо здесь."
      : "👋 This is Zerake support.\n\nWrite your question in one message. If it is about a chips top-up or cash-out, add the operation number (DEP-… or WD-…) or a screenshot. A person from the team will answer right here." });
    return new Response("ok");
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const name = m.from?.username ? "@" + m.from.username : [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || String(chat);
  // who is it in Zerake: their ClubGG ID, if they have used the app
  const email = `tg${chat}@users.zerake.invalid`;
  let gg = "";
  const list = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const u = (list.data?.users ?? []).find((x) => x.email === email);
  if (u) gg = (await admin.from("profiles").select("gg_id").eq("user_id", u.id).maybeSingle()).data?.gg_id ?? "";

  const text = String(m.text ?? m.caption ?? "");
  const kind: "text" | "photo" | "document" = m.photo ? "photo" : m.document ? "document" : "text";
  if (kind === "text" && !text) {
    await tg(token, "sendMessage", { chat_id: chat, text: ru ? "Пока можно отправить текст, фото или файл." : "You can send text, a photo or a file." });
    return new Response("ok");
  }
  const head = `💬 <b>Поддержка</b> · ${esc(name)}${gg ? ` · ClubGG ID <code>${fid(gg)}</code>` : " · ClubGG ID не указан"}\n<i>Ответьте на это сообщение (Reply), и ответ уйдёт игроку.</i>\n\n`;
  const staff = (await admin.from("staff").select("telegram_id")).data ?? [];
  let delivered = 0;
  for (const s of staff) {
    if (!staffToken) break;
    let r;
    if (kind === "text") r = await tg(staffToken, "sendMessage", { chat_id: Number(s.telegram_id), text: head + esc(text), parse_mode: "HTML", disable_web_page_preview: true });
    else r = await relayFile(token, staffToken, Number(s.telegram_id), kind === "photo" ? m.photo[m.photo.length - 1].file_id : m.document.file_id, kind, head + esc(text));
    if (r?.ok) {
      delivered++;
      await admin.from("support_messages").insert({ player_tg: chat, player_name: name, dir: "in", body: text, kind, staff_tg: Number(s.telegram_id), staff_msg_id: r.result.message_id });
    }
  }
  if (!delivered) await admin.from("support_messages").insert({ player_tg: chat, player_name: name, dir: "in", body: text, kind });
  // a short "got it" only for the first message of a conversation (nothing from this player in the last 30 minutes)
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const recent = (await admin.from("support_messages").select("id", { count: "exact", head: true }).eq("player_tg", chat).gte("created_at", since)).count ?? 0;
  if (recent <= Math.max(1, delivered)) await tg(token, "sendMessage", { chat_id: chat, text: ru ? "✅ Получили, скоро ответим здесь." : "✅ Got it, we will answer here soon." });
  return new Response("ok");
});
