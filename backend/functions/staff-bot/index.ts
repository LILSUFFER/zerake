// Supabase Edge Function: the staff bot (webhook). Only for the owner and managers (the `staff` table).
//   /start           -> a button that opens the admin panel (zerake.com/admin)
//   Reply to a 💬 support message -> the reply (text, photo or file) goes to that player through the support bot
// It also carries every staff alert (new top-ups, cash-outs, agent problems) — the other functions send them here.
// Setup (once): open https://<project>.supabase.co/functions/v1/staff-bot?setup=1
// Secrets: STAFF_BOT_TOKEN, SUPPORT_BOT_TOKEN.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN = "https://zerake.com/admin/";
async function secretFor(token: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("zerake-staff:" + token)));
  return Array.from(h.subarray(0, 24), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function tg(token: string, method: string, body: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return await r.json().catch(() => ({}));
}
async function relayFile(fromToken: string, toToken: string, chat: number, fileId: string, kind: "photo" | "document", caption: string) {
  const f = await tg(fromToken, "getFile", { file_id: fileId });
  if (!f.ok) return null;
  const bin = await (await fetch(`https://api.telegram.org/file/bot${fromToken}/${f.result.file_path}`)).blob();
  const fd = new FormData();
  fd.append("chat_id", String(chat)); if (caption) fd.append("caption", caption.slice(0, 1000));
  fd.append(kind, bin, String(f.result.file_path).split("/").pop() || kind);
  const r = await fetch(`https://api.telegram.org/bot${toToken}/send${kind === "photo" ? "Photo" : "Document"}`, { method: "POST", body: fd });
  return await r.json().catch(() => null);
}
const menu = { inline_keyboard: [[{ text: "🛠 Open the admin panel · Открыть админку", url: ADMIN }]] };

Deno.serve(async (req: Request) => {
  const token = Deno.env.get("STAFF_BOT_TOKEN");
  const supportToken = Deno.env.get("SUPPORT_BOT_TOKEN");
  if (!token) return new Response("no STAFF_BOT_TOKEN", { status: 500 });
  const url = new URL(req.url);

  if (req.method === "GET" && url.searchParams.get("setup") === "1") {
    const hook = `https://${url.host}/functions/v1/staff-bot`;
    const a = await tg(token, "setWebhook", { url: hook, secret_token: await secretFor(token), allowed_updates: ["message"], drop_pending_updates: true });
    await tg(token, "setMyCommands", { commands: [{ command: "start", description: "Admin panel" }] });
    await tg(token, "setMyCommands", { commands: [{ command: "start", description: "Админка" }], language_code: "ru" });
    return new Response(JSON.stringify({ webhook: a.ok, info: a.description ?? null, support_bot: !!supportToken }), { headers: { "Content-Type": "application/json" } });
  }
  if (req.method !== "POST") return new Response("ok");
  if (req.headers.get("x-telegram-bot-api-secret-token") !== await secretFor(token)) return new Response("forbidden", { status: 403 });

  const m = (await req.json().catch(() => ({}))).message;
  if (!m?.chat?.id || m.chat.type !== "private") return new Response("ok");
  const chat = Number(m.chat.id);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const me = (await admin.from("staff").select("role,username").eq("telegram_id", chat).maybeSingle()).data;
  if (!me) {
    await tg(token, "sendMessage", { chat_id: chat, text: "This bot is only for the Zerake team. · Этот бот только для команды Zerake." });
    return new Response("ok");
  }

  const replyTo = m.reply_to_message?.message_id;
  if (!replyTo) {
    await tg(token, "sendMessage", { chat_id: chat, reply_markup: menu, text:
      `👋 ${me.role === "owner" ? "Владелец" : "Менеджер"}${me.username ? " @" + me.username : ""}.\n\nСюда приходят уведомления о заявках и сообщения игроков в поддержку.\nЧтобы ответить игроку, нажмите «Ответить» (Reply) на его сообщении 💬.` });
    return new Response("ok");
  }

  // a reply to a support message: find the player and send the answer through the support bot
  const src = (await admin.from("support_messages").select("player_tg,player_name").eq("staff_tg", chat).eq("staff_msg_id", replyTo).maybeSingle()).data;
  if (!src) {
    await tg(token, "sendMessage", { chat_id: chat, reply_to_message_id: m.message_id, text: "Это не сообщение из поддержки — ответ никуда не отправлен." });
    return new Response("ok");
  }
  if (!supportToken) {
    await tg(token, "sendMessage", { chat_id: chat, text: "Бот поддержки не настроен (нет SUPPORT_BOT_TOKEN)." });
    return new Response("ok");
  }
  const text = String(m.text ?? m.caption ?? "");
  const kind: "text" | "photo" | "document" = m.photo ? "photo" : m.document ? "document" : "text";
  let r;
  if (kind === "text") r = await tg(supportToken, "sendMessage", { chat_id: Number(src.player_tg), text, disable_web_page_preview: true });
  else r = await relayFile(token, supportToken, Number(src.player_tg), kind === "photo" ? m.photo[m.photo.length - 1].file_id : m.document.file_id, kind, text);
  const name = me.username ? "@" + me.username : "staff";
  if (r?.ok) {
    await admin.from("support_messages").insert({ player_tg: src.player_tg, player_name: src.player_name, dir: "out", body: text, kind, staff_tg: chat, staff_name: name });
    await tg(token, "setMessageReaction", { chat_id: chat, message_id: m.message_id, reaction: [{ type: "emoji", emoji: "👍" }] });
    // the other managers see that it is answered
    for (const s of (await admin.from("staff").select("telegram_id")).data ?? []) {
      if (Number(s.telegram_id) === chat) continue;
      await tg(token, "sendMessage", { chat_id: Number(s.telegram_id), text: `↩️ ${name} ответил ${src.player_name}: ${text.slice(0, 300)}${kind !== "text" ? " [" + kind + "]" : ""}` });
    }
  } else {
    await tg(token, "sendMessage", { chat_id: chat, reply_to_message_id: m.message_id, text: "Не удалось отправить: " + (r?.description ?? "ошибка") + ". Возможно, игрок заблокировал бота поддержки." });
  }
  return new Response("ok");
});
